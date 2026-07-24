/*
 * devtools.js — registers the "GraphQL" panel inside Chrome DevTools.
 * Runs once when DevTools opens for a tab.
 */
chrome.devtools.panels.create(
  'GraphQL',
  'icons/icon48.png',
  'src/panel.html',
  function () { /* panel created */ }
);
