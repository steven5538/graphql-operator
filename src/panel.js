/*
 * panel.js — the DevTools "GraphQL" panel.
 *
 * Connects to the background service worker, renders recorded operations,
 * and drives the right-click actions (resend / modify / block / rewrite).
 * All dynamic text is set via textContent — response bodies are never
 * injected as HTML.
 */
(function () {
  'use strict';

  var tabId = chrome.devtools.inspectedWindow.tabId;

  // ---- state -------------------------------------------------------------
  var records = [];              // ordered list of operation records
  var byId = Object.create(null); // id -> record
  var rowById = Object.create(null); // id -> <tr>
  var pendingPatches = Object.create(null); // id -> patch that arrived early
  var selectedId = null;
  var recording = true;
  var preserveLog = false;
  var filterText = '';
  var filterMode = 'all';
  var rules = [];
  var contextRecord = null;
  var editorRecord = null;
  var editorMode = 'single';
  var editorOrigBody = null;
  var editingRuleId = null;

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, props, children) {
    var e = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (props[k] == null) continue;
        if (k === 'class') e.className = props[k];
        else if (k === 'text') e.textContent = props[k];
        else if (k.slice(0, 2) === 'on' && typeof props[k] === 'function') e.addEventListener(k.slice(2), props[k]);
        else e.setAttribute(k, props[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function genId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fmtMs(ms) { ms = +ms || 0; if (ms >= 1000) { var s = ms / 1000; return (s % 1 === 0 ? s : s.toFixed(1)) + 's'; } return ms + 'ms'; }

  // ---- background port ---------------------------------------------------
  var port = null;
  var reconnectTimer = null;
  function connectPort() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (port) return; // already connected — never open a second port
    try { port = chrome.runtime.connect({ name: GQLOP.PORT_DEVTOOLS }); }
    catch (e) { port = null; scheduleReconnect(); return; }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(function () { port = null; scheduleReconnect(); });
    try { port.postMessage({ type: GQLOP.M_INIT, tabId: tabId }); } catch (e) { /* will retry */ }
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connectPort(); }, 500);
  }

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.type === GQLOP.M_BUFFER) {
      (msg.events || []).forEach(function (ev) {
        if (ev.kind === 'record') addRecord(ev.record, true);
        else if (ev.kind === 'update') patchRecord(ev.id, ev.patch);
      });
    } else if (msg.type === GQLOP.M_RECORD) {
      if (recording) addRecord(msg.record, false);
    } else if (msg.type === GQLOP.M_RECORD_UPDATE) {
      patchRecord(msg.id, msg.patch);
    } else if (msg.type === GQLOP.M_RESEND_RESULT) {
      onResendResult(msg.payload);
    } else if (msg.type === GQLOP.M_CLEAR_BUFFER) {
      if (!preserveLog) clearAll();
    }
  }

  function sendPort(msg) {
    if (!port) connectPort();
    if (!port) return;
    try { port.postMessage(msg); } catch (e) { port = null; connectPort(); if (port) { try { port.postMessage(msg); } catch (e2) {} } }
  }

  // ---- record model ------------------------------------------------------
  function addRecord(rec, fromBuffer) {
    if (byId[rec.id]) { patchRecord(rec.id, rec); return; }
    if (pendingPatches[rec.id]) { Object.assign(rec, pendingPatches[rec.id]); delete pendingPatches[rec.id]; }
    records.push(rec);
    byId[rec.id] = rec;
    indexDup(rec);
    // A late arrival can turn an earlier record into a duplicate, so settle the
    // dup state (and repaint whoever changed) before this record's own row.
    var reRendered = flushDupes();
    if (!reRendered && matchesFilter(rec)) appendRow(rec);
    updateCount();
    updateEmpty();
    updateChips();
    scheduleSearch();
  }

  function patchRecord(id, patch) {
    var rec = byId[id];
    if (!rec) { pendingPatches[id] = Object.assign(pendingPatches[id] || {}, patch); return; }
    Object.assign(rec, patch);
    delete searchFieldCache[id]; // body/headers may have changed — re-derive on next search
    indexDup(rec);               // a rewrite rule can change entries → new signature
    if (!flushDupes()) {
      if (rowById[id]) updateRowCells(rec);
      else if (matchesFilter(rec)) appendRow(rec);
    }
    if (selectedId === id) renderDetail(rec);
    updateChips();
    scheduleSearch();
  }

  function clearAll() {
    records = [];
    byId = Object.create(null);
    rowById = Object.create(null);
    pendingPatches = Object.create(null);
    searchFieldCache = Object.create(null);
    resetDupes();
    selectedId = null;
    $('op-rows').textContent = '';
    $('detail').classList.add('hidden');
    $('detail-empty').classList.remove('hidden');
    updateCount();
    updateEmpty();
    if (searchOpen) runSearch();
  }

  // ---- duplicate detection -----------------------------------------------
  // Flags identical calls (same URL, query and variables — see lib/dupes.js)
  // that landed within `dupWindowMs` of each other: usually a double-firing
  // effect or two components asking for the same thing.
  //
  // Records are bucketed by signature so a new arrival only re-clusters its own
  // bucket instead of rescanning the whole log on every request.
  var dupWindowMs = GQLDupes.DEFAULT_WINDOW_MS;
  var dupInfo = Object.create(null);    // id -> { size, index, gapMs, ids }
  var dupSig = Object.create(null);     // id -> signature
  var dupBuckets = Object.create(null); // signature -> [id]
  var dupDirty = Object.create(null);   // signature -> needs re-clustering
  var dupChanged = [];                  // ids whose dup state moved since the last flush
  var dupCount = 0;

  function resetDupes() {
    dupInfo = Object.create(null);
    dupSig = Object.create(null);
    dupBuckets = Object.create(null);
    dupDirty = Object.create(null);
    dupChanged = [];
    dupCount = 0;
  }

  function dropDupInfo(id) {
    if (!dupInfo[id]) return;
    delete dupInfo[id];
    dupCount--;
    dupChanged.push(id);
  }

  // Put a record in the right signature bucket (moving it if its payload changed).
  function indexDup(rec) {
    var sig = GQLDupes.eligible(rec) ? GQLDupes.signature(rec) : null;
    var old = dupSig[rec.id];
    // Same payload as last time (the common case — a status/response patch):
    // the clustering can't have moved, so don't dirty the bucket.
    if (old === sig) return;
    if (old) {
      var bucket = dupBuckets[old].filter(function (x) { return x !== rec.id; });
      if (bucket.length) { dupBuckets[old] = bucket; dupDirty[old] = true; }
      else { delete dupBuckets[old]; delete dupDirty[old]; }
      delete dupSig[rec.id];
      dropDupInfo(rec.id); // no longer in that cluster; re-clustering won't see it
    }
    if (sig) {
      dupSig[rec.id] = sig;
      (dupBuckets[sig] = dupBuckets[sig] || []).push(rec.id);
      dupDirty[sig] = true;
    }
  }

  // Re-cluster every dirty bucket and repaint the rows whose badge changed.
  // Returns true when it re-rendered the whole list (caller must not append).
  function flushDupes() {
    var sigs = Object.keys(dupDirty);
    dupDirty = Object.create(null);
    sigs.forEach(function (sig) {
      var ids = dupBuckets[sig] || [];
      var recs = ids.map(function (id) { return byId[id]; }).filter(Boolean);
      var fresh = Object.create(null);
      GQLDupes.cluster(recs, dupWindowMs).forEach(function (c) {
        if (c.length < 2) return;
        var part = GQLDupes.infoFor(c);
        Object.keys(part).forEach(function (id) { fresh[id] = part[id]; });
      });
      recs.forEach(function (r) {
        var was = dupInfo[r.id], now = fresh[r.id];
        if (!was && !now) return;
        if (was && now && was.size === now.size && was.index === now.index) { dupInfo[r.id] = now; return; }
        if (now) { if (!was) dupCount++; dupInfo[r.id] = now; }
        else { delete dupInfo[r.id]; dupCount--; }
        dupChanged.push(r.id);
      });
    });

    var changed = dupChanged;
    dupChanged = [];
    if (!changed.length) return false;
    // The open detail pane carries its own duplicate banner — refresh it first,
    // since the list rebuild below can return early.
    if (selectedId && changed.indexOf(selectedId) !== -1 && byId[selectedId]) renderDetail(byId[selectedId]);
    // In "Dupes" mode membership itself moved, so rebuild rather than trying to
    // splice newly-duplicate rows back into timeline order.
    if (filterMode === 'dupes') { reRenderList(); return true; }
    changed.forEach(function (id) { if (rowById[id] && byId[id]) updateRowCells(byId[id]); });
    return false;
  }

  // Window changed — every bucket has to be re-clustered.
  function recomputeDupes() {
    Object.keys(dupBuckets).forEach(function (sig) { dupDirty[sig] = true; });
    if (!flushDupes()) reRenderList();
    updateChips();
  }

  function dupTitle(d) {
    return d.size + ' identical calls within ' + fmtMs(dupWindowMs) + ' — this is #' + d.index +
      (d.gapMs != null ? ', ' + Math.round(d.gapMs) + ' ms after the previous one' : '');
  }

  // ---- filtering ---------------------------------------------------------
  function recHasError(rec) {
    if (rec.blocked || rec.status === '(failed)') return true;
    var n = typeof rec.status === 'number' ? rec.status : parseInt(rec.status, 10);
    if (!isNaN(n) && n >= 400) return true;
    return hasGraphQLErrors(rec);
  }
  // Panel-side mirror of the interceptor's rule matcher (for the "Ruled" chip).
  // ruleTargets ignores `enabled` on purpose: the context menu also has to find
  // a switched-off block rule, so it can re-arm that one instead of stacking a twin.
  function ruleTargets(rule, rec) {
    if (!rule) return false;
    var m = rule.match || {};
    var entries = rec.entries && rec.entries.length ? rec.entries : [{ operationName: rec.operationName, operationType: rec.operationType }];
    return entries.some(function (e) {
      var has = false;
      if (m.operationName) { has = true; if (m.operationName !== e.operationName) return false; }
      if (m.nameRegex) { has = true; try { if (!new RegExp(m.nameRegex).test(e.operationName)) return false; } catch (x) { return false; } }
      if (m.operationType) { has = true; if (m.operationType !== e.operationType) return false; }
      if (m.method) { has = true; if (!rec.method || m.method.toUpperCase() !== String(rec.method).toUpperCase()) return false; }
      if (m.urlContains) { has = true; if (!rec.url || rec.url.indexOf(m.urlContains) === -1) return false; }
      return has;
    });
  }
  function panelRuleMatches(rule, rec) { return !!rule && rule.enabled !== false && ruleTargets(rule, rec); }
  function recIsRuled(rec) { return rules.some(function (r) { return panelRuleMatches(r, rec); }); }

  function matchesFilter(rec) {
    if (filterMode === 'errors' && !recHasError(rec)) return false;
    if (filterMode === 'mutations' && rec.operationType !== 'mutation') return false;
    if (filterMode === 'ruled' && !recIsRuled(rec)) return false;
    if (filterMode === 'dupes' && !dupInfo[rec.id]) return false;
    if (!filterText) return true;
    var hay = (rec.operationName + ' ' + rec.operationType + ' ' + (rec.url || '') + ' ' + (rec.method || '') + ' ' + (rec.transport || '')).toLowerCase();
    return hay.indexOf(filterText) !== -1;
  }
  function updateChips() {
    var n = records.filter(recHasError).length;
    $('chip-errors-n').textContent = String(n);
    $('chip-dupes-n').textContent = String(dupCount);
  }

  function reRenderList() {
    var tbody = $('op-rows');
    tbody.textContent = '';
    rowById = Object.create(null);
    records.forEach(function (rec) { if (matchesFilter(rec)) appendRow(rec); });
    if (selectedId && rowById[selectedId]) rowById[selectedId].classList.add('selected');
    updateEmpty();
  }

  // ---- row rendering -----------------------------------------------------
  function appendRow(rec) {
    var tr = el('tr', { 'data-id': rec.id });
    tr.appendChild(el('td', { class: 'c-name op' }));
    tr.appendChild(el('td', { class: 'c-type' }));
    tr.appendChild(el('td', { class: 'c-status' }));
    tr.appendChild(el('td', { class: 'c-time' }));
    tr.appendChild(el('td', { class: 'c-when' }));
    tr.addEventListener('click', function () { selectRecord(rec.id); });
    tr.addEventListener('contextmenu', function (e) { e.preventDefault(); selectRecord(rec.id); showContextMenu(e.clientX, e.clientY, rec); });
    rowById[rec.id] = tr;
    $('op-rows').appendChild(tr);
    if (selectedId === rec.id) tr.classList.add('selected');
    updateRowCells(rec);
  }

  function statusInfo(rec) {
    if (rec.blocked || rec.status === '(blocked)') return { text: 'blocked', cls: 'blocked' };
    var s = rec.status;
    if (s == null || s === '(pending)') return { text: 'pending', cls: 'pending' };
    if (s === '(failed)') return { text: 'failed', cls: 'err' };
    var n = typeof s === 'number' ? s : parseInt(s, 10);
    if (!isNaN(n)) {
      if (n >= 200 && n < 300) {
        return hasGraphQLErrors(rec) ? { text: n + ' ⚠', cls: 'blocked' } : { text: String(n), cls: 'ok' };
      }
      return { text: String(n), cls: 'err' };
    }
    return { text: String(s), cls: '' };
  }

  function hasGraphQLErrors(rec) {
    if (!rec.responseBody) return false;
    try {
      var j = JSON.parse(rec.responseBody);
      var arr = Array.isArray(j) ? j : [j];
      return arr.some(function (x) { return x && x.errors && x.errors.length; });
    } catch (e) { return false; }
  }

  function updateRowCells(rec) {
    var tr = rowById[rec.id];
    if (!tr) return;
    var cells = tr.children;
    var st = statusInfo(rec);

    // name
    var nameCell = cells[0];
    nameCell.textContent = '';
    nameCell.appendChild(el('span', { class: 'dot ' + st.cls }));
    nameCell.appendChild(document.createTextNode(rec.operationName));
    if (rec.isResent) nameCell.appendChild(el('span', { class: 'tag resent', text: 'resent' }));
    if (rec.rewritten) nameCell.appendChild(el('span', { class: 'tag rewritten', text: 'rewritten' }));
    if (rec.delayedMs) nameCell.appendChild(el('span', { class: 'tag delayed', text: 'delay ' + fmtMs(rec.delayedMs) }));
    if (rec.overridden) nameCell.appendChild(el('span', { class: 'tag overridden', text: 'mocked' }));
    if (rec.imported) nameCell.appendChild(el('span', { class: 'tag', text: 'imported' }));
    if (rec.transport === 'xhr') nameCell.appendChild(el('span', { class: 'tag xhr', text: 'xhr' }));
    var dup = dupInfo[rec.id];
    if (dup) nameCell.appendChild(el('span', { class: 'tag dup', text: 'dup ×' + dup.size, title: dupTitle(dup) }));
    tr.classList.toggle('dup', !!dup);
    tr.classList.toggle('blocked', !!rec.blocked || rec.status === '(blocked)');
    nameCell.title = rec.operationName;

    // type
    cells[1].textContent = '';
    cells[1].appendChild(el('span', { class: 'type-badge ' + rec.operationType, text: rec.operationType }));

    // status
    cells[2].textContent = st.text;
    cells[2].style.color = st.cls === 'err' ? 'var(--red)' : st.cls === 'blocked' ? 'var(--amber)' : st.cls === 'ok' ? 'var(--green)' : 'var(--muted)';

    // time
    cells[3].textContent = rec.durationMs != null ? Math.round(rec.durationMs) + ' ms' : '';

    // when
    cells[4].textContent = rec.ts ? new Date(rec.ts).toLocaleTimeString() : '';
  }

  function selectRecord(id) {
    if (selectedId && rowById[selectedId]) rowById[selectedId].classList.remove('selected');
    selectedId = id;
    if (rowById[id]) rowById[id].classList.add('selected');
    var rec = byId[id];
    if (rec) renderDetail(rec);
  }

  function updateCount() { $('count').textContent = records.length + (records.length === 1 ? ' operation' : ' operations'); }
  function updateEmpty() {
    var anyVisible = $('op-rows').children.length > 0;
    $('empty').classList.toggle('hidden', anyVisible);
    if (anyVisible) return;
    var filteredOut = records.length > 0; // records exist but the filter hid them all
    $('empty-title').textContent = filteredOut ? 'No operations match the filter.' : 'No GraphQL operations yet.';
    $('empty-hint').classList.toggle('hidden', filteredOut);
  }

  // ---- detail pane -------------------------------------------------------
  function prettyJson(text) {
    if (typeof text !== 'string') { try { return JSON.stringify(text, null, 2); } catch (e) { return String(text); } }
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  // Foldable, syntax-highlighted code block (falls back to <pre> if codeview missing).
  // opts.autoCollapseLines auto-folds blocks taller than N lines (used for bodies).
  var AUTO_COLLAPSE = 24;
  function codeBlock(text, lang, opts) {
    if (window.GQLCode && text != null && text !== '') {
      try { return GQLCode.renderFoldableCode(String(text), lang, opts); } catch (e) { /* fall through */ }
    }
    return el('pre', { class: 'block', text: (text == null || text === '') ? '(empty)' : String(text) });
  }
  function jsonOrPre(text, opts) {
    if (text == null || text === '') return el('pre', { class: 'block', text: '(none)' });
    var parses = false;
    try { JSON.parse(typeof text === 'string' ? text : JSON.stringify(text)); parses = true; } catch (e) {}
    return parses ? codeBlock(prettyJson(text), 'json', opts) : el('pre', { class: 'block', text: String(text) });
  }
  // Tags a code block with the search key its text was derived from (see
  // lib/search.js) so a search hit can find the block and scroll to the line.
  function tagged(node, sk) { if (node && sk) node.setAttribute('data-sk', sk); return node; }

  // Query viewer with an "Inline fragments" toggle (shown only when the query
  // actually uses fragment spreads).
  function queryBlock(query, sk) {
    var wrap = el('div');
    var holder = el('div');
    var cb = el('input', { type: 'checkbox' });
    var lbl = el('label', { class: 'tcheck inline' }, [cb, document.createTextNode(' Inline fragments')]);
    var bar = el('div', { class: 'findbar' }, [lbl]);
    function render() {
      holder.textContent = '';
      var q = query || '(not available)';
      if (cb.checked && window.GQLCode && GQLCode.inlineFragments) { try { q = GQLCode.inlineFragments(query); } catch (e) {} }
      holder.appendChild(tagged(codeBlock(q, 'graphql'), cb.checked ? null : sk));
    }
    cb.addEventListener('change', render);
    if (!/\.\.\.[A-Za-z_]/.test(query || '')) bar.style.display = 'none'; // no fragment spreads → hide toggle
    render();
    wrap.appendChild(bar);
    wrap.appendChild(holder);
    return wrap;
  }

  // A find box that highlights matching rows across the code viewers in a pane
  // and steps through them: Enter / Shift+Enter, or the ↓ / ↑ buttons. The
  // current match is marked cv-active and centred; navigation wraps around.
  // Also exposes paneEl.__applyFind(term, matcher, activeRow) so a global-search
  // hit can light up the same rows (matcher may be a regex one — see
  // lib/search.js) and start the local stepping from the line it jumped to.
  function makeFindBar(paneEl) {
    var input = el('input', { type: 'search', class: 'find-input', placeholder: 'Find…' });
    var prev = el('button', { type: 'button', class: 'find-nav', text: '↑', title: 'Previous match (Shift+Enter)' });
    var next = el('button', { type: 'button', class: 'find-nav', text: '↓', title: 'Next match (Enter)' });
    var count = el('span', { class: 'find-count muted' });
    var hits = [];   // matching .cv-row elements, in document order
    var cur = -1;    // index into hits, -1 = nothing focused yet

    function paint() {
      for (var i = 0; i < hits.length; i++) hits[i].classList.toggle('cv-active', i === cur);
      prev.disabled = next.disabled = !hits.length;
      count.textContent = !input.value ? ''
        : !hits.length ? 'No matches'
          : cur >= 0 ? (cur + 1) + ' / ' + hits.length
            : hits.length + (hits.length === 1 ? ' match' : ' matches');
    }
    function reveal(block) { if (cur >= 0 && hits[cur]) hits[cur].scrollIntoView({ block: block }); }

    function apply(matcher, scroll) {
      hits = [];
      cur = -1;
      Array.prototype.forEach.call(paneEl.querySelectorAll('.codeview .cv-row'), function (row) {
        row.classList.remove('cv-match', 'cv-active');
        if (!matcher) return;
        row.style.display = ''; // reveal folded rows so matches are visible
        if (GQLSearch.matchRanges(matcher, row.textContent).length) { row.classList.add('cv-match'); hits.push(row); }
      });
      if (hits.length && scroll) cur = 0; // land on the first match as you type
      paint();
      if (scroll) reveal('nearest');
      return hits.length;
    }
    function step(delta) {
      if (!hits.length) return;
      cur = cur < 0 ? (delta > 0 ? 0 : hits.length - 1) : (cur + delta + hits.length) % hits.length;
      paint();
      reveal('center');
    }

    input.addEventListener('input', function () {
      var term = input.value;
      apply(term ? { needle: term.toLowerCase(), ci: true } : null, true);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); return; }
      // First Escape clears the find; a second one falls through to the panel
      // handler (which closes the global search / a modal).
      if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(null, false); }
    });
    prev.addEventListener('click', function () { step(-1); input.focus(); });
    next.addEventListener('click', function () { step(1); input.focus(); });

    paneEl.__applyFind = function (term, matcher, activeRow) {
      input.value = term || '';
      apply(matcher || null, false);
      var at = activeRow ? hits.indexOf(activeRow) : -1;
      if (at >= 0) { cur = at; paint(); }  // keep Enter stepping on from this line
    };
    paint();
    return el('div', { class: 'findbar' }, [input, el('span', { class: 'find-nav-group' }, [prev, next]), count]);
  }

  function renderDetail(rec) {
    $('detail-empty').classList.add('hidden');
    $('detail').classList.remove('hidden');

    var head = $('detail-head');
    head.textContent = '';
    head.appendChild(el('div', { class: 'op-name', text: rec.operationName }));
    head.appendChild(el('div', { class: 'op-url', text: (rec.method || '') + '  ' + (rec.url || '') }));
    var dup = dupInfo[rec.id];
    if (dup) head.appendChild(dupBanner(rec, dup));

    // request
    var reqPane = document.querySelector('.tabpane[data-pane="request"]');
    reqPane.textContent = '';
    reqPane.appendChild(makeFindBar(reqPane));
    reqPane.appendChild(el('div', { class: 'section-label', text: 'Operation type' }));
    reqPane.appendChild(el('div', { text: rec.operationType + (rec.isBatch ? ' (batched)' : '') + (rec.isResent ? '  · resent from a captured request' : '') }));
    (rec.entries || []).forEach(function (entry, i) {
      reqPane.appendChild(el('div', { class: 'section-label', text: 'Query' + ((rec.entries.length > 1) ? ' #' + (i + 1) + ' — ' + entry.operationName : '') }));
      if (entry.persisted) reqPane.appendChild(el('div', { class: 'muted', text: 'Persisted query (hash only — no query text sent).' }));
      reqPane.appendChild(queryBlock(entry.query, 'q' + i)); // foldable, with inline-fragments toggle
      reqPane.appendChild(el('div', { class: 'section-label', text: 'Variables' }));
      reqPane.appendChild(tagged(codeBlock(prettyJson(entry.variables != null ? entry.variables : {}), 'json', { autoCollapseLines: AUTO_COLLAPSE }), 'v' + i));
    });
    if (rec.requestBody) {
      reqPane.appendChild(el('div', { class: 'section-label', text: 'Raw request body' + (rec.requestBodyTruncated ? ' (truncated — resend disabled)' : '') }));
      reqPane.appendChild(tagged(jsonOrPre(rec.requestBody, { autoCollapseLines: AUTO_COLLAPSE }), 'rb'));
    }

    // response
    var resPane = document.querySelector('.tabpane[data-pane="response"]');
    resPane.textContent = '';
    resPane.appendChild(makeFindBar(resPane));
    var st = statusInfo(rec);
    resPane.appendChild(el('div', { class: 'section-label', text: 'Status' }));
    resPane.appendChild(el('div', { text: (rec.status != null ? String(rec.status) : 'pending') + (rec.statusText ? ' ' + rec.statusText : '') + (rec.durationMs != null ? '  ·  ' + Math.round(rec.durationMs) + ' ms' : '') }));
    if (rec.error) { resPane.appendChild(el('div', { class: 'section-label', text: 'Error' })); resPane.appendChild(el('pre', { class: 'block', text: rec.error })); }
    resPane.appendChild(el('div', { class: 'section-label', text: 'Body' }));
    resPane.appendChild(rec.responseBody != null ? tagged(jsonOrPre(rec.responseBody, { autoCollapseLines: AUTO_COLLAPSE }), 'res') : el('pre', { class: 'block', text: '(no response yet)' }));

    // headers
    var hPane = document.querySelector('.tabpane[data-pane="headers"]');
    hPane.textContent = '';
    hPane.appendChild(el('div', { class: 'section-label', text: 'Request headers' }));
    hPane.appendChild(kvTable(rec.requestHeaders));
    hPane.appendChild(el('div', { class: 'section-label', text: 'Response headers' }));
    hPane.appendChild(kvTable(rec.responseHeaders));

    // meta
    var mPane = document.querySelector('.tabpane[data-pane="meta"]');
    mPane.textContent = '';
    mPane.appendChild(kvTable({
      'Operation': rec.operationName,
      'Type': rec.operationType,
      'Transport': rec.transport,
      'Method': rec.method,
      'URL': rec.url,
      'Status': String(rec.status),
      'Duration': rec.durationMs != null ? Math.round(rec.durationMs) + ' ms' : '—',
      'Timestamp': rec.ts ? new Date(rec.ts).toISOString() : '—',
      'Blocked': rec.blocked ? 'yes' : 'no',
      'Rewritten': rec.rewritten ? 'yes' : 'no',
      'Delayed': rec.delayedMs ? fmtMs(rec.delayedMs) : '—',
      'Duplicate': dup ? ('#' + dup.index + ' of ' + dup.size + ' identical calls within ' + fmtMs(dupWindowMs)) : 'no',
      'Resent from': rec.resendOf || '—',
      'Rule id': rec.ruleId || '—',
      'Record id': rec.id
    }));
  }

  // "You sent this exact call N times" — with the siblings one click away.
  function dupBanner(rec, d) {
    var wrap = el('div', { class: 'dup-warn' });
    wrap.appendChild(el('span', { class: 'dup-badge', text: 'duplicate' }));
    wrap.appendChild(el('span', {
      text: d.size + ' identical calls (same query & variables) within ' + fmtMs(dupWindowMs) +
        ' — this is #' + d.index + (d.gapMs != null ? ', ' + Math.round(d.gapMs) + ' ms after the previous.' : '.')
    }));
    d.ids.forEach(function (id, i) {
      if (id === rec.id) return;
      wrap.appendChild(el('button', {
        class: 'dup-link', text: '#' + (i + 1), title: 'Jump to call #' + (i + 1),
        onclick: function () { selectRecord(id); }
      }));
    });
    return wrap;
  }

  function kvTable(obj) {
    var t = el('table', { class: 'kv' });
    if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) {
      t.appendChild(el('tr', {}, [el('td', { class: 'k muted', text: '(none)' })]));
      return t;
    }
    Object.keys(obj).forEach(function (k) {
      t.appendChild(el('tr', {}, [
        el('td', { class: 'k', text: k }),
        el('td', { class: 'v', text: obj[k] == null ? '' : String(obj[k]) })
      ]));
    });
    return t;
  }

  function activateTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabpane'), function (p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === name);
    });
  }

  // ---- global search (across every recorded operation) -------------------
  // Answers "which request carried this id / returned this value?" — scans the
  // query text, variables, request & response bodies and headers of every
  // record, groups the hits per operation, and jumps to the matching line.
  var searchOpen = false;
  var searchTerm = '';
  var searchOpts = { caseSensitive: false, regex: false };
  var searchScope = 'all';
  var searchFieldCache = Object.create(null); // id -> searchable fields (cleared on patch)
  var searchTimer = null;
  var searchHits = [];   // flat, in render order — drives Enter / Shift+Enter
  var activeHit = -1;

  function cachedFields(rec) {
    var f = searchFieldCache[rec.id];
    if (!f) { f = GQLSearch.fieldsFor(rec); searchFieldCache[rec.id] = f; }
    return f;
  }
  function currentMatcher() {
    try { return GQLSearch.buildMatcher(searchTerm, searchOpts); } catch (e) { return null; }
  }

  function openSearch() {
    searchOpen = true;
    $('searchbar').classList.remove('hidden');
    $('search-pane').classList.remove('hidden');
    $('list-pane').classList.add('hidden');
    $('btn-search').classList.add('active');
    $('search-input').focus();
    $('search-input').select();
    runSearch();
  }
  function closeSearch() {
    searchOpen = false;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    $('searchbar').classList.add('hidden');
    $('search-pane').classList.add('hidden');
    $('list-pane').classList.remove('hidden');
    $('btn-search').classList.remove('active');
  }
  function toggleSearch() { if (searchOpen) closeSearch(); else openSearch(); }

  // Records keep arriving (and responses land as patches) while search is open.
  function scheduleSearch() {
    if (!searchOpen || !searchTerm) return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { searchTimer = null; runSearch(); }, 250);
  }

  function searchEmptyMsg(text) {
    $('search-empty-text').textContent = text;
    $('search-empty').classList.toggle('hidden', !text);
  }

  function runSearch() {
    if (!searchOpen) return;
    var host = $('search-results');
    var pane = $('search-pane');
    var keepScroll = pane.scrollTop;
    host.textContent = '';
    searchHits = [];
    activeHit = -1;
    $('search-error').classList.add('hidden');
    $('search-count').textContent = '';

    if (!searchTerm) {
      searchEmptyMsg('Type to search across all ' + records.length + ' recorded operation' + (records.length === 1 ? '' : 's') +
        ' — variable values, query text, response bodies and headers. The list filters above are ignored here.');
      return;
    }
    var matcher;
    try { matcher = GQLSearch.buildMatcher(searchTerm, searchOpts); }
    catch (e) {
      searchEmptyMsg('');
      var err = $('search-error');
      err.textContent = 'Invalid regular expression: ' + e.message;
      err.classList.remove('hidden');
      return;
    }

    var res = GQLSearch.searchAll(records, matcher, { scope: searchScope, fieldsFor: cachedFields });
    res.groups.forEach(function (g) { host.appendChild(renderSearchGroup(g)); });

    if (!res.groups.length) {
      searchEmptyMsg('No matches in ' + records.length + ' recorded operation' + (records.length === 1 ? '' : 's') + '.');
    } else {
      searchEmptyMsg('');
      $('search-count').textContent = res.totalMatches + (res.totalMatches === 1 ? ' match in ' : ' matches in ') +
        res.groups.length + (res.groups.length === 1 ? ' operation' : ' operations');
    }
    pane.scrollTop = keepScroll;
  }

  function renderSearchGroup(g) {
    var rec = g.rec;
    var st = statusInfo(rec);
    var head = el('div', { class: 'sr-head' }, [
      el('span', { class: 'dot ' + st.cls }),
      el('span', { class: 'sr-op', text: rec.operationName, title: rec.operationName }),
      el('span', { class: 'type-badge ' + rec.operationType, text: rec.operationType }),
      dupInfo[rec.id] ? el('span', { class: 'tag dup', text: 'dup ×' + dupInfo[rec.id].size, title: dupTitle(dupInfo[rec.id]) }) : null,
      el('span', { class: 'muted', text: g.total + (g.total === 1 ? ' match' : ' matches') }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted', text: rec.ts ? new Date(rec.ts).toLocaleTimeString() : '' })
    ]);
    head.addEventListener('click', function () { selectRecord(rec.id); });
    head.addEventListener('contextmenu', function (e) { e.preventDefault(); selectRecord(rec.id); showContextMenu(e.clientX, e.clientY, rec); });

    var group = el('div', { class: 'sr-group' }, [head]);
    g.matches.forEach(function (m) {
      var idx = searchHits.length;
      var btn = el('button', { class: 'sr-hit' }, [
        el('span', { class: 'sr-field', text: m.field.label + (m.field.single ? '' : ':' + (m.line + 1)) }),
        snippet(m.text, m.ranges)
      ]);
      btn.addEventListener('click', function () { jumpToHit(idx); });
      searchHits.push({ rec: rec, field: m.field, match: m, node: btn });
      group.appendChild(btn);
    });
    if (g.total > g.matches.length) {
      group.appendChild(el('div', { class: 'sr-more', text: '+ ' + (g.total - g.matches.length) + ' more match(es) — open the operation to see them all' }));
    }
    return group;
  }

  // One result line: the matching text, dedented, windowed around the first hit.
  function snippet(line, ranges) {
    var lead = /^\s*/.exec(line)[0].length;
    var disp = line.slice(lead);
    var rs = ranges.map(function (r) { return [Math.max(0, r[0] - lead), Math.max(0, r[1] - lead)]; });
    var start = Math.max(0, rs[0][0] - 48);
    var end = Math.min(disp.length, start + 260);
    var out = el('span', { class: 'sr-snip' });
    if (start > 0) out.appendChild(el('span', { class: 'muted', text: '…' }));
    var pos = start;
    rs.forEach(function (r) {
      if (r[1] <= start || r[0] >= end) return;
      var s = Math.max(r[0], start), e = Math.min(r[1], end);
      if (s > pos) out.appendChild(document.createTextNode(disp.slice(pos, s)));
      out.appendChild(el('span', { class: 's-hit', text: disp.slice(s, e) }));
      pos = e;
    });
    if (pos < end) out.appendChild(document.createTextNode(disp.slice(pos, end)));
    if (end < disp.length) out.appendChild(el('span', { class: 'muted', text: '…' }));
    return out;
  }

  // Open the hit's operation on the right tab and scroll to the exact line.
  function jumpToHit(i) {
    if (i < 0 || i >= searchHits.length) return;
    if (activeHit >= 0 && searchHits[activeHit]) searchHits[activeHit].node.classList.remove('active');
    activeHit = i;
    var h = searchHits[i];
    h.node.classList.add('active');
    h.node.scrollIntoView({ block: 'nearest' });

    selectRecord(h.rec.id); // re-renders the detail pane
    activateTab(h.field.tab);
    var pane = document.querySelector('.tabpane[data-pane="' + h.field.tab + '"]');
    if (!pane) return;
    var blk = h.field.sk ? pane.querySelector('[data-sk="' + h.field.sk + '"]') : null;
    var rows = blk ? blk.querySelectorAll('.cv-row') : null;
    var row = rows && rows[h.match.line];

    var matcher = currentMatcher();
    // Hand the landing row to the pane's find bar so its "3 / 12" counter and
    // Enter-stepping continue from here instead of restarting at match 1.
    if (pane.__applyFind) pane.__applyFind(searchTerm, matcher, row);
    highlightKvRows(pane, matcher);

    if (row) {
      row.style.display = ''; // may have been folded away
      row.classList.add('cv-match', 'cv-active');
      row.scrollIntoView({ block: 'center' });
    } else if (blk) {
      blk.scrollIntoView({ block: 'nearest' });
    }
  }
  function stepHit(delta) {
    if (!searchHits.length) return;
    var next = activeHit < 0 ? (delta > 0 ? 0 : searchHits.length - 1) : (activeHit + delta + searchHits.length) % searchHits.length;
    jumpToHit(next);
  }

  // Headers / Timing tabs render key-value tables, not code views.
  function highlightKvRows(pane, matcher) {
    var first = null;
    Array.prototype.forEach.call(pane.querySelectorAll('table.kv tr'), function (tr) {
      tr.classList.remove('kv-match');
      if (!matcher) return;
      if (GQLSearch.matchRanges(matcher, tr.textContent).length) { tr.classList.add('kv-match'); if (!first) first = tr; }
    });
    if (first) first.scrollIntoView({ block: 'nearest' });
  }

  $('btn-search').addEventListener('click', toggleSearch);
  $('search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', function () {
    searchTerm = $('search-input').value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { searchTimer = null; runSearch(); }, 140);
  });
  $('search-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; runSearch(); } stepHit(e.shiftKey ? -1 : 1); }
  });
  $('s-case').addEventListener('click', function () {
    searchOpts.caseSensitive = !searchOpts.caseSensitive;
    $('s-case').classList.toggle('on', searchOpts.caseSensitive);
    runSearch();
  });
  $('s-regex').addEventListener('click', function () {
    searchOpts.regex = !searchOpts.regex;
    $('s-regex').classList.toggle('on', searchOpts.regex);
    runSearch();
  });
  Array.prototype.forEach.call(document.querySelectorAll('#search-scopes .chip'), function (chip) {
    chip.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('#search-scopes .chip'), function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      searchScope = chip.getAttribute('data-s');
      runSearch();
    });
  });

  // ---- context menu ------------------------------------------------------
  function showContextMenu(x, y, rec) {
    contextRecord = rec;
    var menu = $('ctx-menu');
    menu.textContent = '';
    var truncated = !!rec.requestBodyTruncated;
    var primary = primaryOpName(rec);

    function item(label, cls, fn, disabled) {
      var b = el('button', { class: cls || '', text: label });
      if (disabled) { b.disabled = true; b.style.opacity = '.5'; b.style.cursor = 'default'; }
      else b.addEventListener('click', function () { hideContextMenu(); fn(); });
      menu.appendChild(b);
    }
    function sep() { menu.appendChild(el('div', { class: 'sep' })); }

    item(truncated ? 'Resend (body truncated)' : 'Resend', '', function () { resendRecord(rec); }, truncated);
    item('Modify & resend…', '', function () { openEditor(rec); }, truncated);
    sep();
    // Already blocked → offer the inverse instead of a second identical rule.
    if (blockRulesFor(rec).some(function (r) { return r.enabled !== false; })) {
      item('Unblock operation "' + primary + '"', '', function () { removeBlockRule(rec); });
    } else {
      item('Block operation "' + primary + '"', '', function () { addBlockRule(rec); });
    }
    item('Delay operation…', '', function () { openRuleEditor(null, { type: 'delay', operationName: primary, delayMs: 30000 }); });
    item('Override response…', '', function () { openRuleEditor(null, { type: 'override', operationName: primary, overrideBody: rec.responseBody || '' }); });
    item('Create rewrite rule…', '', function () { openRuleEditorFromRecord(rec); });
    sep();
    item('Copy operation name', '', function () { copyText(primary, 'Operation name copied'); });
    item('Copy query', '', function () { copyText(primaryQuery(rec), 'Query copied'); });
    item('Copy variables', '', function () { copyText(primaryVars(rec), 'Variables copied'); });
    item('Copy as cURL', '', function () { copyText(asCurl(rec), 'cURL command copied'); });

    menu.classList.remove('hidden');
    // reposition to stay on-screen
    var rect = menu.getBoundingClientRect();
    var px = Math.min(x, window.innerWidth - rect.width - 6);
    var py = Math.min(y, window.innerHeight - rect.height - 6);
    menu.style.left = Math.max(4, px) + 'px';
    menu.style.top = Math.max(4, py) + 'px';
  }
  function hideContextMenu() { $('ctx-menu').classList.add('hidden'); }
  document.addEventListener('click', function (e) { if (!$('ctx-menu').contains(e.target)) hideContextMenu(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideContextMenu();
      var modalOpen = ['editor-backdrop', 'rules-backdrop', 'rule-backdrop'].some(function (id) { return !$(id).classList.contains('hidden'); });
      if (modalOpen) closeAllModals();
      else if (searchOpen) closeSearch();
      return;
    }
    // Cmd/Ctrl+F (and +Shift+F) open the cross-request search from anywhere.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (searchOpen) { $('search-input').focus(); $('search-input').select(); } else openSearch();
    }
  });
  window.addEventListener('blur', hideContextMenu);
  $('list-pane').addEventListener('scroll', hideContextMenu);
  $('search-pane').addEventListener('scroll', hideContextMenu);

  function primaryOpName(rec) {
    if (rec.entries && rec.entries.length && rec.entries[0].operationName) return rec.entries[0].operationName;
    return rec.operationName;
  }

  // ---- resend ------------------------------------------------------------
  function resendRecord(rec) {
    resend({ reqId: rec.id, url: rec.url, method: rec.method, headers: rec.requestHeaders, body: rec.requestBody, credentials: rec.credentials, frameId: rec.frameId });
  }
  function resend(payload) {
    sendPort({ type: GQLOP.M_RESEND, tabId: tabId, payload: payload });
    toast('Resending ' + (parseBodyOpName(payload.body) || 'request') + '…');
  }
  function onResendResult(payload) {
    if (!payload) return;
    if (payload.ok) toast('Resent ✓');
    else toast('Resend failed: ' + (payload.error || 'unknown error'), true);
  }
  function parseBodyOpName(body) {
    try { var j = JSON.parse(body); var it = Array.isArray(j) ? j[0] : j; return it && it.operationName; } catch (e) { return null; }
  }

  function primaryQuery(rec) {
    var qs = (rec.entries || []).map(function (e) { return e.query || ''; }).filter(Boolean);
    var q = qs.join('\n\n');
    if (window.GQLCode && q) { try { q = GQLCode.formatGraphQL(q); } catch (e) {} }
    return q || '(no query)';
  }
  function primaryVars(rec) {
    var es = rec.entries || [];
    if (es.length === 1) return prettyJson(es[0].variables != null ? es[0].variables : {});
    return prettyJson(es.map(function (e) { return e.variables != null ? e.variables : {}; }));
  }
  function asCurl(rec) {
    function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
    var parts = ['curl ' + q(rec.url), '-X ' + (rec.method || 'POST')];
    var h = rec.requestHeaders || {};
    Object.keys(h).forEach(function (k) { parts.push('-H ' + q(k + ': ' + h[k])); });
    if (rec.requestBody) parts.push('--data ' + q(rec.requestBody));
    return parts.join(' \\\n  ');
  }

  // ---- clipboard ---------------------------------------------------------
  function copyText(text, okMsg) {
    text = text || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || 'Copied'); }, fallback);
    } else fallback();
    function fallback() {
      var ta = el('textarea', {}); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg || 'Copied'); } catch (e) { toast('Copy failed', true); }
      document.body.removeChild(ta);
    }
  }

  // ---- editor (modify & resend) ------------------------------------------
  // Single-op requests are edited as separate Query + Variables fields (much
  // easier than a raw escaped JSON blob); batches / non-JSON fall back to raw.
  function fmtQuery(q) { return window.GQLCode ? GQLCode.formatGraphQL(q || '') : (q || ''); }

  function openEditor(rec) {
    editorRecord = rec;
    $('ed-method').value = rec.method || 'POST';
    $('ed-url').value = rec.url || '';
    $('ed-headers').value = headersToLines(rec.requestHeaders);
    editorOrigBody = null;
    try { editorOrigBody = rec.requestBody ? JSON.parse(rec.requestBody) : null; } catch (e) { editorOrigBody = null; }

    var single = !!(rec.entries && rec.entries.length === 1 && editorOrigBody && !Array.isArray(editorOrigBody));
    if (single) {
      $('ed-query').value = fmtQuery(rec.entries[0].query);
      $('ed-vars').value = prettyJson(rec.entries[0].variables != null ? rec.entries[0].variables : {});
      $('ed-raw-toggle').checked = false;
      $('ed-raw-toggle').disabled = false;
      setEditorMode('single');
    } else {
      $('ed-body').value = prettyJson(rec.requestBody || '');
      $('ed-raw-toggle').checked = true;
      $('ed-raw-toggle').disabled = true; // batch / non-JSON — raw only
      setEditorMode('raw');
    }
    $('ed-error').classList.add('hidden');
    $('editor-backdrop').classList.remove('hidden');
  }
  function setEditorMode(mode) {
    editorMode = mode;
    $('ed-single').classList.toggle('hidden', mode !== 'single');
    $('ed-raw').classList.toggle('hidden', mode !== 'raw');
  }
  function buildSingleBody() {
    var vtext = $('ed-vars').value.trim();
    var vars;
    try { vars = vtext ? JSON.parse(vtext) : {}; } catch (e) { throw new Error('Variables JSON is invalid: ' + e.message); }
    var base = (editorOrigBody && !Array.isArray(editorOrigBody)) ? Object.assign({}, editorOrigBody) : {};
    base.query = $('ed-query').value;
    base.variables = vars;
    return JSON.stringify(base, null, 2);
  }
  function closeEditor() { $('editor-backdrop').classList.add('hidden'); editorRecord = null; editorOrigBody = null; }

  function headersToLines(h) {
    if (!h) return '';
    return Object.keys(h).map(function (k) { return k + ': ' + h[k]; }).join('\n');
  }
  function linesToHeaders(text) {
    var out = {};
    (text || '').split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) {
        var k = line.slice(0, i).trim();
        var v = line.slice(i + 1).trim();
        if (k) out[k] = v;
      }
    });
    return out;
  }

  $('ed-cancel').addEventListener('click', closeEditor);
  $('editor-close').addEventListener('click', closeEditor);
  $('ed-raw-toggle').addEventListener('change', function () {
    if ($('ed-raw-toggle').checked) {
      if (editorMode === 'single') {
        try { $('ed-body').value = buildSingleBody(); } catch (e) { $('ed-raw-toggle').checked = false; return showEdError(e.message); }
      }
      setEditorMode('raw');
    } else {
      try {
        var j = JSON.parse($('ed-body').value);
        var it = Array.isArray(j) ? j[0] : j;
        $('ed-query').value = fmtQuery(it.query);
        $('ed-vars').value = prettyJson(it.variables != null ? it.variables : {});
        editorOrigBody = j;
        setEditorMode('single');
      } catch (e) { $('ed-raw-toggle').checked = true; return showEdError('Cannot switch: body is not valid JSON.'); }
    }
    $('ed-error').classList.add('hidden');
  });
  $('ed-format').addEventListener('click', function () {
    try {
      if (editorMode === 'single') {
        $('ed-query').value = fmtQuery($('ed-query').value);
        var vt = $('ed-vars').value.trim();
        if (vt) $('ed-vars').value = JSON.stringify(JSON.parse(vt), null, 2);
      } else {
        $('ed-body').value = JSON.stringify(JSON.parse($('ed-body').value), null, 2);
      }
      $('ed-error').classList.add('hidden');
    } catch (e) { showEdError('Invalid JSON: ' + e.message); }
  });
  $('ed-send').addEventListener('click', function () {
    var body;
    if (editorMode === 'single') {
      try { body = buildSingleBody(); } catch (e) { return showEdError(e.message); }
    } else {
      body = $('ed-body').value;
    }
    resend({
      reqId: editorRecord ? editorRecord.id : null,
      url: $('ed-url').value.trim(),
      method: $('ed-method').value.trim() || 'POST',
      headers: linesToHeaders($('ed-headers').value),
      body: body,
      credentials: editorRecord ? editorRecord.credentials : undefined,
      frameId: editorRecord ? editorRecord.frameId : undefined
    });
    closeEditor();
  });
  $('ed-rule').addEventListener('click', function () {
    var op = null, query = '', vars = '';
    if (editorMode === 'single') {
      op = editorRecord ? primaryOpName(editorRecord) : null;
      query = $('ed-query').value;
      vars = $('ed-vars').value.trim();
    } else {
      try {
        var j = JSON.parse($('ed-body').value);
        var it = Array.isArray(j) ? j[0] : j;
        op = it.operationName || null;
        query = it.query || '';
        vars = it.variables != null ? JSON.stringify(it.variables, null, 2) : '';
      } catch (e) {}
    }
    closeEditor();
    openRuleEditor(null, { type: 'rewrite', operationName: op, query: query, varsMode: vars ? 'replace' : 'none', vars: vars });
  });
  function showEdError(m) { var e = $('ed-error'); e.textContent = m; e.classList.remove('hidden'); }

  // ---- rules -------------------------------------------------------------
  function loadRules() {
    chrome.storage.local.get(GQLOP.STORAGE_RULES, function (res) {
      onRulesChanged((res && res[GQLOP.STORAGE_RULES]) || []);
    });
  }
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[GQLOP.STORAGE_RULES]) onRulesChanged(changes[GQLOP.STORAGE_RULES].newValue || []);
  });
  function onRulesChanged(next) {
    rules = next;
    renderRulesBadge();
    if (!$('rules-backdrop').classList.contains('hidden')) renderRulesList();
    if (filterMode === 'ruled') reRenderList(); // membership of the Ruled chip just moved
  }
  function saveRules(next) { rules = next; chrome.storage.local.set((function () { var o = {}; o[GQLOP.STORAGE_RULES] = next; return o; })()); }
  function renderRulesBadge() {
    var active = rules.filter(function (r) { return r.enabled !== false; }).length;
    $('rules-count').textContent = String(active);
  }

  // Block rules covering this record (enabled or not) — drives the
  // Block/Unblock item in the context menu.
  function blockRulesFor(rec) {
    return rules.filter(function (r) { return r.type === 'block' && ruleTargets(r, rec); });
  }
  // A rule the Block item created itself: nothing but this operation name, so
  // deleting it can't take other operations down with it.
  function isPlainNameBlock(rule, name) {
    var m = rule.match || {};
    return m.operationName === name && Object.keys(m).length === 1;
  }

  function addBlockRule(rec) {
    var name = primaryOpName(rec);
    var existing = blockRulesFor(rec);
    if (existing.some(function (r) { return r.enabled !== false; })) { toast('"' + name + '" is already blocked'); return; }
    if (existing.length) { // switched-off rule already covers it — re-arm that one
      var off = Object.create(null);
      existing.forEach(function (r) { off[r.id] = true; });
      saveRules(rules.map(function (r) { return off[r.id] ? Object.assign({}, r, { enabled: true }) : r; }));
      toast('Re-enabled the block rule for "' + name + '"');
      return;
    }
    var rule = { id: genId('rule_'), type: 'block', enabled: true, match: { operationName: name } };
    saveRules(rules.concat([rule]));
    toast('Blocking "' + name + '" — manage in Rules');
  }

  // The inverse of Block, straight from the list. Rules this menu created are
  // deleted; anything broader (regex / URL / type — it may cover many other
  // operations, or have been hand-written) is only switched off, never lost.
  function removeBlockRule(rec) {
    var name = primaryOpName(rec);
    var on = blockRulesFor(rec).filter(function (r) { return r.enabled !== false; });
    if (!on.length) { toast('No block rule matches "' + name + '"'); return; }
    var drop = Object.create(null), disable = Object.create(null);
    on.forEach(function (r) { (isPlainNameBlock(r, name) ? drop : disable)[r.id] = true; });
    saveRules(rules
      .filter(function (r) { return !drop[r.id]; })
      .map(function (r) { return disable[r.id] ? Object.assign({}, r, { enabled: false }) : r; }));
    var broad = Object.keys(disable).length;
    toast('Unblocked "' + name + '"' + (broad ? ' — disabled ' + broad + ' broader rule' + (broad === 1 ? '' : 's') : ''));
  }

  function ruleMatchSummary(r) {
    var m = r.match || {};
    var parts = [];
    if (m.operationName) parts.push('name=' + m.operationName);
    if (m.nameRegex) parts.push('name~/' + m.nameRegex + '/');
    if (m.operationType) parts.push('type=' + m.operationType);
    if (m.method) parts.push('method=' + m.method);
    if (m.urlContains) parts.push('url~' + m.urlContains);
    var base = parts.length ? parts.join('  ') : '(matches nothing — edit me)';
    if (r.type === 'delay' && r.delayMs) base += '  → ' + fmtMs(r.delayMs);
    if (r.type === 'override' && r.override) base += '  → HTTP ' + (r.override.status || 200);
    return base;
  }

  function renderRulesList() {
    var list = $('rules-list');
    list.textContent = '';
    if (!rules.length) { list.appendChild(el('div', { class: 'rules-empty', text: 'No rules yet. Right-click an operation to block it, or add one below.' })); return; }
    rules.forEach(function (r) {
      var item = el('div', { class: 'rule-item' + (r.enabled === false ? ' disabled' : '') });
      var toggle = el('input', { type: 'checkbox' });
      toggle.checked = r.enabled !== false;
      toggle.addEventListener('change', function () {
        var next = rules.map(function (x) { return x.id === r.id ? Object.assign({}, x, { enabled: toggle.checked }) : x; });
        saveRules(next);
      });
      var main = el('div', { class: 'rule-main' }, [
        el('span', { class: 'rule-type ' + r.type, text: r.type }),
        el('span', { class: 'rule-match', text: '  ' + ruleMatchSummary(r) })
      ]);
      var edit = el('button', { class: 'tbtn', text: 'Edit', onclick: function () { openRuleEditor(r, null); } });
      var del = el('button', { class: 'tbtn', text: 'Delete', onclick: function () { saveRules(rules.filter(function (x) { return x.id !== r.id; })); } });
      item.appendChild(toggle);
      item.appendChild(main);
      item.appendChild(edit);
      item.appendChild(del);
      list.appendChild(item);
    });
  }

  function openRules() { $('rules-backdrop').classList.remove('hidden'); renderRulesList(); }
  function closeRules() { $('rules-backdrop').classList.add('hidden'); }
  $('btn-rules').addEventListener('click', openRules);
  $('rules-close').addEventListener('click', closeRules);
  $('rules-done').addEventListener('click', closeRules);
  $('add-block').addEventListener('click', function () { openRuleEditor(null, { type: 'block' }); });
  $('add-rewrite').addEventListener('click', function () { openRuleEditor(null, { type: 'rewrite' }); });
  $('add-delay').addEventListener('click', function () { openRuleEditor(null, { type: 'delay' }); });
  $('add-override').addEventListener('click', function () { openRuleEditor(null, { type: 'override' }); });

  // ---- rule editor -------------------------------------------------------
  function openRuleEditorFromRecord(rec) {
    var entry = (rec.entries && rec.entries[0]) || {};
    openRuleEditor(null, {
      type: 'rewrite',
      operationName: primaryOpName(rec),
      query: entry.query || '',
      varsMode: entry.variables != null ? 'replace' : 'none',
      vars: entry.variables != null ? JSON.stringify(entry.variables, null, 2) : ''
    });
  }

  function openRuleEditor(existing, prefill) {
    editingRuleId = existing ? existing.id : null;
    var r = existing || {};
    var m = r.match || {};
    var rw = r.rewrite || {};
    prefill = prefill || {};

    var ov = r.override || {};
    $('rule-title').textContent = existing ? 'Edit rule' : 'New rule';
    $('r-type').value = r.type || prefill.type || 'block';
    $('r-enabled').checked = r.enabled !== false;
    $('r-op-name').value = m.nameRegex || m.operationName || prefill.operationName || '';
    $('r-name-regex').checked = !!m.nameRegex;
    $('r-op-type').value = m.operationType || '';
    $('r-method').value = m.method || '';
    $('r-url').value = m.urlContains || '';
    $('r-query').value = rw.query || prefill.query || '';
    $('r-var-mode').value = (rw.variables && rw.variables.mode) || prefill.varsMode || 'none';
    $('r-vars').value = rw.variables ? JSON.stringify(rw.variables.value, null, 2) : (prefill.vars || '');
    $('r-hset').value = rw.headers && rw.headers.set ? headersToLines(rw.headers.set) : '';
    $('r-hremove').value = rw.headers && rw.headers.remove ? rw.headers.remove.join(', ') : '';
    $('r-delay-ms').value = (r.delayMs != null ? r.delayMs : (prefill.delayMs != null ? prefill.delayMs : 30000));
    $('o-status').value = ov.status != null ? ov.status : 200;
    $('o-error').value = ov.errorMessage || '';
    $('o-body').value = ov.body != null ? ov.body : (prefill.overrideBody != null ? prefill.overrideBody : '');
    updateDelayHint();
    $('rule-error').classList.add('hidden');
    toggleTypeFields();
    $('rule-backdrop').classList.remove('hidden');
  }
  function closeRuleEditor() { $('rule-backdrop').classList.add('hidden'); editingRuleId = null; }
  function toggleTypeFields() {
    var t = $('r-type').value;
    $('rewrite-fields').style.display = t === 'rewrite' ? '' : 'none';
    $('delay-fields').style.display = t === 'delay' ? '' : 'none';
    $('override-fields').style.display = t === 'override' ? '' : 'none';
  }
  function updateDelayHint() { $('r-delay-hint').textContent = '= ' + fmtMs(+$('r-delay-ms').value || 0); }
  $('r-type').addEventListener('change', toggleTypeFields);
  $('r-delay-ms').addEventListener('input', updateDelayHint);
  $('rule-close').addEventListener('click', closeRuleEditor);
  $('rule-cancel').addEventListener('click', closeRuleEditor);
  $('rule-save').addEventListener('click', function () {
    var type = $('r-type').value;
    var match = {};
    var opName = $('r-op-name').value.trim();
    var opType = $('r-op-type').value;
    var method = $('r-method').value;
    var url = $('r-url').value.trim();
    if (opName) {
      if ($('r-name-regex').checked) {
        try { new RegExp(opName); } catch (e) { return ruleError('Invalid regex: ' + e.message); }
        match.nameRegex = opName;
      } else { match.operationName = opName; }
    }
    if (opType) match.operationType = opType;
    if (method) match.method = method;
    if (url) match.urlContains = url;
    if (!match.operationName && !match.nameRegex && !match.operationType && !match.method && !match.urlContains) {
      return ruleError('Add at least one match condition (name, type, method, or URL).');
    }

    var rule = { id: editingRuleId || genId('rule_'), type: type, enabled: $('r-enabled').checked, match: match };
    if (type === 'rewrite') {
      var rw = {};
      var q = $('r-query').value;
      if (q.trim()) rw.query = q;
      var mode = $('r-var-mode').value;
      if (mode !== 'none') {
        var raw = $('r-vars').value.trim() || '{}';
        var val;
        try { val = JSON.parse(raw); } catch (e) { return ruleError('Variables JSON is invalid: ' + e.message); }
        rw.variables = { mode: mode, value: val };
      }
      var hset = linesToHeaders($('r-hset').value);
      var hremove = $('r-hremove').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (Object.keys(hset).length || hremove.length) rw.headers = { set: hset, remove: hremove };
      if (!rw.query && !rw.variables && !rw.headers) { return ruleError('A rewrite rule needs at least one change (query, variables, or headers).'); }
      rule.rewrite = rw;
    } else if (type === 'delay') {
      var ms = parseInt($('r-delay-ms').value, 10);
      if (!(ms > 0)) return ruleError('Enter a delay greater than 0 ms.');
      rule.delayMs = ms;
    } else if (type === 'override') {
      var status = parseInt($('o-status').value, 10) || 200;
      var body = $('o-body').value;
      var errMsg = $('o-error').value.trim();
      if (!body.trim() && !errMsg) return ruleError('Provide a response body or a GraphQL error message.');
      if (body.trim()) { try { JSON.parse(body); } catch (e) { return ruleError('Response body is not valid JSON: ' + e.message); } }
      rule.override = { status: status, body: body, errorMessage: errMsg };
    }

    var next = editingRuleId ? rules.map(function (x) { return x.id === editingRuleId ? rule : x; }) : rules.concat([rule]);
    saveRules(next);
    closeRuleEditor();
    if (!$('rules-backdrop').classList.contains('hidden')) renderRulesList();
    toast('Rule saved');
  });
  function ruleError(m) { var e = $('rule-error'); e.textContent = m; e.classList.remove('hidden'); }

  function closeAllModals() { closeEditor(); closeRuleEditor(); closeRules(); }

  // ---- resizable list / detail divider -----------------------------------
  // The width is stored as a percentage of the split (the DevTools drawer gets
  // resized and re-docked constantly, so pixels wouldn't survive) and applied to
  // both left panes, so it holds when the search pane takes over from the list.
  var SPLIT_KEY = 'gqlop_split_pct';
  var SPLIT_DEFAULT = 58;
  var MIN_LEFT = 220, MIN_RIGHT = 260; // px — keep both sides usable
  var splitPct = SPLIT_DEFAULT;        // what the user asked for, before clamping

  // Clamped on apply rather than on set: a narrow window can't shrink the
  // remembered width, it only limits what's shown until there's room again.
  function clampSplit(pct) {
    var w = $('split').getBoundingClientRect().width;
    if (!w) return pct;
    var min = MIN_LEFT / w * 100, max = (w - MIN_RIGHT) / w * 100;
    if (min > max) return 50; // too narrow to honour both minimums
    return Math.min(max, Math.max(min, pct));
  }
  function applySplit(pct) {
    splitPct = pct;
    var eff = clampSplit(pct);
    $('list-pane').style.flexBasis = eff + '%';
    $('search-pane').style.flexBasis = eff + '%';
    $('splitter').setAttribute('aria-valuenow', String(Math.round(eff)));
  }
  function saveSplit() { try { localStorage.setItem(SPLIT_KEY, String(Math.round(splitPct * 10) / 10)); } catch (e) {} }

  (function initSplitter() {
    var sp = $('splitter');
    var stored = NaN;
    try { stored = parseFloat(localStorage.getItem(SPLIT_KEY)); } catch (e) {}
    applySplit(stored > 0 && stored < 100 ? stored : SPLIT_DEFAULT);

    var dragging = false;
    function moveTo(clientX) {
      var box = $('split').getBoundingClientRect();
      if (box.width) applySplit((clientX - box.left) / box.width * 100);
    }
    sp.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      // Keep the events coming while the cursor is over the panes (or has left
      // the panel iframe entirely).
      try { sp.setPointerCapture(e.pointerId); } catch (x) {}
      sp.classList.add('dragging');
      document.body.classList.add('resizing');
      hideContextMenu();
      e.preventDefault();
    });
    // On document, not the splitter: works whether or not the capture took.
    document.addEventListener('pointermove', function (e) { if (dragging) moveTo(e.clientX); });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveSplit();
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    sp.addEventListener('dblclick', function () { applySplit(SPLIT_DEFAULT); saveSplit(); });
    sp.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowLeft') applySplit(clampSplit(splitPct) - step);
      else if (e.key === 'ArrowRight') applySplit(clampSplit(splitPct) + step);
      else if (e.key === 'Home') applySplit(SPLIT_DEFAULT);
      else return;
      e.preventDefault();
      saveSplit();
    });
    window.addEventListener('resize', function () { applySplit(splitPct); }); // re-clamp, keep the intent
  })();

  // ---- toolbar wiring ----------------------------------------------------
  $('btn-record').addEventListener('click', function () {
    recording = !recording;
    $('btn-record').classList.toggle('paused', !recording);
    $('rec-label').textContent = recording ? 'Recording' : 'Paused';
  });
  $('btn-clear').addEventListener('click', function () { clearAll(); sendPort({ type: GQLOP.M_CLEAR_BUFFER }); });
  $('chk-preserve').addEventListener('change', function () { preserveLog = $('chk-preserve').checked; });
  $('filter').addEventListener('input', function () { filterText = $('filter').value.trim().toLowerCase(); reRenderList(); });
  // Scoped to the toolbar — the search pane has its own chips with their own handler.
  Array.prototype.forEach.call(document.querySelectorAll('#toolbar .chip'), function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('#toolbar .chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      filterMode = chip.getAttribute('data-f');
      reRenderList();
    });
  });
  $('dup-window').addEventListener('change', function () {
    dupWindowMs = parseInt($('dup-window').value, 10) || GQLDupes.DEFAULT_WINDOW_MS;
    recomputeDupes();
    if (selectedId && byId[selectedId]) renderDetail(byId[selectedId]);
  });

  // ---- export / import ---------------------------------------------------
  $('btn-export').addEventListener('click', function () {
    if (!records.length) { toast('Nothing to export'); return; }
    var payload = { tool: 'graphql-operator', version: 1, exportedAt: new Date().toISOString(), operations: records };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'graphql-operator-' + records.length + '-ops.json' });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 0);
    toast('Exported ' + records.length + ' operations');
  });
  $('btn-import').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function () {
    var file = $('import-file').files && $('import-file').files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var ops = Array.isArray(data) ? data : (data && data.operations);
        if (!Array.isArray(ops)) throw new Error('no operations array');
        var n = 0;
        ops.forEach(function (op) {
          if (!op || !op.id) return;
          op.imported = true;
          if (byId[op.id]) op.id = op.id + '_imp' + (++n); else n++;
          addRecord(op, true);
        });
        toast('Imported ' + n + ' operations');
      } catch (e) { toast('Import failed: ' + e.message, true); }
      $('import-file').value = '';
    };
    reader.readAsText(file);
  });

  // tabs
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () { activateTab(tab.getAttribute('data-tab')); });
  });

  // backdrops: click outside modal closes
  ['editor-backdrop', 'rules-backdrop', 'rule-backdrop'].forEach(function (id) {
    $(id).addEventListener('mousedown', function (e) { if (e.target === $(id)) $(id).classList.add('hidden'); });
  });

  // ---- toast -------------------------------------------------------------
  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3000);
  }

  // ---- go ----------------------------------------------------------------
  dupWindowMs = parseInt($('dup-window').value, 10) || GQLDupes.DEFAULT_WINDOW_MS; // browsers restore <select> state on reload
  connectPort();
  loadRules();
  updateCount();
})();
