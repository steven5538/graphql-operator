/*
 * injected.js — runs in the page's MAIN world at document_start.
 *
 * Patches window.fetch and XMLHttpRequest so every GraphQL operation can be:
 *   - recorded (operation name/type, request, response, timing),
 *   - blocked  (synthetic GraphQL-error response) via a persistent rule,
 *   - rewritten (query / variables / headers) via a persistent rule,
 *   - resent   (replayed, optionally modified) on demand from the panel.
 *
 * It cannot use chrome.* APIs (wrong world), so it talks to content-bridge.js
 * exclusively through window.postMessage, tagged with GQLOP.SRC_PAGE.
 */
(function () {
  'use strict';
  if (window.__GQLOP_INSTALLED__) return;
  window.__GQLOP_INSTALLED__ = true;

  // Constants are INLINED here (not read from lib/protocol.js). In the
  // `world: "MAIN"` content-script entry, sibling files do not reliably share
  // scope, so relying on a protocol.js global caused "GQLOP is not defined".
  // These postMessage tags MUST stay in sync with src/lib/protocol.js.
  var GQLOP = {
    SRC_PAGE: 'gqlop-page',
    SRC_CONTENT: 'gqlop-content',
    P_READY: 'ready',
    P_RECORD: 'record',
    P_RECORD_UPDATE: 'record-update',
    P_RESEND_RESULT: 'resend-result',
    P_RULES: 'rules-update',
    P_RESEND: 'resend'
  };

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var perfNow = (window.performance && performance.now)
    ? performance.now.bind(performance)
    : function () { return Date.now(); };

  // Opt-in logging: run `localStorage.GQLOP_DEBUG = '1'` in the page console, then reload.
  var DEBUG = false;
  try { DEBUG = !!(window.localStorage && window.localStorage.getItem('GQLOP_DEBUG')); } catch (e) {}
  function debug() {
    if (!DEBUG) return;
    try { console.debug.apply(console, ['%c[GraphQL Operator]', 'color:#e535ab;font-weight:bold'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // Headers the browser forbids setting on fetch/XHR; dropping them avoids errors on resend.
  var FORBIDDEN_HEADERS = {
    'accept-charset': 1, 'accept-encoding': 1, 'access-control-request-headers': 1,
    'access-control-request-method': 1, 'connection': 1, 'content-length': 1, 'cookie': 1,
    'cookie2': 1, 'date': 1, 'dnt': 1, 'expect': 1, 'host': 1, 'keep-alive': 1, 'origin': 1,
    'referer': 1, 'te': 1, 'trailer': 1, 'transfer-encoding': 1, 'upgrade': 1, 'via': 1
  };

  var MAX_BODY = 512 * 1024; // cap stored RESPONSE bodies at 512 KB (display only)
  var MAX_REQ_BODY = 5 * 1024 * 1024; // request bodies kept intact up to 5 MB so resend is faithful
  var counter = 0;

  function genId() {
    counter += 1;
    return 'op_' + Date.now().toString(36) + '_' + counter + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---- rule state (populated by content-bridge.js via P_RULES on load) ----
  // Rules are delivered by postMessage shortly after document_start; requests
  // that fire in that brief window before rules arrive are recorded but not
  // subject to block/rewrite rules.
  var rules = [];

  // ---- messaging to the content bridge -----------------------------------
  function postToContent(type, payload) {
    try {
      window.postMessage({ __gqlop: true, source: GQLOP.SRC_PAGE, type: type, payload: payload }, '*');
    } catch (e) { /* payload not cloneable — ignore */ }
  }
  function postRecord(rec) { postToContent(GQLOP.P_RECORD, rec); }
  function postUpdate(id, patch) { postToContent(GQLOP.P_RECORD_UPDATE, { id: id, patch: patch }); }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__gqlop !== true || d.source !== GQLOP.SRC_CONTENT) return;
    if (d.type === GQLOP.P_RULES) {
      rules = Array.isArray(d.payload) ? d.payload : [];
    } else if (d.type === GQLOP.P_RESEND) {
      doResend(d.payload);
    }
  });

  postToContent(GQLOP.P_READY, {});

  // ---- helpers -----------------------------------------------------------
  function truncate(text) {
    if (typeof text !== 'string') return text;
    if (text.length <= MAX_BODY) return text;
    return text.slice(0, MAX_BODY) + '\n…[truncated ' + (text.length - MAX_BODY) + ' bytes]';
  }

  // Request bodies are needed intact for faithful resend, so they are only
  // clipped at a much higher limit and the record is flagged when that happens.
  function reqBody(text) {
    if (typeof text !== 'string') return { body: text, truncated: false };
    if (text.length <= MAX_REQ_BODY) return { body: text, truncated: false };
    return { body: text.slice(0, MAX_REQ_BODY), truncated: true };
  }

  function headersToObject(headers) {
    var out = {};
    try {
      if (headers && typeof headers.forEach === 'function') {
        headers.forEach(function (v, k) { out[k] = v; });
      } else if (headers && typeof headers === 'object') {
        Object.keys(headers).forEach(function (k) { out[k] = headers[k]; });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function parseOperationInfo(query, explicitName) {
    var operationType = 'query';
    var operationName = explicitName || null;
    if (typeof query === 'string' && query.length) {
      var m = query.match(/(^|[\s{])(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/);
      if (m) {
        operationType = m[2];
        if (!operationName && m[3]) operationName = m[3];
      }
    }
    return { operationName: operationName || '(anonymous)', operationType: operationType };
  }

  // Returns { isGraphQL, isBatch, entries:[{operationName, operationType, query, variables, persisted}] }
  function analyzeJsonBody(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return { isGraphQL: false };
    var trimmed = bodyText.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return { isGraphQL: false };
    var json;
    try { json = JSON.parse(trimmed); } catch (e) { return { isGraphQL: false }; }
    var arr = Array.isArray(json) ? json : [json];
    var entries = [];
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!item || typeof item !== 'object') return { isGraphQL: false };
      var hasQuery = typeof item.query === 'string';
      var hasPersisted = item.extensions && item.extensions.persistedQuery;
      if (!hasQuery && !hasPersisted && typeof item.operationName !== 'string') return { isGraphQL: false };
      var info = parseOperationInfo(item.query, item.operationName);
      entries.push({
        operationName: info.operationName,
        operationType: info.operationType,
        query: hasQuery ? item.query : null,
        variables: item.variables,
        persisted: !hasQuery && !!hasPersisted
      });
    }
    if (!entries.length) return { isGraphQL: false };
    return { isGraphQL: true, isBatch: Array.isArray(json), entries: entries, json: json };
  }

  function summarizeOps(entries) {
    var names = entries.map(function (e) { return e.operationName; });
    if (names.length === 1) return names[0];
    return 'Batch(' + names.length + '): ' + names.join(', ');
  }

  // ---- rule matching / application ---------------------------------------
  function ruleMatchesEntry(rule, entry, url, method) {
    if (!rule || rule.enabled === false) return false;
    var mm = rule.match || {};
    var hasCond = false;
    if (mm.operationName) { hasCond = true; if (mm.operationName !== entry.operationName) return false; }
    if (mm.nameRegex) {
      hasCond = true;
      try { if (!new RegExp(mm.nameRegex).test(entry.operationName)) return false; } catch (e) { return false; }
    }
    if (mm.operationType) { hasCond = true; if (mm.operationType !== entry.operationType) return false; }
    if (mm.method) { hasCond = true; if (!method || mm.method.toUpperCase() !== String(method).toUpperCase()) return false; }
    if (mm.urlContains) { hasCond = true; if (!url || url.indexOf(mm.urlContains) === -1) return false; }
    if (!hasCond) return false; // never match "everything"
    return true;
  }

  function anyEntryMatches(rule, analysis, url, method) {
    for (var e = 0; e < analysis.entries.length; e++) {
      if (ruleMatchesEntry(rule, analysis.entries[e], url, method)) return true;
    }
    return false;
  }

  function resolveOverride(rule) {
    var ov = rule.override || {};
    var status = +ov.status || 200;
    var body = ov.body;
    if ((body == null || body === '') && ov.errorMessage) {
      body = JSON.stringify({ data: null, errors: [{ message: ov.errorMessage, extensions: { gqlOperatorOverride: true } }] });
    }
    if (body == null) body = '';
    return { status: status, body: body, ruleId: rule.id };
  }

  // Decide fate of a request.
  function evaluate(analysis, url, method) {
    // block wins over everything; a batch is blocked whole if ANY entry matches
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].type === 'block' && anyEntryMatches(rules[i], analysis, url, method)) {
        return { block: true, blockRule: rules[i], rewrittenJson: null, delayMs: 0, override: null };
      }
    }

    // delay: hold the request for the longest matching delay rule
    var delayMs = 0;
    for (var d = 0; d < rules.length; d++) {
      if (rules[d].type === 'delay' && anyEntryMatches(rules[d], analysis, url, method)) {
        delayMs = Math.max(delayMs, +rules[d].delayMs || 0);
      }
    }

    // override: return a canned response instead of hitting the server
    for (var o = 0; o < rules.length; o++) {
      if (rules[o].type === 'override' && anyEntryMatches(rules[o], analysis, url, method)) {
        return { block: false, override: resolveOverride(rules[o]), overrideRule: rules[o], rewrittenJson: null, delayMs: delayMs };
      }
    }

    var changed = false;
    var json = analysis.json;
    var arr = Array.isArray(json) ? json : [json];
    var headerOps = null; // { set:{}, remove:[] }
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      if (rule.type !== 'rewrite' || !rule.rewrite) continue;
      for (var k = 0; k < arr.length; k++) {
        if (!ruleMatchesEntry(rule, analysis.entries[k], url, method)) continue;
        var rw = rule.rewrite;
        if (typeof rw.query === 'string' && rw.query.length) { arr[k].query = rw.query; changed = true; }
        if (rw.variables && rw.variables.mode) {
          if (rw.variables.mode === 'replace') {
            arr[k].variables = clone(rw.variables.value);
          } else { // merge
            arr[k].variables = Object.assign({}, arr[k].variables || {}, rw.variables.value || {});
          }
          changed = true;
        }
        if (rw.headers && (rw.headers.set || rw.headers.remove)) {
          headerOps = headerOps || { set: {}, remove: [] };
          if (rw.headers.set) Object.assign(headerOps.set, rw.headers.set);
          if (rw.headers.remove) headerOps.remove = headerOps.remove.concat(rw.headers.remove);
        }
      }
    }
    return {
      block: false,
      blockRule: null,
      override: null,
      rewrittenJson: changed ? json : null,
      headerOps: headerOps,
      ruleTouched: changed || !!headerOps,
      delayMs: delayMs
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }

  function blockedResponse(names, ruleId) {
    var body = JSON.stringify({
      data: null,
      errors: [{
        message: 'Blocked by GraphQL Operator',
        extensions: { gqlOperatorBlocked: true, operationName: names, ruleId: ruleId || null }
      }]
    });
    return new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-gqlop-blocked': '1' }
    });
  }

  function overrideResponse(ov) {
    var headers = { 'content-type': 'application/json', 'x-gqlop-override': '1' };
    try { return new Response(ov.body, { status: ov.status, headers: headers }); }
    catch (e) { // out-of-range status, or null-body status (204/304) with a body
      try { return new Response(ov.body, { status: 200, headers: headers }); }
      catch (e2) { return new Response(ov.body || '', { headers: headers }); }
    }
  }

  function applyHeaderOps(headers, headerOps) {
    if (!headerOps) return headers;
    var h = new Headers(headers);
    if (headerOps.set) Object.keys(headerOps.set).forEach(function (k) { h.set(k, headerOps.set[k]); });
    if (headerOps.remove) headerOps.remove.forEach(function (k) { h.delete(k); });
    return h;
  }

  // ======================================================================
  //  fetch patch
  // ======================================================================
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        return handleFetch(input, init);
      } catch (e) {
        return origFetch(input, init); // fail open: never break the page
      }
    };
  }

  function handleFetch(input, init) {
    // Cheap method check first so we don't touch bodies of non-POST requests.
    var method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (method !== 'POST') return origFetch(input, init);

    var req;
    try { req = new Request(input, init); } catch (e) { return origFetch(input, init); }
    // IMPORTANT: constructing `req` may disturb a Request-object `input`'s body,
    // so every send below goes through `req` (or a fresh init) — never `input`/`init`.

    var url = req.url;
    var contentType = req.headers.get('content-type') || '';
    var isMultipart = contentType.toLowerCase().indexOf('multipart/form-data') !== -1;

    if (isMultipart) {
      // graphql-multipart-request-spec: FormData with an "operations" JSON field.
      return req.clone().formData().then(function (fd) {
        try {
          var opsRaw = fd.get('operations');
          var analysis = (typeof opsRaw === 'string') ? analyzeJsonBody(opsRaw) : { isGraphQL: false };
          if (!analysis.isGraphQL) return origFetch(req);
          var decision = evaluate(analysis, url, method);
          var id = genId();
          var meta = baseMeta(id, analysis, url, method, req, contentType, true);
          postRecord(meta);
          debug('multipart op', meta.operationName);
          if (decision.block) {
            postUpdate(id, { status: '(blocked)', blocked: true, ruleId: decision.blockRule && decision.blockRule.id, durationMs: 0 });
            return blockedResponse(meta.operationName, decision.blockRule && decision.blockRule.id);
          }
          if (decision.override) return doOverride(id, decision, meta.operationName);
          return sendAndRecord(origFetch(req), id, perfNow());
        } catch (e) { debug('multipart handler error', e); return origFetch(req); }
      }, function () { return origFetch(req); });
    }

    return req.clone().text().then(function (bodyText) {
      try {
        var analysis = analyzeJsonBody(bodyText);
        if (!analysis.isGraphQL) return origFetch(req);

        var decision = evaluate(analysis, url, method);
        var id = genId();
        var meta = baseMeta(id, analysis, url, method, req, contentType, false);
        var rb = reqBody(bodyText);
        meta.requestBody = rb.body;
        meta.requestBodyTruncated = rb.truncated;
        postRecord(meta);
        debug('fetch op', meta.operationName, url);

        if (decision.block) {
          postUpdate(id, {
            status: '(blocked)', blocked: true,
            ruleId: decision.blockRule && decision.blockRule.id, durationMs: 0
          });
          return blockedResponse(meta.operationName, decision.blockRule && decision.blockRule.id);
        }

        if (decision.override) return doOverride(id, decision, meta.operationName);

        var sender;
        if (decision.ruleTouched) {
          // Reconstruct the request with rewritten body/headers.
          var newBody = decision.rewrittenJson ? JSON.stringify(decision.rewrittenJson) : bodyText;
          var newHeaders = applyHeaderOps(req.headers, decision.headerOps);
          var newInit = {
            method: method, headers: newHeaders, body: newBody,
            credentials: req.credentials, mode: req.mode === 'navigate' ? 'cors' : req.mode,
            cache: req.cache, redirect: req.redirect, referrerPolicy: req.referrerPolicy,
            integrity: req.integrity, keepalive: req.keepalive, signal: req.signal
          };
          if (req.referrer && req.referrer !== 'about:client') newInit.referrer = req.referrer;
          var rbn = reqBody(newBody);
          var patch = { rewritten: true, requestBody: rbn.body, requestBodyTruncated: rbn.truncated };
          if (decision.rewrittenJson) {
            var reAnalyzed = analyzeJsonBody(newBody);
            if (reAnalyzed.isGraphQL) patch.entries = reAnalyzed.entries; // keep detail view in sync
          }
          postUpdate(id, patch);
          sender = function () { return sendAndRecord(origFetch(url, newInit), id, perfNow()); };
        } else {
          sender = function () { return sendAndRecord(origFetch(req), id, perfNow()); };
        }

        if (decision.delayMs > 0) {
          postUpdate(id, { delayedMs: decision.delayMs });
          debug('delaying', meta.operationName, decision.delayMs + 'ms');
          return sleep(decision.delayMs).then(sender);
        }
        return sender();
      } catch (e) {
        // Our processing failed — send the original unchanged. (Do NOT catch a
        // rejection from the real fetch here, or we'd silently re-send it.)
        debug('fetch handler error', e);
        return origFetch(req);
      }
    }, function () { return origFetch(req); });
  }

  function baseMeta(id, analysis, url, method, req, contentType, isMultipart) {
    return {
      id: id,
      transport: 'fetch',
      operationName: summarizeOps(analysis.entries),
      operationType: analysis.entries.length === 1 ? analysis.entries[0].operationType : 'batch',
      isBatch: !!analysis.isBatch,
      entries: analysis.entries,
      url: url,
      method: method,
      contentType: contentType,
      multipart: !!isMultipart,
      requestHeaders: headersToObject(req.headers),
      credentials: req.credentials, // preserved so resend can replay faithfully
      isResent: false,
      blocked: false,
      status: '(pending)',
      ts: Date.now()
    };
  }

  function sendAndRecord(fetchPromise, id, started) {
    return fetchPromise.then(function (resp) {
      var durationMs = perfNow() - started;
      try {
        resp.clone().text().then(function (txt) {
          postUpdate(id, {
            status: resp.status,
            statusText: resp.statusText,
            ok: resp.ok,
            responseHeaders: headersToObject(resp.headers),
            responseBody: truncate(txt),
            durationMs: durationMs
          });
        }).catch(function () {
          postUpdate(id, { status: resp.status, ok: resp.ok, durationMs: durationMs, responseBody: '[unreadable body]' });
        });
      } catch (e) {
        postUpdate(id, { status: resp.status, ok: resp.ok, durationMs: durationMs });
      }
      return resp;
    }, function (err) {
      postUpdate(id, { status: '(failed)', error: String(err && err.message || err), durationMs: perfNow() - started });
      throw err;
    });
  }

  // Return a canned (mocked) response instead of hitting the server.
  function doOverride(id, decision, opName) {
    var ov = decision.override;
    var fire = function () {
      postUpdate(id, {
        status: ov.status, ok: ov.status >= 200 && ov.status < 300,
        responseHeaders: { 'content-type': 'application/json', 'x-gqlop-override': '1' },
        responseBody: truncate(ov.body), overridden: true, ruleId: ov.ruleId, durationMs: decision.delayMs || 0
      });
      debug('override', opName, ov.status);
      return overrideResponse(ov);
    };
    if (decision.delayMs > 0) { postUpdate(id, { delayedMs: decision.delayMs }); return sleep(decision.delayMs).then(fire); }
    return fire();
  }

  // ======================================================================
  //  XMLHttpRequest patch (legacy clients; fetch is the common path)
  // ======================================================================
  var XProto = XMLHttpRequest.prototype;
  var origOpen = XProto.open;
  var origSend = XProto.send;
  var origSetHeader = XProto.setRequestHeader;

  XProto.open = function (method, url) {
    this.__gqlop = { method: (method || 'GET').toUpperCase(), url: String(url), headers: {} };
    return origOpen.apply(this, arguments);
  };

  XProto.setRequestHeader = function (name, value) {
    if (this.__gqlop) this.__gqlop.headers[name] = value;
    return origSetHeader.apply(this, arguments);
  };

  XProto.send = function (body) {
    var info = this.__gqlop;
    var modifiedBody = null; // set only when we actually rewrite the body
    var delayMs = 0;
    try {
      if (info && info.method === 'POST' && typeof body === 'string') {
        var analysis = analyzeJsonBody(body);
        if (analysis.isGraphQL) {
          var decision = evaluate(analysis, info.url, info.method);
          var id = genId();
          var rb = reqBody(body); // compute once
          var meta = {
            id: id, transport: 'xhr', operationName: summarizeOps(analysis.entries),
            operationType: analysis.entries.length === 1 ? analysis.entries[0].operationType : 'batch',
            isBatch: !!analysis.isBatch, entries: analysis.entries, url: info.url, method: 'POST',
            requestHeaders: info.headers, requestBody: rb.body, requestBodyTruncated: rb.truncated,
            credentials: this.withCredentials ? 'include' : 'same-origin',
            isResent: false, blocked: false, status: '(pending)', ts: Date.now()
          };
          postRecord(meta);
          debug('xhr op', meta.operationName, info.url);

          if (decision.block) {
            postUpdate(id, { status: '(blocked)', blocked: true, ruleId: decision.blockRule && decision.blockRule.id, durationMs: 0 });
            var self = this;
            setTimeout(function () {
              try { self.dispatchEvent(new Event('error')); self.dispatchEvent(new Event('loadend')); } catch (e) {}
            }, 0);
            return; // do not send
          }

          if (decision.override) {
            // Best-effort XHR mock: shadow the native getters on this instance,
            // then fire the lifecycle events. (fetch overrides are exact.)
            var ovx = decision.override;
            postUpdate(id, {
              status: ovx.status, ok: ovx.status >= 200 && ovx.status < 300,
              responseBody: truncate(ovx.body), overridden: true, ruleId: ovx.ruleId,
              durationMs: decision.delayMs || 0, delayedMs: decision.delayMs || undefined
            });
            var xo = this;
            var fireOv = function () {
              try {
                Object.defineProperty(xo, 'readyState', { configurable: true, get: function () { return 4; } });
                Object.defineProperty(xo, 'status', { configurable: true, get: function () { return ovx.status; } });
                Object.defineProperty(xo, 'responseText', { configurable: true, get: function () { return ovx.body; } });
                Object.defineProperty(xo, 'response', { configurable: true, get: function () { return ovx.body; } });
                xo.dispatchEvent(new Event('readystatechange'));
                xo.dispatchEvent(new Event('load'));
                xo.dispatchEvent(new Event('loadend'));
              } catch (e) { debug('xhr override error', e); }
            };
            setTimeout(fireOv, decision.delayMs || 0);
            return; // do not send
          }

          // XHR can only rewrite the BODY reliably (setRequestHeader appends and
          // cannot remove/replace), so header-only rewrites are NOT applied here.
          if (decision.ruleTouched && decision.rewrittenJson) {
            modifiedBody = JSON.stringify(decision.rewrittenJson);
            var rbn = reqBody(modifiedBody);
            var patch = { rewritten: true, requestBody: rbn.body, requestBodyTruncated: rbn.truncated };
            var reAnalyzed = analyzeJsonBody(modifiedBody);
            if (reAnalyzed.isGraphQL) patch.entries = reAnalyzed.entries;
            postUpdate(id, patch);
          }

          if (decision.delayMs > 0) { delayMs = decision.delayMs; postUpdate(id, { delayedMs: delayMs }); }

          var started = perfNow();
          var xhr = this;
          this.addEventListener('loadend', function () {
            var txt = '';
            try { txt = (xhr.responseType === '' || xhr.responseType === 'text') ? xhr.responseText : '[non-text response]'; } catch (e) { txt = '[unreadable body]'; }
            postUpdate(id, { status: xhr.status || '(failed)', ok: xhr.status >= 200 && xhr.status < 300, responseBody: truncate(txt), durationMs: perfNow() - started });
          });
        }
      }
    } catch (e) { debug('xhr handler error', e); }
    // Send the rewritten body explicitly (strict mode decouples `arguments`
    // from the `body` param, so `origSend.apply(this, arguments)` would send
    // the ORIGINAL body).
    var finalBody = (modifiedBody !== null) ? modifiedBody : body;
    if (delayMs > 0) {
      var selfX = this;
      setTimeout(function () { try { origSend.call(selfX, finalBody); } catch (e) {} }, delayMs);
      return; // held until the delay elapses
    }
    if (modifiedBody !== null) return origSend.call(this, finalBody);
    return origSend.apply(this, arguments);
  };

  // ======================================================================
  //  Resend (triggered from the panel)
  // ======================================================================
  function doResend(payload) {
    if (!origFetch || !payload) return;
    var reqId = payload.reqId;
    var url = payload.url;
    var method = (payload.method || 'POST').toUpperCase();
    var body = payload.body;
    var headersIn = payload.headers || { 'content-type': 'application/json' };
    // Replay with the original request's credentials mode rather than always
    // forcing cookies; default to same-origin when unknown.
    var credentials = payload.credentials || 'same-origin';

    // Strip forbidden headers so the browser doesn't reject the fetch.
    var headers = new Headers();
    Object.keys(headersIn).forEach(function (k) {
      if (!FORBIDDEN_HEADERS[k.toLowerCase()]) {
        try { headers.set(k, headersIn[k]); } catch (e) {}
      }
    });
    if (!headers.has('content-type') && method !== 'GET') headers.set('content-type', 'application/json');

    var analysis = analyzeJsonBody(body);
    var entries = analysis.isGraphQL ? analysis.entries : [{ operationName: '(resend)', operationType: 'query' }];
    var id = genId();
    postRecord({
      id: id, transport: 'fetch', operationName: summarizeOps(entries),
      operationType: entries.length === 1 ? entries[0].operationType : 'batch',
      isBatch: entries.length > 1, entries: entries, url: url, method: method,
      requestHeaders: headersToObject(headers), requestBody: reqBody(body).body, requestBodyTruncated: reqBody(body).truncated,
      isResent: true, resendOf: reqId, blocked: false, credentials: credentials, status: '(pending)', ts: Date.now()
    });

    var started = perfNow();
    var init = { method: method, headers: headers, credentials: credentials };
    if (method !== 'GET' && method !== 'HEAD') init.body = body;

    origFetch(url, init).then(function (resp) {
      return resp.clone().text().then(function (txt) {
        postUpdate(id, {
          status: resp.status, statusText: resp.statusText, ok: resp.ok,
          responseHeaders: headersToObject(resp.headers), responseBody: truncate(txt),
          durationMs: perfNow() - started
        });
        postToContent(GQLOP.P_RESEND_RESULT, { reqId: reqId, id: id, ok: true });
      });
    }).catch(function (err) {
      postUpdate(id, { status: '(failed)', error: String(err && err.message || err), durationMs: perfNow() - started });
      postToContent(GQLOP.P_RESEND_RESULT, { reqId: reqId, id: id, ok: false, error: String(err && err.message || err) });
    });
  }

  debug('interceptor installed on', location.href, '· fetch patched:', !!origFetch);
})();
