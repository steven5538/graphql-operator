/*
 * wire.js — the headers a request *actually* left the browser with.
 *
 * The interceptor in injected.js only sees what the page handed to
 * fetch()/XHR. Everything the network stack adds afterwards — Cookie,
 * Authorization injected by a service worker, User-Agent, Origin, Referer,
 * sec-* — is invisible from the page. DevTools does see those, so the panel
 * feeds every finished network request through here (via
 * chrome.devtools.network.onRequestFinished) and we pair it back up with the
 * recorded operation. That pairing is what makes "Copy as cURL" a command you
 * can actually paste into a terminal and have the server accept.
 *
 * Pure functions + a bounded store: no chrome APIs, so it is unit-testable.
 */
(function (glob) {
  'use strict';

  var MAX_ENTRIES = 400;          // ring buffer; a busy app fires a lot of XHRs
  var MAX_BODY = 512 * 1024;      // don't hoard megabyte uploads
  var PREFIX_CMP = 512;           // chars compared when the record body was truncated

  // Headers curl derives itself, or that would make a replay lie.
  // Cookie is not "dropped" — it is emitted separately as -b.
  var SKIP_HEADERS = {
    'cookie': 1, 'content-length': 1, 'host': 1, 'connection': 1,
    'keep-alive': 1, 'transfer-encoding': 1, 'proxy-connection': 1
  };

  function lower(s) { return String(s || '').toLowerCase(); }

  // Hash never reaches the server, so it must not affect matching.
  function stripHash(u) {
    var s = String(u || '');
    var i = s.indexOf('#');
    return i === -1 ? s : s.slice(0, i);
  }

  // XHR records keep whatever the page passed to open() — often a bare
  // "/graphql" — while HAR entries are always absolute. Comparing
  // path+query lets the two meet in the middle.
  function pathKey(u) {
    try {
      var url = new URL(String(u || ''), 'http://gqlop.invalid');
      return url.pathname + url.search;
    } catch (e) {
      return stripHash(u);
    }
  }

  function cookieHeaderOf(req) {
    var hs = req.headers || [];
    for (var i = 0; i < hs.length; i++) {
      if (lower(hs[i].name) === 'cookie' && hs[i].value) return hs[i].value;
    }
    // Some HAR producers only fill request.cookies — rebuild the header from it.
    var cs = req.cookies || [];
    var pairs = [];
    for (var j = 0; j < cs.length; j++) {
      if (cs[j] && cs[j].name) pairs.push(cs[j].name + '=' + (cs[j].value == null ? '' : cs[j].value));
    }
    return pairs.length ? pairs.join('; ') : null;
  }

  /* Flatten a HAR entry down to the parts we need. Returns null for entries
   * that can't be a recorded GraphQL call. */
  function normalizeEntry(harEntry) {
    var req = harEntry && harEntry.request;
    if (!req || !req.url) return null;
    // _resourceType is a Chrome extension to HAR; when present, only
    // fetch/XHR can be one of our records.
    var rt = harEntry._resourceType;
    if (rt && rt !== 'xhr' && rt !== 'fetch') return null;

    var headers = (req.headers || [])
      .filter(function (h) { return h && h.name && h.name.charAt(0) !== ':'; }) // drop :method/:authority pseudo-headers
      .map(function (h) { return { name: String(h.name), value: h.value == null ? '' : String(h.value) }; });

    var body = null;
    if (req.postData && typeof req.postData.text === 'string') body = req.postData.text.slice(0, MAX_BODY);

    return {
      url: stripHash(req.url),
      path: pathKey(req.url),
      method: lower(req.method || 'get').toUpperCase(),
      headers: headers,
      cookie: cookieHeaderOf(req),
      body: body,
      started: Date.parse(harEntry.startedDateTime) || 0,
      recId: null // set when a record claims this entry
    };
  }

  /* Same operation fired twice produces two identical records AND two
   * identical entries; body equality can't tell them apart, so an entry is
   * claimed by the first record that takes it and later records prefer a
   * free one. */
  function bodyMatches(rec, entry) {
    var rb = rec.requestBody;
    if (typeof rb !== 'string' || !rb || entry.body == null) return false;
    if (rec.requestBodyTruncated) {
      var n = Math.min(rb.length, PREFIX_CMP);
      return entry.body.slice(0, n) === rb.slice(0, n);
    }
    return entry.body === rb;
  }

  function entryKey(e) {
    return e.method + ' ' + e.url + ' ' + e.started + ' ' + (e.body == null ? -1 : e.body.length);
  }

  function createStore() {
    var entries = [];
    var byRec = Object.create(null); // record id -> entry (stable across repeat lookups)
    var seen = Object.create(null);  // dedupe: getHAR() backfill overlaps the live feed

    return {
      add: function (harEntry) {
        var e = normalizeEntry(harEntry);
        if (!e) return null;
        var key = entryKey(e);
        if (seen[key]) return null;
        seen[key] = 1;
        entries.push(e);
        if (entries.length > MAX_ENTRIES) {
          var gone = entries.shift(); // byRec still holds any claimed ref
          delete seen[entryKey(gone)];
        }
        return e;
      },
      clear: function () { entries = []; byRec = Object.create(null); seen = Object.create(null); },
      size: function () { return entries.length; },

      /* Best wire entry for a record, or null when DevTools never saw it
       * (blocked, overridden, imported from a file, or recorded before the
       * panel was opened). */
      match: function (rec) {
        if (!rec) return null;
        if (rec.id && byRec[rec.id]) return byRec[rec.id];

        var method = lower(rec.method || 'post').toUpperCase();
        var absolute = stripHash(rec.url);
        var path = pathKey(rec.url);

        // A record whose body we know must never be paired with an entry
        // carrying a different one: everything downstream (the cURL body most
        // of all) would then describe someone else's request. Only when a body
        // is unavailable on either side do we fall back to timing.
        var haveBody = typeof rec.requestBody === 'string' && !!rec.requestBody;

        var best = null, bestScore = -1, bestDist = Infinity;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (e.method !== method) continue;
          if (e.url !== absolute && e.path !== path) continue;
          var comparable = haveBody && e.body != null;
          if (comparable && !bodyMatches(rec, e)) continue;
          // Among equals (two identical calls) an unclaimed entry wins.
          var score = (comparable ? 2 : 0) + (e.recId ? 0 : 1);
          var dist = Math.abs((e.started || 0) - (rec.ts || 0));
          if (score > bestScore || (score === bestScore && dist < bestDist)) {
            best = e; bestScore = score; bestDist = dist;
          }
        }
        if (best) {
          if (rec.id) byRec[rec.id] = best;
          if (!best.recId) best.recId = rec.id || '?';
        }
        return best;
      }
    };
  }

  // ---- cURL -------------------------------------------------------------
  function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  function headerPairs(rec, entry) {
    if (entry) return entry.headers;
    var h = rec.requestHeaders || {};
    return Object.keys(h).map(function (k) { return { name: k, value: h[k] == null ? '' : String(h[k]) }; });
  }

  /* Build a paste-ready command. With a wire entry this carries the real
   * cookies and browser headers; without one it degrades to the page-visible
   * headers we used to emit. */
  function buildCurl(rec, entry) {
    rec = rec || {};
    var url = (entry && entry.url) || rec.url || '';
    var method = ((entry && entry.method) || rec.method || 'POST').toUpperCase();

    // Prefer the wire body: a rewrite rule may have changed it, and DevTools
    // keeps it whole where our own capture may have truncated it.
    var body = null;
    if (entry && entry.body != null && entry.body !== '') body = entry.body;
    else if (typeof rec.requestBody === 'string' && rec.requestBody) body = rec.requestBody;

    var pairs = headerPairs(rec, entry);
    var cookie = entry ? entry.cookie : null;
    var compressed = false;

    var parts = ['curl ' + shellQuote(url)];
    // curl infers POST from --data-raw and GET from its absence.
    if (!(method === 'POST' && body != null) && !(method === 'GET' && body == null)) {
      parts.push('-X ' + method);
    }
    pairs.forEach(function (h) {
      var name = lower(h.name);
      if (SKIP_HEADERS[name]) {
        if (name === 'cookie' && !cookie) cookie = h.value; // page-set cookie header (rare)
        return;
      }
      if (name === 'accept-encoding') compressed = true; // else curl prints the compressed bytes
      parts.push('-H ' + shellQuote(h.name + ': ' + h.value));
    });
    if (cookie) parts.push('-b ' + shellQuote(cookie));
    // --data-raw, not --data: a body starting with @ must not be read as a file.
    if (body != null) parts.push('--data-raw ' + shellQuote(body));
    if (compressed) parts.push('--compressed');

    return parts.join(' \\\n  ');
  }

  glob.GQLWire = {
    createStore: createStore,
    normalizeEntry: normalizeEntry,
    buildCurl: buildCurl,
    pathKey: pathKey
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
