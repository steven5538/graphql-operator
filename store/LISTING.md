# Chrome Web Store listing copy — GraphQL Operator

Paste these fields into the Web Store Developer Dashboard. Replace anything in
`<angle brackets>`.

---

## Product name
GraphQL Operator

## Category
Developer Tools

## Language
English (United States)

## Single purpose (required field)
> Record the GraphQL operations made by the page you are inspecting and let developers
> modify, block, delay, override, or resend them from a DevTools panel.

## Short description (≤ 132 characters)
> Record, inspect, modify, block, delay, mock & resend GraphQL operations from a DevTools panel. Everything stays local.

_(120 characters — check the counter after any edit.)_

## Detailed description

> **GraphQL Operator** is a DevTools panel for working with GraphQL traffic.
>
> Open DevTools, switch to the **GraphQL** tab, and every GraphQL operation the page
> makes (over `fetch` or `XMLHttpRequest`, including batched requests) shows up with its
> operation name, type, status, and timing.
>
> **Read it easily**
> • Queries, variables, and responses render as collapsible, syntax‑highlighted code —
>   not one giant escaped string.
> • Large response/variable blocks auto‑collapse; an "Inline fragments" toggle expands
>   `...FragmentSpreads` in place so fragment‑heavy queries read as one tree.
> • Filter by text or by chips (errors / mutations / ruled), and find text inside a
>   query or response.
>
> **Act on any operation (right‑click)**
> • **Resend** — replay a captured request (runs in the page, so cookies/auth are kept).
> • **Modify & resend** — edit the query and variables (or raw body), headers, and URL.
> • **Block** — return a synthetic GraphQL error.
> • **Delay** — hold matching requests N seconds to test loading/timeout states.
> • **Override response** — return a custom body / GraphQL error / HTTP status without
>   hitting the server (force empty or error states).
> • **Copy** the query, variables, or a ready‑to‑run cURL command.
>
> **Reusable rules**
> Block / rewrite / delay / override rules persist across sessions and apply to all tabs.
> Match by exact operation name, **regex**, operation type, HTTP method, or URL substring.
>
> **Export / import** captured operations as JSON to share a repro.
>
> **Privacy:** everything runs locally in your browser. GraphQL Operator has no servers,
> no analytics, and never transmits your data anywhere. See the privacy policy.

## Permission justifications (Dashboard → Privacy practices)

- **`storage`**
  > Stores the user's block/rewrite/delay/override rules locally on their device so they
  > persist between sessions. No data is transmitted.

- **Host permissions / broad site access (content scripts on all sites)**
  > The extension attaches a small script at document start to observe the GraphQL
  > requests made by the page the developer is inspecting, and — only when the user
  > creates a rule or triggers an action — to modify or replay them. GraphQL endpoints
  > are site‑specific and not known in advance, so access to the sites the user inspects
  > is required. The extension only inspects GraphQL requests and transmits nothing.

- **"Remote code" question:** No. All code is bundled in the package; the extension does
  not load or execute any remote/hosted code. (It monkey‑patches `fetch`/`XMLHttpRequest`
  in the page to observe requests; it does not inject third‑party code.)

## Data usage disclosures (Dashboard → Privacy practices → Data collection)

Answer **"I do not collect or use" / uncheck every category.** The extension:
- does **not** collect or transmit personally identifiable information, health, financial,
  authentication, personal communications, location, web history, or user activity;
- does **not** sell or transfer data to third parties;
- does **not** use data for purposes unrelated to the single purpose;
- does **not** use data to determine creditworthiness or for lending.

Then check the three required certification boxes.

## Privacy policy URL
`<host store/PRIVACY.md somewhere public and paste the URL — e.g. a GitHub Pages page or a public Gist>`

## Support / homepage URL (optional)
`<link to your repo or a support page>`
