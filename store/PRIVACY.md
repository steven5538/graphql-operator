# Privacy Policy — GraphQL Operator

_Last updated: 2026-07-27_

GraphQL Operator is a developer tool that runs entirely inside your browser. It is
designed so that **your data never leaves your device**.

## What the extension does

GraphQL Operator observes GraphQL network requests made by the web pages you inspect and
displays them in a DevTools panel, where you can inspect, modify, block, delay, override,
and resend them. It also lets you save reusable rules (block / rewrite / delay / override).

## Data we collect and send

**None.** The developer does not collect, receive, store, sell, or transmit any of your
data. The extension contains no analytics, no telemetry, and makes no network requests of
its own to any server operated by the developer or any third party.

## Data the extension handles locally (on your device only)

- **Captured GraphQL operations** (operation names, queries, variables, request/response
  headers and bodies, timing). These exist only in memory while the DevTools panel is
  open and in a temporary in‑memory buffer in the extension's background service worker.
  They are **not persisted to disk** and are discarded when you close the panel/DevTools,
  when the inspected tab navigates, or when the browser evicts the service worker.
- **Rules** you create (block / rewrite / delay / override) are stored locally using the
  browser's `chrome.storage.local` API so they persist between sessions. They remain on
  your device and are removed when you delete them or uninstall the extension.
- **Export files** are created only when you explicitly click "Export", and are saved by
  you, to a location you choose, as a normal file download.

Because captured request/response data can include authentication headers and other
sensitive content (just like the browser's built‑in Network panel), treat exported files
and the panel contents accordingly. This data is never sent anywhere by the extension.

## Permissions and why they are needed

- **`storage`** — to save your rules locally on your device.
- **Host access (all sites, via content scripts)** — to observe and, when you create a
  rule, modify the GraphQL requests made by the pages you choose to inspect. The extension
  only acts on GraphQL requests and only does anything beyond passive recording when you
  create a rule or trigger an action (resend/modify).

## Changes

If this policy changes, the "Last updated" date above will be revised.

## Contact

Questions about this policy: <your-contact-email@example.com>
