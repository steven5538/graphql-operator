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
      if (req.method === 'GET' && req.url.startsWith('/csp')) {
        // Stands in for a real app whose CSP blocks a third-party tracker.
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "connect-src 'self'" });
        res.end(`<!doctype html><html><body><script>
          window.fireBlocked = function () { return fetch('http://127.0.0.1:9/tracker/ip.json').catch(function () { return 'blocked'; }); };
        </script></body></html>`);
        return;
      }
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

  // The interceptor is dormant until something needs it, so stand in for an open
  // DevTools panel for the whole run: an extension page holding the same port
  // the real panel uses, collecting forwarded records for every tab.
  // (Section [16] covers the dormant case on purpose.)
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
  await sleep(300); // let the ports register and the page install its hooks
  await page.bringToFront();
  const wokeOnAttach = await page.evaluate(() => !/native code/.test(String(window.fetch)));
  check('attaching a panel hooks the already-loaded page (no reload needed)', wokeOnAttach);

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
    // a large JSON body opens fully expanded; collapseAll folds it to an outline
    const big = JSON.stringify({ data: { list: Array.from({ length: 40 }, function (_, i) { return { id: i }; }) } }, null, 2);
    const w2 = GQLCode.renderFoldableCode(big, 'json');
    document.body.appendChild(w2);
    const hiddenRows = () => Array.prototype.filter.call(w2.querySelectorAll('.cv-row'), (r) => r.style.display === 'none').length;
    // a visible row's code, with " …" only where the row is folded (no CSS on this page)
    const visibleText = () => Array.prototype.filter.call(w2.querySelectorAll('.cv-row'), (r) => r.style.display !== 'none')
      .map((r) => Array.prototype.filter.call(r.querySelector('.cv-code').children, (c) => !c.classList.contains('cv-ellipsis'))
        .map((c) => c.textContent).join('') + (r.classList.contains('cv-collapsed') ? ' …' : ''));
    const autoHidden = hiddenRows();
    w2.cvFold.collapseAll();
    const outline = { hidden: hiddenRows(), lines: visibleText(), arrow: w2.querySelectorAll('.cv-gutter')[1].textContent };
    w2.cvFold.expandAll();
    const reopened = { hidden: hiddenRows(), arrow: w2.querySelectorAll('.cv-gutter')[1].textContent };
    const foldCount = w2.cvFold.count; // data, list, and the 40 items
    // inline fragments: spread should be replaced by the fragment's fields
    const inlined = GQLCode.inlineFragments('query Q { a { ...F } } fragment F on T { x y }');
    const inlineOk = /x[\s\S]*y/.test(inlined) && inlined.indexOf('fragment F') === -1;
    // copy info: what each line hands to the clipboard
    const doc = JSON.stringify({ data: { 'odd key': { note: 'a, b', n: -1.5, kids: [{ id: 'x' }] } } }, null, 2);
    const at = (i) => GQLCode.copyInfo(doc, 'json', i);
    const copy = {
      note: at(3).value, noteKeyed: at(3).withKey, num: at(4).value,
      oddPath: at(3).path, deepPath: at(6).path,
      block: at(5).value, blockLines: at(5).lineCount,
      gql: GQLCode.copyInfo(src, 'graphql', 1).value
    };
    return { rows, foldable, hidden, highlighted, autoHidden, outline, reopened, foldCount, inlineOk, copy, docLines: doc.split('\n') };
  });
  check('renders multiple code rows', cv.rows > 3, cv.rows);
  check('has foldable blocks (incl. fragment)', cv.foldable >= 2, cv.foldable);
  check('collapsing a block hides rows', cv.hidden > 0, cv.hidden);
  check('applies syntax highlighting (keywords)', cv.highlighted > 0, cv.highlighted);
  check('large JSON blocks open fully expanded', cv.autoHidden === 0, cv.autoHidden);
  check('collapseAll folds every nested block but leaves the root open',
    cv.foldCount === 42 && cv.outline.lines.join('|') === '{|  "data": { …|}' && cv.outline.arrow === '▸', cv.outline);
  check('expandAll unfolds everything again', cv.reopened.hidden === 0 && cv.reopened.arrow === '▾', cv.reopened);
  check('inline fragments expands spreads inline', cv.inlineOk);
  check('a leaf copies as its bare value, keeping a comma inside the string',
    cv.copy.note === 'a, b' && cv.copy.noteKeyed === '"note": "a, b"' && cv.copy.num === '-1.5', cv.copy);
  check('a block copies as standalone JSON', cv.copy.block === '[\n  {\n    "id": "x"\n  }\n]' && cv.copy.blockLines === 5, cv.copy);
  check('paths quote keys that are not identifiers and count array entries',
    cv.copy.oddPath === 'data["odd key"].note' && cv.copy.deepPath === 'data["odd key"].kids[0]', cv.copy);
  check('a GraphQL selection set copies dedented', cv.copy.gql === 'a(id: $id) {\n  b\n  c\n}', JSON.stringify(cv.copy.gql));
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

  // --- in-block find bar: step through the matches of one response ---
  await panelPage.click('#op-rows tr:nth-child(2)'); // ListJobs — 4 "i" lines in its body
  await panelPage.click('.tab[data-tab="response"]');
  const findState = () => panelPage.evaluate(() => {
    const pane = document.querySelector('.tabpane[data-pane="response"]');
    const active = pane.querySelector('.cv-row.cv-active');
    return {
      count: pane.querySelector('.find-count').textContent,
      matches: pane.querySelectorAll('.cv-row.cv-match').length,
      actives: pane.querySelectorAll('.cv-row.cv-active').length,
      active: active ? active.textContent.trim() : null,
      navDisabled: Array.prototype.map.call(pane.querySelectorAll('.find-nav'), (b) => b.disabled)
    };
  });
  await panelPage.fill('.tabpane[data-pane="response"] .find-input', 'i');
  const f1 = await findState();
  check('the find bar counts the matches and focuses the first', f1.count === '1 / 4' && f1.matches === 4 && f1.actives === 1 && /"id": "j1"/.test(f1.active), f1);

  await panelPage.keyboard.press('Enter');
  const f2 = await findState();
  check('Enter advances to the next match', f2.count === '2 / 4' && /"title": "Cook"/.test(f2.active), f2);

  await panelPage.keyboard.press('Shift+Enter');
  await panelPage.keyboard.press('Shift+Enter');
  const f0 = await findState();
  check('Shift+Enter walks back and wraps to the last match', f0.count === '4 / 4' && /"title": "Barista"/.test(f0.active), f0);

  await panelPage.click('.tabpane[data-pane="response"] .find-nav:last-child');
  const fWrap = await findState();
  check('the ↓ button wraps around to the first match', fWrap.count === '1 / 4' && /"id": "j1"/.test(fWrap.active), fWrap);

  await panelPage.click('.tabpane[data-pane="response"] .find-nav:first-child');
  const fPrev = await findState();
  check('the ↑ button steps backwards', fPrev.count === '4 / 4', fPrev);

  await panelPage.fill('.tabpane[data-pane="response"] .find-input', 'zzz-nothing');
  const fNone = await findState();
  check('no matches disables the arrows', fNone.count === 'No matches' && fNone.actives === 0 && fNone.navDisabled.every(Boolean), fNone);

  await panelPage.keyboard.press('Escape');
  const fCleared = await findState();
  check('Escape clears the find box', fCleared.count === '' && fCleared.matches === 0, fCleared);

  // a global-search jump should hand its line to the find bar as the current match
  await panelPage.click('#btn-search');
  await panelPage.fill('#search-input', 'abc-123');
  await sleep(260);
  await panelPage.click('.sr-group:nth-child(2) .sr-hit:last-child'); // ListJobs → response line
  await sleep(120);
  const handoff = await findState();
  check('a global-search jump seeds the find bar at that line', /^\d+ \/ \d+$/.test(handoff.count) && handoff.actives === 1 && /abc-123/.test(handoff.active), handoff);
  await panelPage.keyboard.press('Escape');

  check('no panel page errors while searching', panelErrors.length === 0, panelErrors);
  await panelPage.close();

  console.log('\n[15] duplicate detection: library + panel highlighting');
  const dPage = await context.newPage();
  const dupErrors = [];
  dPage.on('pageerror', (e) => dupErrors.push(String(e)));
  await dPage.goto('about:blank');
  await dPage.addScriptTag({ path: EXT + '/src/lib/dupes.js' });
  const dl = await dPage.evaluate(() => {
    const mk = (id, ts, vars, name, extra) => Object.assign({
      id, ts, url: '/graphql', method: 'POST',
      entries: [{ operationName: name || 'GetJobs', query: 'query ' + (name || 'GetJobs') + ' { field }', variables: vars }]
    }, extra || {});
    const sig = (q, vars) => GQLDupes.signature({ url: '/g', method: 'POST', entries: [{ operationName: 'A', query: q, variables: vars }] });

    const inWindow = GQLDupes.analyze([mk('1', 1000, { x: 1 }), mk('2', 1300, { x: 1 })], 1000);
    const outWindow = GQLDupes.analyze([mk('1', 1000, { x: 1 }), mk('2', 3000, { x: 1 })], 1000);
    const diffVars = GQLDupes.analyze([mk('1', 1000, { x: 1 }), mk('2', 1100, { x: 2 })], 1000);
    const diffOp = GQLDupes.analyze([mk('1', 1000, {}, 'A'), mk('2', 1100, {}, 'B')], 1000);
    const resend = GQLDupes.analyze([mk('1', 1000, {}), mk('2', 1100, {}, null, { isResent: true })], 1000);
    // anchored to the first of the run: 0,400,800 group; 1200,1600 start a new one
    const burst = GQLDupes.analyze([mk('1', 0, {}), mk('2', 400, {}), mk('3', 800, {}), mk('4', 1200, {}), mk('5', 1600, {})], 1000);
    const unordered = GQLDupes.analyze([mk('2', 1300, {}), mk('1', 1000, {})], 1000);
    return {
      inWindow: inWindow.dupCount, outWindow: outWindow.dupCount,
      diffVars: diffVars.dupCount, diffOp: diffOp.dupCount, resend: resend.dupCount,
      first: inWindow.info['1'], second: inWindow.info['2'],
      burstGroups: burst.groups, burstFirstSize: burst.info['1'].size, burstTailSize: burst.info['4'].size,
      orderedIndex: unordered.info['1'].index, orderedGap: unordered.info['2'].gapMs,
      fmtSame: sig('query A{b}', { y: 2, x: 1 }) === sig('query A  {\n  b\n}', { x: 1, y: 2 }),
      fieldDiff: sig('query A{b}', {}) !== sig('query A{c}', {}),
      widened: GQLDupes.analyze([mk('1', 1000, {}), mk('2', 3000, {})], 5000).dupCount
    };
  });
  check('identical calls inside the window are duplicates', dl.inWindow === 2, dl.inWindow);
  check('same call outside the window is not', dl.outWindow === 0, dl.outWindow);
  check('different variables are not duplicates', dl.diffVars === 0, dl.diffVars);
  check('different operations are not duplicates', dl.diffOp === 0, dl.diffOp);
  check('user resends are excluded', dl.resend === 0, dl.resend);
  check('reports position, size and gap', dl.first.index === 1 && dl.first.size === 2 && dl.second.index === 2 && dl.second.gapMs === 300, [dl.first, dl.second]);
  check('a burst clusters from its first call, not endlessly', dl.burstGroups === 2 && dl.burstFirstSize === 3 && dl.burstTailSize === 2, dl);
  check('out-of-order arrivals are ordered by timestamp', dl.orderedIndex === 1 && dl.orderedGap === 300, dl);
  check('query formatting and key order do not affect the signature', dl.fmtSame);
  check('but a different field does', dl.fieldDiff);
  check('widening the window catches a farther-apart pair', dl.widened === 2, dl.widened);
  await dPage.close();

  const dupPanel = await context.newPage();
  const dupPanelErrors = [];
  dupPanel.on('pageerror', (e) => dupPanelErrors.push(String(e)));
  await dupPanel.addInitScript(() => {
    window.chrome = window.chrome || {};
    try { window.chrome.devtools = { inspectedWindow: { tabId: 999998 } }; } catch (e) {}
  });
  await dupPanel.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });

  const T0 = 1700000000000;
  const dupOp = (id, ts, vars, name) => ({
    id, operationName: name || 'GetJobs', operationType: 'query', method: 'POST',
    url: 'https://ex.test/graphql', status: 200, ts,
    entries: [{ operationName: name || 'GetJobs', query: 'query ' + (name || 'GetJobs') + ' { jobs { id } }', variables: vars }]
  });
  await dupPanel.setInputFiles('#import-file', {
    name: 'dupes.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      tool: 'graphql-operator', version: 1,
      operations: [
        dupOp('d1', T0, { page: 1 }),          // \ identical, 300 ms apart
        dupOp('d2', T0 + 300, { page: 1 }),    // /
        dupOp('d3', T0 + 400, { page: 2 }),    // same query, different variables
        dupOp('d4', T0 + 4000, { page: 1 }),   // same as d1/d2 but far apart
        dupOp('d5', T0 + 500, {}, 'Unrelated')
      ]
    }))
  });
  await dupPanel.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 5);

  const dupUi = await dupPanel.evaluate(() => {
    const row = (id) => document.querySelector('#op-rows tr[data-id="' + id + '"]');
    const marked = Array.prototype.map.call(document.querySelectorAll('#op-rows tr.dup'), (t) => t.getAttribute('data-id'));
    const tag = row('d1').querySelector('.tag.dup');
    const bg = getComputedStyle(row('d1')).backgroundColor;
    const plainBg = getComputedStyle(row('d3')).backgroundColor;
    return {
      marked, tagText: tag && tag.textContent,
      tagTitle: tag && tag.title,
      secondTagTitle: row('d2').querySelector('.tag.dup').title,
      chip: document.getElementById('chip-dupes-n').textContent,
      tinted: bg !== plainBg && bg !== 'rgba(0, 0, 0, 0)',
      bar: getComputedStyle(row('d1').querySelector('td')).boxShadow
    };
  });
  check('only the two identical close-together calls are flagged', dupUi.marked.join(',') === 'd1,d2', dupUi.marked);
  check('flagged rows carry a dup ×N tag', dupUi.tagText === 'dup ×2', dupUi.tagText);
  check('the tag names the window and position', /2 identical calls within 1s — this is #1$/.test(dupUi.tagTitle || ''), dupUi.tagTitle);
  check('the tag explains the gap to the previous call', /this is #2, 300 ms after the previous one/.test(dupUi.secondTagTitle || ''), dupUi.secondTagTitle);
  check('flagged rows are colour-tinted', dupUi.tinted, dupUi.tinted);
  check('flagged rows get a coloured edge bar', /rgb/.test(dupUi.bar) && dupUi.bar !== 'none', dupUi.bar);
  check('the Dupes chip counts them', dupUi.chip === '2', dupUi.chip);

  await dupPanel.click('#op-rows tr[data-id="d2"]');
  const dupDetail = await dupPanel.evaluate(() => ({
    warn: (document.querySelector('#detail-head .dup-warn') || {}).textContent,
    links: document.querySelectorAll('#detail-head .dup-link').length,
    meta: Array.prototype.map.call(document.querySelectorAll('.tabpane[data-pane="meta"] tr'), (t) => t.textContent).filter((t) => /^Duplicate/.test(t))[0]
  }));
  check('the detail pane warns about the duplicate', /2 identical calls/.test(dupDetail.warn || '') && /#2/.test(dupDetail.warn || ''), dupDetail.warn);
  check('the warning links to the sibling call', dupDetail.links === 1, dupDetail.links);
  check('the Timing tab records the duplicate position', /#2 of 2/.test(dupDetail.meta || ''), dupDetail.meta);
  await dupPanel.click('#detail-head .dup-link');
  const jumpedToSibling = await dupPanel.evaluate(() => (document.querySelector('#op-rows tr.selected') || {}).getAttribute('data-id'));
  check('clicking the link selects the sibling call', jumpedToSibling === 'd1', jumpedToSibling);

  await dupPanel.click('#toolbar .chip[data-f="dupes"]');
  const filtered = await dupPanel.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#op-rows tr'), (t) => t.getAttribute('data-id')));
  check('the Dupes filter shows only duplicates', filtered.join(',') === 'd1,d2', filtered);

  // widening the window should pull in d4, which is 4s after d1
  await dupPanel.selectOption('#dup-window', '5000');
  const widened = await dupPanel.evaluate(() => ({
    rows: Array.prototype.map.call(document.querySelectorAll('#op-rows tr'), (t) => t.getAttribute('data-id')),
    chip: document.getElementById('chip-dupes-n').textContent,
    tag: (document.querySelector('#op-rows tr[data-id="d1"] .tag.dup') || {}).textContent
  }));
  check('widening the window re-clusters live', widened.rows.join(',') === 'd1,d2,d4' && widened.chip === '3', widened);
  check('the tag count follows the new cluster size', widened.tag === 'dup ×3', widened.tag);
  await dupPanel.selectOption('#dup-window', '250');
  const narrowed = await dupPanel.evaluate(() => ({
    rows: document.querySelectorAll('#op-rows tr').length,
    chip: document.getElementById('chip-dupes-n').textContent
  }));
  check('narrowing below the gap clears the duplicates', narrowed.rows === 0 && narrowed.chip === '0', narrowed);
  await dupPanel.selectOption('#dup-window', '1000');

  await dupPanel.click('#toolbar .chip[data-f="all"]');
  const backToAll = await dupPanel.evaluate(() => document.querySelectorAll('#op-rows tr').length);
  check('switching back to All restores every row', backToAll === 5, backToAll);
  check('no panel page errors while detecting duplicates', dupPanelErrors.length === 0, dupPanelErrors);
  check('no errors in the dupes library page', dupErrors.length === 0, dupErrors);
  await dupPanel.close();

  // The checks above drive the panel from an imported file. This one runs the
  // real thing: a page double-firing a query, through injected -> background ->
  // panel, with the panel bound to the actual inspected tab.
  await page.bringToFront();
  const liveTabId = await sw.evaluate(() => new Promise((res) =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => res(t[0] && t[0].id))));
  check('found the inspected tab for the live check', liveTabId != null, liveTabId);
  const livePanel = await context.newPage();
  const liveErrors = [];
  livePanel.on('pageerror', (e) => liveErrors.push(String(e)));
  await livePanel.addInitScript((id) => {
    window.chrome = window.chrome || {};
    try { window.chrome.devtools = { inspectedWindow: { tabId: id } }; } catch (e) {}
  }, liveTabId);
  await livePanel.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });
  await livePanel.click('#btn-clear'); // drop whatever the earlier sections recorded
  await sleep(300);
  await page.evaluate(() => { window.fireFetch('DoubleFetch', { page: 1 }); window.fireFetch('DoubleFetch', { page: 1 }); });
  let live = { rows: 0 };
  for (let i = 0; i < 40; i++) {
    live = await livePanel.evaluate(() => ({
      rows: document.querySelectorAll('#op-rows tr').length,
      dupRows: document.querySelectorAll('#op-rows tr.dup').length,
      chip: document.getElementById('chip-dupes-n').textContent
    }));
    if (live.rows >= 2 && live.dupRows >= 2) break;
    await sleep(100);
  }
  check('a page double-firing one query is flagged on the live path', live.rows === 2 && live.dupRows === 2 && live.chip === '2', live);
  // and a genuinely different call recorded right after must stay unflagged
  await page.evaluate(() => window.fireFetch('DoubleFetch', { page: 2 }));
  await livePanel.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 3, null, { timeout: 8000 });
  const liveMixed = await livePanel.evaluate(() => document.querySelectorAll('#op-rows tr.dup').length);
  check('a different-variables call beside them stays unflagged', liveMixed === 2, liveMixed);
  check('no panel errors on the live path', liveErrors.length === 0, liveErrors);
  await livePanel.close();

  console.log('\n[16] stays out of the way when nothing needs it');
  // A hook left installed sits on the call stack of every request the page makes,
  // which makes Chrome file the PAGE's own CSP violations under this extension.
  await setRules(sw, []);
  const idle = await context.newPage();
  const idleErrors = [];
  idle.on('pageerror', (e) => idleErrors.push(String(e)));
  await idle.goto(base + '/', { waitUntil: 'load' });
  await sleep(500);
  const dormant = await idle.evaluate(() => ({
    fetch: /native code/.test(String(window.fetch)),
    send: /native code/.test(String(XMLHttpRequest.prototype.send)),
    open: /native code/.test(String(XMLHttpRequest.prototype.open))
  }));
  check('fetch and XHR are left untouched while no panel watches and no rule exists',
    dormant.fetch && dormant.send && dormant.open, dormant);
  await idle.evaluate(() => window.fireFetch('DormantOp', {}));
  await sleep(400);
  const idleRecs = await idle.evaluate(() => window.__records.filter((r) => r.type === 'record').map((r) => r.payload.operationName));
  check('and nothing is recorded', idleRecs.length === 0, idleRecs);

  // The point of all this: Chrome blames the top-most script frame for a CSP
  // violation. With a hook installed that frame is injected.js, so the page's
  // own blocked requests get filed under this extension in chrome://extensions.
  const cspPage = await context.newPage();
  const cspBlamed = [];
  cspPage.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|violates the following/.test(m.text())) {
      cspBlamed.push(m.location().url || '');
    }
  });
  await cspPage.goto(base + '/csp', { waitUntil: 'load' });
  await sleep(300);
  await cspPage.evaluate(() => window.fireBlocked());
  await sleep(500);
  check('the page CSP actually blocked the request (fixture is valid)', cspBlamed.length > 0, cspBlamed.length);
  check('a page CSP violation is blamed on the page, not on this extension',
    cspBlamed.every((u) => u.indexOf('chrome-extension://') !== 0), cspBlamed);
  await cspPage.close();

  // an enabled rule alone must still hook, so rules work with DevTools closed
  await setRules(sw, [{ id: 'wake', type: 'block', enabled: true, match: { operationName: 'NeverFired' } }]);
  await sleep(500);
  const byRule = await idle.evaluate(() => !/native code/.test(String(window.fetch)));
  check('an enabled rule alone is enough to hook', byRule);
  await setRules(sw, []);
  await sleep(500);
  const afterRuleRemoved = await idle.evaluate(() => /native code/.test(String(window.fetch)));
  check('removing the last rule unhooks again', afterRuleRemoved);

  // a panel attaching must wake it, and detaching must put it back
  await idle.bringToFront();
  const idleTabId = await sw.evaluate(() => new Promise((res) =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => res(t[0] && t[0].id))));
  const waker = await context.newPage();
  await waker.goto('chrome-extension://' + extId + '/src/popup.html', { waitUntil: 'load' });
  await waker.evaluate((id) => {
    window.__p = chrome.runtime.connect({ name: 'gqlop-devtools-port' });
    window.__p.postMessage({ type: 'init', tabId: id });
  }, idleTabId);
  await sleep(400);
  const wokeUp = await idle.evaluate(() => !/native code/.test(String(window.fetch)));
  check('a panel attaching hooks the page', wokeUp);
  await idle.evaluate(() => window.fireFetch('WokeUpOp', {}));
  const wokeRec = await pollRecords(idle, (r) => r.type === 'record' && r.payload.operationName === 'WokeUpOp');
  check('and recording resumes immediately', wokeRec.hit.length > 0);
  await waker.close();
  await sleep(600);
  const unhooked = await idle.evaluate(() => ({
    fetch: /native code/.test(String(window.fetch)),
    send: /native code/.test(String(XMLHttpRequest.prototype.send))
  }));
  check('closing the panel restores the native fetch and XHR', unhooked.fetch && unhooked.send, unhooked);
  check('no page errors from installing/removing the hooks', idleErrors.length === 0, idleErrors);
  await idle.close();

  console.log('\n[17] panel UI: block/unblock from the list + resizable divider');
  await setRules(sw, []);
  const uiPanel = await context.newPage();
  const uiErrors = [];
  uiPanel.on('pageerror', (e) => uiErrors.push(String(e)));
  await uiPanel.addInitScript(() => {
    window.chrome = window.chrome || {};
    try { window.chrome.devtools = { inspectedWindow: { tabId: 999997 } }; } catch (e) {}
  });
  await uiPanel.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });

  const uiOp = (id, name) => ({
    id, operationName: name, operationType: 'query', method: 'POST', url: 'https://ex.test/graphql', status: 200, ts: 1700000000000,
    entries: [{ operationName: name, query: 'query ' + name + ' { field }', variables: {} }]
  });
  await uiPanel.setInputFiles('#import-file', {
    name: 'ops.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ tool: 'graphql-operator', version: 1, operations: [uiOp('u1', 'GetUser'), uiOp('u2', 'ListJobs')] }))
  });
  await uiPanel.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 2);

  // The menu is positioned at the cursor, so it can cover the row it came from —
  // dismiss it before opening the next one.
  async function ctxMenu(id) {
    await uiPanel.keyboard.press('Escape');
    await uiPanel.click('#op-rows tr[data-id="' + id + '"]', { button: 'right' });
    return uiPanel.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#ctx-menu button'), (b) => b.textContent));
  }
  function ctxClick(prefix) {
    return uiPanel.evaluate((p) => {
      const b = Array.prototype.filter.call(document.querySelectorAll('#ctx-menu button'), (x) => x.textContent.indexOf(p) === 0)[0];
      if (!b) return false;
      b.click();
      return true;
    }, prefix);
  }
  const getRules = () => sw.evaluate(() => new Promise((res) => chrome.storage.local.get('gqlop_rules', (r) => res(r.gqlop_rules || []))));
  async function waitRules(pred, timeout = 4000) {
    const start = Date.now();
    let rs = [];
    while (Date.now() - start < timeout) {
      rs = await getRules();
      if (pred(rs)) return rs;
      await sleep(100);
    }
    return rs;
  }
  // The panel only relabels the menu once the storage change has reached it.
  async function waitCtxLabel(id, re, timeout = 4000) {
    const start = Date.now();
    let labels = [];
    while (Date.now() - start < timeout) {
      labels = await ctxMenu(id);
      if (labels.some((l) => re.test(l))) return labels;
      await sleep(100);
    }
    return labels;
  }
  // Confirms the panel itself has the rule set (the badge only counts enabled ones).
  async function waitPanelRuleCount(n, timeout = 4000) {
    const start = Date.now();
    await uiPanel.keyboard.press('Escape');
    await uiPanel.click('#btn-rules');
    let count = -1;
    while (Date.now() - start < timeout) {
      count = await uiPanel.evaluate(() => document.querySelectorAll('#rules-list .rule-item').length);
      if (count === n) break;
      await sleep(100);
    }
    await uiPanel.click('#rules-done');
    return count === n;
  }

  const menu0 = await ctxMenu('u1');
  check('an unblocked row offers Block', menu0.some((l) => l === 'Block operation "GetUser"'), menu0);
  check('and does not offer Unblock', !menu0.some((l) => /^Unblock/.test(l)), menu0);

  check('clicking Block hits the menu item', await ctxClick('Block operation'));
  const blocked = await waitRules((rs) => rs.length === 1);
  check('Block creates one block rule matching the operation name',
    blocked.length === 1 && blocked[0].type === 'block' && blocked[0].enabled === true && blocked[0].match.operationName === 'GetUser', blocked);

  const menu1 = await waitCtxLabel('u1', /^Unblock operation "GetUser"$/);
  check('a blocked row offers Unblock instead', menu1.some((l) => l === 'Unblock operation "GetUser"'), menu1);
  check('and no longer offers Block (so a second rule cannot be stacked)', !menu1.some((l) => /^Block operation/.test(l)), menu1);
  const menuOther = await ctxMenu('u2');
  check('a different operation is unaffected and still offers Block', menuOther.some((l) => l === 'Block operation "ListJobs"'), menuOther);

  await ctxMenu('u1');
  check('clicking Unblock hits the menu item', await ctxClick('Unblock operation'));
  const unblocked = await waitRules((rs) => rs.length === 0);
  check('Unblock deletes the rule the menu created', unblocked.length === 0, unblocked);

  // A rule that is only switched off must be re-armed, not duplicated.
  await setRules(sw, [{ id: 'off1', type: 'block', enabled: false, match: { operationName: 'GetUser' } }]);
  check('panel sees the disabled rule', await waitPanelRuleCount(1));
  const menuOff = await ctxMenu('u1');
  check('a disabled block rule still shows Block', menuOff.some((l) => l === 'Block operation "GetUser"'), menuOff);
  await ctxClick('Block operation');
  const rearmed = await waitRules((rs) => rs.length === 1 && rs[0].enabled === true);
  check('Block re-enables the existing rule instead of adding a second one',
    rearmed.length === 1 && rearmed[0].id === 'off1' && rearmed[0].enabled === true, rearmed);

  // A broader rule (regex here) could cover other operations, so Unblock only
  // switches it off rather than throwing it away.
  await setRules(sw, []);
  await waitCtxLabel('u1', /^Block operation/);
  await setRules(sw, [{ id: 'rx1', type: 'block', enabled: true, match: { nameRegex: '^Get' } }]);
  const menuRx = await waitCtxLabel('u1', /^Unblock operation "GetUser"$/);
  check('a regex block rule is recognised as blocking the row', menuRx.some((l) => /^Unblock/.test(l)), menuRx);
  await ctxMenu('u1');
  await ctxClick('Unblock operation');
  const broadened = await waitRules((rs) => rs.length === 1 && rs[0].enabled === false);
  check('Unblock only disables a broader rule, keeping it in the list',
    broadened.length === 1 && broadened[0].id === 'rx1' && broadened[0].enabled === false, broadened);

  // Unblocking from inside the Ruled filter must drop the row from the list.
  await setRules(sw, [{ id: 'b9', type: 'block', enabled: true, match: { operationName: 'GetUser' } }]);
  await waitCtxLabel('u1', /^Unblock operation/);
  await uiPanel.keyboard.press('Escape');
  await uiPanel.click('#toolbar .chip[data-f="ruled"]');
  const ruledRows = await uiPanel.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#op-rows tr'), (t) => t.getAttribute('data-id')));
  check('the Ruled filter shows the blocked operation', ruledRows.join(',') === 'u1', ruledRows);
  await ctxMenu('u1');
  await ctxClick('Unblock operation');
  let ruledAfter = -1;
  for (let i = 0; i < 40; i++) {
    ruledAfter = await uiPanel.evaluate(() => document.querySelectorAll('#op-rows tr').length);
    if (ruledAfter === 0) break;
    await sleep(100);
  }
  check('unblocking removes the row from the Ruled filter live', ruledAfter === 0, ruledAfter);
  await uiPanel.click('#toolbar .chip[data-f="all"]');
  await setRules(sw, []);

  // ---- the divider ----
  const panes = () => uiPanel.evaluate(() => ({
    left: document.getElementById('list-pane').getBoundingClientRect().width,
    right: document.getElementById('detail-pane').getBoundingClientRect().width,
    total: document.getElementById('split').getBoundingClientRect().width,
    sx: document.getElementById('splitter').getBoundingClientRect().x + 2,
    sy: document.getElementById('splitter').getBoundingClientRect().y + 60
  }));
  const p0 = await panes();
  check('the divider sits between the panes at the default 58/42 split',
    Math.abs(p0.left / p0.total * 100 - 58) < 2 && p0.sx > p0.left - 4, p0);

  async function dragTo(x) {
    const p = await panes();
    await uiPanel.mouse.move(p.sx, p.sy);
    await uiPanel.mouse.down();
    await uiPanel.mouse.move(x, p.sy, { steps: 6 });
    await uiPanel.mouse.up();
    return panes();
  }
  const dragged = await dragTo(p0.sx - 150);
  check('dragging the divider narrows the list and widens the detail pane',
    Math.abs(dragged.left - (p0.left - 150)) < 14 && dragged.right > p0.right + 130, [p0.left, dragged.left, p0.right, dragged.right]);

  await uiPanel.click('#btn-search');
  const searchWidth = await uiPanel.evaluate(() => document.getElementById('search-pane').getBoundingClientRect().width);
  check('the search pane inherits the same width', Math.abs(searchWidth - dragged.left) < 2, [searchWidth, dragged.left]);
  await uiPanel.keyboard.press('Escape');

  const farRight = await dragTo(p0.total + 400);
  check('the detail pane keeps a usable minimum width', farRight.right >= 258 && farRight.right < 320, farRight);
  const farLeft = await dragTo(-400);
  check('so does the list pane', farLeft.left >= 218 && farLeft.left < 280, farLeft);

  const keep = await dragTo(p0.sx - 200);
  await uiPanel.reload({ waitUntil: 'load' });
  await uiPanel.waitForSelector('#splitter');
  const restored = await panes();
  check('the dragged width survives a panel reload', Math.abs(restored.left - keep.left) < 4, [keep.left, restored.left]);

  await uiPanel.evaluate(() => document.getElementById('splitter').focus());
  await uiPanel.keyboard.press('Shift+ArrowRight');
  const nudged = await panes();
  check('arrow keys nudge the divider when it is focused',
    Math.abs((nudged.left - restored.left) - restored.total * 0.05) < 8, [restored.left, nudged.left]);

  await uiPanel.dblclick('#splitter');
  const reset = await panes();
  check('double-clicking the divider restores the default split', Math.abs(reset.left / reset.total * 100 - 58) < 2, reset);
  check('no panel page errors while blocking, unblocking and resizing', uiErrors.length === 0, uiErrors);
  await uiPanel.close();

  console.log('\n[18] Copy as cURL carries the headers actually sent (cookies included)');
  const curlPanel = await context.newPage();
  const curlErrors = [];
  curlPanel.on('pageerror', (e) => curlErrors.push(String(e)));
  // Stub the two DevTools APIs the panel uses: a tabId, plus a network log we
  // can push HAR entries into. Also capture clipboard writes.
  await curlPanel.addInitScript(() => {
    window.chrome = window.chrome || {};
    window.__netListeners = [];
    try {
      window.chrome.devtools = {
        inspectedWindow: { tabId: 999996 },
        network: { onRequestFinished: { addListener: (fn) => window.__netListeners.push(fn) } }
      };
    } catch (e) {}
    window.__copied = [];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } }
      });
    } catch (e) {}
  });
  await curlPanel.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });

  const CURL_BODY = JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { field }', variables: { id: 'abc-1' } });
  const curlRec = {
    id: 'c1', operationName: 'GetUser', operationType: 'query', method: 'POST',
    url: 'https://ex.test/graphql', status: 200, ts: 1700000000000,
    requestHeaders: { 'content-type': 'application/json' }, // all the page hooks can see
    requestBody: CURL_BODY,
    entries: [{ operationName: 'GetUser', query: 'query GetUser { field }', variables: { id: 'abc-1' } }]
  };
  // Another operation on the same endpoint with no network entry of its own:
  // stands in for a blocked/imported/pre-panel record, and must not borrow the
  // entry (or the body!) belonging to GetUser.
  const OTHER_BODY = JSON.stringify({ operationName: 'Orphan', query: 'query Orphan { f }', variables: {} });
  const curlRecNoWire = Object.assign({}, curlRec, {
    id: 'c2', operationName: 'Orphan', requestBody: OTHER_BODY,
    entries: [{ operationName: 'Orphan', query: 'query Orphan { f }', variables: {} }]
  });
  await curlPanel.setInputFiles('#import-file', {
    name: 'ops.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ tool: 'graphql-operator', version: 1, operations: [curlRec, curlRecNoWire] }))
  });
  await curlPanel.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 2);

  // What DevTools would report for that request.
  const fed = await curlPanel.evaluate((body) => {
    const entry = {
      startedDateTime: new Date(1700000000050).toISOString(),
      _resourceType: 'xhr',
      request: {
        method: 'POST',
        url: 'https://ex.test/graphql#frag',
        headers: [
          { name: ':authority', value: 'ex.test' },
          { name: 'content-type', value: 'application/json' },
          { name: 'Cookie', value: 'sid=supersecret123; plain=visible456' },
          { name: 'authorization', value: 'Bearer tok-987' },
          { name: 'User-Agent', value: 'Mozilla/5.0 (probe)' },
          { name: 'Origin', value: 'https://ex.test' },
          { name: 'Accept-Encoding', value: 'gzip, deflate, br' },
          { name: 'Content-Length', value: String(body.length) },
          { name: 'Host', value: 'ex.test' }
        ],
        cookies: [{ name: 'sid', value: 'supersecret123', httpOnly: true }],
        postData: { text: body }
      }
    };
    window.__netListeners.forEach((fn) => fn(entry));
    // A resource type the panel must ignore, on the same URL.
    window.__netListeners.forEach((fn) => fn({
      startedDateTime: new Date(1700000000000).toISOString(), _resourceType: 'stylesheet',
      request: { method: 'POST', url: 'https://ex.test/graphql', headers: [{ name: 'Cookie', value: 'wrong=1' }], postData: { text: body } }
    }));
    return window.__netListeners.length;
  }, CURL_BODY);
  check('panel subscribed to the DevTools network log', fed === 1, fed);

  async function copyCurlFor(id) {
    await curlPanel.keyboard.press('Escape');
    await curlPanel.click('#op-rows tr[data-id="' + id + '"]', { button: 'right' });
    const clicked = await curlPanel.evaluate(() => {
      const b = Array.prototype.filter.call(document.querySelectorAll('#ctx-menu button'), (x) => x.textContent === 'Copy as cURL')[0];
      if (!b) return false;
      b.click();
      return true;
    });
    if (!clicked) return null;
    await curlPanel.waitForFunction(() => window.__copied.length > 0);
    return curlPanel.evaluate(() => {
      const t = window.__copied.pop();
      return { text: t, toast: document.getElementById('toast').textContent };
    });
  }

  const c = await copyCurlFor('c1');
  check('Copy as cURL produced a command', !!c && /^curl 'https:\/\/ex\.test\/graphql'/.test(c.text), c && c.text);
  check('the session cookie is included (the actual complaint)', /-b 'sid=supersecret123; plain=visible456'/.test(c.text), c.text);
  check('Authorization added below the page is included', /-H 'authorization: Bearer tok-987'/.test(c.text), c.text);
  check('browser headers the page never set are included (UA, Origin)',
    /-H 'User-Agent: Mozilla\/5\.0 \(probe\)'/.test(c.text) && /-H 'Origin: https:\/\/ex\.test'/.test(c.text), c.text);
  check('the page-set content-type survives', /-H 'content-type: application\/json'/.test(c.text), c.text);
  check('the request body is sent with --data-raw (so a leading @ is not a filename)',
    c.text.indexOf("--data-raw '" + CURL_BODY + "'") !== -1, c.text);
  check('HTTP/2 pseudo-headers are dropped', !/:authority/.test(c.text), c.text);
  check('Cookie is not also emitted as -H (curl would send it twice)', !/-H 'Cookie/i.test(c.text), c.text);
  check('curl-managed headers are dropped (Content-Length, Host)', !/Content-Length|-H 'Host/i.test(c.text), c.text);
  check('--compressed accompanies Accept-Encoding', /--compressed/.test(c.text), c.text);
  check('redundant -X POST is omitted (implied by --data-raw)', !/-X POST/.test(c.text), c.text);
  check('the URL fragment is stripped', !/#frag/.test(c.text), c.text);
  check('a stylesheet entry on the same URL is never matched', !/wrong=1/.test(c.text), c.text);
  check('the toast says cookies went along', /includes cookies/.test(c.toast || ''), c && c.toast);

  const c2 = await copyCurlFor('c2');
  check('a record DevTools never saw still copies (page headers only)',
    !!c2 && /-H 'content-type: application\/json'/.test(c2.text) && !/-b /.test(c2.text), c2 && c2.text);
  check('and the toast says so instead of implying a working command',
    /no cookies/.test((c2 && c2.toast) || ''), c2 && c2.toast);
  check('another operation on the same endpoint never borrows GetUser\'s entry or body',
    !!c2 && c2.text.indexOf(OTHER_BODY) !== -1 && c2.text.indexOf('supersecret123') === -1, c2 && c2.text);

  const headersShown = await curlPanel.evaluate(() => {
    document.querySelector('#op-rows tr[data-id="c1"]').click();
    const tab = Array.prototype.filter.call(document.querySelectorAll('.tab'), (t) => t.getAttribute('data-tab') === 'headers')[0];
    tab.click();
    const pane = document.querySelector('.tabpane[data-pane="headers"]');
    return pane.textContent;
  });
  check('the Headers tab shows the wire headers too', /as sent on the wire/.test(headersShown) && /supersecret123/.test(headersShown), headersShown.slice(0, 200));
  check('and still shows what the page set separately', /set by the page/.test(headersShown), headersShown.slice(0, 200));
  check('no panel page errors while copying cURL', curlErrors.length === 0, curlErrors);
  await curlPanel.close();

  console.log('\n[19] wire.js pairs records with the right network entry');
  const wirePage = await context.newPage();
  await wirePage.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });
  const wire = await wirePage.evaluate(() => {
    const body = JSON.stringify({ operationName: 'Dup', query: 'query Dup { f }' });
    const entry = (t, cookie, url) => ({
      startedDateTime: new Date(t).toISOString(), _resourceType: 'fetch',
      request: { method: 'POST', url: url || 'https://ex.test/graphql', headers: [{ name: 'Cookie', value: cookie }], postData: { text: body } }
    });
    const rec = (id, ts, extra) => Object.assign({ id, method: 'POST', url: 'https://ex.test/graphql', requestBody: body, ts }, extra || {});
    const out = {};

    // two identical calls -> two distinct entries
    let s = GQLWire.createStore();
    s.add(entry(1000, 'first=1'));
    s.add(entry(2000, 'second=2'));
    out.dupA = s.match(rec('a', 1000)).cookie;
    out.dupB = s.match(rec('b', 2000)).cookie;
    out.stable = s.match(rec('a', 1000)).cookie; // repeat lookup must not drift

    // a relative XHR url still finds its absolute entry
    s = GQLWire.createStore();
    s.add(entry(1000, 'rel=1'));
    out.relative = s.match(rec('r', 1000, { url: '/graphql' })).cookie;

    // a different path never matches
    out.otherPath = s.match(rec('o', 1000, { url: '/other' }));

    // truncated capture still pairs by body prefix, and cURL uses the whole body
    s = GQLWire.createStore();
    s.add(entry(1000, 'trunc=1'));
    const cut = rec('t', 1000, { requestBody: body.slice(0, 20), requestBodyTruncated: true });
    const hit = s.match(cut);
    out.truncMatched = !!hit && hit.cookie === 'trunc=1';
    out.truncFullBody = GQLWire.buildCurl(cut, hit).indexOf(body) !== -1;

    // GET (persisted queries) keeps no -X and no body
    const g = GQLWire.buildCurl({ id: 'g', method: 'GET', url: 'https://ex.test/graphql?q=1' }, null);
    out.getCurl = g;

    // quoting survives a body with single quotes
    out.quoted = GQLWire.buildCurl({ id: 'q', method: 'POST', url: 'https://ex.test/g', requestBody: `{"a":"it's"}` }, null);
    return out;
  });
  check('two identical calls pair with two different network entries',
    wire.dupA === 'first=1' && wire.dupB === 'second=2', [wire.dupA, wire.dupB]);
  check('a second lookup of the same record returns the same entry', wire.stable === 'first=1', wire.stable);
  check('a relative XHR url pairs with its absolute network entry', wire.relative === 'rel=1', wire.relative);
  check('a different path is never paired', wire.otherPath === null, wire.otherPath);
  check('a truncated captured body still pairs by prefix', wire.truncMatched, wire);
  check('and cURL then uses the complete body from the network log', wire.truncFullBody, wire);
  check('a GET copies without -X or a body', !/-X|--data-raw/.test(wire.getCurl), wire.getCurl);
  check("a body containing ' is escaped for the shell", wire.quoted.indexOf(`'{"a":"it'\\''s"}'`) !== -1, wire.quoted);
  await wirePage.close();

  console.log('\n[20] copy: values, blocks and paths out of a response');
  const copyPanel = await context.newPage();
  const copyErrors = [];
  copyPanel.on('pageerror', (e) => copyErrors.push(String(e)));
  await copyPanel.addInitScript(() => {
    window.chrome = window.chrome || {};
    try { window.chrome.devtools = { inspectedWindow: { tabId: 999995 } }; } catch (e) {}
    window.__copied = [];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } }
      });
    } catch (e) {}
  });
  await copyPanel.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });

  // A title with a comma in it: the separator-comma must go, that one must stay.
  const RESULTS = [{ id: 'job-1', title: 'Cook, night shift' }, { id: 'job-2', title: 'Barista' }];
  const COPY_RESP = JSON.stringify({ data: { search: { total: 2, results: RESULTS } } });
  const COPY_QUERY = 'query FindJobs($q: String!) { search(q: $q) { total results { id title } } }';
  await copyPanel.setInputFiles('#import-file', {
    name: 'copy.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      tool: 'graphql-operator', version: 1,
      operations: [
        { id: 'k1', operationName: 'FindJobs', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql',
          status: 200, ts: 1700000000000, responseBody: COPY_RESP,
          entries: [{ operationName: 'FindJobs', query: COPY_QUERY, variables: { q: 'cook' } }] },
        { id: 'k2', operationName: 'NoBody', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql',
          status: 200, ts: 1700000001000, entries: [{ operationName: 'NoBody', query: 'query NoBody { f }', variables: {} }] }
      ]
    }))
  });
  await copyPanel.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 2);
  await copyPanel.click('#op-rows tr[data-id="k1"]');
  await copyPanel.click('.tab[data-tab="response"]');

  // Click the hover-copy button on the response row containing `needle`.
  const clickRowCopy = (needle) => copyPanel.evaluate((n) => {
    const rows = document.querySelectorAll('.tabpane[data-pane="response"] [data-sk="res"] .cv-row');
    for (const r of rows) {
      if (r.textContent.indexOf(n) === -1) continue;
      const b = r.querySelector('.cv-copy');
      b.dispatchEvent(new MouseEvent('mouseenter'));
      const highlighted = document.querySelectorAll('.tabpane[data-pane="response"] .cv-row.cv-copyhi').length;
      b.click();
      return { highlighted, title: b.title };
    }
    return null;
  }, needle);
  const lastCopy = () => copyPanel.evaluate(() => ({ text: window.__copied.pop(), toast: document.getElementById('toast').textContent }));

  const hasCopyButtons = await copyPanel.evaluate(() => {
    const rows = document.querySelectorAll('.tabpane[data-pane="response"] [data-sk="res"] .cv-row');
    return { rows: rows.length, buttons: document.querySelectorAll('.tabpane[data-pane="response"] [data-sk="res"] .cv-copy').length };
  });
  check('every row of the response gets a copy button', hasCopyButtons.rows > 5 && hasCopyButtons.buttons === hasCopyButtons.rows, hasCopyButtons);

  const blockHover = await clickRowCopy('"results": [');
  const blockCopy = await lastCopy();
  check('hovering the button previews the whole block it will copy',
    blockHover && blockHover.highlighted === 10, blockHover);
  check('copying a block yields the value on its own, valid and dedented',
    JSON.stringify(JSON.parse(blockCopy.text)) === JSON.stringify(RESULTS), blockCopy.text);
  check('the toast names the block that was copied and its size',
    /Copied "results" — 10 lines/.test(blockCopy.toast || ''), blockCopy.toast);

  await clickRowCopy('Cook, night shift');
  const leafCopy = await lastCopy();
  check('copying a leaf gives the bare value — no quotes, no separating comma, inner comma kept',
    leafCopy.text === 'Cook, night shift', JSON.stringify(leafCopy.text));

  await clickRowCopy('"total"');
  const numCopy = await lastCopy();
  check('a number copies as a number', numCopy.text === '2', numCopy.text);

  // right-click a line -> value / with key / path / everything
  const openRowMenu = (needle) => copyPanel.evaluate((n) => {
    const rows = document.querySelectorAll('.tabpane[data-pane="response"] [data-sk="res"] .cv-row');
    for (const r of rows) {
      if (r.textContent.indexOf(n) === -1) continue;
      r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 120 }));
      return Array.prototype.map.call(document.querySelectorAll('#ctx-menu button'),
        (b) => b.querySelector('span').textContent);
    }
    return null;
  }, needle);
  const clickMenu = (label) => copyPanel.evaluate((l) => {
    const b = Array.prototype.filter.call(document.querySelectorAll('#ctx-menu button'),
      (x) => x.querySelector('span').textContent === l)[0];
    if (!b) return false;
    b.click();
    return true;
  }, label);

  const rowMenu = await openRowMenu('"title": "Barista"');
  check('right-clicking a line offers value, key and path',
    rowMenu && rowMenu.join('|') === 'Copy value|Copy with key|Copy path|Copy everything here', rowMenu);

  await clickMenu('Copy path');
  const pathCopy = await lastCopy();
  check('Copy path gives the JSON path to that line', pathCopy.text === 'data.search.results[1].title', pathCopy.text);

  await openRowMenu('"title": "Barista"');
  await clickMenu('Copy with key');
  const withKey = await lastCopy();
  check('Copy with key keeps the JSON shape', withKey.text === '"title": "Barista"', withKey.text);

  await openRowMenu('"results": [');
  const blockMenu = await copyPanel.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#ctx-menu button'), (b) => b.textContent));
  check('a block line says so and shows how big it is', /Copy block10 lines/.test(blockMenu.join('|')), blockMenu);
  await clickMenu('Copy everything here');
  const allCopy = await lastCopy();
  check('Copy everything here takes the whole viewer',
    JSON.stringify(JSON.parse(allCopy.text)) === JSON.stringify(JSON.parse(COPY_RESP)), allCopy.text);

  // the heading's own Copy button
  await copyPanel.click('.tabpane[data-pane="response"] .section-label .copy-link');
  const sectionCopy = await lastCopy();
  check('the Body heading copies the whole response',
    JSON.stringify(JSON.parse(sectionCopy.text)) === JSON.stringify(JSON.parse(COPY_RESP)) && /Response copied/.test(sectionCopy.toast || ''), sectionCopy.toast);

  await copyPanel.click('.tab[data-tab="request"]');
  const reqCopyLabels = await copyPanel.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('.tabpane[data-pane="request"] .section-label'),
      (l) => l.firstChild.textContent + (l.querySelector('.copy-link') ? '+copy' : '')));
  check('the query and variables headings have one too', reqCopyLabels.join(',') === 'Operation type,Query+copy,Variables+copy', reqCopyLabels);
  await copyPanel.click('.tabpane[data-pane="request"] .section-label .copy-link');
  const queryCopy = await lastCopy();
  check('copying the query gives it formatted, not as one escaped line',
    /^query FindJobs\(\$q: String!\) \{\n {2}search\(q: \$q\) \{/.test(queryCopy.text || ''), queryCopy.text);

  // and from the operation list, without opening anything
  await copyPanel.keyboard.press('Escape');
  await copyPanel.click('#op-rows tr[data-id="k1"]', { button: 'right' });
  const listMenu = await copyPanel.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#ctx-menu button'), (b) => b.textContent));
  check('the operation list offers Copy response', listMenu.indexOf('Copy response') !== -1, listMenu);
  await copyPanel.evaluate(() => {
    Array.prototype.filter.call(document.querySelectorAll('#ctx-menu button'), (b) => b.textContent === 'Copy response')[0].click();
  });
  const listCopy = await lastCopy();
  check('and copies it pretty-printed', /^\{\n {2}"data": \{/.test(listCopy.text || ''), (listCopy.text || '').slice(0, 40));

  await copyPanel.keyboard.press('Escape');
  await copyPanel.click('#op-rows tr[data-id="k2"]', { button: 'right' });
  const noBodyMenu = await copyPanel.evaluate(() => {
    const b = Array.prototype.filter.call(document.querySelectorAll('#ctx-menu button'), (x) => x.textContent === 'Copy response')[0];
    return b ? b.disabled : null;
  });
  check('an operation with no response has Copy response disabled', noBodyMenu === true, noBodyMenu);
  await copyPanel.keyboard.press('Escape');

  console.log('\n[21] the tab bar lives in the title bar and stays put while scrolling');
  const placement = await copyPanel.evaluate(() => ({
    inTitleBar: !!document.querySelector('#detail-top #detail-head') && !!document.querySelector('#detail-top .tabs'),
    sameRow: (() => {
      const h = document.querySelector('#detail-head').getBoundingClientRect();
      const t = document.querySelector('.tabs').getBoundingClientRect();
      return t.left >= h.right - 1 && t.bottom <= h.bottom + 12;
    })()
  }));
  check('the tabs sit inside the title bar, beside the operation name', placement.inTitleBar && placement.sameRow, placement);

  await copyPanel.setViewportSize({ width: 1000, height: 360 });
  await copyPanel.click('#op-rows tr[data-id="k1"]');
  await copyPanel.click('.tab[data-tab="response"]');
  const scrolled = await copyPanel.evaluate(() => {
    const panes = document.querySelector('.tabpanes');
    const before = document.querySelector('.tabs').getBoundingClientRect().top;
    panes.scrollTop = 9999;
    const tabs = document.querySelector('.tabs').getBoundingClientRect();
    return {
      before, after: tabs.top, scrolledBy: panes.scrollTop,
      onScreen: tabs.top >= 0 && tabs.bottom <= window.innerHeight,
      paneScrolls: document.getElementById('detail-pane').scrollHeight <= document.getElementById('detail-pane').clientHeight
    };
  });
  check('the pane below the tabs is the thing that scrolls', scrolled.scrolledBy > 0 && scrolled.paneScrolls, scrolled);
  check('the tab bar does not move when it does', scrolled.after === scrolled.before && scrolled.onScreen, scrolled);

  await copyPanel.click('.tab[data-tab="headers"]');
  const afterSwitch = await copyPanel.evaluate(() => ({
    active: (document.querySelector('.tab.active') || {}).textContent,
    pane: !!document.querySelector('.tabpane[data-pane="headers"].active')
  }));
  check('so you can still switch tabs from the bottom of a long response',
    afterSwitch.active === 'Headers' && afterSwitch.pane, afterSwitch);

  await copyPanel.click('.tab[data-tab="response"]');
  await copyPanel.evaluate(() => { document.querySelector('.tabpanes').scrollTop = 9999; });
  await copyPanel.click('#op-rows tr[data-id="k2"]');
  const topReset = await copyPanel.evaluate(() => document.querySelector('.tabpanes').scrollTop);
  check('picking another operation starts it at the top', topReset === 0, topReset);
  check('no panel page errors while copying', copyErrors.length === 0, copyErrors);
  await copyPanel.close();

  console.log('\n[22] viewers grow to fit, open expanded, and fold from their heading');
  const foldPanel = await context.newPage();
  const foldErrors = [];
  foldPanel.on('pageerror', (e) => foldErrors.push(String(e)));
  await foldPanel.addInitScript(() => {
    window.chrome = window.chrome || {};
    try { window.chrome.devtools = { inspectedWindow: { tabId: 999994 } }; } catch (e) {}
  });
  await foldPanel.setViewportSize({ width: 1200, height: 700 });
  await foldPanel.goto('chrome-extension://' + extId + '/src/panel.html', { waitUntil: 'load' });
  const BIG_RESULTS = Array.from({ length: 80 }, (_, i) => ({ id: 'job-' + i, title: 'Job ' + i }));
  await foldPanel.setInputFiles('#import-file', {
    name: 'fold.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      tool: 'graphql-operator', version: 1,
      operations: [
        { id: 'f1', operationName: 'BigList', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql',
          status: 200, ts: 1700000000000,
          responseBody: JSON.stringify({ data: { search: { total: 80, results: BIG_RESULTS } } }),
          entries: [{ operationName: 'BigList',
            query: 'query BigList($filter: F!) { search(filter: $filter) { total results { ...R } } } fragment R on Result { id title }',
            variables: { filter: { text: 'cook', tags: ['a', 'b'] }, note: 'x'.repeat(600) } }] },
        { id: 'f2', operationName: 'Flat', operationType: 'query', method: 'POST', url: 'https://ex.test/graphql',
          status: 200, ts: 1700000001000, responseBody: JSON.stringify({ data: { ok: true } }),
          entries: [{ operationName: 'Flat', query: 'query Flat($q: String) { ok }', variables: { q: 'cook' } }] }
      ]
    }))
  });
  await foldPanel.waitForFunction(() => document.querySelectorAll('#op-rows tr').length === 2);
  await foldPanel.click('#op-rows tr[data-id="f1"]');
  await foldPanel.click('.tab[data-tab="response"]');

  const resBlock = () => foldPanel.evaluate(() => {
    const b = document.querySelector('.tabpane[data-pane="response"] [data-sk="res"]');
    const panes = document.querySelector('.tabpanes');
    return {
      rows: b.querySelectorAll('.cv-row').length,
      hidden: Array.prototype.filter.call(b.querySelectorAll('.cv-row'), (r) => r.style.display === 'none').length,
      height: b.clientHeight, scrollHeight: b.scrollHeight,
      sideways: b.scrollWidth > b.clientWidth,
      paneScrolls: panes.scrollHeight > panes.clientHeight,
      dataFolded: Array.prototype.some.call(b.querySelectorAll('.cv-row.cv-collapsed'), (r) => /"data": \{/.test(r.textContent))
    };
  });
  const big = await resBlock();
  check('a long response opens with every row showing', big.rows > 300 && big.hidden === 0, big);
  check('it grows to its full height instead of scrolling inside a 360px box',
    big.height > 2000 && big.scrollHeight <= big.height, big);
  check('the tab pane is the one scroller', big.paneScrolls, big);
  check('no sideways scrollbar when every line fits', !big.sideways, big);

  const resLinks = await foldPanel.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('.tabpane[data-pane="response"] .section-label .fold-link'), (b) => b.textContent));
  check('the Body heading offers Expand all / Collapse all', resLinks.join(',') === 'Expand all,Collapse all', resLinks);
  const clickFold = (pane, heading, label) => foldPanel.evaluate(([p, h, l]) => {
    const lab = Array.prototype.filter.call(document.querySelectorAll('.tabpane[data-pane="' + p + '"] .section-label'),
      (x) => x.firstChild.textContent === h)[0];
    Array.prototype.filter.call(lab.querySelectorAll('.fold-link'), (b) => b.textContent === l)[0].click();
  }, [pane, heading, label]);
  await clickFold('response', 'Body', 'Collapse all');
  const folded = await resBlock();
  check('Collapse all folds the response down to its outline',
    folded.rows - folded.hidden === 3 && folded.dataFolded && folded.height < 200, folded);
  await clickFold('response', 'Body', 'Expand all');
  const unfolded = await resBlock();
  check('Expand all opens every block again', unfolded.hidden === 0 && unfolded.height === big.height, unfolded);

  await foldPanel.click('.tab[data-tab="request"]');
  const req = await foldPanel.evaluate(() => {
    const pane = document.querySelector('.tabpane[data-pane="request"]');
    const v = pane.querySelector('[data-sk="v0"]');
    const links = {};
    pane.querySelectorAll('.section-label').forEach((l) => { links[l.firstChild.textContent] = l.querySelectorAll('.fold-link').length; });
    return { links, sideways: v.scrollWidth > v.clientWidth, tall: v.scrollHeight > v.clientHeight };
  });
  check('a line wider than the pane scrolls sideways — only that block, never vertically',
    req.sideways && !req.tall, req);
  check('Query and nested Variables headings get fold buttons too',
    req.links.Query === 2 && req.links.Variables === 2, req.links);

  // Inline fragments swaps the query block; the buttons must drive the new one.
  await foldPanel.click('.tabpane[data-pane="request"] .findbar .tcheck input');
  await clickFold('request', 'Query', 'Collapse all');
  const inlined = await foldPanel.evaluate(() => {
    const pane = document.querySelector('.tabpane[data-pane="request"]');
    const label = Array.prototype.filter.call(pane.querySelectorAll('.section-label'), (x) => x.firstChild.textContent === 'Query')[0];
    const q = label.parentNode.querySelector('.codeview');
    return {
      buttons: label.querySelectorAll('.fold-link').length,
      inlinedFields: /# \.\.\.R/.test(q.textContent),
      hidden: Array.prototype.filter.call(q.querySelectorAll('.cv-row'), (r) => r.style.display === 'none').length
    };
  });
  check('after Inline fragments, the Query buttons fold the expanded query (and are not duplicated)',
    inlined.buttons === 2 && inlined.inlinedFields && inlined.hidden > 0, inlined);

  await foldPanel.click('#op-rows tr[data-id="f2"]');
  const flatLinks = await foldPanel.evaluate(() => {
    const links = {};
    document.querySelectorAll('.tabpane[data-pane="request"] .section-label').forEach((l) => {
      links[l.firstChild.textContent] = l.querySelectorAll('.fold-link').length;
    });
    return links;
  });
  check('a flat variables object (nothing to fold) gets no fold buttons', flatLinks.Variables === 0, flatLinks);
  check('no panel page errors while folding', foldErrors.length === 0, foldErrors);
  await foldPanel.close();

  console.log('\n[23] no fatal page errors');
  const gqlopErr = pageErrors.filter((e) => /GQLOP is not defined/.test(e));
  check('no "GQLOP is not defined" errors', gqlopErr.length === 0, gqlopErr);
  check('no uncaught page errors at all', pageErrors.length === 0, pageErrors);

  await context.close();
  server.close();

  console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
