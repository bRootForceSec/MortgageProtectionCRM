/* global MpcrmCalendar, MpcrmBusiness, browser */
// Watches the Unitrust calendar and the Business Management Report, and sends what they show to the CRM whenever it
// changes (and every few minutes).
// A small note in the corner says what was sent; click it to hide it.
(function () {
  'use strict';
  var last = '';
  var lastAt = 0;
  var timer = null;
  var note = null;

  function show(text, bad) {
    if (!note) {
      note = document.createElement('div');
      note.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;border-radius:6px;'
        + 'font:12px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;max-width:320px';
      note.title = 'Mortgage Protection CRM. Click to hide.';
      note.addEventListener('click', function () { note.style.display = 'none'; });
      document.body.appendChild(note);
    }
    note.style.background = bad ? '#fde8e8' : '#e8f4ea';
    note.style.color = bad ? '#8a1c1c' : '#1d4d2a';
    note.textContent = text;
  }

  function scanPolicies() {
    var r = MpcrmBusiness.read(document);
    if (!r) return;
    if (r.agents.length > 1) {
      show('CRM: pick only yourself in the agent filter, so only your policies are sent (' + r.agents.length + ' agents showing)', true);
      return;
    }
    if (r.missing.length) {
      show('CRM: can\'t find the ' + r.missing.join(', ').replace(/_/g, ' ') + ' column' + (r.missing.length > 1 ? 's' : '')
        + '. Try Card View, or turn the column on with Columns.', true);
      return;
    }
    if (!r.policies.length) return;
    var sig = JSON.stringify([r.policies, r.level]);
    if (sig === last && Date.now() - lastAt < 5 * 60 * 1000) return;
    browser.runtime.sendMessage({ type: 'policies', policies: r.policies, level: r.level, today: today() }).then(function (res) {
      if (!res || !res.ok) {
        show('CRM: ' + ((res && res.error) || 'not sent'), true);
        return;
      }
      last = sig;
      lastAt = Date.now();
      var s = res.sync;
      var more = r.paging && r.paging.total > r.paging.shown
        ? ' Only ' + r.paging.shown + ' of ' + r.paging.total + ' are on this page: make Page Size bigger.' : '';
      var rules = s.needs_rules ? ' ' + s.needs_rules + ' product' + (s.needs_rules === 1 ? ' needs' : 's need') + ' comp rules: CRM → Settings → Products and comp.' : '';
      show('CRM: ' + s.seen + ' policies sent, ' + s.added + ' new, ' + s.changed + ' changed'
        + (s.unmatched.length ? ', ' + s.unmatched.length + ' with no lead' : '') + '.' + rules + more, !!(rules || more));
    }, function (e) { show('CRM: ' + e.message, true); });
  }

  function today() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function scan() {
    timer = null;
    if (/business_management/i.test(location.pathname)) return scanPolicies();
    var r = MpcrmCalendar.read(document);
    if (!r.events.length) {
      if (r.skipped) show('CRM: switch the Unitrust calendar to week or day view so appointments can be read', true);
      return;
    }
    var sig = JSON.stringify(r.events);
    if (sig === last && Date.now() - lastAt < 5 * 60 * 1000) return;
    browser.runtime.sendMessage({ type: 'events', events: r.events, days: r.days, today: r.today }).then(function (res) {
      if (!res || !res.ok) {
        show('CRM: ' + ((res && res.error) || 'not sent'), true);
        return;
      }
      last = sig;
      lastAt = Date.now();
      var s = res.sync;
      show('CRM: ' + s.seen + ' appointments sent, ' + s.changed + ' changed'
        + (s.unmatched.length ? ', ' + s.unmatched.length + ' not found in the CRM' : '')
        + (r.skipped ? ', ' + r.skipped + ' unreadable' : ''), false);
    }, function (e) { show('CRM: ' + e.message, true); });
  }

  function later() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(scan, 1500);
  }

  new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
  setInterval(later, 60 * 1000);
  later();
})();
