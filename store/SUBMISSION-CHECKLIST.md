# Chrome Web Store — submission checklist

## 0. Before you start (non-technical)
- [ ] Confirm you're cleared to publish this (employer IP / open-source-release policy).
- [ ] Decide the publishing account: a **personal** developer account vs your org's.

## 1. Developer account
- [ ] Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
      and pay the one-time **$5** fee (if you don't already have an account).
- [ ] Set up the developer contact email and verify it (required before publishing).

## 2. Package
- [ ] Build the upload zip (already produced): `graphql-operator-v1.6.0.zip`.
      Rebuild after any change with:
      ```bash
      find . -maxdepth 1 -name 'graphql-operator-v*.zip' -delete  # not `rm v*.zip`: zsh errors when nothing matches
      zip -r "graphql-operator-v$(node -e "process.stdout.write(require('./manifest.json').version)").zip" \
        manifest.json src icons README.md -x '*.DS_Store'
      ```
- [ ] The zip has `manifest.json` at its root and contains **only** runtime files
      (no `node_modules`, `test/`, `tools/`, or `package*.json`).

## 3. Privacy policy (required — the extension has broad host access)
- [ ] Host `store/PRIVACY.md` at a public URL (GitHub Pages, a public Gist, or any site).
- [ ] Fill in the contact email in the policy.
- [ ] Paste that URL into Dashboard → **Privacy practices → Privacy policy**.

## 4. Listing assets
- [ ] **Icon:** 128×128 PNG — `icons/icon128.png` (already have it).
- [ ] **Screenshots:** 1–5 at **1280×800** — see `store/screenshots/` (generated).
- [ ] **Small promo tile** 440×280 (optional but recommended). Not generated — create if desired.
- [ ] Product name, short description, detailed description — copy from `store/LISTING.md`.
- [ ] Category: **Developer Tools**. Language: English (US).

## 5. Privacy practices tab
- [ ] Single purpose — from `store/LISTING.md`.
- [ ] Per-permission justifications (`storage`, host access) — from `store/LISTING.md`.
- [ ] "Are you using remote code?" → **No**.
- [ ] Data collection — mark **nothing collected** (see LISTING.md), then tick the 3 certs.

## 6. Submit
- [ ] Choose visibility (Public / Unlisted / Private). **Unlisted** is a good first step —
      shareable by link without appearing in search while you validate.
- [ ] Set distribution regions (default: all).
- [ ] Submit for review. First review typically takes anywhere from a few hours to a few
      days; broad host permissions can lengthen it.

## 7. After approval
- [ ] Note the extension ID / listing URL.
- [ ] For updates: bump `version` in `manifest.json`, rebuild the zip, upload a new
      package (the version must increase), resubmit.

## Notes / known review flags
- Broad host access (`<all_urls>` content scripts) + a `world:"MAIN"` script that hooks
  `fetch`/`XHR` will draw permission scrutiny. The justification and "no data leaves the
  device" privacy story (already written) are what reviewers look for.
- If asked to reduce scope, an option is `activeTab` + on-demand injection instead of
  `<all_urls>` — but that changes UX (only inspect after a click, and misses requests that
  fire before activation). Keep `<all_urls>` unless the reviewer requires otherwise.
