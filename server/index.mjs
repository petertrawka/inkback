#!/usr/bin/env node
// Inkback — channel server.
//
// One process, three jobs:
//   1. MCP server over stdio (spawned by Claude Code). Declares the `claude/channel`
//      capability so it can PUSH events into the running session, and exposes a few
//      tools (open, progress, done, screenshot, pull, wait, clear, close).
//   2. Local HTTP bridge for the in-page overlay: state sync, Send, SSE for progress.
//   3. Browser driver: launches your installed Chrome through playwright-core with a
//      dedicated profile, injects the overlay on every page, takes the screenshots.
//
// stdout is reserved for JSON-RPC. All logging goes to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { compareFiles } from "./compare.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version; // plugin root
const log = (...a) => process.stderr.write(`inkback: ${a.join(" ")}\n`);

const PARENT_PID = process.ppid; // Claude Code. Captured now: it reads as 1 once the parent is gone.
const TOKEN = crypto.randomBytes(18).toString("hex");
const SESSION = TOKEN.slice(0, 8);
const CACHE_DIR = path.join(os.homedir(), ".cache", "inkback");
const PROFILE_DIR = path.join(CACHE_DIR, "chrome-profile");
const SESSIONS_DIR = path.join(CACHE_DIR, "sessions");
const SHOTS_ROOT = path.join(os.tmpdir(), "inkback");
const SHOTS_DIR = path.join(SHOTS_ROOT, SESSION);
const REFS_DIR = path.join(SHOTS_DIR, "refs"); // reference images pasted into notes; removed on clear / session end
const COMPARE_DIR = path.join(SHOTS_DIR, "compare"); // before/after pictures, kept until Close / More feedback / clear
const REF_NAME = /^[a-z0-9]{12}\.(png|jpg|gif|webp)$/;
const OVERLAY_SRC = fs.readFileSync(path.join(__dirname, "overlay.js"), "utf8");
const BROWSER_CHANNEL = process.env.INKBACK_BROWSER || "chrome"; // chrome | msedge | chromium

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  mode: "poll", // "poll" (default, works without any startup flag): Claude blocks in inkback_wait. "channel": push into the session (needs the channel flag).
  pages: new Map(), // url -> { shapes: [], notes: [] }
  nextNote: 1,
  batchSeq: 0,
  batches: [], // { id, dir, content, notes, pages, createdAt, done }
  pending: [], // batches sent but not yet pulled/handled (poll mode + safety net)
  waiters: [],
  listeners: new Set(),
  lastUrl: null,
  sending: false, // one Send (or Clear) at a time; the build takes seconds
  review: null, // { batch, summary, items: [{ k, url, clip, notes, before, after }] } shown on the page after inkback_done
};

let endpoint = null;
let markReady;
const ready = new Promise((r) => (markReady = r));

// ---------------------------------------------------------------------------
// SSE out (server -> overlay)
// ---------------------------------------------------------------------------
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of state.listeners) {
    try { res.write(data); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
let context = null;
let mainPage = null;
let sessionProfile = null;

function bootstrapSource(renderOnly = false) {
  return `window.__INKBACK__ = ${JSON.stringify({ endpoint, token: TOKEN, renderOnly, version: VERSION })};\n${OVERLAY_SRC}`;
}

let launching = null;
function ensureBrowser() {
  if (context) return Promise.resolve(context);
  if (!launching) launching = launchBrowser().finally(() => { launching = null; });
  return launching;
}
async function launchBrowser() {
  await ready;
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  const opts = {
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    // Apps with a strict Content-Security-Policy (e.g. Email Desk: default-src 'none') would otherwise block the
    // overlay's styles and its calls to the local bridge. Only this dedicated review browser is affected.
    bypassCSP: true,
    args: ["--window-size=1440,1000", "--no-first-run", "--no-default-browser-check", "--disable-infobars"],
  };
  if (BROWSER_CHANNEL !== "chromium") opts.channel = BROWSER_CHANNEL;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  } catch (first) {
    // Usually: another session holds the shared profile. Chrome's message for that varies,
    // so retry on a throwaway profile; a second failure is the real error (no browser).
    sessionProfile = `${PROFILE_DIR}-${SESSION}`;
    await fsp.mkdir(sessionProfile, { recursive: true });
    log(`shared profile launch failed (${String(first.message).split("\n")[0]}), retrying with a session profile`);
    try {
      context = await chromium.launchPersistentContext(sessionProfile, opts);
    } catch (second) {
      throw new Error(
        `Could not launch ${BROWSER_CHANNEL}. Install Google Chrome, or set INKBACK_BROWSER=msedge, ` +
          `or run "npx playwright install chromium" and set INKBACK_BROWSER=chromium. (${String(second.message).split("\n")[0]})`,
      );
    }
  }
  context.on("close", () => {
    context = null;
    mainPage = null;
    for (const w of state.waiters.splice(0)) w(null); // a pending inkback_wait returns "closed" right away
    log("browser closed");
  });
  await context.addInitScript(bootstrapSource(false));
  return context;
}

function sameUrl(a, b) {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}
// Mirrors isLocalHost() in overlay.js: the overlay only mounts there, so opening anything else is useless.
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/;
function assertLocal(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("url must be a full http:// or https:// URL"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("url must start with http:// or https://");
  if (!LOCAL_HOST.test(u.hostname) && !/\.(localhost|test|local|internal)$/.test(u.hostname)) {
    throw new Error(`Inkback works on local development hosts only (localhost, 127.0.0.1, private IPs, *.localhost, *.test, *.local). Got ${u.hostname}.`);
  }
  return u.href;
}

// The user's tab. A second /inkback:review navigates it in place rather than opening another tab.
async function openUrl(url) {
  url = assertLocal(url);
  const ctx = await ensureBrowser();
  const live = ctx.pages().filter((p) => !p.isClosed());
  const page = live.find((p) => sameUrl(p.url(), url)) || (mainPage && !mainPage.isClosed() ? mainPage : null) || live[0] || (await ctx.newPage());
  mainPage = page;
  await page.bringToFront();
  if (!sameUrl(page.url(), url)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  state.lastUrl = url;
  return page;
}

// A tab that opens behind the user's tab, so Send never pulls focus away. Falls back to a
// normal new tab when the devtools command isn't available.
async function backgroundPage(ctx) {
  const anchor = ctx.pages().find((p) => !p.isClosed());
  if (anchor) {
    try {
      const cdp = await ctx.newCDPSession(anchor);
      const arrival = ctx.waitForEvent("page", { timeout: 5000 });
      await cdp.send("Target.createTarget", { url: "about:blank", newWindow: false, background: true });
      await cdp.detach().catch(() => {});
      return await arrival;
    } catch (e) {
      log(`background tab unavailable (${String(e.message).split("\n")[0]}), using a normal tab`);
    }
  }
  return ctx.newPage();
}

async function pageFor(url, fresh = false) {
  const ctx = await ensureBrowser();
  const live = ctx.pages().filter((p) => !p.isClosed());
  const found = !fresh && live.find((p) => sameUrl(p.url(), url));
  if (found) return { page: found, temp: false };
  const page = await backgroundPage(ctx);
  await page.addInitScript("window.__INKBACK_RENDER_ONLY__ = true;");
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => window.__inkback && window.__inkback.ready, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(250);
  return { page, temp: true };
}

// A document-space rectangle at the size the tab already has. A full-page capture lays the page
// out again at the whole document's height, which the user sees as the tab resizing; instead
// scroll the rectangle into view, clip it to the viewport (centred when larger), scroll back.
async function shootRect(page, clip, file) {
  const vp = await page.evaluate(() => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }));
  const w = Math.min(clip.width, vp.w), h = Math.min(clip.height, vp.h);
  const x = clip.width > vp.w ? Math.round(clip.x) : Math.round(clip.x + (clip.width - w) / 2), y = Math.round(clip.y + (clip.height - h) / 2);
  const inView = x >= vp.x && y >= vp.y && x + w <= vp.x + vp.w && y + h <= vp.y + vp.h;
  const to = ([l, t]) => { scrollTo({ left: l, top: t, behavior: "instant" }); return [scrollX, scrollY]; };
  const [sx, sy] = inView ? [vp.x, vp.y] : await page.evaluate(to, [x, y]);
  if (!inView) await page.waitForTimeout(60); // let sticky headers and lazy images settle
  try {
    const cx = clampN(x - sx, 0, vp.w - w), cy = clampN(y - sy, 0, vp.h - h); // the scroll stops at the document's edge
    return await shoot(page, { path: file, scale: "css", clip: { x: cx, y: cy, width: w, height: h } });
  } finally {
    if (!inView) await page.evaluate(to, [vp.x, vp.y]).catch(() => {});
  }
}

// Screenshot a page that may be a background tab. If Chrome refuses to paint it, bring it
// forward for the shot and give the user's tab back afterwards.
async function shoot(page, opts) {
  try {
    return await page.screenshot({ ...opts, timeout: 10000 });
  } catch (e) {
    const front = mainPage && !mainPage.isClosed() && mainPage !== page ? mainPage : null;
    await page.bringToFront().catch(() => {});
    try {
      return await page.screenshot({ ...opts, timeout: 30000 });
    } finally {
      if (front) await front.bringToFront().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshots + batch content
// ---------------------------------------------------------------------------
function bboxOf(item) {
  if (item.kind === "note") return { x: item.x - 24, y: item.y - 24, w: 48 + 200, h: 48 }; // pin + label
  const s = item;
  if (s.type === "pen") {
    const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (s.type === "arrow" || s.type === "line") {
    const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
    return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  }
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function pad(b, p) { return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p }; }
// Each picture is a full-width strip, so two notes belong together when their strips overlap vertically (sideways does not matter).
function overlaps(a, b) { return a.y < b.y + b.h && b.y < a.y + a.h; }
function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function clusterItems(pageState, doc) {
  const items = [
    ...pageState.notes.map((n) => ({ kind: "note", ref: n, box: pad(bboxOf({ kind: "note", ...n }), 160) })),
    ...pageState.shapes.map((s) => ({ kind: "shape", ref: s, box: pad(bboxOf(s), 120) })),
  ];
  let clusters = items.map((it) => ({ box: it.box, notes: it.kind === "note" ? [it.ref] : [], shapes: it.kind === "shape" ? [it.ref] : [] }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (overlaps(clusters[i].box, clusters[j].box)) {
          clusters[i] = { box: union(clusters[i].box, clusters[j].box), notes: [...clusters[i].notes, ...clusters[j].notes], shapes: [...clusters[i].shapes, ...clusters[j].shapes] };
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  // Minimum useful size, then clamp to the document.
  return clusters.map((c) => {
    let { x, y, w, h } = c.box;
    // Always the full page width (x = 0), so nothing at the sides is cut off; only the height is local to the note.
    const minH = 440;
    if (h < minH) { y -= (minH - h) / 2; h = minH; }
    x = 0; w = Math.round(doc.w); h = Math.round(Math.min(h, doc.h));
    y = Math.round(clampN(y, 0, doc.h - h));
    return { ...c, clip: { x, y, width: Math.max(1, w), height: Math.max(1, h) } };
  });
}

const short = (t, n) => (t && t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
function fmtEl(ctx) {
  if (!ctx) return "(no element under it)";
  const t = ctx.text ? `  "${short(ctx.text, 70)}"` : "";
  return `<${ctx.selector}>${t}  at ${ctx.rect[0]},${ctx.rect[1]} size ${ctx.rect[2]}×${ctx.rect[3]}`;
}
function fmtCtx(ctx, indent = "") {
  if (!ctx) return `${indent}on: (nothing under it)\n`;
  let out = `${indent}on: ${fmtEl(ctx)}\n`;
  if (ctx.chain) out += `${indent}in: ${ctx.chain}\n`;
  if (ctx.react && ctx.react.components && ctx.react.components.length) out += `${indent}component: ${ctx.react.components.join(" ‹ ")}\n`;
  if (ctx.react && ctx.react.source) out += `${indent}source: ${ctx.react.source}\n`;
  if (ctx.inside && ctx.inside.length) out += `${indent}contains: ${ctx.inside.join("; ")}\n`;
  return out;
}
function shapeWord(s) {
  const target = s.ctx ? `<${s.ctx.selector}>${s.ctx.text ? ` "${short(s.ctx.text, 36)}"` : ""}` : "nothing in particular";
  const verb = { pen: "stroke around", arrow: "arrow →", line: "line along", rect: "box around", ellipse: "circle around" }[s.type] || s.type;
  return `${s.color} ${verb} ${target}`;
}

function renderContent(batch, sections) {
  const totalNotes = sections.reduce((n, s) => n + s.pageState.notes.length, 0);
  const totalShapes = sections.reduce((n, s) => n + s.pageState.shapes.length, 0);
  let out = `Browser annotations · batch ${batch.id} · ${sections.length} page${sections.length === 1 ? "" : "s"} · ${totalNotes} note${totalNotes === 1 ? "" : "s"} · ${totalShapes} mark${totalShapes === 1 ? "" : "s"}\n`;
  out += `Read the PNGs, then inkback_progress(note, working|done|skipped) per note and inkback_done(summary) at the end.\n`;
  sections.forEach((sec, i) => {
    out += `\n## Page ${i + 1} of ${sections.length} — ${sec.url}\n`;
    out += `viewport ${sec.viewport.width}×${sec.viewport.height} · document ${sec.doc.w}×${sec.doc.h}\n`;
    out += `overview (${sec.fullPage ? "full page, tall" : "the visible window"}): ${sec.fullPath}\n`;
    const sortedNotes = [...sec.pageState.notes].sort((a, b) => a.n - b.n);
    for (const note of sortedNotes) {
      const cluster = sec.shots.find((c) => c.notes.includes(note));
      out += `\n### Note ${note.n} — "${note.text.replace(/\s+/g, " ").trim()}"\n`;
      if (cluster) out += `crop: ${cluster.path}  (region ${cluster.clip.x},${cluster.clip.y} → ${cluster.clip.width}×${cluster.clip.height})\n`;
      out += `pin at ${Math.round(note.x)},${Math.round(note.y)} · ${note.color}\n`;
      out += fmtCtx(note.ctx);
      const linked = note.shapeId && sec.pageState.shapes.find((k) => k.id === note.shapeId);
      const refs = (Array.isArray(note.refs) ? note.refs : []).filter((r) => REF_NAME.test(r) && fs.existsSync(path.join(REFS_DIR, r)));
      for (const r of refs) out += `reference image the user attached (Read it): ${path.join(REFS_DIR, r)}\n`;
      if (linked) { out += `this note is about the area the user drew around: ${shapeWord(linked)}\n`; out += fmtCtx(linked.ctx, "  "); }
      if (cluster && cluster.shapes.length) {
        out += `marks here: ${cluster.shapes.map(shapeWord).join("; ")}\n`;
      }
    }
    const orphanClusters = sec.shots.filter((c) => c.notes.length === 0 && c.shapes.length);
    if (orphanClusters.length) {
      out += `\n### Marks without a note (page ${i + 1})\n`;
      for (const c of orphanClusters) {
        out += `crop: ${c.path}  (region ${c.clip.x},${c.clip.y} → ${c.clip.width}×${c.clip.height})\n`;
        for (const s of c.shapes) {
          out += `- ${shapeWord(s)}\n`;
          out += fmtCtx(s.ctx, "  ");
        }
      }
    }
  });
  return out;
}

async function buildBatch() {
  // Snapshot: a PUT /state during the build replaces the live arrays.
  const pages = [...state.pages.entries()]
    .map(([url, p]) => [url, { shapes: p.shapes.filter((s) => s.type !== "pen" || (Array.isArray(s.points) && s.points.length > 1)), notes: [...p.notes] }])
    .filter(([, p]) => p.shapes.length || p.notes.length);
  if (!pages.length) throw new Error("Nothing to send yet.");
  const id = ++state.batchSeq;
  const dir = path.join(SHOTS_DIR, `batch-${id}`);
  await fsp.mkdir(dir, { recursive: true });
  const sections = [];
  const compare = [];
  let pi = 0;
  for (const [url, pageState] of pages) {
    pi++;
    const { page, temp } = await pageFor(url);
    try {
      await page.evaluate(() => window.__inkback && window.__inkback.capture(true));
      await page.waitForTimeout(80);
      const viewport = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
      const doc = await page.evaluate(() => ({
        w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
        h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      }));
      const fullPath = path.join(dir, `p${pi}-page.png`);
      // The user's own tab: what they see, at its size. A background tab nobody sees can be laid out full height.
      await shoot(page, { path: fullPath, fullPage: temp, scale: "css" });
      const clusters = clusterItems(pageState, doc);
      const shots = [];
      for (const [ci, c] of clusters.entries()) {
        const p = path.join(dir, `p${pi}-crop${ci + 1}.png`);
        await shootRect(page, c.clip, p);
        shots.push({ ...c, path: p });
      }
      sections.push({ url, viewport, doc, fullPath, fullPage: temp, shots, pageState });
      // Clean "before" pictures (no pins or ink) of the same spots, for the before/after view.
      try {
        await page.evaluate(() => window.__inkback && window.__inkback.hide(true));
        const cdir = path.join(COMPARE_DIR, `batch-${id}`);
        await fsp.mkdir(cdir, { recursive: true });
        for (const c of shots) {
          const k = compare.length + 1;
          const before = path.join(cdir, `c${k}-before.png`);
          const pt = c.notes.length ? [c.notes[0].x, c.notes[0].y] : (() => { const b = bboxOf(c.shapes[0]); return [b.x + b.w / 2, b.y + b.h / 2]; })();
          const anchor = await page.evaluate(([x, y]) => window.__inkback && window.__inkback.anchor ? window.__inkback.anchor(x, y) : null, pt).catch(() => null);
          await shootRect(page, c.clip, before);
          compare.push({ k, url, clip: c.clip, anchor, notes: c.notes.map((n) => n.n).sort((a, b) => a - b), shapesOnly: !c.notes.length, before, after: null });
        }
      } catch (e) { log(`before shots skipped: ${String(e.message).split("\n")[0]}`); }
    } finally {
      await page.evaluate(() => window.__inkback && window.__inkback.hide(false)).catch(() => {});
      await page.evaluate(() => window.__inkback && window.__inkback.capture(false)).catch(() => {});
      if (temp) await page.close().catch(() => {});
    }
  }
  const batch = {
    id, dir, compare,
    notes: sections.reduce((n, s) => n + s.pageState.notes.length, 0),
    pages: sections.length,
    createdAt: Date.now(),
    done: false,
  };
  batch.content = renderContent(batch, sections);
  // Mark what went out as sent, on the live objects (they may have been replaced during the build).
  for (const [url, snap] of pages) {
    const live = state.pages.get(url);
    if (!live) continue;
    const ids = new Set([...snap.notes, ...snap.shapes].map((x) => x.id));
    for (const n of live.notes) if (ids.has(n.id) && !n.batch) { n.batch = id; if (!n.status || n.status === "draft") n.status = "pending"; }
    for (const sh of live.shapes) if (ids.has(sh.id) && !sh.batch) sh.batch = id;
  }
  return batch;
}

async function deliver(batch) {
  state.batches.push(batch);
  state.pending.push(batch);
  let pushed = false;
  if (state.mode === "channel") {
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: batch.content,
          meta: { batch: String(batch.id), notes: String(batch.notes), pages: String(batch.pages) },
        },
      });
      pushed = true;
    } catch (e) {
      log(`channel push failed: ${e.message}`);
    }
  }
  const waiters = state.waiters.splice(0);
  if (waiters.length) { takePending(batch); for (const w of waiters) w(batch); }
  return pushed;
}

function takePending(batch) { state.pending = state.pending.filter((b) => b !== batch); return batch; }

async function removeBatchFiles(batch) {
  if (!batch || !batch.dir) return;
  await fsp.rm(batch.dir, { recursive: true, force: true }).catch(() => {});
}

// After Claude is done: the same spots again on a fresh load of each page (picks up changes on apps without hot reload).
async function shootAfter(batch) {
  const byUrl = new Map();
  for (const it of batch.compare || []) { if (!byUrl.has(it.url)) byUrl.set(it.url, []); byUrl.get(it.url).push(it); }
  for (const [url, items] of byUrl) {
    let page = null, temp = false;
    try {
      ({ page, temp } = await pageFor(url, true));
      // Bypass the cache and load again: otherwise Chrome can serve the old CSS/JS and "after" equals "before".
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await page.reload({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await page.waitForFunction(() => window.__inkback && window.__inkback.ready, null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(250);
        await cdp.detach().catch(() => {});
      } catch (e) { log(`fresh reload skipped: ${String(e.message).split("\n")[0]}`); }
      await page.evaluate(() => window.__inkback && window.__inkback.hide(true)).catch(() => {});
      for (const it of items) {
        const file = it.before.replace(/-before\.png$/, "-after.png");
        it.verdict = "unchecked"; // Changed / No visible change need a real after picture; until we have one we say so
        // Follow the anchored element if it moved; otherwise the same spot on the page.
        let clip = it.clip;
        const now = it.anchor ? await page.evaluate((a) => window.__inkback.locate(a), it.anchor).catch(() => null) : null;
        if (now) {
          const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
          const dx = Math.round(now.x - it.anchor.rect.x), dy = Math.round(now.y - it.anchor.rect.y);
          clip = { ...clip, x: clampN(clip.x + dx, 0, Math.max(0, doc.w - clip.width)), y: clampN(clip.y + dy, 0, Math.max(0, doc.h - clip.height)) };
          it.moved = dx !== 0 || dy !== 0;
        }
        if (it.anchor && !now) { it.gone = true; continue; } // the marked element is no longer on the page: nothing honest to compare
        try {
          await shootRect(page, clip, file); it.after = file;
          it.verdict = await compareFiles(page, it.before, file) === "same" ? "same" : "changed";
        } catch (e) { log(`after shot or compare ${it.k} failed: ${String(e.message).split("\n")[0]}`); it.verdict = "unchecked"; }
      }
    } catch (e) {
      log(`after shots for ${url} failed: ${String(e.message).split("\n")[0]}`);
    } finally {
      if (page && temp) await page.close().catch(() => {});
    }
  }
}
async function dropReview() {
  state.review = null;
  await fsp.rm(COMPARE_DIR, { recursive: true, force: true }).catch(() => {});
}
function reviewView() {
  const r = state.review;
  if (!r) return null;
  const noteOf = (n) => { for (const [, p] of state.pages) for (const k of p.notes) if (k.n === n && k.batch === r.batch) return k; return null; };
  return {
    batch: r.batch,
    summary: r.summary,
    items: r.items.map((it) => ({
      k: it.k,
      after: !!it.after,
      verdict: it.verdict || "unchecked", // changed | same | unchecked
      notes: it.notes.map((n) => { const k = noteOf(n); return { n, text: k ? k.text : "", status: k ? k.status : "done", result: k ? k.result || "" : "" }; }),
    })),
  };
}

async function clearAll() {
  await dropReview();
  state.pages.clear();
  state.nextNote = 1;
  state.pending = [];
  for (const b of state.batches) await removeBatchFiles(b);
  state.batches = [];
  await fsp.rm(REFS_DIR, { recursive: true, force: true }).catch(() => {});
  broadcast({ type: "clear" });
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
const INSTRUCTIONS = [
  "The 'inkback' channel carries visual feedback the user draws on a live localhost page.",
  "Events arrive as <channel source=\"...inkback\" batch=\"N\" notes=\"K\" pages=\"P\">: a list of pages, numbered notes (with the user's text, the element under the pin, its React component chain and source when known), marks (strokes, arrows, lines, boxes, circles), and PNG paths.",
  "When one arrives: Read every PNG path listed (the crops first, the overview for context). Then for each note in order call inkback_progress(note, \"working\"), change the code, and call inkback_progress(note, \"done\", <one short line>) or (note, \"skipped\", <why>). Marks without a note describe what they point at: act on them too. If the dev server hot-reloads you may call inkback_screenshot to check the result. Finish with inkback_done(summary): it shows the summary on the page and removes the temporary screenshots.",
  "Say one short line in the terminal when you start on a batch and one when you finish. The user is watching the page, not the terminal.",
  "By default the session runs in poll mode: after inkback_open, call inkback_wait and handle each batch it returns, then call it again. Events are only pushed when inkback_open was called with delivery \"channel\" and the session was started with the channel flag; inkback_pull is the safety net.",
].join(" ");

const mcp = new Server(
  { name: "inkback", version: VERSION },
  { capabilities: { experimental: { "claude/channel": {} }, tools: {} }, instructions: INSTRUCTIONS },
);

const TOOLS = [
  {
    name: "inkback_open",
    description: "Open a URL in the annotation browser with the drawing and note tools ready. Reuses the open browser. Returns when the page is loaded. delivery: 'poll' (default, works without any startup flag: you must call inkback_wait) or 'channel' (optional faster push, only if the session was started with the channel flag).",
    inputSchema: { type: "object", properties: { url: { type: "string" }, delivery: { type: "string", enum: ["channel", "poll"] } }, required: ["url"] },
  },
  {
    name: "inkback_progress",
    description: "Report progress on one note so the user sees it on the page. status: working | done | skipped. message: one short line (what changed, or why skipped).",
    inputSchema: { type: "object", properties: { note: { type: "integer" }, status: { type: "string", enum: ["working", "done", "skipped"] }, message: { type: "string" } }, required: ["note", "status"] },
  },
  {
    name: "inkback_done",
    description: "Call once the whole batch is handled (after your edits are saved). Marks every remaining note done, deletes the batch's temporary screenshots, retakes each marked spot and shows the user a before/after view with your summary. Takes a few seconds.",
    inputSchema: { type: "object", properties: { summary: { type: "string" }, batch: { type: "integer" } }, required: ["summary"] },
  },
  {
    name: "inkback_reply",
    description: "Show a short message as a toast on the marked-up page (for questions or notes to the user while you work).",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "inkback_screenshot",
    description: "Take a screenshot of the annotation browser to verify a change. Returns the image inline and the file path. Optional url (rendered in a background tab, the user's tab stays where it is), full (full page, rendered in a background tab so the user's tab is never resized), selector (clip to an element), chrome (keep the annotation toolbar visible, off by default).",
    inputSchema: { type: "object", properties: { url: { type: "string" }, full: { type: "boolean" }, selector: { type: "string" }, chrome: { type: "boolean" } } },
  },
  {
    name: "inkback_pull",
    description: "Return the latest batch of annotations that was sent but not yet handled (safety net if the channel event did not arrive, or for poll mode).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inkback_wait",
    description: "Poll mode: block until the user hits Send, then return that batch. Returns {status:'timeout'} after timeout_s (default 1500, max 1700): call it again. Returns {status:'closed'} when the browser was closed.",
    inputSchema: { type: "object", properties: { timeout_s: { type: "integer" } } },
  },
  {
    name: "inkback_clear",
    description: "Remove every annotation on every page and delete temporary screenshots. Same as the Clear button.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inkback_close",
    description: "Close the annotation browser and clean up.",
    inputSchema: { type: "object", properties: {} },
  },
];

if (process.env.INKBACK_DEBUG === "1") {
  TOOLS.push({
    name: "inkback_debug",
    description: "Development only. Drive the annotation browser: mouse ops [[move|down|up|click|wheel, x, y]...], keys to press, text to type, and/or JS to evaluate in the page.",
    inputSchema: { type: "object", properties: { mouse: { type: "array" }, keys: { type: "array" }, type: { type: "string" }, eval: { type: "string" }, viewport: { type: "object" } } },
  });
}

const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments || {};
  switch (req.params.name) {
    case "inkback_open": {
      const url = String(args.url || "").trim();
      state.mode = args.delivery === "channel" ? "channel" : "poll";
      await openUrl(url);
      broadcast({ type: "hello", mode: state.mode });
      return text({
        ok: true,
        url,
        delivery: state.mode,
        note: state.mode === "channel"
          ? "Tools are on the page. Do not poll: a channel event arrives here when the user hits Send. If the user says they sent and nothing arrived, call inkback_pull."
          : "Tools are on the page. Call inkback_wait now and process what it returns; call it again after inkback_done.",
      });
    }
    case "inkback_progress": {
      const n = Number(args.note);
      const status = String(args.status);
      const message = String(args.message || "").trim();
      for (const [, p] of state.pages) for (const note of p.notes) if (note.n === n) { note.status = status; note.result = message; }
      broadcast({ type: "progress", n, status, message });
      return text("ok");
    }
    case "inkback_done": {
      const summary = String(args.summary || "").trim();
      // Without an id: the oldest batch still open, never a newer one Claude hasn't read yet.
      const batch = args.batch ? state.batches.find((b) => b.id === Number(args.batch)) : state.batches.find((b) => !b.done);
      if (batch) {
        for (const [, p] of state.pages) for (const note of p.notes) if (note.batch === batch.id && (note.status === "pending" || note.status === "working")) note.status = "done";
        batch.done = true;
        await removeBatchFiles(batch);
        takePending(batch);
        if (batch.compare && batch.compare.length && context) {
          state.sending = true; // no Send while the after pictures are taken
          try { await shootAfter(batch); } finally { state.sending = false; }
          const items = batch.compare; // every spot gets a result card; spots we could not check say so
          if (items.length) state.review = { batch: batch.id, summary, items };
        }
      }
      broadcast({ type: "done", summary, batch: batch ? batch.id : null, review: !!state.review });
      return text("ok");
    }
    case "inkback_reply": {
      broadcast({ type: "toast", text: String(args.text || "").trim() });
      return text("shown");
    }
    case "inkback_screenshot": {
      // A url renders in a tab behind the user's (or reuses one already on it): never navigate the tab they're marking up.
      let { page, temp } = args.url ? await pageFor(assertLocal(String(args.url))) : { page: mainPage && !mainPage.isClosed() ? mainPage : null, temp: false };
      // full on the user's tab would resize it for the capture: render a copy behind it instead
      if (page && args.full && !temp) ({ page, temp } = await pageFor(page.url(), true));
      if (!page) throw new Error("No page open. Pass a url.");
      await fsp.mkdir(SHOTS_DIR, { recursive: true });
      const file = path.join(SHOTS_DIR, `verify-${Date.now()}.png`);
      if (!args.chrome) await page.evaluate(() => window.__inkback && window.__inkback.capture(true)).catch(() => {});
      let buf;
      try {
        if (args.selector) {
          const el = page.locator(String(args.selector)).first();
          buf = await el.screenshot({ path: file, scale: "css" });
        } else {
          buf = await shoot(page, { path: file, fullPage: !!args.full, scale: "css" });
        }
      } finally {
        await page.evaluate(() => window.__inkback && window.__inkback.capture(false)).catch(() => {});
        if (temp) await page.close().catch(() => {});
      }
      return { content: [{ type: "text", text: `saved ${file}` }, { type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
    }
    case "inkback_pull": {
      const b = state.pending[0];
      if (!b) return text({ status: "empty", hint: "Nothing waiting. Ask the user to hit Send to Claude on the page." });
      return text(takePending(b).content);
    }
    case "inkback_wait": {
      if (state.pending[0]) return text(takePending(state.pending[0]).content);
      if (!context) return text({ status: "closed" });
      const timeoutS = Math.min(Math.max(Number(args.timeout_s) || 1500, 5), 1700);
      const batch = await new Promise((resolve) => {
        const waiter = (b) => { clearTimeout(t); resolve(b); };
        state.waiters.push(waiter);
        const t = setTimeout(() => {
          state.waiters = state.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutS * 1000);
      });
      if (!batch) return text({ status: context ? "timeout" : "closed", hint: "Call inkback_wait again." });
      return text(batch.content);
    }
    case "inkback_clear": {
      await clearAll();
      return text("cleared");
    }
    case "inkback_close": {
      if (context) await context.close().catch(() => {});
      context = null; mainPage = null;
      return text("closed");
    }
    case "inkback_debug": {
      if (process.env.INKBACK_DEBUG !== "1") throw new Error("unknown tool");
      const page = mainPage;
      if (!page) throw new Error("no page");
      if (args.viewport) await page.setViewportSize(args.viewport);
      for (const [op, x, y] of args.mouse || []) {
        if (op === "move") await page.mouse.move(x, y, { steps: 10 });
        else if (op === "down") await page.mouse.down();
        else if (op === "up") await page.mouse.up();
        else if (op === "click") await page.mouse.click(x, y);
        else if (op === "wheel") await page.mouse.wheel(x, y);
        await page.waitForTimeout(40);
      }
      for (const k of args.keys || []) { await page.keyboard.press(k); await page.waitForTimeout(40); }
      if (args.type) await page.keyboard.type(String(args.type), { delay: 8 });
      let out = "ok";
      if (args.eval) out = await page.evaluate(String(args.eval));
      return text(out == null ? "ok" : out);
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

// ---------------------------------------------------------------------------
// HTTP bridge (overlay <-> server)
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Inkback-Token",
};
const json = (res, code, obj) => { res.writeHead(code, { ...CORS, "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 8e6) { req.destroy(); reject(new Error("too large")); } });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});

function pageState(url) {
  if (!state.pages.has(url)) state.pages.set(url, { shapes: [], notes: [] });
  return state.pages.get(url);
}
function totals() {
  let notes = 0, shapes = 0, pages = 0, unsent = 0, open = 0;
  for (const [, p] of state.pages) {
    if (!p.notes.length && !p.shapes.length) continue;
    pages++; notes += p.notes.length; shapes += p.shapes.length;
    unsent += p.notes.filter((n) => !n.batch).length + p.shapes.filter((s) => !s.batch).length;
    open += p.notes.filter((n) => n.batch && (n.status === "pending" || n.status === "working")).length;
  }
  return { notes, shapes, pages, unsent, open, batches: state.batches.length };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    // EventSource cannot set headers, so /events alone may carry the token in the query.
    const token = req.headers["x-inkback-token"] || (url.pathname === "/events" ? url.searchParams.get("t") : null);
    if (token !== TOKEN) return json(res, 403, { ok: false, error: "forbidden" });

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`: connected\n\n`);
      res.write(`data: ${JSON.stringify({ type: "hello", mode: state.mode, totals: totals() })}\n\n`);
      state.listeners.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 20000);
      req.on("close", () => { clearInterval(ping); state.listeners.delete(res); });
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      const page = url.searchParams.get("url") || "";
      const p = state.pages.get(page) || { shapes: [], notes: [] };
      return json(res, 200, { ok: true, shapes: p.shapes, notes: p.notes, totals: totals(), mode: state.mode, review: !!state.review });
    }
    if (req.method === "PUT" && url.pathname === "/state") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const page = String(body.url || "");
      if (!page) return json(res, 400, { ok: false, error: "url required" });
      const p = pageState(page);
      p.shapes = Array.isArray(body.shapes) ? body.shapes.slice(0, 500) : [];
      p.notes = Array.isArray(body.notes) ? body.notes.slice(0, 200) : [];
      for (const n of p.notes) if (n.n >= state.nextNote) state.nextNote = n.n + 1;
      return json(res, 200, { ok: true, totals: totals() });
    }
    if (req.method === "POST" && url.pathname === "/note/next") {
      // Next number = highest note that still exists + 1, so a cancelled or deleted last note frees its number.
      let max = 0;
      for (const pg of state.pages.values()) for (const n of pg.notes) if (n.n > max) max = n.n;
      return json(res, 200, { ok: true, n: max + 1 });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      if (state.sending) return json(res, 409, { ok: false, error: "busy" });
      state.sending = true;
      try {
        let batch;
        try { batch = await buildBatch(); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const pushed = await deliver(batch);
        log(`batch ${batch.id}: ${batch.notes} notes on ${batch.pages} page(s) → ${pushed ? "written to the channel" : state.mode === "poll" ? "handed to waiter" : "queued (pull)"}`);
        broadcast({ type: "sent", batch: batch.id, notes: batch.notes, pages: batch.pages, pushed, mode: state.mode });
        return json(res, 200, { ok: true, batch: batch.id, notes: batch.notes, pages: batch.pages, pushed, mode: state.mode, totals: totals() });
      } finally {
        state.sending = false;
      }
    }
    if (req.method === "POST" && url.pathname === "/status") {
      const body = JSON.parse((await readBody(req)) || "{}");
      broadcast({ type: "status", text: String(body.text || "").slice(0, 200) });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/attach") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
      if (!m) return json(res, 400, { ok: false, error: "only png, jpg, gif or webp images" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 5e6) return json(res, 413, { ok: false, error: "image over 5 MB" });
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const name = `${crypto.randomBytes(6).toString("hex")}.${ext}`;
      await fsp.mkdir(REFS_DIR, { recursive: true });
      await fsp.writeFile(path.join(REFS_DIR, name), buf);
      return json(res, 200, { ok: true, ref: name });
    }
    if (req.method === "GET" && url.pathname === "/review") {
      return json(res, 200, { ok: true, review: reviewView() });
    }
    if (req.method === "GET" && url.pathname === "/review/img") {
      const k = Number(url.searchParams.get("k")), which = url.searchParams.get("which");
      const it = state.review && state.review.items.find((x) => x.k === k);
      const file = it && (which === "before" ? it.before : which === "after" ? it.after : null);
      if (!file) return json(res, 404, { ok: false, error: "not found" });
      const buf = await fsp.readFile(file).catch(() => null);
      if (!buf) return json(res, 404, { ok: false, error: "not found" });
      res.writeHead(200, { ...CORS, "Content-Type": "image/png", "Cache-Control": "no-store" });
      return res.end(buf);
    }
    if (req.method === "POST" && url.pathname === "/review/close") {
      // "Looks good, close": the round is over. Wipe it and close the window; a waiting inkback_wait returns "closed".
      json(res, 200, { ok: true });
      await clearAll();
      setTimeout(() => { if (context) context.close().catch(() => {}); }, 150);
      return;
    }
    if (req.method === "POST" && url.pathname === "/review/more") {
      // "More feedback": drop the finished round's notes and marks so the page is clean for the next one.
      const id = state.review ? state.review.batch : null;
      await dropReview();
      if (id != null) for (const [, p] of state.pages) { p.notes = p.notes.filter((n) => n.batch !== id); p.shapes = p.shapes.filter((x) => x.batch !== id); }
      return json(res, 200, { ok: true, totals: totals() });
    }
    if (req.method === "POST" && url.pathname === "/clear") {
      if (state.sending) return json(res, 409, { ok: false, error: "busy" });
      await clearAll();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    log(`http error: ${e.message}`);
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.on("error", (e) => log(`http server error: ${e}`));

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
async function writeSessionFile() {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  // Prune files whose owning process is gone.
  for (const f of await fsp.readdir(SESSIONS_DIR).catch(() => [])) {
    const pid = Number(f.replace(/\.json$/, ""));
    if (!pid) continue;
    try { process.kill(pid, 0); } catch { await fsp.rm(path.join(SESSIONS_DIR, f), { force: true }).catch(() => {}); }
  }
  await fsp.writeFile(path.join(SESSIONS_DIR, `${PARENT_PID}.json`), JSON.stringify({ endpoint, token: TOKEN, pid: process.pid, startedAt: Date.now() }));
}


let cleaned = false;
function cleanupSync() {
  if (cleaned) return;
  cleaned = true;
  try { fs.rmSync(SHOTS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  if (sessionProfile) { try { fs.rmSync(sessionProfile, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(path.join(SESSIONS_DIR, `${PARENT_PID}.json`), { force: true }); } catch { /* ignore */ }
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 3000).unref(); // a wedged Chrome must not keep an orphan alive
  if (context) await context.close().catch(() => {});
  cleanupSync();
  process.exit(0);
}
process.on("unhandledRejection", (e) => log(`unhandled: ${e && e.stack ? e.stack.split("\n")[0] : e}`));
process.on("exit", cleanupSync);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown); // Claude Code went away
setInterval(() => { try { process.kill(PARENT_PID, 0); } catch { shutdown(); } }, 5000).unref();

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
await mcp.connect(new StdioServerTransport());
server.listen(0, "127.0.0.1", async () => {
  endpoint = `http://127.0.0.1:${server.address().port}`;
  markReady();
  await writeSessionFile().catch((e) => log(`session file: ${e.message}`));
  log(`v${VERSION} ready at ${endpoint}`);
});
