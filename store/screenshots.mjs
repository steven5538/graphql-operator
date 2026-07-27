/*
 * Generates Chrome Web Store screenshots (1280x800) of the real DevTools panel.
 *
 * It renders src/panel.html/.css/.js unchanged, but with a stubbed `chrome`
 * object and curated sample operations, so the screenshots are pixel-identical
 * to the live panel with clean demo data. Writes to store/screenshots/.
 *
 * Run: node store/screenshots.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'store', 'screenshots');
const HARNESS = path.join(SRC, '_harness.html');
fs.mkdirSync(OUT, { recursive: true });

// ---- fake chrome + sample data injected into the page --------------------
const FAKE_CHROME = `
window.chrome = {
  devtools: { inspectedWindow: { tabId: 1 }, panels: { create: function(){} } },
  runtime: {
    connect: function () {
      var ls = [];
      window.__emit = function (m) { ls.forEach(function (f) { f(m); }); };
      return { onMessage: { addListener: function (f) { ls.push(f); } }, onDisconnect: { addListener: function () {} }, postMessage: function () {} };
    }
  },
  storage: {
    local: {
      get: function (k, cb) { cb({ gqlop_rules: window.__RULES }); },
      set: function (o, cb) { if (cb) cb(); }
    },
    onChanged: { addListener: function () {} }
  }
};
window.__RULES = [
  { id: 'r1', type: 'block', enabled: true, match: { operationName: 'DeleteAccount' } },
  { id: 'r2', type: 'delay', enabled: true, match: { nameRegex: '^Search' }, delayMs: 3000 },
  { id: 'r3', type: 'override', enabled: true, match: { operationName: 'GetFeatureFlags' }, override: { status: 200, body: '{"data":{"flags":{"newCheckout":true}}}' } },
  { id: 'r4', type: 'rewrite', enabled: false, match: { operationName: 'ListProducts' }, rewrite: { variables: { mode: 'merge', value: { first: 5 } } } }
];
`;

const DRIVER = `
(function () {
  var now = Date.now();
  function rec(o) {
    return Object.assign({
      transport: 'fetch', isBatch: false, method: 'POST', url: 'https://api.example.com/graphql',
      requestHeaders: { 'content-type': 'application/json', 'authorization': 'Bearer \\u2022\\u2022\\u2022' },
      credentials: 'include', status: 200, ok: true, statusText: 'OK',
      responseHeaders: { 'content-type': 'application/json' }, ts: now
    }, o);
  }
  function body(op, q, vars) { return JSON.stringify({ operationName: op, query: q, variables: vars || {} }); }

  var products = { data: { products: { edges: [] } } };
  for (var i = 1; i <= 8; i++) products.data.products.edges.push({ node: { id: 'p' + i, name: 'Product ' + i, price: { amount: (i * 3.5).toFixed(2), currency: 'USD' }, inStock: i % 2 === 0 } });

  var recs = [
    rec({ id: 'a', operationName: 'GetCurrentUser', operationType: 'query', durationMs: 31,
      entries: [{ operationName: 'GetCurrentUser', operationType: 'query', query: 'query GetCurrentUser {\\n  me {\\n    id\\n    name\\n    email\\n  }\\n}', variables: {} }],
      requestBody: body('GetCurrentUser', 'query GetCurrentUser { me { id name email } }'),
      responseBody: JSON.stringify({ data: { me: { id: 'u_42', name: 'Ada Lovelace', email: 'ada@example.com' } } }) }),
    rec({ id: 'b', operationName: 'ListProducts', operationType: 'query', durationMs: 118,
      entries: [{ operationName: 'ListProducts', operationType: 'query', query: 'query ListProducts($first: Int!) {\\n  products(first: $first) {\\n    edges { node { id name price { amount currency } inStock } }\\n  }\\n}', variables: { first: 8 } }],
      requestBody: body('ListProducts', 'query ListProducts($first: Int!) { products(first: $first) { edges { node { id name price { amount currency } inStock } } } }', { first: 8 }),
      responseBody: JSON.stringify(products) }),
    rec({ id: 'c', operationName: 'ProductDetails', operationType: 'query', durationMs: 64,
      entries: [{ operationName: 'ProductDetails', operationType: 'query', variables: { id: 'p3' },
        query: 'query ProductDetails($id: ID!) {\\n  product(id: $id) {\\n    ...ProductCard\\n    description\\n    reviews(first: 3) { edges { node { rating author } } }\\n  }\\n}\\n\\nfragment ProductCard on Product {\\n  id\\n  name\\n  price { ...PriceInfo }\\n}\\n\\nfragment PriceInfo on Money {\\n  amount\\n  currency\\n}' }],
      requestBody: body('ProductDetails', 'query ProductDetails($id: ID!){ product(id:$id){ ...ProductCard } }', { id: 'p3' }),
      responseBody: JSON.stringify({ data: { product: { id: 'p3', name: 'Product 3', price: { amount: '10.50', currency: 'USD' }, description: 'A fine product.', reviews: { edges: [{ node: { rating: 5, author: 'Grace' } }] } } } }) }),
    rec({ id: 'd', operationName: 'AddToCart', operationType: 'mutation', durationMs: 96,
      entries: [{ operationName: 'AddToCart', operationType: 'mutation', query: 'mutation AddToCart($id: ID!, $qty: Int!) {\\n  addToCart(productId: $id, quantity: $qty) {\\n    cart { itemCount subtotal }\\n  }\\n}', variables: { id: 'p3', qty: 2 } }],
      requestBody: body('AddToCart', 'mutation AddToCart($id: ID!, $qty: Int!){ addToCart(productId:$id, quantity:$qty){ cart{ itemCount subtotal } } }', { id: 'p3', qty: 2 }),
      responseBody: JSON.stringify({ data: { addToCart: { cart: { itemCount: 3, subtotal: '31.50' } } } }) }),
    rec({ id: 'e', operationName: 'Checkout', operationType: 'mutation', durationMs: 142,
      entries: [{ operationName: 'Checkout', operationType: 'mutation', query: 'mutation Checkout($token: String!) {\\n  checkout(paymentToken: $token) { orderId }\\n}', variables: { token: 'tok_abc' } }],
      requestBody: body('Checkout', 'mutation Checkout($token: String!){ checkout(paymentToken:$token){ orderId } }', { token: 'tok_abc' }),
      responseBody: JSON.stringify({ data: null, errors: [{ message: 'Payment declined', path: ['checkout'], extensions: { code: 'PAYMENT_DECLINED' } }] }) }),
    rec({ id: 'f', operationName: 'SearchProducts', operationType: 'query', durationMs: 3040, delayedMs: 3000,
      entries: [{ operationName: 'SearchProducts', operationType: 'query', query: 'query SearchProducts($q: String!) {\\n  search(query: $q) { edges { node { id name } } }\\n}', variables: { q: 'lamp' } }],
      requestBody: body('SearchProducts', 'query SearchProducts($q: String!){ search(query:$q){ edges{ node{ id name } } } }', { q: 'lamp' }),
      responseBody: JSON.stringify({ data: { search: { edges: [{ node: { id: 'p2', name: 'Product 2' } }] } } }) }),
    rec({ id: 'g', operationName: 'GetFeatureFlags', operationType: 'query', durationMs: 2, overridden: true, ruleId: 'r3',
      entries: [{ operationName: 'GetFeatureFlags', operationType: 'query', query: 'query GetFeatureFlags {\\n  flags { newCheckout darkMode }\\n}', variables: {} }],
      requestBody: body('GetFeatureFlags', 'query GetFeatureFlags { flags { newCheckout darkMode } }'),
      responseHeaders: { 'content-type': 'application/json', 'x-gqlop-override': '1' },
      responseBody: '{"data":{"flags":{"newCheckout":true}}}' }),
    rec({ id: 'h', operationName: 'UpdateProfile', operationType: 'mutation', durationMs: 77, isResent: true, resendOf: 'x',
      entries: [{ operationName: 'UpdateProfile', operationType: 'mutation', query: 'mutation UpdateProfile($name: String!) {\\n  updateProfile(name: $name) { id name }\\n}', variables: { name: 'Ada L.' } }],
      requestBody: body('UpdateProfile', 'mutation UpdateProfile($name: String!){ updateProfile(name:$name){ id name } }', { name: 'Ada L.' }),
      responseBody: JSON.stringify({ data: { updateProfile: { id: 'u_42', name: 'Ada L.' } } }) })
  ];

  window.__emit({ type: 'buffer', events: recs.map(function (r) { return { kind: 'record', record: r }; }) });
})();
`;

function buildHarness() {
  let html = fs.readFileSync(path.join(SRC, 'panel.html'), 'utf8');
  html = html.replace('<script src="lib/protocol.js"></script>', '<script>' + FAKE_CHROME + '</script>\n  <script src="lib/protocol.js"></script>');
  html = html.replace('<script src="panel.js"></script>', '<script src="panel.js"></script>\n  <script>' + DRIVER + '</script>');
  fs.writeFileSync(HARNESS, html);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  buildHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  await page.goto('file://' + HARNESS);
  await page.waitForSelector('#op-rows tr');
  await sleep(300);

  async function shot(name) { await page.screenshot({ path: path.join(OUT, name) }); console.log('  wrote store/screenshots/' + name); }
  const row = (name) => page.locator('#op-rows tr', { hasText: name }).first();

  // 1) overview — a query with a rich, folded response
  await row('ListProducts').click();
  await page.locator('.tab[data-tab="response"]').click();
  await sleep(200);
  await shot('01-overview.png');

  // 2) right-click context menu on a mutation
  await row('AddToCart').click({ button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)');
  await sleep(150);
  await shot('02-context-menu.png');
  await page.keyboard.press('Escape');

  // 3) modify & resend editor (Query + Variables fields)
  await row('AddToCart').click({ button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)');
  await page.locator('#ctx-menu button', { hasText: 'Modify & resend' }).click();
  await page.waitForSelector('#editor-backdrop:not(.hidden)');
  await sleep(200);
  await shot('03-modify-resend.png');
  await page.keyboard.press('Escape');

  // 4) rules manager (block / rewrite / delay / override)
  await page.locator('#btn-rules').click();
  await page.waitForSelector('#rules-backdrop:not(.hidden)');
  await sleep(150);
  await shot('04-rules.png');
  await page.keyboard.press('Escape');

  // 5) request tab with inline-fragments expansion
  await row('ProductDetails').click();
  await page.locator('.tab[data-tab="request"]').click();
  await sleep(150);
  const toggle = page.locator('#detail .findbar input[type="checkbox"]').first();
  if (await toggle.count()) { await toggle.check(); await sleep(200); }
  await shot('05-inline-fragments.png');

  await browser.close();
  fs.rmSync(HARNESS, { force: true });
  console.log('done.');
})().catch((e) => { console.error(e); try { fs.rmSync(HARNESS, { force: true }); } catch (x) {} process.exit(1); });
