// "Before" picture test: needs Chrome (skips with a notice when it can't launch).
// The before pictures come from the user's own tab. After a round, that tab is reloaded (More feedback, Cmd+R);
// with a static server that sends only Last-Modified, Chrome kept the old style.css, so the user marked up an
// old page and BEFORE showed it. keepFresh() must make every tab, the user's included, load current files,
// and matchViewport() must lay the background tab (whole page before, after pictures) out at the user's size.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { keepFresh, matchViewport, viewportOf } from "../server/fresh.mjs";

let css = "body { background: rgb(0, 0, 0); }";
const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toUTCString(); // a month old: cacheable for days by heuristic
const server = http.createServer((req, res) => {
  const isCss = req.url.startsWith("/style.css");
  res.writeHead(200, { "Content-Type": isCss ? "text/css" : "text/html", "Last-Modified": old });
  res.end(isCss ? css : '<!doctype html><link rel="stylesheet" href="/style.css"><main style="max-width:400px;margin:0 auto">hi</main>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const headless = process.env.INKBACK_TEST_HEADED !== "1";
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const reload = (page) => Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.evaluate(() => setTimeout(() => location.reload(), 10))]);

// The same kind of browser the plugin opens: a persistent profile, window-sized tabs.
async function launch(fresh) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkback-test-"));
  const ctx = await chromium.launchPersistentContext(dir, { channel: process.env.INKBACK_BROWSER || "chrome", headless, viewport: null, args: ["--window-size=1280,900"] });
  if (fresh) keepFresh(ctx);
  return { ctx, dir };
}
// A user tab that loaded the page, then Claude edited style.css, then the tab was reloaded.
async function roundTrip(ctx) {
  css = "body { background: rgb(0, 0, 0); }";
  const user = ctx.pages()[0] || (await ctx.newPage());
  await user.goto(url, { waitUntil: "load" });
  css = "body { background: rgb(0, 128, 0); }";
  await reload(user);
  return user;
}

let b;
try { b = await launch(false); }
catch (e) { console.log("- before-picture test skipped: no Chrome to run it in"); server.close(); process.exit(0); }
const stale = (await bg(await roundTrip(b.ctx))) === "rgb(0, 0, 0)";
await b.ctx.close(); fs.rmSync(b.dir, { recursive: true, force: true });

const { ctx, dir } = await launch(true);
try {
  const user = await roundTrip(ctx);
  assert.equal(await bg(user), "rgb(0, 128, 0)", "the user's tab shows the edited CSS after a reload");
  console.log(`✓ user's tab reloads edited files from the server${stale ? " (without the fix it showed the old file)" : " (note: this Chrome did not cache the old file)"}`);

  // The user's tab at a size other than the window's (inkback_act viewport, a resized window).
  await user.setViewportSize({ width: 900, height: 640 });
  const size = await viewportOf(user);
  const anchor = await ctx.newCDPSession(user);
  const arrival = ctx.waitForEvent("page");
  await anchor.send("Target.createTarget", { url: "about:blank", newWindow: false, background: true });
  const back = await arrival;
  await matchViewport(back, size);
  await back.goto(url, { waitUntil: "load" });
  assert.deepEqual(await viewportOf(back), size, "the background tab has the user's viewport");
  const left = (p) => p.evaluate(() => Math.round(document.querySelector("main").getBoundingClientRect().left));
  assert.equal(await left(back), await left(user), "the page is laid out the same in both tabs");
  console.log("✓ background tab is laid out at the user's viewport");
} finally {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}
