/*
 * End-to-end test: loads the unpacked extension into Chromium and exercises the
 * real interception pipeline against a mock GraphQL server.
 *
 * Verifies:
 *   1. background service worker loads with no error (extension is valid)
 *   2. injected.js attaches (no "GQLOP is not defined") and records a fetch op
 *   3. response is captured (status update)
 *   4. block rule (chrome.storage -> content-bridge -> injected) short-circuits
 *      the request with a synthetic GraphQL error
 *   5. rewrite rule modifies variables AND headers actually sent to the server
 *   6. XHR operations are recorded
 *
 * Run: node test/e2e.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); passed++; }
  else { console.log('  ❌ ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); failed++; }
}

// ---- mock GraphQL server: echoes back what it actually received ----------
function startServer() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE_HTML);
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) {}
        received.push(parsed && parsed.operationName);
        server.__received = received;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            echo: {
              operationName: parsed && parsed.operationName,
              variables: parsed && parsed.variables,
              headerXInjected: req.headers['x-injected'] || null,
              rawBody: raw
            }
          }
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>gqlop test</title></head><body>
<script>
  window.__records = [];
  window.__rules = [];
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__gqlop !== true) return;
    if (d.source === 'gqlop-page') window.__records.push({ type: d.type, payload: d.payload });
    if (d.source === 'gqlop-content' && d.type === 'rules-update') window.__rules.push(d.payload);
  });
  window.fireFetch = function (name, vars, extraHeaders) {
    return fetch('/graphql', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}),
      body: JSON.stringify({ operationName: name, query: 'query ' + name + ' { field }', variables: vars || {} })
    }).then(function (r) { return r.json(); });
  };
  window.fireXHR = function (name, vars) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open('POST', '/graphql');
      x.setRequestHeader('content-type', 'application/json');
      x.onloadend = function () { try { resolve(JSON.parse(x.responseText)); } catch (e) { resolve({ raw: x.responseText }); } };
      x.send(JSON.stringify({ operationName: name, query: 'mutation ' + name + ' { do }', variables: vars || {} }));
    });
  };
</script>
</body></html>`;

// ---- helpers -------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollRecords(page, pred, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const recs = await page.evaluate(() => window.__records);
    const hit = recs.filter(pred);
    if (hit.length) return { recs, hit };
    await sleep(100);
  }
  return { recs: await page.evaluate(() => window.__records), hit: [] };
}

async function waitForRule(page, opName, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ruleSets = await page.evaluate(() => window.__rules);
    const latest = ruleSets[ruleSets.length - 1] || [];
    if (latest.some((r) => r.match && r.match.operationName === opName && r.enabled !== false)) return true;
    await sleep(100);
  }
  return false;
}

async function waitForRuleCount(page, n, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ruleSets = await page.evaluate(() => window.__rules);
    const latest = ruleSets[ruleSets.length - 1] || [];
    if (latest.length >= n) return true;
    await sleep(100);
  }
  return false;
}

async function setRules(sw, rules) {
  await sw.evaluate((r) => new Promise((res) => chrome.storage.local.set({ gqlop_rules: r }, res)), rules);
}

// ---- main ----------------------------------------------------------------
(async () => {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log('mock GraphQL server on ' + base);

  let context;
  async function launch(headless) {
    return chromium.launchPersistentContext('', {
      headless,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });
  }

  context = await launch(true);
  let sw = context.serviceWorkers()[0];
  if (!sw) { try { sw = await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (e) {} }
  if (!sw) {
    console.log('  (headless produced no service worker — relaunching headed)');
    await context.close();
    context = await launch(false);
    sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  }

  console.log('\n[1] extension / service worker');
  check('service worker present (background loaded without fatal error)', !!sw, sw && sw.url());
  const extId = sw ? new URL(sw.url()).host : null;

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(base + '/', { waitUntil: 'load' });

  console.log('\n[2] records a normal fetch GraphQL operation');
  const resp1 = await page.evaluate(() => window.fireFetch('GetJobs', { id: 1 }));
  const r1 = await pollRecords(page, (r) => r.type === 'record' && r.payload.operationName === 'GetJobs');
  check('operation recorded with correct name', r1.hit.length > 0);
  check('operation type parsed as query', r1.hit[0] && r1.hit[0].payload.operationType === 'query', r1.hit[0] && r1.hit[0].payload.operationType);
  check('transport marked fetch', r1.hit[0] && r1.hit[0].payload.transport === 'fetch');
  check('server actually received the request (fetch not broken)', resp1 && resp1.data && resp1.data.echo.operationName === 'GetJobs');

  console.log('\n[3] captures the response (status update)');
  const opId = r1.hit[0] && r1.hit[0].payload.id;
  const upd = await pollRecords(page, (r) => r.type === 'record-update' && r.payload.id === opId && r.payload.patch && r.payload.patch.status === 200);
  check('response status 200 captured', upd.hit.length > 0);

  console.log('\n[4] block rule returns a synthetic GraphQL error');
  await setRules(sw, [{ id: 'b1', type: 'block', enabled: true, match: { operationName: 'BlockedOp' } }]);
  await page.reload({ waitUntil: 'load' });
  const ruleArrived = await waitForRule(page, 'BlockedOp');
  check('block rule propagated to page (storage -> content-bridge -> injected)', ruleArrived);
  const blockedResp = await page.evaluate(() => window.fireFetch('BlockedOp', {}));
  check('blocked request got synthetic gqlOperatorBlocked response',
    !!(blockedResp && blockedResp.errors && blockedResp.errors[0] && blockedResp.errors[0].extensions && blockedResp.errors[0].extensions.gqlOperatorBlocked),
    blockedResp);

  console.log('\n[5] rewrite rule changes variables AND headers sent to the server');
  await setRules(sw, [{
    id: 'w1', type: 'rewrite', enabled: true, match: { operationName: 'RewriteOp' },
    rewrite: { variables: { mode: 'replace', value: { injected: true } }, headers: { set: { 'x-injected': 'yes' }, remove: [] } }
  }]);
  await page.reload({ waitUntil: 'load' });
  await waitForRule(page, 'RewriteOp');
  const rwResp = await page.evaluate(() => window.fireFetch('RewriteOp', { original: 1 }));
  check('server received REWRITTEN variables', rwResp && rwResp.data && JSON.stringify(rwResp.data.echo.variables) === JSON.stringify({ injected: true }), rwResp && rwResp.data && rwResp.data.echo.variables);
  check('server received injected header', rwResp && rwResp.data && rwResp.data.echo.headerXInjected === 'yes', rwResp && rwResp.data && rwResp.data.echo.headerXInjected);

  console.log('\n[6] records an XHR GraphQL operation');
  await setRules(sw, []); // clear rules
  await page.reload({ waitUntil: 'load' });
  const xhrResp = await page.evaluate(() => window.fireXHR('XhrMutation', { a: 1 }));
  const rx = await pollRecords(page, (r) => r.type === 'record' && r.payload.operationName === 'XhrMutation');
  check('XHR operation recorded', rx.hit.length > 0);
  check('XHR transport marked xhr', rx.hit[0] && rx.hit[0].payload.transport === 'xhr');
  check('XHR operation type parsed as mutation', rx.hit[0] && rx.hit[0].payload.operationType === 'mutation');
  check('XHR server received request', xhrResp && xhrResp.data && xhrResp.data.echo.operationName === 'XhrMutation');

  console.log('\n[7] records reach a DevTools-style consumer (content -> background -> panel)');
  // Stand in for the panel: an extension page that opens the same port the panel
  // uses and collects forwarded records for every tab.
  const dtPage = await context.newPage();
  await dtPage.goto('chrome-extension://' + extId + '/src/popup.html', { waitUntil: 'load' });
  await dtPage.evaluate(() => new Promise((resolve) => {
    window.__got = [];
    chrome.tabs.query({}, (tabs) => {
      window.__ports = tabs.map((t) => {
        const p = chrome.runtime.connect({ name: 'gqlop-devtools-port' });
        p.onMessage.addListener((m) => {
          if (m.type === 'record') window.__got.push(m.record);
          else if (m.type === 'buffer') (m.events || []).forEach((e) => { if (e.kind === 'record') window.__got.push(e.record); });
        });
        p.postMessage({ type: 'init', tabId: t.id });
        return p;
      });
      resolve(tabs.map((t) => t.id));
    });
  }));
  await sleep(200); // let ports register in the background
  await page.bringToFront();
  await page.evaluate(() => window.fireFetch('PanelPipelineOp', { x: 9 }));
  let forwarded = [];
  for (let i = 0; i < 40; i++) {
    forwarded = await dtPage.evaluate(() => window.__got.filter((r) => r && r.operationName === 'PanelPipelineOp'));
    if (forwarded.length) break;
    await sleep(100);
  }
  check('record forwarded through background to the panel port', forwarded.length > 0, forwarded.length);
  check('forwarded record carries a frameId (for resend routing)', forwarded[0] && forwarded[0].frameId != null, forwarded[0] && forwarded[0].frameId);

  console.log('\n[8] resend replays a request through the page (panel -> background -> content -> injected)');
  await dtPage.evaluate((payload) => {
    window.__ports.forEach((p) => { try { p.postMessage({ type: 'resend', payload: payload }); } catch (e) {} });
  }, { reqId: 'resend-test', url: base + '/graphql', method: 'POST', frameId: 0, credentials: 'include',
       body: JSON.stringify({ operationName: 'ResentOp', query: 'query ResentOp { f }', variables: { r: 1 } }) });
  let serverGotResend = false, resendRecord = [];
  for (let i = 0; i < 40; i++) {
    serverGotResend = (server.__received || []).indexOf('ResentOp') !== -1;
    resendRecord = await dtPage.evaluate(() => window.__got.filter((r) => r && r.operationName === 'ResentOp' && r.isResent));
    if (serverGotResend && resendRecord.length) break;
    await sleep(100);
  }
  check('resent request actually reached the server', serverGotResend);
  check('resent operation recorded and flagged isResent', resendRecord.length > 0);
  await dtPage.close();

  console.log('\n[9] delay rule holds the request before it resolves');
  await setRules(sw, [{ id: 'd1', type: 'delay', enabled: true, match: { operationName: 'SlowOp' }, delayMs: 1200 }]);
  await page.reload({ waitUntil: 'load' });
  await waitForRule(page, 'SlowOp');
  const t0 = Date.now();
  const slowResp = await page.evaluate(() => window.fireFetch('SlowOp', {}));
  const elapsed = Date.now() - t0;
  check('request was delayed ~1.2s before resolving', elapsed >= 1100, elapsed + 'ms');
  check('delayed request still resolved with real data', slowResp && slowResp.data && slowResp.data.echo.operationName === 'SlowOp');
  const dr = await pollRecords(page, (r) => r.type === 'record-update' && r.payload.patch && r.payload.patch.delayedMs === 1200);
  check('record marked with delayedMs', dr.hit.length > 0);
  await setRules(sw, []);

  console.log('\n[10] codeview formats, highlights & folds GraphQL');
  const cvPage = await context.newPage();
  await cvPage.goto('about:blank');
  await cvPage.addScriptTag({ path: EXT + '/src/lib/codeview.js' });
  const cv = await cvPage.evaluate(() => {
    const src = 'query Q($id: ID!) { a(id: $id) { b c } } fragment F on T { x }';
    const wrap = GQLCode.renderFoldableCode(src, 'graphql');
    document.body.appendChild(wrap);
    const rows = wrap.querySelectorAll('.cv-row').length;
    const foldable = wrap.querySelectorAll('.cv-gutter.cv-foldable').length;
    const g = wrap.querySelector('.cv-gutter.cv-foldable');
    g.click(); // collapse the outermost block
    const hidden = Array.prototype.filter.call(wrap.querySelectorAll('.cv-row'), (r) => r.style.display === 'none').length;
    const highlighted = wrap.querySelectorAll('.cv-t-k').length; // keyword tokens present
    // auto-collapse: a large JSON body should start with big blocks folded
    const big = JSON.stringify({ data: { list: Array.from({ length: 40 }, function (_, i) { return { id: i }; }) } }, null, 2);
    const w2 = GQLCode.renderFoldableCode(big, 'json', { autoCollapseLines: 24 });
    document.body.appendChild(w2);
    const autoHidden = Array.prototype.filter.call(w2.querySelectorAll('.cv-row'), (r) => r.style.display === 'none').length;
    // inline fragments: spread should be replaced by the fragment's fields
    const inlined = GQLCode.inlineFragments('query Q { a { ...F } } fragment F on T { x y }');
    const inlineOk = /x[\s\S]*y/.test(inlined) && inlined.indexOf('fragment F') === -1;
    return { rows, foldable, hidden, highlighted, autoHidden, inlineOk };
  });
  check('renders multiple code rows', cv.rows > 3, cv.rows);
  check('has foldable blocks (incl. fragment)', cv.foldable >= 2, cv.foldable);
  check('collapsing a block hides rows', cv.hidden > 0, cv.hidden);
  check('applies syntax highlighting (keywords)', cv.highlighted > 0, cv.highlighted);
  check('auto-collapses large JSON blocks by default', cv.autoHidden > 0, cv.autoHidden);
  check('inline fragments expands spreads inline', cv.inlineOk);
  await cvPage.close();

  console.log('\n[11] override rule returns a mocked response (no server hit)');
  await setRules(sw, [{ id: 'o1', type: 'override', enabled: true, match: { operationName: 'MockOp' }, override: { status: 200, body: JSON.stringify({ data: { mock: true } }) } }]);
  await page.reload({ waitUntil: 'load' });
  await waitForRule(page, 'MockOp');
  const ovResp = await page.evaluate(() => window.fireFetch('MockOp', {}));
  check('overridden op returns the mocked body', ovResp && ovResp.data && ovResp.data.mock === true, ovResp);
  check('override did NOT reach the server', (server.__received || []).indexOf('MockOp') === -1);
  await setRules(sw, [{ id: 'o2', type: 'override', enabled: true, match: { operationName: 'FailOp' }, override: { status: 500, body: JSON.stringify({ errors: [{ message: 'boom' }] }) } }]);
  await page.reload({ waitUntil: 'load' });
  await waitForRule(page, 'FailOp');
  const failStatus = await page.evaluate(() => fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'FailOp', query: 'query FailOp { f }' }) }).then((r) => r.status));
  check('override can set a custom HTTP status', failStatus === 500, failStatus);

  console.log('\n[12] regex rule matches by pattern');
  await setRules(sw, [{ id: 'rx', type: 'block', enabled: true, match: { nameRegex: '^Search' } }]);
  await page.reload({ waitUntil: 'load' });
  await waitForRuleCount(page, 1);
  const rxHit = await page.evaluate(() => window.fireFetch('SearchJobs', {}));
  const rxMiss = await page.evaluate(() => window.fireFetch('GetProfile', {}));
  const blockedRx = !!(rxHit && rxHit.errors && rxHit.errors[0] && rxHit.errors[0].extensions && rxHit.errors[0].extensions.gqlOperatorBlocked);
  const missBlocked = !!(rxMiss && rxMiss.errors && rxMiss.errors[0] && rxMiss.errors[0].extensions && rxMiss.errors[0].extensions.gqlOperatorBlocked);
  check('regex /^Search/ blocks SearchJobs', blockedRx);
  check('regex /^Search/ leaves GetProfile alone', !missBlocked && rxMiss.data && rxMiss.data.echo.operationName === 'GetProfile');
  await setRules(sw, []);

  console.log('\n[13] search library finds strings across records');
  const sPage = await context.newPage();
  await sPage.goto('about:blank');
  await sPage.addScriptTag({ path: EXT + '/src/lib/codeview.js' });
  await sPage.addScriptTag({ path: EXT + '/src/lib/search.js' });
  const sl = await sPage.evaluate(() => {
    const rec = {
      id: 'r1', operationName: 'GetUser', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql',
      entries: [{ operationName: 'GetUser', query: 'query GetUser($userId: ID!) { user(id: $userId) { id email } }', variables: { userId: 'abc-123' } }],
      requestBody: JSON.stringify({ operationName: 'GetUser', variables: { userId: 'abc-123' } }),
      responseBody: JSON.stringify({ data: { user: { id: 'abc-123', email: 'nobody@ex.test' } } }),
      requestHeaders: { 'x-request-id': 'trace-777' }, responseHeaders: { 'content-type': 'application/json' }
    };
    const run = (term, opts, scope) => GQLSearch.searchAll([rec], GQLSearch.buildMatcher(term, opts || {}), { scope: scope });

    const all = run('abc-123');
    const labels = all.groups[0].matches.map((m) => m.field.label);
    const varsOnly = run('abc-123', {}, 'vars');
    const respOnly = run('abc-123', {}, 'response');
    const headers = run('trace-777', {}, 'headers');
    const ci = run('ABC-123');
    const cs = run('ABC-123', { caseSensitive: true });
    const rx = run('abc-\\d+', { regex: true });
    let badRegex = false;
    try { GQLSearch.buildMatcher('(', { regex: true }); } catch (e) { badRegex = true; }

    // the promise of the feature: a reported line number is the code viewer's row
    const respField = GQLSearch.fieldsFor(rec).filter((f) => f.key === 'response')[0];
    const hit = GQLSearch.searchRecord(rec, GQLSearch.buildMatcher('nobody@ex.test', {}), { scope: 'response' }).matches[0];
    const rows = GQLCode.renderFoldableCode(respField.text, 'json').querySelectorAll('.cv-row');
    const lineAligns = rows[hit.line].textContent.indexOf('nobody@ex.test') !== -1;

    return {
      labels, total: all.totalMatches,
      varsOnly: varsOnly.groups[0].matches.length, respOnly: respOnly.groups[0].matches.length,
      headerHit: headers.groups.length && headers.groups[0].matches[0].field.label,
      ci: ci.totalMatches, cs: cs.totalMatches, rx: rx.totalMatches, badRegex, lineAligns,
      snippet: hit.text.trim()
    };
  });
  check('finds the value in variables and response', sl.total === 2, sl);
  check('does not double-report the raw body when entries carry the text', sl.labels.join(',') === 'Variables,Response', sl.labels);
  check('scope=vars searches only variables', sl.varsOnly === 1 && sl.respOnly === 1, sl);
  check('searches headers', sl.headerHit === 'Request header', sl.headerHit);
  check('case-insensitive by default, exact with match-case', sl.ci === 2 && sl.cs === 0, [sl.ci, sl.cs]);
  check('regex mode matches by pattern', sl.rx === 2, sl.rx);
  check('invalid regex is reported, not swallowed', sl.badRegex);
  check('reported line number is the code viewer row', sl.lineAligns, sl.snippet);
  await sPage.close();

  console.log('\n[14] panel UI: global search lists hits and jumps to them');
  const panelPage = await context.newPage();
  const panelErrors = [];
  panelPage.on('pageerror', (e) => panelErrors.push(String(e)));
  // panel.js needs the devtools API; stub the one property it reads. A tabId no
  // real tab owns keeps the background's buffer out of this fixture.
  await panelPage.addInitScript(() => {
    window.chrome = window.chrome || {};
    try { window.chrome.devtools = { inspectedWindow: { tabId: 999999 } }; } catch (e) {}
  });
  await panelPage.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });

  const fixture = {
    tool: 'graphql-operator', version: 1,
    operations: [
      { id: 'sf1', operationName: 'GetUser', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql', status: 200, ts: 1700000000000,
        entries: [{ operationName: 'GetUser', query: 'query GetUser($userId: ID!) { user(id: $userId) { id email } }', variables: { userId: 'abc-123' } }],
        responseBody: JSON.stringify({ data: { user: { id: 'abc-123', email: 'nobody@ex.test' } } }),
        requestHeaders: { 'x-request-id': 'trace-777' }, responseHeaders: { 'content-type': 'application/json' } },
      { id: 'sf2', operationName: 'ListJobs', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql', status: 200, ts: 1700000001000,
        entries: [{ operationName: 'ListJobs', query: 'query ListJobs { jobs { id title } }', variables: { limit: 10 } }],
        responseBody: JSON.stringify({ data: { jobs: [{ id: 'j1', title: 'Cook' }, { id: 'abc-123', title: 'Barista' }] } }) },
      { id: 'sf3', operationName: 'SaveThing', operationType: 'mutation', method: 'POST', url: 'https://ex.test/graphql', status: 200, ts: 1700000002000,
        entries: [{ operationName: 'SaveThing', query: 'mutation SaveThing($in: In!) { save(in: $in) { ok } }', variables: { in: { note: 'ABC-123 upper' } } }],
        responseBody: JSON.stringify({ data: { save: { ok: true } } }) }
    ]
  };
  await panelPage.setInputFiles('#import-file', {
    name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))
  });
  await panelPage.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 3);

  await panelPage.click('#btn-search');
  const searchVisible = await panelPage.isVisible('#search-pane');
  check('search pane opens from the toolbar', searchVisible);

  async function typeSearch(term) {
    await panelPage.fill('#search-input', term);
    await sleep(260); // debounce
    return panelPage.evaluate(() => ({
      groups: document.querySelectorAll('.sr-group').length,
      hits: document.querySelectorAll('.sr-hit').length,
      count: document.getElementById('search-count').textContent,
      fields: Array.prototype.map.call(document.querySelectorAll('.sr-hit .sr-field'), (f) => f.textContent),
      ops: Array.prototype.map.call(document.querySelectorAll('.sr-head .sr-op'), (o) => o.textContent),
      marked: document.querySelectorAll('.sr-hit .s-hit').length
    }));
  }

  const r = await typeSearch('abc-123');
  check('groups hits by operation across all requests', r.groups === 3 && r.ops.join(',') === 'GetUser,ListJobs,SaveThing', r);
  check('lists every matching line', r.hits === 4, r.hits);
  check('labels the field and line of each hit', r.fields.some((f) => /^Variables:\d+$/.test(f)) && r.fields.some((f) => /^Response:\d+$/.test(f)), r.fields);
  check('highlights the matched text in the snippet', r.marked >= 4, r.marked);
  check('summarises the match count', /4 matches in 3 operations/.test(r.count), r.count);

  await panelPage.click('#search-scopes .chip[data-s="vars"]');
  await sleep(120);
  const scoped = await panelPage.evaluate(() => ({
    groups: document.querySelectorAll('.sr-group').length,
    fields: Array.prototype.map.call(document.querySelectorAll('.sr-hit .sr-field'), (f) => f.textContent)
  }));
  check('scope chip narrows the search to variables', scoped.groups === 2 && scoped.fields.every((f) => /^Variables/.test(f)), scoped);
  await panelPage.click('#search-scopes .chip[data-s="all"]');
  await sleep(120);

  await panelPage.click('#s-case');
  await sleep(120);
  const cased = await panelPage.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sr-head .sr-op'), (o) => o.textContent));
  check('match-case toggle drops the upper-case-only record', cased.join(',') === 'GetUser,ListJobs', cased);
  await panelPage.click('#s-case');
  await sleep(120);

  await panelPage.click('#s-regex');
  await panelPage.fill('#search-input', 'abc-\\d+');
  await sleep(260);
  const regexed = await panelPage.evaluate(() => document.querySelectorAll('.sr-group').length);
  check('regex toggle searches by pattern', regexed === 3, regexed);
  await panelPage.fill('#search-input', '(');
  await sleep(260);
  const badRegexShown = await panelPage.isVisible('#search-error');
  check('invalid regex shows an error instead of results', badRegexShown);
  await panelPage.click('#s-regex');

  await panelPage.fill('#search-input', 'nobody@ex.test');
  await sleep(260);
  await panelPage.click('.sr-hit');
  await sleep(120);
  const jumped = await panelPage.evaluate(() => {
    const active = document.querySelector('#detail .cv-row.cv-active');
    return {
      op: document.querySelector('#detail-head .op-name').textContent,
      tab: (document.querySelector('.tab.active') || {}).textContent,
      activeText: active ? active.textContent : null,
      selectedRow: !!document.querySelector('#op-rows tr.selected'),
      findValue: (document.querySelector('.tabpane[data-pane="response"] .find-input') || {}).value
    };
  });
  check('clicking a hit opens that operation', jumped.op === 'GetUser', jumped.op);
  check('clicking a hit switches to the matching tab', jumped.tab === 'Response', jumped.tab);
  check('clicking a hit highlights the exact matching line', !!jumped.activeText && jumped.activeText.indexOf('nobody@ex.test') !== -1, jumped.activeText);
  check('the detail find box is primed with the term', jumped.findValue === 'nobody@ex.test', jumped.findValue);

  await panelPage.fill('#search-input', 'abc-123');
  await sleep(260);
  await panelPage.focus('#search-input');
  await panelPage.keyboard.press('Enter');
  await sleep(120);
  const firstStep = await panelPage.evaluate(() => document.querySelector('#detail-head .op-name').textContent);
  await panelPage.keyboard.press('Enter');
  await panelPage.keyboard.press('Enter');
  await sleep(120);
  const thirdStep = await panelPage.evaluate(() => ({
    op: document.querySelector('#detail-head .op-name').textContent,
    activeHits: document.querySelectorAll('.sr-hit.active').length
  }));
  check('Enter steps through hits', firstStep === 'GetUser' && thirdStep.op === 'ListJobs' && thirdStep.activeHits === 1, [firstStep, thirdStep]);

  await panelPage.keyboard.press('Escape');
  const closed = await panelPage.evaluate(() => ({
    search: document.getElementById('search-pane').classList.contains('hidden'),
    list: !document.getElementById('list-pane').classList.contains('hidden')
  }));
  check('Escape closes search and restores the list', closed.search && closed.list, closed);
  check('no panel page errors while searching', panelErrors.length === 0, panelErrors);
  await panelPage.close();

  console.log('\n[15] no fatal page errors');
  const gqlopErr = pageErrors.filter((e) => /GQLOP is not defined/.test(e));
  check('no "GQLOP is not defined" errors', gqlopErr.length === 0, gqlopErr);
  check('no uncaught page errors at all', pageErrors.length === 0, pageErrors);

  await context.close();
  server.close();

  console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
