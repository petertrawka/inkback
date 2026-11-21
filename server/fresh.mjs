// Fresh loads for the "after" pictures and inkback_screenshot: always from the server, never from Chrome's cache.
//
// Plain static servers (python -m http.server, many file servers) send Last-Modified and no Cache-Control.
// Chrome then treats an old file as fresh for hours ("heuristic freshness") and loads index.html and
// style.css from its cache without asking the server, so a picture taken after Claude edited the files
// showed the old page. Network.setCacheDisabled fixes that, but only on a CDP session that has called
// Network.enable first: without it Chrome (headed) ignores the setting without an error.

/** Turns Chrome's HTTP cache off for this tab. Call before page.goto. The session stays open with the tab. */
export async function bypassCache(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  return cdp;
}
