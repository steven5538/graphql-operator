/*
 * Shared constants used across every context of the extension:
 * the main-world interceptor, the isolated-world content bridge, the
 * background service worker, and the DevTools panel / popup pages.
 *
 * This file is loaded into four different JS realms (MAIN-world content
 * script, ISOLATED-world content script, service worker via importScripts,
 * and extension pages via <script>). Content-script files are function-scoped,
 * so a bare `var GQLOP` would NOT be visible to sibling files as a bare
 * identifier. We therefore assign GQLOP onto the shared global object
 * explicitly — bare `GQLOP` references in the other files then resolve to it
 * via the scope chain in every realm.
 */
(function (glob) {
  if (glob.GQLOP) return; // idempotent across double-injection
  glob.GQLOP = {
    // ---- window.postMessage tags (page main world <-> content bridge) ----
    SRC_PAGE: 'gqlop-page', // messages originating in the injected interceptor
    SRC_CONTENT: 'gqlop-content', // messages originating in the content bridge

    // page -> content bridge
    P_READY: 'ready',
    P_RECORD: 'record',
    P_RECORD_UPDATE: 'record-update',
    P_RESEND_RESULT: 'resend-result',

    // content bridge -> page
    P_RULES: 'rules-update',
    P_RESEND: 'resend',

    // ---- runtime port names ----
    PORT_CONTENT: 'gqlop-content-port', // content bridge <-> background
    PORT_DEVTOOLS: 'gqlop-devtools-port', // DevTools panel <-> background

    // ---- messages carried over the ports ----
    M_HELLO: 'hello', // content -> bg: announce doc load (docId) to detect real navigations
    M_INIT: 'init', // devtools -> bg: announce inspected tabId
    M_RECORD: 'record', // content -> bg -> devtools: a new operation
    M_RECORD_UPDATE: 'record-update', // content -> bg -> devtools: patch existing op by id
    M_RESEND: 'resend', // devtools -> bg -> content: replay a request
    M_RESEND_RESULT: 'resend-result', // content -> bg -> devtools: replay outcome
    M_BUFFER: 'buffer', // bg -> devtools: replay of buffered events on connect
    M_CLEAR_BUFFER: 'clear-buffer', // bg -> devtools: inspected page navigated

    // ---- chrome.storage keys ----
    STORAGE_RULES: 'gqlop_rules',
    STORAGE_SETTINGS: 'gqlop_settings'
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
