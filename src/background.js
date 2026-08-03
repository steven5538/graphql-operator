/*
 * background.js — MV3 service worker.
 *
 * Routes messages between content bridges (one per FRAME of each inspected
 * page) and DevTools panels (one per inspected tab). It:
 *   - buffers recorded operations per tab so a panel opened late still sees
 *     recent history,
 *   - forwards live records/updates to the matching panel,
 *   - routes resend commands from a panel back to the exact frame that made
 *     the original request,
 *   - clears history only on a genuine top-frame navigation (detected via a
 *     per-document id), NOT on a mere port reconnect after SW idle.
 *
 * Rules are NOT handled here — content bridges and panels read/write
 * chrome.storage directly and react to storage.onChanged.
 */
importScripts(chrome.runtime.getURL('src/lib/protocol.js'));

var BUFFER_MAX = 1000;
// tabId -> { contentByFrame: Map<frameId,Port>, devtools: Port|null, buffer: [], docId: string|null }
var tabs = new Map();

function entryFor(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { contentByFrame: new Map(), devtools: null, buffer: [], docId: null });
  return tabs.get(tabId);
}

function post(port, msg) {
  if (!port) return;
  try { port.postMessage(msg); } catch (e) { /* port closed */ }
}

function pushBuffer(entry, event) {
  entry.buffer.push(event);
  if (entry.buffer.length > BUFFER_MAX) entry.buffer.shift();
}

// The page only patches fetch/XHR while something needs it (see injected.js), so
// every frame of a tab has to be told when a panel starts or stops watching.
function broadcastPanelState(entry) {
  var attached = !!entry.devtools;
  entry.contentByFrame.forEach(function (p) { post(p, { type: GQLOP.M_PANEL_STATE, attached: attached }); });
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === GQLOP.PORT_CONTENT) handleContent(port);
  else if (port.name === GQLOP.PORT_DEVTOOLS) handleDevtools(port);
});

function handleContent(port) {
  var sender = port.sender || {};
  var tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  var frameId = sender.frameId || 0;
  var entry = entryFor(tabId);
  entry.contentByFrame.set(frameId, port);
  // Answer immediately: a frame starting up must learn whether to hook at all.
  post(port, { type: GQLOP.M_PANEL_STATE, attached: !!entry.devtools });

  port.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === GQLOP.M_HELLO) {
      // Only the top frame drives history reset, and only when the document id
      // actually changes (real navigation). A reconnect after SW idle reuses
      // the same docId, so the open panel keeps its history.
      if (frameId === 0) {
        if (entry.docId != null && entry.docId !== msg.docId) {
          entry.buffer = [];
          post(entry.devtools, { type: GQLOP.M_CLEAR_BUFFER });
        }
        entry.docId = msg.docId;
      }
    } else if (msg.type === GQLOP.M_RECORD) {
      if (msg.record) msg.record.frameId = frameId; // so resend can target this frame
      pushBuffer(entry, { kind: 'record', record: msg.record });
      post(entry.devtools, { type: GQLOP.M_RECORD, record: msg.record });
    } else if (msg.type === GQLOP.M_RECORD_UPDATE) {
      pushBuffer(entry, { kind: 'update', id: msg.id, patch: msg.patch });
      post(entry.devtools, { type: GQLOP.M_RECORD_UPDATE, id: msg.id, patch: msg.patch });
    } else if (msg.type === GQLOP.M_RESEND_RESULT) {
      post(entry.devtools, { type: GQLOP.M_RESEND_RESULT, payload: msg.payload });
    }
  });

  port.onDisconnect.addListener(function () {
    if (entry.contentByFrame.get(frameId) === port) entry.contentByFrame.delete(frameId);
  });
}

function handleDevtools(port) {
  var tabId = null;

  port.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === GQLOP.M_INIT) {
      tabId = msg.tabId;
      var entry = entryFor(tabId);
      entry.devtools = port;
      post(port, { type: GQLOP.M_BUFFER, events: entry.buffer });
      broadcastPanelState(entry); // wake the interceptor in the inspected page
    } else if (msg.type === GQLOP.M_RESEND) {
      var e = entryFor(msg.tabId != null ? msg.tabId : tabId);
      var fid = (msg.payload && msg.payload.frameId) || 0;
      var target = e.contentByFrame.get(fid) || e.contentByFrame.get(0);
      if (!target) { var first = e.contentByFrame.values().next(); target = first && first.value; }
      if (target) {
        post(target, { type: GQLOP.M_RESEND, payload: msg.payload });
      } else {
        post(port, {
          type: GQLOP.M_RESEND_RESULT,
          payload: { reqId: msg.payload && msg.payload.reqId, ok: false, error: 'No page connection — reload the inspected tab and try again.' }
        });
      }
    } else if (msg.type === GQLOP.M_CLEAR_BUFFER) {
      if (tabId != null) entryFor(tabId).buffer = [];
    }
  });

  port.onDisconnect.addListener(function () {
    if (tabId != null) {
      var entry = tabs.get(tabId);
      if (entry && entry.devtools === port) {
        entry.devtools = null;
        broadcastPanelState(entry); // nothing is watching — let the page unhook
      }
    }
  });
}

// Tidy up state when a tab is closed.
chrome.tabs.onRemoved.addListener(function (tabId) {
  tabs.delete(tabId);
});
