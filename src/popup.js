/*
 * popup.js — toolbar popup. Shows active rules and lets you toggle/delete
 * them. The full inspector lives in the DevTools "GraphQL" panel.
 */
(function () {
  'use strict';

  function render(rules) {
    rules = rules || [];
    document.getElementById('count').textContent = String(rules.filter(function (r) { return r.enabled !== false; }).length);
    var box = document.getElementById('rules');
    box.textContent = '';
    if (!rules.length) {
      var none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'No rules. Right-click an operation in the panel to block it.';
      box.appendChild(none);
      return;
    }
    rules.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'rule';

      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = r.enabled !== false;
      toggle.addEventListener('change', function () {
        update(function (list) {
          return list.map(function (x) { return x.id === r.id ? Object.assign({}, x, { enabled: toggle.checked }) : x; });
        });
      });

      var type = document.createElement('span');
      type.className = 't ' + r.type;
      type.textContent = r.type;

      var name = document.createElement('span');
      name.className = 'name';
      var m = r.match || {};
      name.textContent = m.operationName || (m.nameRegex ? '/' + m.nameRegex + '/' : '') || m.urlContains || m.method || m.operationType || '(any)';
      name.title = name.textContent;

      var del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Delete rule';
      del.addEventListener('click', function () {
        update(function (list) { return list.filter(function (x) { return x.id !== r.id; }); });
      });

      row.appendChild(toggle);
      row.appendChild(type);
      row.appendChild(name);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function update(fn) {
    chrome.storage.local.get(GQLOP.STORAGE_RULES, function (res) {
      var next = fn((res && res[GQLOP.STORAGE_RULES]) || []);
      var o = {}; o[GQLOP.STORAGE_RULES] = next;
      chrome.storage.local.set(o);
    });
  }

  chrome.storage.local.get(GQLOP.STORAGE_RULES, function (res) { render((res && res[GQLOP.STORAGE_RULES]) || []); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[GQLOP.STORAGE_RULES]) render(changes[GQLOP.STORAGE_RULES].newValue || []);
  });
})();
