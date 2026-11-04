/* global browser */
// Sends what the calendar page read to the CRM on this computer, with the key from the CRM's Settings.
'use strict';

var DEFAULT_URL = 'http://127.0.0.1:5170';

// What each message from the page sends, and where.
var SENDS = {
  events: function (msg) { return { path: '/api/unitrust/events', body: { events: msg.events, days: msg.days, today: msg.today } }; },
  policies: function (msg) { return { path: '/api/unitrust/policies', body: { policies: msg.policies, level: msg.level, today: msg.today } }; },
};

browser.runtime.onMessage.addListener(function (msg) {
  if (!msg || !SENDS[msg.type]) return undefined;
  var send = SENDS[msg.type](msg);
  return browser.storage.local.get({ url: DEFAULT_URL, key: '' }).then(function (o) {
    if (!o.key) return { ok: false, error: 'paste the key from the CRM (Settings → Unitrust extension) into this extension\'s options' };
    return fetch(o.url.replace(/\/+$/, '') + send.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mpcrm-extension-key': o.key },
      body: JSON.stringify(send.body),
    }).then(function (res) {
      return res.json().then(function (body) {
        return res.ok ? { ok: true, sync: body } : { ok: false, error: body.error || 'the CRM said ' + res.status };
      });
    }, function () {
      return { ok: false, error: 'can\'t reach the CRM. Is it running?' };
    });
  });
});

browser.browserAction.onClicked.addListener(function () { browser.runtime.openOptionsPage(); });
