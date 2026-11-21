// Fresh-load test: needs Chrome (skips with a notice when it can't launch).
// A static server that sends only Last-Modified lets Chrome reuse an old style.css from its cache.
// bypassCache() must make a new tab load the file as it is now, or "after" pictures equal "before".
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import http from "node:http";
import { bypassCache } from "../server/fresh.mjs";

let css = "body { background: rgb(250, 250, 250); }";
let cssHits = 0;
const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toUTCString(); // a month old: cacheable for days by heuristic
const server = http.createServer((req, res) => {
  const type = req.url.startsWith("/style.css") ? "text/css" : "text/html";
  if (type === "text/css") cssHits++;
  res.writeHead(200, { "Content-Type": type, "Last-Modified": old });
  res.end(type === "text/css" ? css : '<!doctype html><link rel="stylesheet" href="/style.css"><p>hi</p>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

let browser;
const headless = process.env.INKBACK_TEST_HEADED !== "1";
try { browser = await chromium.launch({ channel: process.env.INKBACK_BROWSER || "chrome", headless }); }
catch (e) { console.log("- fresh-load test skipped: no Chrome to run it in"); server.close(); process.exit(0); }
const ctx = await browser.newContext();
const bg = async (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
try {
  // Prime the cache the way the user's tab does, then check it really is served from cache.
  const user = await ctx.newPage();
  await user.goto(url, { waitUntil: "load" });
  const hitsBefore = cssHits;
  const second = await ctx.newPage();
  await second.goto(url, { waitUntil: "load" });
  const cached = cssHits === hitsBefore;
  await second.close();

  css = "body { background: rgb(255, 0, 0); }"; // Claude edits the file
  const fresh = await ctx.newPage();
  await bypassCache(fresh);
  const hits = cssHits;
  await fresh.goto(url, { waitUntil: "load" });
  assert.ok(cssHits > hits, "the fresh tab asked the server for style.css");
  assert.equal(await bg(fresh), "rgb(255, 0, 0)", "the fresh tab shows the edited CSS");
  console.log(`✓ fresh tab loads edited files from the server${cached ? " (cache was primed)" : " (note: this Chrome did not cache the old file)"}`);
} finally {
  await browser.close();
  server.close();
}
