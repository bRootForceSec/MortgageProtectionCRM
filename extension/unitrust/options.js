/* global browser */
'use strict';
var DEFAULT_URL = 'http://127.0.0.1:5170';
var key = document.getElementById('key');
var url = document.getElementById('url');
var msg = document.getElementById('msg');
browser.storage.local.get({ url: DEFAULT_URL, key: '' }).then(function (o) {
  key.value = o.key;
  url.value = o.url;
});
document.getElementById('save').addEventListener('click', function () {
  var u = (url.value.trim() || DEFAULT_URL).replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)) {
    msg.textContent = 'The CRM address must be on this computer (127.0.0.1 or localhost).';
    return;
  }
  browser.storage.local.set({ key: key.value.trim(), url: u }).then(function () { msg.textContent = 'Saved.'; });
});
