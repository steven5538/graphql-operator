/*
 * codeview.js — dependency-free GraphQL/JSON pretty-printer + collapsible,
 * syntax-highlighted code viewer used by the DevTools panel.
 *
 * Exposes GQLCode = { formatGraphQL, computeFoldRanges, highlightGraphQLLine,
 * highlightJsonLine, renderFoldableCode, copyInfo }. Also exports for Node so
 * the formatter can be unit-tested.
 */
(function (root) {
  'use strict';

  // ---- GraphQL tokenizer -------------------------------------------------
  function tokenize(src) {
    var toks = [], i = 0, n = src.length;
    var isNameStart = function (c) { return /[_A-Za-z]/.test(c); };
    var isName = function (c) { return /[_0-9A-Za-z]/.test(c); };
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
      if (c === '#') { var s = i; while (i < n && src[i] !== '\n') i++; toks.push({ t: 'comment', v: src.slice(s, i) }); continue; }
      if (c === '"') {
        if (src.substr(i, 3) === '"""') {
          var j = i + 3; while (j < n && src.substr(j, 3) !== '"""') j++; j = Math.min(n, j + 3);
          toks.push({ t: 'string', v: src.slice(i, j) }); i = j; continue;
        }
        var k = i + 1; while (k < n) { if (src[k] === '\\') { k += 2; continue; } if (src[k] === '"') { k++; break; } k++; }
        toks.push({ t: 'string', v: src.slice(i, k) }); i = k; continue;
      }
      if (src.substr(i, 3) === '...') { toks.push({ t: 'punct', v: '...' }); i += 3; continue; }
      if ('{}()[]:!=@|&$'.indexOf(c) !== -1) { toks.push({ t: 'punct', v: c }); i++; continue; }
      if (isNameStart(c)) { var m = i + 1; while (m < n && isName(src[m])) m++; toks.push({ t: 'name', v: src.slice(i, m) }); i = m; continue; }
      var p = i + 1; while (p < n && /[-+0-9.eE]/.test(src[p])) p++; toks.push({ t: 'other', v: src.slice(i, Math.max(p, i + 1)) }); i = Math.max(p, i + 1);
    }
    return toks;
  }

  var KEYWORDS = /^(query|mutation|subscription|fragment|on)$/;

  // ---- GraphQL formatter -------------------------------------------------
  // Produces 2-space-indented output; fields inside selection sets go on their
  // own line, args/directives stay inline, and each fragment definition sits
  // on its own foldable block.
  function formatGraphQL(src) {
    if (typeof src !== 'string' || !src.trim()) return src || '';
    try {
      var toks = tokenize(src);
      var lines = [], cur = '', indent = 0, paren = 0, inlineNext = false;
      function push() { lines.push(new Array(indent + 1).join('  ') + cur); cur = ''; }
      function needSpace(v) {
        if (!cur.length) return false;
        if (/[\s(\[@$.!]$/.test(cur)) return v === 'on' && /\.\.\.$/.test(cur); // "... on"
        return true;
      }
      for (var idx = 0; idx < toks.length; idx++) {
        var tok = toks[idx], v = tok.v, t = tok.t;
        if (t === 'comment') { if (cur.trim()) push(); cur = v; push(); inlineNext = false; continue; }
        if (v === '{') { cur += ' {'; push(); indent++; inlineNext = false; continue; }
        if (v === '}') { if (cur.trim()) push(); indent = Math.max(0, indent - 1); cur = '}'; push(); inlineNext = false; continue; }
        if (v === '(') { paren++; cur += '('; inlineNext = true; continue; }
        if (v === ')') { paren = Math.max(0, paren - 1); cur += ')'; inlineNext = false; continue; }
        if (v === '[') { paren++; cur += '['; inlineNext = true; continue; }
        if (v === ']') { paren = Math.max(0, paren - 1); cur += ']'; inlineNext = false; continue; }
        if (v === ':') { cur += ': '; inlineNext = true; continue; }
        if (v === '!') { cur += '!'; continue; }
        if (v === '=') { cur += ' = '; inlineNext = true; continue; }
        if (v === '@') { cur += ' @'; inlineNext = true; continue; }
        if (v === '|' || v === '&') { cur += ' ' + v + ' '; inlineNext = true; continue; }
        if (v === '$') { cur += (cur && !/[\s(\[]$/.test(cur) ? ' ' : '') + '$'; inlineNext = true; continue; }
        if (v === '...') { if (cur.trim()) push(); cur = '...'; inlineNext = true; continue; }
        // name / string / other value
        var fieldStart = !inlineNext && paren === 0 && indent > 0;
        if (fieldStart && cur.trim()) push();
        if (needSpace(v)) cur += ' ';
        cur += v;
        inlineNext = (t === 'name' && KEYWORDS.test(v));
      }
      if (cur.trim()) push();
      var out = lines.join('\n');
      return out.trim() ? out : src;
    } catch (e) { return src; }
  }

  // ---- fold ranges (string-aware bracket matching) -----------------------
  // Returns [{open, close}] line-index pairs for multi-line {..} / [..] blocks.
  function computeFoldRanges(text, lang) {
    var ranges = [], stack = [], line = 0, i = 0, n = text.length;
    var isGql = lang === 'graphql';
    while (i < n) {
      var c = text[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === '"') {
        if (isGql && text.substr(i, 3) === '"""') {
          i += 3; while (i < n && text.substr(i, 3) !== '"""') { if (text[i] === '\n') line++; i++; } i += 3; continue;
        }
        i++; while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; } i++; continue;
      }
      if (isGql && c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
      if (c === '{' || c === '[') { stack.push({ open: line }); i++; continue; }
      if (c === '}' || c === ']') { var top = stack.pop(); if (top && line > top.open) ranges.push({ open: top.open, close: line }); i++; continue; }
      i++;
    }
    return ranges;
  }

  // ---- line highlighters (return [{v, c}] token runs) --------------------
  function highlightGraphQLLine(line) {
    var re = /(#[^\n]*)|("""[\s\S]*?"""|"(?:\\.|[^"\\])*"|"[^"]*$)|\b(query|mutation|subscription|fragment|on)\b|(\$[_A-Za-z][_0-9A-Za-z]*)|(@[_A-Za-z][_0-9A-Za-z]*)|([_A-Za-z][_0-9A-Za-z]*)|([{}()\[\]:!=|&]+|\.\.\.)|(\s+)|([\s\S])/g;
    return runTokens(line, re, function (m) {
      if (m[1]) return 'c'; if (m[2]) return 's'; if (m[3]) return 'k'; if (m[4]) return 'v';
      if (m[5]) return 'd'; if (m[6]) return 'n'; if (m[7]) return 'p'; return null;
    });
  }
  function highlightJsonLine(line) {
    var toks = [];
    var re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],:])|(\s+)|([\s\S])/g;
    var m;
    while ((m = re.exec(line)) !== null) {
      if (m[1]) { toks.push({ v: m[1], c: m[2] ? 'key' : 's' }); if (m[2]) toks.push({ v: m[2], c: 'p' }); }
      else if (m[3]) toks.push({ v: m[3], c: 'k' });
      else if (m[4]) toks.push({ v: m[4], c: 'num' });
      else if (m[5]) toks.push({ v: m[5], c: 'p' });
      else toks.push({ v: m[0], c: null });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return toks;
  }
  function runTokens(line, re, classify) {
    var toks = [], m;
    while ((m = re.exec(line)) !== null) {
      toks.push({ v: m[0], c: classify(m) });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return toks;
  }

  // ---- copy helpers -------------------------------------------------------
  // Everything needed to copy one piece of a document: the value under a line,
  // that value with its key, and (for JSON) the path that leads to it. They all
  // work on the *formatted* lines, so what you copy is exactly what you see.
  var JSON_KEY = /^\s*"((?:\\.|[^"\\])*)"\s*:[ \t]?/;

  function indentOf(s) { return /^[ \t]*/.exec(s)[0].length; }
  function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  // The value on a leaf line, without the comma that separates it from the next
  // entry — a comma *inside* a string has to survive.
  function valueToken(v) {
    if (v.charAt(0) === '"') { var m = /^"(?:\\.|[^"\\])*"/.exec(v); if (m) return m[0]; }
    return v.replace(/,\s*$/, '');
  }

  // What to call this line in a menu / toast: the JSON key, or the GraphQL field.
  function keyAt(line, lang) {
    line = line || '';
    if (lang === 'json') { var m = JSON_KEY.exec(line); return m ? tryParse('"' + m[1] + '"') : null; }
    var g = /^\s*(?:\.\.\.\s*(?:on\s+)?)?([_A-Za-z][_0-9A-Za-z]*)/.exec(line);
    return g ? g[1] : null;
  }

  // The text of the block starting on line `i` — its whole subtree when that
  // line opens one — dedented so it stands on its own. In JSON the key is kept
  // only when asked for, and a lone string is unquoted: pasting `abc-123`
  // somewhere else is the point, `"abc-123"` rarely is.
  function textAt(lines, closeOf, i, lang, withKey) {
    var end = closeOf[i] != null ? closeOf[i] : i;
    var base = indentOf(lines[i] || '');
    var out = [];
    for (var n = i; n <= end && n < lines.length; n++) {
      out.push(lines[n].slice(Math.min(base, indentOf(lines[n]))));
    }
    if (end > i) out[out.length - 1] = out[out.length - 1].replace(/,$/, ''); // a closer, never a string
    if (lang !== 'json') return out.join('\n');

    var m = JSON_KEY.exec(out[0]);
    if (end > i) {
      if (m && !withKey) out[0] = out[0].slice(m[0].length);
      return out.join('\n');
    }
    var val = valueToken(m ? out[0].slice(m[0].length) : out[0].replace(/^\s+/, ''));
    if (withKey && m) return '"' + m[1] + '": ' + val;
    if (val.charAt(0) === '"') { var s = tryParse(val); if (s != null) return s; }
    return val;
  }

  // "data.user.tags[0]" for the entry on line `i`. Walks the lines above it,
  // tracking open containers by indentation (pretty-printed JSON is regular
  // enough that this needs no parser).
  function jsonPathAt(lines, i) {
    var stack = [];  // one frame per open container: { at, isArray, count }
    var path = [];   // the segment each open container hangs off
    for (var n = 0; n <= i && n < lines.length; n++) {
      var t = (lines[n] || '').replace(/^\s+/, '');
      if (!t) continue;
      var ind = indentOf(lines[n]);
      if (t.charAt(0) === '}' || t.charAt(0) === ']') {
        if (n === i) return renderPath(path);   // a closer names the block it ends
        while (stack.length && stack[stack.length - 1].at >= ind) { stack.pop(); path.pop(); }
        continue;
      }
      while (stack.length && stack[stack.length - 1].at >= ind) { stack.pop(); path.pop(); }
      var top = stack[stack.length - 1];
      var km = JSON_KEY.exec(t);
      var seg = km ? { key: tryParse('"' + km[1] + '"') } : (top && top.isArray ? { index: top.count } : null);
      if (top) top.count++;
      if (n === i) return renderPath(path.concat([seg]));
      var last = t.replace(/,\s*$/, '').slice(-1);
      if (last === '{' || last === '[') { stack.push({ at: ind, isArray: last === '[', count: 0 }); path.push(seg); }
    }
    return '';
  }
  function renderPath(segs) {
    var s = '';
    segs.forEach(function (g) {
      if (!g) return;
      if (g.index != null) s += '[' + g.index + ']';
      else if (/^[A-Za-z_$][\w$]*$/.test(g.key)) s += (s ? '.' : '') + g.key;
      else s += '[' + JSON.stringify(g.key) + ']';
    });
    return s;
  }

  function copyInfoAt(lines, closeOf, i, lang) {
    var isBlock = closeOf[i] != null;
    return {
      line: i,
      lang: lang,
      isBlock: isBlock,
      lineCount: isBlock ? closeOf[i] - i + 1 : 1,
      key: keyAt(lines[i], lang),
      value: textAt(lines, closeOf, i, lang, false),
      withKey: textAt(lines, closeOf, i, lang, true),
      path: lang === 'json' ? jsonPathAt(lines, i) : '',
      all: lines.join('\n')
    };
  }

  // Same thing from raw text — formats first, so line numbers line up with what
  // renderFoldableCode() shows.
  function copyInfo(text, lang, line) {
    var formatted = lang === 'graphql' ? formatGraphQL(text) : String(text);
    var lines = formatted.split('\n');
    var closeOf = {};
    computeFoldRanges(formatted, lang).forEach(function (r) {
      if (closeOf[r.open] == null || r.close > closeOf[r.open]) closeOf[r.open] = r.close;
    });
    return copyInfoAt(lines, closeOf, line, lang);
  }

  // ---- DOM renderer (browser only) ---------------------------------------
  function renderFoldableCode(text, lang, opts) {
    opts = opts || {};
    var doc = root.document;
    var formatted = lang === 'graphql' ? formatGraphQL(text) : text;
    var lines = String(formatted).split('\n');
    var ranges = computeFoldRanges(formatted, lang);
    var closeOf = {};        // openLine -> closeLine (for header lines)
    ranges.forEach(function (r) { if (closeOf[r.open] == null || r.close > closeOf[r.open]) closeOf[r.open] = r.close; });
    var collapsed = {};      // openLine -> true; everything starts expanded
    // Blocks that open at column 0 (the JSON root, a GraphQL operation or
    // fragment definition) stay open on "collapse all", so it leaves an outline
    // one level deep instead of a single `{ … }`.
    var nested = Object.keys(closeOf).map(Number).filter(function (o) { return indentOf(lines[o]) > 0; });

    var wrap = doc.createElement('div');
    wrap.className = 'codeview';
    var rowEls = [];
    var gutters = {};        // openLine -> its fold arrow
    var highlight = lang === 'graphql' ? highlightGraphQLLine : highlightJsonLine;

    function svg(tag, attrs) {
      var e = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
    function icon(kind) {
      var s = svg('svg', { viewBox: '0 0 16 16', width: '11', height: '11', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      if (kind === 'check') { s.appendChild(svg('path', { d: 'M2.5 8.5 6 12 13.5 4' })); return s; }
      s.appendChild(svg('rect', { x: '5.6', y: '5.6', width: '9.6', height: '9.6', rx: '2' }));
      s.appendChild(svg('path', { d: 'M10.4 4.4V2.8a2 2 0 0 0-2-2H2.8a2 2 0 0 0-2 2v5.6a2 2 0 0 0 2 2h1.6' }));
      return s;
    }
    // Hovering the button previews exactly what a click will copy.
    function preview(i, on) {
      var end = closeOf[i] != null ? closeOf[i] : i;
      for (var n = i; n <= end && n < rowEls.length; n++) rowEls[n].classList.toggle('cv-copyhi', on);
    }
    function copyButton(i) {
      var btn = doc.createElement('span');
      btn.className = 'cv-copy';
      btn.setAttribute('role', 'button');
      btn.appendChild(icon('copy'));
      var info = null; // computed on demand — cheap per row, but there can be thousands
      function describe() {
        info = info || copyInfoAt(lines, closeOf, i, lang);
        btn.title = (info.isBlock ? 'Copy this block (' + info.lineCount + ' lines)' : 'Copy this value') +
          (info.key ? ' — ' + info.key : '') + '   ·   right-click for more';
        return info;
      }
      btn.addEventListener('mouseenter', function () { describe(); preview(i, true); });
      btn.addEventListener('mouseleave', function () { preview(i, false); });
      btn.addEventListener('click', function () {
        var nfo = describe();
        if (opts.copy) opts.copy(nfo.value, nfo);
        else if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(nfo.value);
        btn.textContent = '';
        btn.appendChild(icon('check'));
        btn.classList.add('cv-copied');
        setTimeout(function () {
          btn.textContent = '';
          btn.appendChild(icon('copy'));
          btn.classList.remove('cv-copied');
        }, 1000);
      });
      return btn;
    }

    lines.forEach(function (ln, i) {
      var row = doc.createElement('div');
      row.className = 'cv-row';
      var gutter = doc.createElement('span');
      gutter.className = 'cv-gutter';
      if (closeOf[i] != null) {
        gutter.classList.add('cv-foldable');
        gutters[i] = gutter;
        gutter.addEventListener('click', function () {
          collapsed[i] = !collapsed[i];
          update();
        });
      }
      row.appendChild(gutter);
      row.appendChild(copyButton(i));
      var code = doc.createElement('span');
      code.className = 'cv-code';
      highlight(ln).forEach(function (tk) {
        var sp = doc.createElement('span');
        if (tk.c) sp.className = 'cv-t-' + tk.c;
        sp.textContent = tk.v;
        code.appendChild(sp);
      });
      var ell = doc.createElement('span');
      ell.className = 'cv-ellipsis';
      ell.textContent = ' … ';
      code.appendChild(ell);
      row.appendChild(code);
      if (opts.menu) {
        row.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          opts.menu(copyInfoAt(lines, closeOf, i, lang), e.clientX, e.clientY);
        });
      }
      wrap.appendChild(row);
      rowEls.push(row);
    });

    // One pass: a row is hidden while it sits inside any folded block above it.
    // (Linear, so folding thousands of blocks at once stays instant.)
    function update() {
      var hideUntil = -1;
      for (var i = 0; i < rowEls.length; i++) {
        var folded = !!collapsed[i];
        rowEls[i].style.display = i <= hideUntil ? 'none' : '';
        rowEls[i].classList.toggle('cv-collapsed', folded);
        if (gutters[i]) gutters[i].textContent = folded ? '▸' : '▾';
        if (folded && closeOf[i] > hideUntil) hideUntil = closeOf[i];
      }
    }
    update();
    // For the panel's Expand all / Collapse all; `count` is how many blocks
    // collapseAll() folds, so a caller can skip the buttons when it's 0.
    wrap.cvFold = {
      count: nested.length,
      expandAll: function () { collapsed = {}; update(); },
      collapseAll: function () {
        collapsed = {};
        nested.forEach(function (o) { collapsed[o] = true; });
        update();
      }
    };
    return wrap;
  }

  // ---- inline fragment expansion -----------------------------------------
  // Rewrites `...FragmentName` spreads with the fragment's fields inline
  // (recursive, cycle-guarded), and drops the now-redundant fragment
  // definitions, so a fragment-heavy query reads as one expanded tree.
  function inlineFragments(src) {
    if (typeof src !== 'string' || !src.trim()) return src || '';
    try {
      var toks = tokenize(src);
      var n = toks.length;
      function matchBrace(start) { // index of '{' -> index of matching '}'
        var depth = 0;
        for (var j = start; j < n; j++) {
          if (toks[j].v === '{') depth++;
          else if (toks[j].v === '}') { depth--; if (depth === 0) return j; }
        }
        return -1;
      }
      // index fragment definitions -> inner tokens
      var frags = {};
      for (var i = 0; i < n; i++) {
        if (toks[i].t === 'name' && toks[i].v === 'fragment') {
          var fname = toks[i + 1] && toks[i + 1].v;
          var b = i + 2; while (b < n && toks[b].v !== '{') b++;
          var end = matchBrace(b);
          if (fname && b < n && end > b) frags[fname] = toks.slice(b + 1, end);
        }
      }
      if (!Object.keys(frags).length) return src; // nothing to inline

      function expand(outArr, srcToks, stack) {
        for (var k = 0; k < srcToks.length; k++) {
          var t = srcToks[k];
          if (t.t === 'punct' && t.v === '...') {
            var nameTok = srcToks[k + 1];
            if (nameTok && nameTok.t === 'name' && nameTok.v !== 'on' && frags[nameTok.v]) {
              var fn = nameTok.v;
              if (stack.indexOf(fn) !== -1) { outArr.push(t); outArr.push(nameTok); k++; continue; } // cycle
              outArr.push({ t: 'comment', v: '# ...' + fn });
              expand(outArr, frags[fn], stack.concat([fn]));
              k++; // consume the fragment name
              continue;
            }
          }
          outArr.push(t);
        }
      }

      var out = [], p = 0, paren = 0;
      while (p < n) {
        var tk = toks[p];
        if (tk.t === 'name' && tk.v === 'fragment' && paren === 0) { // drop fragment definitions
          var bb = p + 1; while (bb < n && toks[bb].v !== '{') bb++;
          var e2 = matchBrace(bb);
          p = e2 > 0 ? e2 + 1 : n;
          continue;
        }
        if (tk.v === '(' || tk.v === '[') { paren++; out.push(tk); p++; continue; }
        if (tk.v === ')' || tk.v === ']') { paren--; out.push(tk); p++; continue; }
        if (tk.v === '{' && paren === 0) { // an operation's selection set
          var e3 = matchBrace(p);
          if (e3 < 0) { out.push(tk); p++; continue; }
          out.push(tk);
          expand(out, toks.slice(p + 1, e3), []);
          out.push({ t: 'punct', v: '}' });
          p = e3 + 1;
          continue;
        }
        out.push(tk); p++;
      }

      var str = '';
      for (var q = 0; q < out.length; q++) {
        str += out[q].t === 'comment' ? ('\n' + out[q].v + '\n') : (out[q].v + ' ');
      }
      var formatted = formatGraphQL(str);
      return formatted && formatted.trim() ? formatted : src;
    } catch (e) { return src; }
  }

  var api = {
    formatGraphQL: formatGraphQL,
    inlineFragments: inlineFragments,
    computeFoldRanges: computeFoldRanges,
    copyInfo: copyInfo,
    highlightGraphQLLine: highlightGraphQLLine,
    highlightJsonLine: highlightJsonLine,
    renderFoldableCode: renderFoldableCode
  };
  root.GQLCode = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
