/*
 * search.js — cross-request text search behind the panel's "Search all" pane.
 *
 * Pure logic, no DOM: builds the searchable text of a record exactly the way
 * the detail pane renders it (formatted GraphQL / pretty-printed JSON) so the
 * line numbers reported here line up with the rows of the code viewer, and a
 * hit can scroll straight to its line.
 *
 * Exposes GQLSearch = { fieldsFor, buildMatcher, matchRanges, searchRecord,
 * searchAll }. Also exports for Node so it can be unit-tested.
 */
(function (root) {
  'use strict';

  var MAX_PER_FIELD = 40;    // line hits listed per field (rest are counted only)
  var MAX_PER_RECORD = 200;
  var MAX_PER_LINE = 500;    // ranges per line — guards pathological patterns

  function prettyJson(text) {
    if (typeof text !== 'string') { try { return JSON.stringify(text, null, 2); } catch (e) { return String(text); } }
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }
  function fmtQuery(q) {
    if (!q) return '';
    if (root.GQLCode && root.GQLCode.formatGraphQL) { try { return root.GQLCode.formatGraphQL(q); } catch (e) {} }
    return String(q);
  }
  function headerLines(h) {
    if (!h || typeof h !== 'object') return '';
    return Object.keys(h).map(function (k) { return k + ': ' + h[k]; }).join('\n');
  }

  // The searchable surface of one record, mirroring how the detail pane lays it
  // out. `tab` is the detail tab a hit lives in; `sk` links the field back to
  // its code block (see the data-sk attributes set in panel.js).
  function fieldsFor(rec) {
    var out = [];
    function add(f) { if (f.text) out.push(f); }
    add({ key: 'name', label: 'Operation', scope: 'meta', tab: 'request', text: rec.operationName || '', single: true });
    add({ key: 'url', label: 'URL', scope: 'meta', tab: 'meta', text: [rec.method, rec.url].filter(Boolean).join(' '), single: true });

    var entries = rec.entries || [];
    var sawEntryText = false;
    entries.forEach(function (e, i) {
      if (!e) return;
      var sfx = entries.length > 1 ? ' #' + (i + 1) : '';
      if (e.query) { sawEntryText = true; add({ key: 'query', label: 'Query' + sfx, scope: 'query', tab: 'request', sk: 'q' + i, text: fmtQuery(e.query) }); }
      if (e.variables != null) { sawEntryText = true; add({ key: 'vars', label: 'Variables' + sfx, scope: 'vars', tab: 'request', sk: 'v' + i, text: prettyJson(e.variables) }); }
    });
    // Raw body is searched only when the parsed entries carry no text (persisted
    // queries, odd payloads) — otherwise every hit would be reported twice.
    if (rec.requestBody && !sawEntryText) add({ key: 'reqbody', label: 'Request body', scope: 'vars', tab: 'request', sk: 'rb', text: prettyJson(rec.requestBody) });

    if (rec.responseBody) add({ key: 'response', label: 'Response', scope: 'response', tab: 'response', sk: 'res', text: prettyJson(rec.responseBody) });
    if (rec.error) add({ key: 'error', label: 'Error', scope: 'response', tab: 'response', text: String(rec.error), single: true });
    add({ key: 'reqheaders', label: 'Request header', scope: 'headers', tab: 'headers', text: headerLines(rec.requestHeaders) });
    add({ key: 'resheaders', label: 'Response header', scope: 'headers', tab: 'headers', text: headerLines(rec.responseHeaders) });
    return out;
  }

  // Throws on an invalid regex so the caller can surface the message.
  function buildMatcher(term, opts) {
    opts = opts || {};
    if (!term) return null;
    if (opts.regex) return { re: new RegExp(term, opts.caseSensitive ? 'g' : 'gi') };
    return { needle: opts.caseSensitive ? term : term.toLowerCase(), ci: !opts.caseSensitive };
  }

  // [[start, end], …] for every match in one line; empty array when none.
  function matchRanges(matcher, line) {
    var out = [];
    if (!matcher || line == null) return out;
    line = String(line);
    if (matcher.re) {
      matcher.re.lastIndex = 0;
      var m;
      while ((m = matcher.re.exec(line)) !== null) {
        out.push([m.index, m.index + m[0].length]);
        if (!m[0].length) matcher.re.lastIndex++; // zero-width match — don't spin
        if (out.length >= MAX_PER_LINE) break;
      }
      return out;
    }
    var hay = matcher.ci ? line.toLowerCase() : line;
    var n = matcher.needle.length;
    var at = hay.indexOf(matcher.needle);
    while (at !== -1) {
      out.push([at, at + n]);
      at = hay.indexOf(matcher.needle, at + n);
      if (out.length >= MAX_PER_LINE) break;
    }
    return out;
  }

  function inScope(field, scope) { return !scope || scope === 'all' || field.scope === scope; }

  // -> { matches: [{field, line, text, ranges}], total }
  // `total` counts every occurrence; `matches` is capped for rendering.
  function searchRecord(rec, matcher, opts) {
    opts = opts || {};
    var maxField = opts.maxPerField || MAX_PER_FIELD;
    var maxRec = opts.maxPerRecord || MAX_PER_RECORD;
    var fields = (opts.fieldsFor || fieldsFor)(rec);
    var matches = [], total = 0;
    fields.forEach(function (f) {
      if (!inScope(f, opts.scope)) return;
      var lines = String(f.text).split('\n');
      var kept = 0;
      for (var ln = 0; ln < lines.length; ln++) {
        var ranges = matchRanges(matcher, lines[ln]);
        if (!ranges.length) continue;
        total += ranges.length;
        if (kept < maxField && matches.length < maxRec) {
          matches.push({ field: f, line: ln, text: lines[ln], ranges: ranges });
          kept++;
        }
      }
    });
    return { matches: matches, total: total };
  }

  // -> { groups: [{rec, matches, total}], totalMatches }  (record order preserved)
  function searchAll(records, matcher, opts) {
    var groups = [], totalMatches = 0;
    (records || []).forEach(function (rec) {
      if (!rec) return;
      var r = searchRecord(rec, matcher, opts);
      if (!r.matches.length) return;
      totalMatches += r.total;
      groups.push({ rec: rec, matches: r.matches, total: r.total });
    });
    return { groups: groups, totalMatches: totalMatches };
  }

  var api = {
    fieldsFor: fieldsFor,
    buildMatcher: buildMatcher,
    matchRanges: matchRanges,
    searchRecord: searchRecord,
    searchAll: searchAll
  };
  root.GQLSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
