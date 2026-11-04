// Reads appointments off the Unitrust calendar page: each event's title, the day column it sits in, its start time
// and its color. Pure page reading; content.js decides when to run it and sends the result to the CRM.
// Kept free of extension APIs so the CRM's tests can load it.

globalThis.MpcrmCalendar = (function () {
  'use strict';

  // "OH - UNION SAVING - CALEB BRIGLE- (614) 706-9261 BRIGLE"
  var TITLE = /\b[A-Z]{2}\s+-\s+[^\n]+?\s+-\s+[^\n]+?\s*-\s*\(?\d{3}\)?[\s.-]*\d{3,}[\s.-]*\d{3,}(?:[ \t]+[A-Za-z'-]+)?/;
  var DAY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\/(\d{1,2})$/;
  var HOUR = /^(\d{1,2})\s*(am|pm)$/i;
  // A lead link copied from the CRM (src/shared/leadLink.ts has the same pattern): http://127.0.0.1:5170/lead/<id>.
  var LEAD_LINK = /\/lead\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

  /** The lead id in a lead link inside some text, or null. */
  function leadIdIn(text) {
    var m = LEAD_LINK.exec(text || '');
    return m ? m[1].toLowerCase() : null;
  }

  /** The appointment title inside some text, or null. */
  function extractTitle(text) {
    var m = TITLE.exec(text || '');
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
  }

  /** "rgb(r, g, b)" or "rgba(r, g, b, a)" to blue / green / red / yellow, or null for white, gray or anything else. */
  function classifyColor(css) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(css || '');
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.1) return null;
    var r = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var l = (max + min) / 2;
    var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (s < 0.25 || l > 0.93 || l < 0.08) return null;
    var h;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h < 18 || h >= 330) return 'red';
    if (h < 70) return 'yellow';
    if (h < 170) return 'green';
    if (h < 260) return 'blue';
    return null;
  }

  /** The year for a month/day shown without one: the one that puts it closest to today. */
  function dateFor(month, day, today) {
    var best = null;
    for (var y = today.getFullYear() - 1; y <= today.getFullYear() + 1; y++) {
      var t = new Date(y, month - 1, day);
      if (!best || Math.abs(t - today) < Math.abs(best - today)) best = t;
    }
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return best.getFullYear() + '-' + p(best.getMonth() + 1) + '-' + p(best.getDate());
  }

  function ownText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  }

  /** The color of the event box around a title: the nearest ancestor with a colored background (or left border). */
  function colorOf(el, win) {
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 8; n = n.parentElement, i++) {
      var cs = win.getComputedStyle(n);
      var c = classifyColor(cs.backgroundColor) || (parseFloat(cs.borderLeftWidth) >= 3 ? classifyColor(cs.borderLeftColor) : null);
      if (c) return { color: c, box: n };
    }
    return null;
  }

  /** Reads the calendar in `doc`. Returns { events, skipped } where skipped counts titles it couldn't place or color. */
  function read(doc, today) {
    var win = doc.defaultView;
    today = today || new Date();
    var days = [];
    var hours = [];
    var all = doc.body ? doc.body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      var t = ownText(all[i]);
      if (!t || t.length > 12) continue;
      var dm = DAY.exec(t);
      if (dm) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0) days.push({ left: r.left, right: r.right, date: dateFor(+dm[2], +dm[3], today) });
        continue;
      }
      var hm = HOUR.exec(t);
      if (hm) {
        var hr = all[i].getBoundingClientRect();
        var h = (+hm[1] % 12) + (hm[2].toLowerCase() === 'pm' ? 12 : 0);
        if (hr.height > 0) hours.push({ top: hr.top, hour: h });
      }
    }
    // An event belongs to the day whose header is centered nearest above it (headers can be narrower than their column).
    days.sort(function (a, b) { return a.left - b.left; });
    for (var d = 0; d < days.length; d++) days[d].center = (days[d].left + days[d].right) / 2;
    var colW = days.length > 1 ? (days[days.length - 1].center - days[0].center) / (days.length - 1) : Infinity;
    hours.sort(function (a, b) { return a.top - b.top; });

    var events = [];
    var skipped = 0;
    var seen = new Set();
    var walker = doc.createTreeWalker(doc.body, 4 /* text nodes */);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var title = extractTitle(node.nodeValue);
      if (!title || !node.parentElement) continue;
      var c = colorOf(node.parentElement, win);
      var box = (c ? c.box : node.parentElement).getBoundingClientRect();
      var x = box.left + box.width / 2;
      var day = null;
      for (var k = 0; k < days.length; k++) {
        if (Math.abs(days[k].center - x) < colW * 0.6 && (!day || Math.abs(days[k].center - x) < Math.abs(day.center - x))) day = days[k];
      }
      if (!c || !day) { skipped++; continue; }
      var key = day.date + '|' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      var ev = { title: title, date: day.date, time: timeAt(box.top, hours), color: c.color };
      // A lead link pasted into the appointment, when the calendar shows it in the event box.
      var leadId = leadIdIn(c.box.textContent);
      if (leadId) ev.lead_id = leadId;
      events.push(ev);
    }
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      events: events,
      skipped: skipped,
      days: days.map(function (x) { return x.date; }),
      today: today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate()),
    };
  }

  /** The time at a height on the day grid, to the quarter hour, from the hour labels down its side. */
  function timeAt(top, hours) {
    if (hours.length < 2) return null;
    var i = 0;
    while (i + 1 < hours.length && hours[i + 1].top <= top + 2) i++;
    var a = hours[i], b = hours[i + 1] || hours[i - 1];
    var per = Math.abs(b.top - a.top) / Math.abs(b.hour - a.hour || 1);
    var mins = Math.round(((top - a.top) / per) * 4) * 15;
    var total = a.hour * 60 + Math.max(0, mins);
    if (total >= 24 * 60) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(Math.floor(total / 60)) + ':' + p(total % 60);
  }

  return { read: read, leadIdIn: leadIdIn, extractTitle: extractTitle, classifyColor: classifyColor, dateFor: dateFor, timeAt: timeAt };
})();
