/* global browser */
// Sends what the calendar page read to the CRM on this computer, with the key from the CRM's Settings.
'use strict';

var DEFAULT_URL = 'http://127.0.0.1:5170';

browser.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== 'events') return undefined;
  return browser.storage.local.get({ url: DEFAULT_URL, key: '' }).then(function (o) {
    if (!o.key) return { ok: false, error: 'paste the key from the CRM (Settings → Unitrust extension) into this extension\'s options' };
    return fetch(o.url.replace(/\/+$/, '') + '/api/unitrust/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mpcrm-extension-key': o.key },
      body: JSON.stringify({ events: msg.events, days: msg.days, today: msg.today }),
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
