/*
 * dupes.js — "this exact call just happened" detection.
 *
 * Two requests are duplicates when they carry the *same payload* (URL, method,
 * operation name, query text and variables) and land within a short time
 * window of each other — the signature of a component re-rendering, an effect
 * firing twice, or two subscribers each kicking off the same fetch.
 *
 * Pure logic, no DOM. Exposes GQLDupes = { DEFAULT_WINDOW_MS, WINDOWS,
 * signature, eligible, cluster, infoFor, analyze }. Also exports for Node so it
 * can be unit-tested.
 */
(function (root) {
  'use strict';

  var DEFAULT_WINDOW_MS = 1000;
  var WINDOWS = [250, 500, 1000, 2000, 5000];

  // Field / entry / header separators — bytes that cannot occur in a payload.
  var SEP = String.fromCharCode(1), OP_SEP = String.fromCharCode(2), HEAD_SEP = String.fromCharCode(3);

  // Formatting must not change the signature: `query A{b}` == `query A { b }`.
  // Whitespace inside string literals is normalized too — two queries that
  // differ only there are treated as one, which is the right call here.
  function normQuery(q) {
    return String(q == null ? '' : q)
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}()[\]:,!$@=])\s*/g, '$1')
      .trim();
  }

  // Stable JSON — key order must not change the signature either, since the key
  // order of a serialized payload is not something the caller controls.
  function canon(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canon(v[k]);
    }).join(',') + '}';
  }

  // The identity of a request's payload; null when there is nothing to compare.
  function signature(rec) {
    if (!rec) return null;
    var entries = rec.entries || [];
    var identifying = '';
    var parts = entries.map(function (e) {
      e = e || {};
      identifying += (e.operationName || '') + normQuery(e.query);
      return [e.operationName || '', normQuery(e.query), canon(e.variables)].join(SEP);
    });
    var body = parts.join(OP_SEP);
    // Persisted queries send a hash instead of query text — two different ones
    // can share a name and variables, so fall back to the raw payload for those.
    if (!entries.length || entries.some(function (e) { return !e || !e.query; })) {
      var raw = normQuery(rec.requestBody);
      identifying += raw;
      body += OP_SEP + 'raw:' + raw;
    }
    if (!identifying) return null; // no name, no query, no body — nothing to compare
    return (rec.method || 'POST').toUpperCase() + ' ' + (rec.url || '') + HEAD_SEP + body;
  }

  // Resends are the user deliberately firing the same request again — flagging
  // those as suspicious would be noise.
  function eligible(rec) {
    return !!rec && !rec.isResent && typeof rec.ts === 'number' && isFinite(rec.ts);
  }

  // Clusters records that already share a signature. A cluster is a run whose
  // members all start within `windowMs` of the run's *first* member, so a steady
  // poll slower than the window never collapses into one endless group.
  function cluster(recs, windowMs) {
    windowMs = windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
    var list = (recs || []).filter(eligible).slice().sort(function (a, b) { return a.ts - b.ts; });
    var out = [], cur = null;
    list.forEach(function (r) {
      if (cur && (r.ts - cur[0].ts) <= windowMs) cur.push(r);
      else { cur = [r]; out.push(cur); }
    });
    return out;
  }

  // Per-record duplicate facts for one cluster of 2+ identical calls.
  // -> { id -> { size, index (1-based), gapMs (since the previous, null for #1), ids } }
  function infoFor(c) {
    var ids = c.map(function (r) { return r.id; });
    var out = {};
    c.forEach(function (r, i) {
      out[r.id] = { size: c.length, index: i + 1, gapMs: i ? (r.ts - c[i - 1].ts) : null, ids: ids };
    });
    return out;
  }

  // Whole-list pass. The panel indexes incrementally instead (see panel.js), but
  // this returns the same answer in one call — for tests and one-off analysis.
  // -> { info: {id -> info}, dupCount, groups }
  function analyze(records, windowMs) {
    var buckets = Object.create(null);
    (records || []).forEach(function (rec) {
      if (!eligible(rec)) return;
      var sig = signature(rec);
      if (!sig) return;
      (buckets[sig] = buckets[sig] || []).push(rec);
    });
    var info = Object.create(null), dupCount = 0, groups = 0;
    Object.keys(buckets).forEach(function (sig) {
      cluster(buckets[sig], windowMs).forEach(function (c) {
        if (c.length < 2) return;
        groups++;
        var part = infoFor(c);
        Object.keys(part).forEach(function (id) { info[id] = part[id]; dupCount++; });
      });
    });
    return { info: info, dupCount: dupCount, groups: groups };
  }

  var api = {
    DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
    WINDOWS: WINDOWS,
    signature: signature,
    eligible: eligible,
    cluster: cluster,
    infoFor: infoFor,
    analyze: analyze
  };
  root.GQLDupes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
