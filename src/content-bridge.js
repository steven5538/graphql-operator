/*
 * content-bridge.js — runs in the ISOLATED world at document_start.
 *
 * The only component that can see both window.postMessage (to talk to the
 * main-world interceptor) and chrome.* APIs. It:
 *   - loads rules from chrome.storage and pushes them into the page,
 *   - relays recorded operations up to the background service worker,
 *   - relays resend commands from the panel down into the page,
 *   - announces a per-document id so the background can tell a real navigation
 *     from a mere reconnect,
 *   - reconnects if the (MV3) service worker is torn down, and stops cleanly
 *     if the extension context is invalidated (avoids error spam on reload).
 */
(function () {
  'use strict';

  var port = null;
  var rulesCache = [];
  var panelAttached = false;
  var activePushed = null; // last value sent to the page (null = never sent)
  // Unique per document load. Stable across port reconnects (script runs once
  // per document), so background can distinguish navigation from reconnect.
  var docId = String(Date.now()) + '_' + Math.random().toString(36).slice(2);

  function contextValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ---- page <- rules -----------------------------------------------------
  // NOTE: rules are pushed via postMessage only (not mirrored into page
  // sessionStorage), so rule contents (which may include header values) are
  // not persisted anywhere the page can read them at rest.
  function pushRulesToPage() {
    try {
      window.postMessage({ __gqlop: true, source: GQLOP.SRC_CONTENT, type: GQLOP.P_RULES, payload: rulesCache }, '*');
    } catch (e) { /* ignore */ }
  }

  // ---- page <- "should you hook at all?" ---------------------------------
  // The interceptor patches fetch/XHR only while it has a reason to. Left
  // installed on every page it would sit on the call stack of every request,
  // which makes Chrome attribute the *page's* own CSP violations (and other
  // network errors) to this extension in chrome://extensions.
  function shouldIntercept() {
    return panelAttached || rulesCache.some(function (r) { return r && r.enabled !== false; });
  }

  function pushActiveToPage(force) {
    var active = shouldIntercept();
    if (!force && active === activePushed) return;
    activePushed = active;
    try {
      window.postMessage({ __gqlop: true, source: GQLOP.SRC_CONTENT, type: GQLOP.P_ACTIVE, payload: { active: active } }, '*');
    } catch (e) { /* ignore */ }
  }

  function setPanelAttached(v) {
    panelAttached = !!v;
    pushActiveToPage(false);
  }

  function loadRules() {
    try {
      chrome.storage.local.get(GQLOP.STORAGE_RULES, function (res) {
        if (chrome.runtime.lastError) return;
        rulesCache = (res && res[GQLOP.STORAGE_RULES]) || [];
        pushRulesToPage();
        pushActiveToPage(false); // an enabled rule is reason enough to hook
      });
    } catch (e) { /* extension context invalidated */ }
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[GQLOP.STORAGE_RULES]) {
        rulesCache = changes[GQLOP.STORAGE_RULES].newValue || [];
        pushRulesToPage();
        pushActiveToPage(false);
      }
    });
  } catch (e) { /* ignore */ }

  loadRules();

  // ---- page messages -> background --------------------------------------
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__gqlop !== true || d.source !== GQLOP.SRC_PAGE) return;

    if (d.type === GQLOP.P_READY) {
      pushRulesToPage();
      pushActiveToPage(true); // the page just (re)loaded — always state it explicitly
      return;
    }
    if (d.type === GQLOP.P_RECORD) {
      send({ type: GQLOP.M_RECORD, record: d.payload });
    } else if (d.type === GQLOP.P_RECORD_UPDATE) {
      send({ type: GQLOP.M_RECORD_UPDATE, id: d.payload.id, patch: d.payload.patch });
    } else if (d.type === GQLOP.P_RESEND_RESULT) {
      send({ type: GQLOP.M_RESEND_RESULT, payload: d.payload });
    }
  });

  // ---- background port ---------------------------------------------------
  function connect() {
    if (!contextValid()) return;
    try {
      port = chrome.runtime.connect({ name: GQLOP.PORT_CONTENT });
    } catch (e) {
      port = null;
      return;
    }
    try { port.postMessage({ type: GQLOP.M_HELLO, docId: docId }); } catch (e) { /* ignore */ }
    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === GQLOP.M_RESEND) {
        try {
          window.postMessage({ __gqlop: true, source: GQLOP.SRC_CONTENT, type: GQLOP.P_RESEND, payload: msg.payload }, '*');
        } catch (e) { /* ignore */ }
      } else if (msg.type === GQLOP.M_PANEL_STATE) {
        setPanelAttached(msg.attached);
      }
    });
    port.onDisconnect.addListener(function () {
      port = null;
      // Reconnect only while the extension is still installed/enabled.
      if (contextValid()) setTimeout(connect, 500);
    });
  }

  function send(msg) {
    if (!port) connect();
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      connect();
      if (port) { try { port.postMessage(msg); } catch (e2) { /* dropped */ } }
    }
  }

  connect();
})();
