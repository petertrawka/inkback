// Pen / ink look test: needs Chrome (skips with a notice when it can't launch).
// Serves a blank page plus a stand-in for the plugin's local bridge, loads the real overlay.js into it,
// then draws with the mouse and checks what the user would see (contrast on three backgrounds, stroke width,
// undo / select / delete, old marks, speed, reduced motion).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = fs.readFileSync(path.join(here, "..", "server", "overlay.js"), "utf8");

let saved = { shapes: [], notes: [] }; // what the overlay last saved to the stand-in bridge
let initial = { shapes: [], notes: [] }; // what it is given on load
const totals = () => ({ notes: saved.notes.length, shapes: saved.shapes.length, pages: 1, unsent: saved.notes.length + saved.shapes.length, open: 0, batches: 0 });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: " + JSON.stringify({ type: "hello" }) + "\n\n"); return; }
  if (u.pathname === "/state") {
    if (req.method === "PUT") {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => { const j = JSON.parse(b); saved = { shapes: j.shapes, notes: j.notes }; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ totals: totals() })); });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ...initial, totals: totals() }));
  }
  const bg = u.searchParams.get("bg") || "#ffffff";
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end('<!doctype html><body style="margin:0;background:' + bg + ';height:700px"><button id="b" style="position:absolute;left:300px;top:250px;width:140px;height:44px;font-size:16px">Buy now</button></body>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkback-ink-"));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(dir, { channel: process.env.INKBACK_BROWSER || "chrome", headless: process.env.INKBACK_TEST_HEADED !== "1", viewport: { width: 900, height: 700 } });
} catch (e) {
  console.log("- ink test skipped: no Chrome to run it in");
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
await ctx.addInitScript({ content: "window.__INKBACK__ = " + JSON.stringify({ endpoint: base, token: "t", renderOnly: false }) + ";\n" + OVERLAY });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(bg, { reduced = false } = {}) {
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.goto(base + "/?bg=" + encodeURIComponent(bg), { waitUntil: "load" });
  await page.waitForFunction(() => window.__inkback && window.__inkback.ready);
  return page;
}
const inShadow = (page, fn, arg) => page.evaluate(([src, a]) => { const root = document.querySelector("inkback-overlay").shadowRoot; return (0, eval)("(" + src + ")")(root, a); }, [fn.toString(), arg]);
async function drawCircle(page, cx = 370, cy = 272, rx = 120, ry = 60, steps = 60) {
  await page.keyboard.press("p");
  await page.mouse.move(cx + rx, cy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { const a = (i / steps) * Math.PI * 2 * 1.04; await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
  await page.mouse.up();
  await sleep(200);
}
const luminance = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Count pixels in a screenshot that differ from the background by a 3:1 contrast or more.
async function strongPixels(page, bgRgb) {
  const png = (await page.screenshot({ clip: { x: 230, y: 190, width: 280, height: 160 } })).toString("base64");
  const px = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0); return [...x.getImageData(0, 0, c.width, c.height).data];
  }, png);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (ratio([px[i], px[i + 1], px[i + 2]], bgRgb) >= 3) n++;
  return n;
}

try {
  // 1. Readable on white, mid-grey and near-black pages, in the live view and in the picture Claude gets (capture mode).
  for (const [name, bg, rgb] of [["white", "#ffffff", [255, 255, 255]], ["mid-grey", "#808080", [128, 128, 128]], ["near-black", "#0b0b0d", [11, 11, 13]]]) {
    const page = await open(bg);
    // keep the button out of the count: hide it, the page is only a background here
    await page.evaluate(() => { document.getElementById("b").style.visibility = "hidden"; });
    await drawCircle(page);
    await page.keyboard.press("Escape"); // close the note box so it is not in the picture
    await page.mouse.move(850, 650); // the hover glow around a mark under the cursor is not the look being tested
    await sleep(250);
    await page.evaluate(() => window.__inkback.capture(true));
    await sleep(100);
    const n = await strongPixels(page, rgb);
    assert.ok(n >= 400, "the stroke reads on a " + name + " page (" + n + " pixels at 3:1 or better)");
    await page.close();
  }
  console.log("✓ stroke reads (3:1) on white, mid-grey and near-black pages, also in capture mode");
  for (const [name, bg, rgb] of [["white", "#ffffff", [255, 255, 255]], ["mid-grey", "#808080", [128, 128, 128]], ["near-black", "#0b0b0d", [11, 11, 13]]]) {
    const page = await open(bg);
    await page.evaluate(() => { document.getElementById("b").style.visibility = "hidden"; });
    await page.keyboard.press("a");
    await page.mouse.move(250, 210); await page.mouse.down(); await page.mouse.move(350, 280, { steps: 5 }); await page.mouse.move(490, 330, { steps: 5 }); await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.mouse.move(850, 650);
    await sleep(800); // the draw-on animation has finished
    await page.evaluate(() => window.__inkback.capture(true));
    await sleep(100);
    const n = await strongPixels(page, rgb);
    assert.ok(n >= 300, "the Area box reads on a " + name + " page (" + n + " pixels at 3:1 or better)");
    await page.close();
  }
  console.log("✓ Area box reads (3:1) on white, mid-grey and near-black pages");

  // 2. Width: slight variation away from the ends, tapered ends, floor on the ends.
  {
    const page = await open("#fff");
    const out = await page.evaluate(() => {
      const pts = [];
      for (let i = 0; i < 160; i++) { // slow half, fast half, slow again: gaps of 2.5 px, 20 px, 2.5 px
        const gap = i < 50 || i > 110 ? 2.5 : 20;
        const prev = pts[i - 1] || [100, 100];
        const a = i * 0.05;
        pts.push([prev[0] + gap * Math.cos(a), prev[1] + gap * Math.sin(a)]);
      }
      const w = window.__inkback.brushWidths(pts);
      const mid = w.slice(8, w.length - 10);
      // a 3-point flick must not vanish
      const flick = window.__inkback.brushWidths([[0, 0], [60, 5], [120, 0]]);
      return { max: Math.max(...mid), min: Math.min(...mid), first: w[0], last: w[w.length - 1], flickMin: Math.min(...flick) };
    });
    assert.ok(out.max / out.min <= 1.6, "thickest is at most 1.6 x the thinnest away from the ends (" + (out.max / out.min).toFixed(2) + ")");
    assert.ok(out.max / out.min >= 1.1, "speed still changes the width (" + (out.max / out.min).toFixed(2) + ")");
    assert.ok(out.first < out.min && out.last < out.min, "the ends taper");
    assert.ok(out.first >= 1.6 - 1e-9 && out.last >= 1.6 - 1e-9 && out.flickMin >= 1.6 - 1e-9, "the ends never get thinner than 1.6 px");
    console.log("✓ width " + out.min.toFixed(1) + "-" + out.max.toFixed(1) + " px (ratio " + (out.max / out.min).toFixed(2) + "), ends taper, floor 1.6 px");

    // 3. Speed: a 1,500-point stroke is built in under 8 ms.
    const ms = await page.evaluate(() => {
      const pts = Array.from({ length: 1500 }, (_, i) => [200 + 150 * Math.cos(i / 40) + i * 0.2, 300 + 90 * Math.sin(i / 25)]);
      for (let i = 0; i < 5; i++) window.__inkback.brushPath(pts); // warm up
      const t = [];
      for (let i = 0; i < 9; i++) { const s = performance.now(); window.__inkback.brushPath(pts); t.push(performance.now() - s); }
      return t.sort((a, b) => a - b)[4]; // median
    });
    assert.ok(ms < 8, "building a 1,500-point stroke takes " + ms.toFixed(2) + " ms (limit 8)");
    console.log("✓ 1,500-point stroke built in " + ms.toFixed(2) + " ms");
    await page.close();
  }

  // 4. Undo, Select + Delete on a pen stroke and a box; the stroke keeps its note.
  {
    const page = await open("#fff");
    saved = { shapes: [], notes: [] };
    await drawCircle(page);
    await page.keyboard.press("Escape");
    await sleep(300);
    assert.equal(saved.shapes.length, 1, "the stroke is saved");
    assert.equal(saved.shapes[0].type, "pen");
    assert.ok(saved.shapes[0].points.length >= 30, "the stroke keeps every point");
    await page.keyboard.press("Meta+z");
    await sleep(300);
    assert.equal(saved.shapes.length, 0, "Undo removes the stroke");
    // Area box
    await page.keyboard.press("a");
    await page.mouse.move(100, 450); await page.mouse.down(); await page.mouse.move(200, 500, { steps: 5 }); await page.mouse.move(260, 560, { steps: 5 }); await page.mouse.up();
    await page.keyboard.press("Escape");
    await sleep(300);
    assert.equal(saved.shapes.length, 1, "the Area box is saved");
    assert.equal(saved.shapes[0].type, "rect");
    // Select + Delete the box (click on its edge)
    await page.keyboard.press("s");
    await page.mouse.click(100, 500);
    await sleep(100);
    await page.keyboard.press("Delete");
    await sleep(500);
    assert.equal(saved.shapes.length, 0, "Select + Delete removes the box");
    // Pen stroke: Select, move, Delete
    await drawCircle(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("s");
    const before = saved.shapes[0].points[0].slice();
    await page.mouse.move(370 + 120, 272); await page.mouse.down(); await page.mouse.move(400 + 120, 300, { steps: 5 }); await page.mouse.up();
    await sleep(300);
    const after = saved.shapes[0].points[0];
    assert.ok(Math.abs(after[0] - before[0] - 30) < 2 && Math.abs(after[1] - before[1] - 28) < 2, "a selected stroke moves with the mouse");
    await page.keyboard.press("Delete");
    await sleep(500);
    assert.equal(saved.shapes.length, 0, "Select + Delete removes the stroke");
    assert.equal(saved.notes.filter((n) => n.shapeId).length, 0, "and its note goes too");
    console.log("✓ undo, select, move and delete work on strokes and boxes");
    await page.close();
  }

  // 5. Marks saved before this change still load and draw (old pen, arrow, circle, box).
  {
    const pen = Array.from({ length: 40 }, (_, i) => [300 + i * 3, 300 + Math.sin(i / 5) * 20]);
    initial = { shapes: [
      { id: "o1", type: "pen", color: "sage", points: pen },
      { id: "o2", type: "arrow", color: "sage", x1: 100, y1: 100, x2: 200, y2: 150 },
      { id: "o3", type: "ellipse", color: "sage", x: 400, y: 400, w: 100, h: 60 },
      { id: "o4", type: "rect", color: "sage", x: 500, y: 100, w: 120, h: 80 },
      { id: "o5", type: "line", color: "sage", x1: 50, y1: 50, x2: 150, y2: 60 },
    ], notes: [] };
    saved = { shapes: initial.shapes, notes: [] };
    const page = await open("#fff");
    const got = await inShadow(page, (root) => [...root.querySelectorAll("g.shape")].map((g) => ({ cls: g.getAttribute("class").split(" ")[1], ok: !!g.querySelector("path[d],rect,ellipse,polygon") && (!g.querySelector(".brush") || g.querySelector(".brush").getAttribute("d").length > 20) })));
    assert.deepEqual(got.map((g) => g.cls).sort(), ["arrow", "ellipse", "line", "pen", "rect"], "old marks all draw");
    assert.ok(got.every((g) => g.ok), "old marks have geometry");
    console.log("✓ marks saved before this change still load and draw");
    await page.close();
    initial = { shapes: [], notes: [] };
  }

  // 6. Reduced motion: a finished stroke does not animate (and it does when motion is allowed).
  for (const reduced of [false, true]) {
    saved = { shapes: [], notes: [] };
    const page = await open("#fff", { reduced });
    await drawCircle(page);
    const anims = await inShadow(page, (root) => [...root.querySelectorAll("g.shape .brush")].reduce((n, e) => n + e.getAnimations().length, 0));
    if (reduced) assert.equal(anims, 0, "no animation with reduced motion");
    else assert.ok(anims > 0, "the settle animation plays normally (control)");
    await page.close();
  }
  console.log("✓ reduced motion: a finished stroke does not animate");
} finally {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}
