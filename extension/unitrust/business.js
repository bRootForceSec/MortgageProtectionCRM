// Reads policies off Unitrust's Business Management Report, in List View or Card View. Pure page reading; content.js
// decides when to run it and sends the result to the CRM. Kept free of extension APIs so the CRM's tests can load it.
//
// List View: finds the column headers by their names (and the group above them, since two columns are called "Phone"
// and two "Amount"), then reads each row's cells by which header they sit under. Card View: reads each card's text in
// order and pairs each label ("Company", "Product"...) with the values after it.

globalThis.MpcrmBusiness = (function () {
  'use strict';

  // List View: [policy field, column name, group it must be under (or null for any)].
  var COLUMNS = [
    ['client_name', 'Client Name', null],
    ['policy_number', 'Policy Number', null],
    ['agent_id', 'Agent ID', null],
    ['client_phone', 'Phone', 'Client Info'],
    ['carrier', 'Insurance Co.', null],
    ['app_id', 'App Number', null],
    ['product', 'Product', null],
    ['premium', 'Amount', 'Premium'],
    ['capped_apv', 'Capped', null],
    ['apv', 'Uncapped', null],
    ['applied', 'Application', null],
    ['applied', 'Application Date', null],
    ['submitted', 'Submitted', null],
    ['paid', 'Paid', null],
    ['paid', 'Paid Date', null],
    ['lapsed', 'Lapsed', null],
    ['lapsed', 'Lapsed Date', null],
    ['status', 'Status', null],
  ];
  var GROUPS = ['Pinned', 'Agent', 'Client Info', 'Application Info', 'Premium', 'Coverage', 'APV', 'Dates', 'Activity', 'Status'];
  var NEEDED = ['app_id', 'carrier', 'product'];

  // Card View labels. The ones mapped to a field are read; the rest only mark where a value ends.
  var CARD_FIELDS = {
    'UFG App ID': 'app_id', 'Carrier Policy Number': 'policy_number', 'Company': 'carrier', 'Product': 'product',
    'Premium': 'premium', 'APV': 'apv', 'Capped': 'capped_apv', 'Status': 'status', 'Application': 'applied',
    'Submitted': 'submitted', 'Paid': 'paid', 'Lapsed': 'lapsed',
  };
  var CARD_OTHER = ['Agent', 'Client', 'Carrier Writing', 'App Type', 'Meeting Type', 'Coverage', 'Last update', 'Rec. at Carrier',
    'City · State', 'City - State', 'Lead Source', 'Direct', 'Base Shop', "To Do's / Requirements", 'Notes', 'Create Note', 'Actions', 'DOB'];

  var PHONE = /\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/;
  var AGENT = /^UFG\d+$/i;
  var LEVEL = /\bLv\.?\s*(\d{2,3}(?:\.\d+)?)\b/;

  function squash(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function ownText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    return squash(t);
  }

  /** A cell's text without the dot in front of a status ("• Issue-Paid"). */
  function cellText(el) {
    return squash(el.textContent).replace(/^[•·●\s]+/, '');
  }

  /**
   * Which column each field is in. `headers` are { text, left, right } for the column names, `groups` { text, left }
   * for the group names above them. A group spans from its name to the next group's name.
   */
  function columnsFrom(headers, groups) {
    var gs = groups.slice().sort(function (a, b) { return a.left - b.left; });
    var groupAt = function (x) {
      var g = null;
      for (var i = 0; i < gs.length; i++) if (gs[i].left <= x + 2) g = gs[i];
      return g ? g.text : null;
    };
    var out = {};
    for (var c = 0; c < COLUMNS.length; c++) {
      var field = COLUMNS[c][0], name = COLUMNS[c][1], group = COLUMNS[c][2];
      if (out[field]) continue;
      for (var h = 0; h < headers.length; h++) {
        var hd = headers[h];
        if (hd.text !== name) continue;
        if (group && gs.length && groupAt(hd.left) !== group) continue;
        out[field] = { left: hd.left, right: hd.right };
        break;
      }
    }
    return out;
  }

  /** The box of a header cell: its nearest ancestor that is a header cell, else the label itself. */
  function headerBox(el) {
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      var role = n.getAttribute('role');
      if (role === 'columnheader' || n.tagName === 'TH' || /header-cell/.test(n.className || '')) return n.getBoundingClientRect();
    }
    return el.getBoundingClientRect();
  }

  function readList(doc) {
    var names = {};
    for (var i = 0; i < COLUMNS.length; i++) names[COLUMNS[i][1]] = true;
    var groupNames = {};
    for (var g = 0; g < GROUPS.length; g++) groupNames[GROUPS[g]] = true;
    var all = doc.body ? doc.body.querySelectorAll('*') : [];
    var clientHeader = null;
    var labels = [];
    for (var k = 0; k < all.length; k++) {
      var t = ownText(all[k]);
      if (!t || t.length > 20 || !(names[t] || groupNames[t])) continue;
      var r = all[k].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      labels.push({ el: all[k], text: t, top: r.top, left: r.left });
      if (t === 'Client Name' && !clientHeader) clientHeader = r;
    }
    if (!clientHeader) return null;
    var rowTop = clientHeader.top;
    var headers = [];
    var groups = [];
    for (var m = 0; m < labels.length; m++) {
      var l = labels[m];
      if (Math.abs(l.top - rowTop) < 8 && names[l.text]) {
        var b = headerBox(l.el);
        headers.push({ text: l.text, left: b.left, right: b.right });
      } else if (l.top < rowTop - 6 && rowTop - l.top < 80 && groupNames[l.text]) {
        groups.push({ text: l.text, left: headerBox(l.el).left });
      }
    }
    var cols = columnsFrom(headers, groups);
    var missing = NEEDED.filter(function (f) { return !cols[f]; });

    // Body cells, grouped into rows by height (a pinned column and the rest of its row are separate elements).
    var cells = doc.body.querySelectorAll('[role="gridcell"], td');
    var rows = [];
    for (var c = 0; c < cells.length; c++) {
      var cr = cells[c].getBoundingClientRect();
      if (cr.top <= rowTop + 4 || (!cr.width && !cr.height)) continue;
      var row = null;
      for (var q = 0; q < rows.length; q++) if (Math.abs(rows[q].top - cr.top) < 4) { row = rows[q]; break; }
      if (!row) rows.push(row = { top: cr.top, cells: [] });
      row.cells.push({ left: cr.left, right: cr.right, text: cellText(cells[c]) });
    }
    rows.sort(function (a, b) { return a.top - b.top; });
    var policies = [];
    for (var w = 0; w < rows.length; w++) {
      var p = {};
      for (var f in cols) {
        var col = cols[f];
        var mid = (col.left + col.right) / 2;
        for (var z = 0; z < rows[w].cells.length; z++) {
          var cell = rows[w].cells[z];
          if (cell.left <= mid && cell.right >= mid) { p[f] = cell.text; break; }
        }
      }
      if (p.app_id || p.client_name) policies.push(p);
    }
    return { view: 'list', policies: policies, missing: missing };
  }

  /**
   * One card's fields from its text pieces in page order. A label takes the values after it; labels in a row
   * ("APV", "Capped") followed by values in a row take one value each.
   */
  function cardFields(tokens) {
    var isLabel = function (t) { return CARD_FIELDS[t] !== undefined || CARD_OTHER.indexOf(t) >= 0; };
    var runs = [];
    var run = null;
    for (var i = 0; i < tokens.length; i++) {
      var t = squash(tokens[i]);
      if (!t) continue;
      if (isLabel(t)) {
        if (!run || run.values.length) runs.push(run = { labels: [], values: [] });
        run.labels.push(t);
      } else if (run) {
        run.values.push(t);
      }
    }
    var values = {};
    for (var r = 0; r < runs.length; r++) {
      var ls = runs[r].labels, vs = runs[r].values;
      for (var j = 0; j < ls.length; j++) {
        if (values[ls[j]]) continue;
        values[ls[j]] = j < ls.length - 1 ? vs.slice(j, j + 1) : vs.slice(j);
      }
    }
    var p = {};
    for (var label in CARD_FIELDS) {
      var v = values[label];
      if (v && v.length) p[CARD_FIELDS[label]] = v[0].replace(/^[•·●\s]+/, '');
    }
    // "Client 900000001", then the name, phone, email and date of birth.
    var client = values.Client || [];
    for (var c = 0; c < client.length; c++) {
      if (!p.client_name && !/^\d+$/.test(client[c]) && !PHONE.test(client[c]) && client[c].indexOf('@') < 0) p.client_name = client[c];
      else if (!p.client_phone && PHONE.test(client[c])) p.client_phone = client[c];
    }
    var agent = values.Agent || [];
    for (var a = 0; a < agent.length; a++) {
      if (!p.agent_id && AGENT.test(agent[a])) p.agent_id = agent[a];
      var lv = LEVEL.exec(agent[a]);
      if (lv && p.level == null) p.level = Number(lv[1]);
    }
    if (p.level == null) {
      var joined = LEVEL.exec(agent.join(' '));
      if (joined) p.level = Number(joined[1]);
    }
    return p;
  }

  function textTokens(el) {
    var out = [];
    var walker = el.ownerDocument.createTreeWalker(el, 4 /* text nodes */);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var t = squash(n.nodeValue);
      if (t) out.push(t);
    }
    return out;
  }

  function readCards(doc) {
    var all = doc.body ? doc.body.querySelectorAll('*') : [];
    var marks = [];
    for (var i = 0; i < all.length; i++) if (ownText(all[i]) === 'UFG App ID') marks.push(all[i]);
    if (!marks.length) return null;
    var countIn = function (el) {
      var n = 0;
      for (var k = 0; k < marks.length; k++) if (el.contains(marks[k])) n++;
      return n;
    };
    var policies = [];
    for (var m = 0; m < marks.length; m++) {
      // The card: the biggest box around this label that holds no other card's label.
      var card = marks[m];
      while (card.parentElement && card.parentElement !== doc.body && countIn(card.parentElement) === 1) card = card.parentElement;
      var p = cardFields(textTokens(card));
      if (p.app_id || p.client_name) policies.push(p);
    }
    return { view: 'card', policies: policies, missing: NEEDED.filter(function (f) { return !policies.length || !policies[0][f]; }) };
  }

  /** "1 to 50 of 120": how many the page shows and how many there are. */
  function paging(doc) {
    var m = /\b(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\b/.exec(squash(doc.body ? doc.body.textContent : ''));
    return m ? { shown: +m[2] - +m[1] + 1, total: +m[3] } : null;
  }

  /**
   * Reads the report in `doc`. Returns { view, policies, level, agents, missing, paging } or null when it isn't showing
   * yet. `agents` is every agent ID seen (the CRM only takes the page when it's just you).
   */
  function read(doc) {
    var r = readList(doc) || readCards(doc);
    if (!r) return null;
    var agents = [];
    var level = null;
    for (var i = 0; i < r.policies.length; i++) {
      var p = r.policies[i];
      if (p.agent_id && agents.indexOf(p.agent_id.toUpperCase()) < 0) agents.push(p.agent_id.toUpperCase());
      if (p.level != null && level == null) level = p.level;
      delete p.level;
      delete p.agent_id;
    }
    return { view: r.view, policies: r.policies, level: agents.length <= 1 ? level : null, agents: agents, missing: r.missing, paging: paging(doc) };
  }

  return { read: read, columnsFrom: columnsFrom, cardFields: cardFields };
})();
