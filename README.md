# GraphQL Operator

A Chrome (Manifest V3) DevTools extension that **records every GraphQL operation**
on a page and lets you **modify, block, or resend** any of them from a right-click
menu — plus persistent rules that intercept future traffic.

![panel](icons/icon128.png)

## Features

- **Records all GraphQL traffic** — `fetch` and `XMLHttpRequest`, single and batched
  operations, with operation name, type (query / mutation / subscription), variables,
  request/response headers, status, and timing.
- **DevTools panel** — a new **GraphQL** tab next to Network/Console, scoped to the
  inspected tab.
- **Foldable, syntax-highlighted view** — queries and variables render as collapsible,
  highlighted code instead of a raw escaped blob. Large response/variable blocks
  auto-collapse; the query stays open. **Inline fragments** toggle expands `...Spreads`
  in place so fragment-heavy queries read as one tree.
- **Duplicate-call hint** — when the *same* operation (same URL, method, query and
  variables) fires twice inside a short window, every call in the burst is tinted
  orange and tagged `dup ×N`. That is almost always a bug: a double-firing effect, a
  re-render refetch, or two components asking for the same data. The detail pane says
  how many, how far apart, and links to the sibling calls; the **Dupes** chip counts
  them and filters the list. The window (`≤250ms` … `≤5s`, default `≤1s`) is a dropdown
  next to the chip and re-clusters live. Query formatting and JSON key order are
  ignored when comparing; your own **Resend**s are never flagged.
- **Filter & find** — filter the list by text and by chips (All / Errors / Mutations /
  Ruled / Dupes, with live errored- and duplicate-op counts); the find-in-viewer box
  highlights every match in the query/response, shows `3 / 12`, and steps through them
  with `Enter` / `Shift+Enter` or the `↑` / `↓` buttons (wrapping around, current match
  centred). `Escape` clears the box.
- **Search all requests** (`Search all` button or `Ctrl/Cmd+F`) — one string searched
  across **every** recorded operation: variable values, query text, request/response
  bodies, headers, operation names and URLs. Hits are grouped per operation with the
  field and line number; clicking one opens that operation on the right tab and scrolls
  to the matching line. Scope it to Variables / Query / Response / Headers, and toggle
  match-case (`Aa`) or regex (`.*`); `Enter` / `Shift+Enter` step through hits.
- **Right-click any operation:**
  - **Resend** — replay the exact captured request (runs in the page, so cookies /
    auth are preserved).
  - **Modify & resend…** — edit the **Query** and **Variables** as separate fields
    (or switch to raw JSON), plus URL/headers, then fire it once.
  - **Block operation** — rule that returns a synthetic GraphQL error for matching ops.
    Right-clicking an already-blocked operation offers **Unblock operation** instead, so
    you never stack a second identical rule: it deletes the rule the menu created, or
    (for a broader hand-written rule — regex / URL / type) just switches it off.
  - **Delay operation…** — rule that holds matching requests for N ms before they
    resolve (test loading states, timeouts, races). Default 30s.
  - **Override response…** — rule that returns a custom body / GraphQL error / HTTP
    status *without hitting the server* (force empty/error states). Prefilled with the
    captured response so you can tweak it.
  - **Create rewrite rule…** — auto-modify the query, variables, or headers of future
    matching requests before they are sent.
  - **Copy** operation name / query / variables / as a `cURL` command. The cURL is built
    from the headers the request **actually left the browser with** — cookies (including
    `HttpOnly`), `Authorization` added by a service worker, `User-Agent`, `Origin`,
    `Referer`, `sec-*` — so it runs as-is in a terminal instead of 401ing. (It therefore
    contains your session: redact before pasting it into a ticket.)
- **Rules** (persistent, apply to all tabs) — block / rewrite / delay / override, matched
  by exact name, **regex**, operation type, HTTP method, or URL substring. Manage from
  the panel or the toolbar popup; toggle and delete individually.
- **Resizable layout** — drag the divider between the list and the detail pane
  (double-click to reset, `←` / `→` when it has focus). The width is remembered.
- **Export / import** — save captured operations to JSON and re-import them.
- **Zero footprint when idle** — `fetch` / `XMLHttpRequest` are only hooked while a
  GraphQL panel is watching that tab or an enabled rule exists. The rest of the time
  the page runs on the untouched native functions, so the extension never appears on
  the call stack of requests it isn't inspecting (see *Notes & limits*).

## Install (unpacked)

1. `chrome://extensions`
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select this folder (`graphql-operator/`).
4. **Reload any already-open tab you want to inspect.** Content scripts attach at
   `document_start`, so they only apply to pages loaded *after* the extension was
   installed/reloaded — an already-open page won't be intercepted until you reload it.
   (The same applies every time you reload the extension during development.)
5. Open **DevTools** (`F12` / `⌥⌘I`) and click the **GraphQL** tab.

Capture begins the moment the panel attaches (no reload needed for that), but
operations that already fired during page load are not retro-captured — reload the page
to see those, the same way Chrome's own Network panel works.

Works in Chrome and Edge 111+ (needs `world: "MAIN"` content scripts).

**Troubleshooting — nothing shows up?** Reload the page (see step 4). To confirm the
interceptor attached, run `localStorage.GQLOP_DEBUG = '1'` in the page console and reload;
you should see `[GraphQL Operator] interceptor installed …` and a line per captured op.

## How it works

```
 page (MAIN world)                isolated world            service worker         DevTools
┌───────────────────┐  postMsg  ┌──────────────────┐  port ┌──────────────┐  port ┌──────────┐
│ injected.js        │◄────────►│ content-bridge.js │◄────►│ background.js │◄────►│ panel.js │
│ patches fetch/XHR  │           │ storage + relay  │       │ buffer+route │       │ the UI   │
└───────────────────┘           └──────────────────┘       └──────────────┘       └──────────┘
```

- `injected.js` runs in the page's **main world** at `document_start` and monkey-patches
  `window.fetch` / `XMLHttpRequest`. For each GraphQL request it records the details,
  applies any matching **block** (synthetic response) or **rewrite** (body/header)
  rules, and can **replay** a request on command.
- `content-bridge.js` (isolated world) is the only piece that sees both the page
  (`window.postMessage`) and `chrome.*`. It loads rules from `chrome.storage`, pushes
  them into the page, and relays records up / resend commands down.
- `background.js` buffers records per tab (so a panel opened late still sees history)
  and routes messages between each page and its DevTools panel.
- `panel.js` is the UI. Rules live in `chrome.storage.local`; the panel and popup read
  and write them directly and react to `chrome.storage.onChanged`.

## Notes & limits

- **Privacy:** everything stays local. Recorded traffic lives only in the open panel's
  memory (and the service worker's per-tab buffer); only your **rules** are persisted
  (`chrome.storage.local`). Nothing is sent anywhere. Recorded requests include auth
  headers/cookies-bearing calls — treat the panel like the Network tab.
- **Where the real headers come from.** A main-world `fetch` hook only sees what the page
  passed in; everything the network stack adds afterwards (cookies, `Origin`, `Referer`,
  `User-Agent`, `sec-*`) is invisible from there. The panel therefore also reads the
  DevTools network log (`chrome.devtools.network`, no extra permission) and pairs each
  finished request back to its record by method + URL + body. That pairing feeds
  **Copy as cURL** and the *“as sent on the wire”* section of the **Headers** tab. When
  no pairing exists — a **blocked** or **overridden** operation never reached the
  network, and an **imported** one has no log entry — the cURL falls back to the
  page-visible headers and the toast says so rather than handing you a command that
  silently 401s. Two identical calls are paired to two distinct log entries, and a record
  whose body is known is never paired with an entry carrying a different one.
- **Blocking** returns HTTP `200` with a GraphQL `errors[]` body (`extensions.gqlOperatorBlocked`)
  for `fetch`, so apps handle it gracefully rather than crashing. Blocked `XHR` requests
  are surfaced to the page as a network error (legacy path).
- **Override** (response mocking) is exact for `fetch`; for `XHR` it is best-effort
  (the native response getters are shadowed on the instance), which covers most clients.
- **Rewrites** apply to POST JSON bodies. Multipart (file upload) and persisted/APQ
  operations are recorded read-only (variables can still be rewritten; query text may be
  unavailable for APQ).
- **XHR rewrites** can change the **body** (query / variables) but **not headers** —
  `XMLHttpRequest.setRequestHeader` can only append, never replace or remove. Header
  rewrite rules therefore apply to `fetch` requests only. (Modern GraphQL clients use
  `fetch`.)
- **GET GraphQL** operations (rare — some persisted-query setups) are not intercepted;
  only POST is inspected/blocked/rewritten.
- **Hooks are installed on demand.** A main-world `fetch` hook is, by construction, the
  top-most script frame of every request the page makes — and Chrome attributes console
  errors (notably **CSP violations**) to that frame. Left always-on, the page's *own*
  blocked requests get filed under this extension in `chrome://extensions`, which looks
  like the extension is failing when nothing is wrong. So the interceptor stays dormant
  and hooks nothing until a panel is watching that tab or an enabled rule exists;
  `window.fetch` is the genuine native function the rest of the time. While you *are*
  recording, the page's CSP violations will still be attributed to the extension —
  that is inherent to main-world interception, and those errors are the page's, not
  the extension's.
- **Trust model:** the interceptor lives in the page's main world, so a hostile page
  could in principle observe rules pushed to it or interfere with interception. This is
  inherent to any main-world network hook; treat this as a developer tool for pages you
  trust, not a security boundary. Rules are not persisted anywhere the page can read them
  at rest (only pushed in-memory via `postMessage`).
- **Batched** operations: a rewrite is applied per matching entry; a block rejects the
  whole batch if any entry matches.
- **Duplicate detection** is a heuristic on the payload, not proof of a bug — a poll
  faster than the window is flagged too. A burst is clustered from its *first* call, so
  a steady poll slower than the window never collapses into one endless group. It runs
  panel-side over what the panel has recorded, so it sees nothing from before the panel
  was opened, and the chosen window is not persisted across panel reopens.
- Request bodies are kept intact up to 5 MB for faithful resend (larger ones are flagged
  and resend is disabled); response bodies are truncated at 512 KB for display.
- The interceptor **fails open**: any internal error falls back to the original
  `fetch`/`send`, so it never breaks the page.

## Icons

Regenerate with:

```bash
node tools/gen-icons.js
```

## File layout

```
manifest.json
src/
  background.js        service worker: buffer + router
  content-bridge.js    isolated-world bridge (storage + relay)
  injected.js          main-world fetch/XHR interceptor
  devtools.html/js     registers the panel
  panel.html/css/js    the DevTools UI
  popup.html/js        toolbar popup (rules overview)
  lib/protocol.js      shared constants (isolated content script, background, pages)
  lib/codeview.js      GraphQL/JSON pretty-printer + foldable, highlighted viewer
  lib/search.js        cross-request text search (fields, matcher, line numbers)
  lib/dupes.js         duplicate-call detection (payload signature + time clustering)
tools/gen-icons.js     dependency-free PNG icon generator
icons/                 icon16/48/128.png
test/e2e.mjs           Playwright end-to-end test (loads the extension in Chromium)
```

> `injected.js` inlines its own copy of the postMessage constants (rather than reading
> `lib/protocol.js`), because sibling files in a `world:"MAIN"` content-script entry do
> not reliably share scope.

## Tests

An end-to-end Playwright test loads the unpacked extension into Chromium and exercises
recording, blocking, rewriting, resend, delay, the foldable code viewer, the
cross-request search, and duplicate detection (library, panel UI, and live intercepted
traffic) against a mock GraphQL server:

```bash
npm install                     # installs playwright
npx playwright install chromium # one-time browser download
npm test                        # runs test/e2e.mjs
```
