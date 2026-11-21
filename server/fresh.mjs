// Fresh loads: every tab of the review browser reads files from the server, never from Chrome's cache.
//
// Plain static servers (python -m http.server, many file servers) send Last-Modified and no Cache-Control.
// Chrome then treats an old file as fresh for hours ("heuristic freshness") and loads index.html and
// style.css from its cache without asking the server, so a picture taken after Claude edited the files
// showed the old page. Network.setCacheDisabled fixes that, but only on a CDP session that has called
// Network.enable first: without it Chrome (headed) ignores the setting without an error.
//
// The user's own tab needs it too (v1.0.3): reloading it after a round (More feedback, Cmd+R) kept the old
// style.css, so the user marked up an old page and the "before" pictures, taken from that tab, showed it.

const sessions = new WeakMap();

/** Turns Chrome's HTTP cache off for this tab. Call before page.goto. The session stays open with the tab. */
export async function bypassCache(page) {
  if (sessions.has(page)) return sessions.get(page);
  const pending = (async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    return cdp;
  })();
  sessions.set(page, pending);
  pending.catch(() => sessions.delete(page));
  return pending;
}

/** Cache off for every tab of a browser context: the ones open now and every one opened later. */
export function keepFresh(ctx, onError = () => {}) {
  const hook = (page) => bypassCache(page).catch(onError);
  for (const p of ctx.pages()) hook(p);
  ctx.on("page", hook);
}

/** The size the user's tab shows the page at (CSS pixels), whatever set it (the window, or an emulated viewport). */
export async function viewportOf(page) {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

/** Lays a background tab out at the user's size, so pictures of it line up with pictures of the user's tab. */
export async function matchViewport(page, vp) {
  if (vp && vp.width > 0 && vp.height > 0) await page.setViewportSize({ width: Math.round(vp.width), height: Math.round(vp.height) });
}
