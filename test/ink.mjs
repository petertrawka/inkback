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
import { inkForCluster, returnMarks, viewInk, followUp, followLines } from "../server/ink.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = fs.readFileSync(path.join(here, "..", "server", "overlay.js"), "utf8");

// ---------------------------------------------------------------------------
// "Your ink comes back": server side, no browser
// ---------------------------------------------------------------------------
{
  const circle = Array.from({ length: 1500 }, (_, i) => [370 + 120 * Math.cos(i / 230), 272 + 60 * Math.sin(i / 230)]);
  const cluster = {
    notes: [
      { id: "n2", n: 2, x: 700, y: 120, text: "pin only", color: "sage" },
      { id: "n1", n: 1, x: 490, y: 212, text: "make this bigger", color: "sage", shapeId: "s1" },
    ],
    shapes: [
      { id: "s1", type: "pen", color: "sage", points: circle, batch: 1, ctx: { selector: "button#b" } },
      { id: "s2", type: "rect", color: "sage", x: 600, y: 100, w: 150, h: 80, batch: 1 },
      { id: "s3", type: "pen", color: "sage", points: [[1, 1]] }, // a dot: never sent, never returned
    ],
  };
  const ink = inkForCluster(cluster);
  assert.equal(ink.marks.length, 2, "two real marks copied");
  assert.equal(ink.marks[0].n, 1, "the stroke belongs to note 1");
  assert.equal(ink.marks[1].n, null, "the box has no note");
  assert.deepEqual(ink.pins.map((p) => [p.n, p.text]), [[1, "make this bigger"], [2, "pin only"]], "pins sorted by number, with their text");
  assert.equal(ink.marks[0].points.length, 1500, "the copy keeps every point");
  cluster.shapes[0].points[0][0] = -999; cluster.shapes[1].x = -999;
  assert.notEqual(ink.marks[0].points[0][0], -999, "a later edit does not change the copy");
  assert.equal(ink.marks[1].x, 600);
  assert.ok(!("ctx" in ink.marks[0]) && !("batch" in ink.marks[0]) && !("id" in ink.marks[0]), "only the drawing is copied");

  const view = viewInk(ink);
  assert.ok(view.marks[0].points.length <= 400, "long strokes thinned for the result screen");
  assert.deepEqual(view.marks[0].points.at(-1), ink.marks[0].points.at(-1), "thinning keeps the last point");
  assert.equal(ink.marks[0].points.length, 1500, "thinning leaves the stored copy alone");
  assert.equal(viewInk(null), null, "a result from an older version has no ink");

  const item = { ink, shift: { dx: 5, dy: 40 } };
  const back = returnMarks(item, item.shift, { batch: 7, note: "nrX" });
  assert.equal(back.shapes.length, 2, "every mark of the card comes back");
  assert.ok(back.shapes.every((s) => s.id && s.id !== "s1" && s.id !== "s2"), "new ids");
  assert.equal(new Set(back.shapes.map((s) => s.id)).size, 2);
  assert.ok(back.shapes.every((s) => s.batch === null && s.ctx === null), "not sent; the page fills in the element");
  assert.deepEqual(back.shapes[0].returned, { batch: 7, n: 1, note: "nrX" }, "flagged as returned, with its note");
  assert.deepEqual(back.shapes[0].points[5], [ink.marks[0].points[5][0] + 5, ink.marks[0].points[5][1] + 40], "a stroke moves with the element");
  assert.equal(back.shapes[0].points.length, 1500, "the returned mark keeps every point");
  assert.deepEqual([back.shapes[1].x, back.shapes[1].y, back.shapes[1].w, back.shapes[1].h], [605, 140, 150, 80], "a box moves with the element");
  assert.equal(back.shapeId, back.shapes[0].id, "the ready-made note is tied to note 1's mark");
  assert.notDeepEqual(back.shapes[0].points[5], ink.marks[0].points[5], "returning moves the new marks, not the stored copy");
  const still = returnMarks(item, null, { batch: 7 });
  assert.deepEqual([still.shapes[1].x, still.shapes[1].y], [600, 100], "element gone or not found: the old spot");
  assert.deepEqual(returnMarks({ rect: { x: 0, y: 0, w: 10, h: 10 } }, null), { shapes: [], shapeId: null }, "an Also changed card returns no marks");
  const pinOnly = inkForCluster({ notes: [{ id: "p", n: 4, x: 1, y: 2, text: "t" }], shapes: [] });
  assert.deepEqual(returnMarks({ ink: pinOnly }, null).shapes, [], "a pin-only note returns no drawing");

  assert.deepEqual(followUp(item), { n: 1, text: "make this bigger", more: [{ n: 2, text: "pin only" }] }, "a follow-up names every original note");
  assert.equal(followUp({ ink: inkForCluster({ notes: [], shapes: cluster.shapes }) }), null, "marks without a note: nothing to follow");
  const said = followLines({ from: followUp(item) }, true);
  assert.match(said, /follows note 1 of the last round: "make this bigger"/, "Claude reads the original note and its text");
  assert.match(said, /follows note 2 of the last round: "pin only"/);
  assert.match(said, /attached picture is the source of truth/);
  assert.equal(followLines({ text: "plain" }, false), "", "an ordinary note gets no extra line");
  console.log("✓ ink copies, thinning, returned marks (new ids, flag, moved along), follow-up text (no browser)");
}

let saved = { shapes: [], notes: [] }; // what the overlay last saved to the stand-in bridge
let initial = { shapes: [], notes: [] }; // what it is given on load
let review = null; // the result screen the stand-in serves (GET /review)
const posted = []; // [path, body] the overlay sent to the stand-in
let png = null; // a plain white picture for Before and After, made by the browser below
const readJson = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
const sendJson = (res, obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
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
    return res.end(JSON.stringify({ ...initial, totals: totals(), review: !!review }));
  }
  if (u.pathname === "/review") return sendJson(res, { ok: true, review });
  if (u.pathname === "/review/img") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(png); }
  if (u.pathname === "/note/next") return sendJson(res, { ok: true, n: 1 + Math.max(0, ...saved.notes.map((n) => n.n)) });
  if (["/review/more", "/review/close", "/send"].includes(u.pathname)) {
    readJson(req).then((body) => {
      posted.push([u.pathname, body]);
      if (u.pathname === "/send") return sendJson(res, { ok: true, batch: 2, notes: saved.notes.length, pages: 1, pushed: false, mode: "poll", totals: { ...totals(), unsent: 0, open: saved.notes.length, batches: 1 } });
      if (u.pathname === "/review/more") review = null;
      sendJson(res, { ok: true });
    });
    return;
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

  // ---------------------------------------------------------------------------
  // "Your ink comes back": the result screen
  // ---------------------------------------------------------------------------
  {
    const p0 = await ctx.newPage();
    await p0.setViewportSize({ width: 900, height: 440 });
    await p0.setContent('<body style="margin:0;background:#fff"></body>');
    png = await p0.screenshot(); // plain white, 900 x 440: Before and After look the same, so only ink shows colour
    await p0.close();
    const circle = Array.from({ length: 900 }, (_, i) => [260 + 150 * Math.cos(i / 140), 220 + 90 * Math.sin(i / 140)]);
    const clip = { x: 0, y: 0, width: 900, height: 440 };
    review = {
      batch: 1, summary: "Made the button bigger.",
      also: { unchecked: false, items: [{ a: 1, box: { l: 0.1, t: 0.1, w: 0.2, h: 0.2 } }] },
      items: [
        { k: 1, after: true, verdict: "changed", clip, notes: [{ n: 1, text: "make this bigger", status: "done", result: "bigger" }],
          ink: { marks: [{ type: "pen", color: "sage", points: circle, n: 1 }, { type: "rect", color: "sage", x: 600, y: 120, w: 220, h: 160, n: null }], pins: [{ n: 1, x: 410, y: 130 }] } },
        { k: 2, after: true, verdict: "same", clip, notes: [{ n: 2, text: "pin only", status: "done", result: "" }], ink: { marks: [], pins: [{ n: 2, x: 300, y: 300 }] } },
        { k: 3, after: false, verdict: "unchecked", clip, notes: [{ n: 3, text: "no after", status: "done", result: "" }], ink: { marks: [{ type: "rect", color: "sage", x: 100, y: 100, w: 200, h: 100, n: 3 }], pins: [{ n: 3, x: 300, y: 200 }] } },
        { k: 4, after: true, verdict: "changed", clip, notes: [{ n: 4, text: "from an older version", status: "done", result: "" }] }, // no ink: card as before
      ],
    };
    const page = await open("#fff", { reduced: true }); // reduced motion: no opening sweep of the divider
    await page.waitForFunction(() => { const r = document.querySelector("inkback-overlay").shadowRoot; return r.querySelectorAll(".cmp.ready").length >= 4; });
    const cards = await inShadow(page, (root) => [...root.querySelectorAll(".rv-card[data-q^='k=']")].map((c) => ({
      q: c.dataset.q,
      lab: c.querySelector(".rv-lab").textContent,
      thumbs: [...c.querySelectorAll(".rv-note")].map((n) => { const t = n.querySelector(".rv-thumb"); return t ? { role: t.getAttribute("role"), label: t.getAttribute("aria-label"), svg: !!t.querySelector("svg polyline, svg rect, svg circle"), next: t.previousElementSibling && t.previousElementSibling.className } : null; }),
      layer: !!c.querySelector(".cmp > .rv-ink"), inAfter: !!c.querySelector("img.a .rv-ink"), pins: [...c.querySelectorAll(".rv-pn")].map((p) => p.textContent),
    })));
    assert.deepEqual(cards.map((c) => c.lab), ["Changed", "No visible change", "Couldn't check", "Changed"], "the labels are the server's verdicts, unchanged");
    assert.deepEqual(cards[0].thumbs[0], { role: "img", label: "Your mark for note 1: a drawn stroke", svg: true, next: "rv-n" }, "a thumbnail of the stroke sits beside note 1's number, labelled for screen readers");
    assert.equal(cards[1].thumbs[0].label, "Note 2: a pin, no drawing", "a note without a drawing shows a pin");
    assert.equal(cards[2].thumbs[0].label, "Your mark for note 3: a box");
    assert.equal(cards[3].thumbs[0], null, "a result without ink shows the card as before");
    assert.ok(cards[0].layer && cards[1].layer && cards[2].layer && !cards[3].layer, "the Before picture carries the marks layer");
    assert.ok(cards.every((c) => !c.inAfter), "the After picture has no marks");
    assert.deepEqual(cards[0].pins, ["1"], "the note number sits on the Before picture");
    // Divider: at 50 % the marks show only on the Before (left) side; at 100 % the whole picture is Before.
    const cmpBox = await inShadow(page, (root) => { const r = root.querySelector(".rv-card[data-q='k=1'] .cmp").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const strong = async (x, w) => {
      const shot = (await page.screenshot({ clip: { x: Math.round(x), y: Math.round(cmpBox.y + 4), width: Math.round(w), height: Math.round(cmpBox.h - 8) } })).toString("base64");
      const px = await page.evaluate(async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return [...x.getImageData(0, 0, c.width, c.height).data]; }, shot);
      let n = 0; for (let i = 0; i < px.length; i += 4) if (ratio([px[i], px[i + 1], px[i + 2]], [255, 255, 255]) >= 3) n++; return n;
    };
    const setPos = (v) => inShadow(page, (root, v) => { const r = root.querySelector(".rv-card[data-q='k=1'] input"); r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); return root.querySelector(".rv-card[data-q='k=1'] .cmp").style.getPropertyValue("--pos"); }, v);
    assert.equal(await setPos(50), "50%", "the slider still moves the divider");
    await sleep(50);
    // Counted against the same picture with the marks layer hidden, so the divider, knob and labels cancel out.
    const half = cmpBox.w / 2;
    const sides = async () => [await strong(cmpBox.x + 4, half - 20), await strong(cmpBox.x + half + 16, half - 20)];
    const bare = async (fn) => { await inShadow(page, (root) => { root.querySelector(".rv-card[data-q='k=1'] .rv-ink").style.visibility = "hidden"; }); await sleep(50); const r = await fn(); await inShadow(page, (root) => { root.querySelector(".rv-card[data-q='k=1'] .rv-ink").style.visibility = ""; }); await sleep(50); return r; };
    const [l50, r50] = await sides(), [l50b, r50b] = await bare(sides);
    assert.ok(l50 - l50b > 200, "marks show on the Before side (" + (l50 - l50b) + " pixels)");
    assert.equal(r50, r50b, "no marks on the After side of the divider");
    await setPos(100); await sleep(50);
    const [, r100] = await sides(), [, r100b] = await bare(sides);
    assert.ok(r100 - r100b > 100, "slide the divider and the marks come back on the Before side (" + (r100 - r100b) + " pixels)");
    await setPos(50);
    // My marks: off hides them on every card and in the real-size view; the choice is remembered.
    const marksBtn = () => inShadow(page, (root) => { const b = root.querySelector(".rv-marks"); return { text: b.textContent, pressed: b.getAttribute("aria-pressed") }; });
    const layersShown = () => inShadow(page, (root) => [...root.querySelectorAll(".rv-ink")].map((l) => getComputedStyle(l).display !== "none"));
    assert.deepEqual(await marksBtn(), { text: "My marks: on", pressed: "true" }, "on by default");
    assert.ok((await layersShown()).every(Boolean));
    await inShadow(page, (root) => root.querySelector(".rv-marks").click());
    assert.deepEqual(await marksBtn(), { text: "My marks: off", pressed: "false" });
    assert.ok((await layersShown()).every((v) => !v), "off hides the marks on every card");
    // real-size view: a plain click on the picture
    await page.mouse.click(cmpBox.x + cmpBox.w * 0.3, cmpBox.y + cmpBox.h / 2);
    await sleep(100);
    const zoomed = await inShadow(page, (root) => { const l = root.querySelector(".rv-zoom .rv-ink"); return l ? getComputedStyle(l).display : "missing"; });
    assert.equal(zoomed, "none", "off also hides them in the real-size view");
    await page.keyboard.press("Escape");
    await inShadow(page, (root) => root.querySelector(".rv-marks").click());
    await page.mouse.click(cmpBox.x + cmpBox.w * 0.3, cmpBox.y + cmpBox.h / 2);
    await sleep(100);
    const zoomed2 = await inShadow(page, (root) => { const l = root.querySelector(".rv-zoom .rv-ink"); return l ? getComputedStyle(l).display : "missing"; });
    assert.equal(zoomed2, "block", "on shows them in the real-size view");
    assert.ok(await inShadow(page, (root) => !!root.querySelector(".rv-zoom img.a") && !root.querySelector(".rv-zoom img.a .rv-ink")), "click-to-zoom still opens the slider at real size");
    await page.keyboard.press("Escape");
    await inShadow(page, (root) => root.querySelector(".rv-marks").click()); // off, then reload: still off
    await page.reload(); await page.waitForFunction(() => window.__inkback && window.__inkback.ready);
    await page.waitForFunction(() => document.querySelector("inkback-overlay").shadowRoot.querySelector(".rv-marks"));
    assert.equal((await marksBtn()).text, "My marks: off", "the choice is remembered");
    assert.ok((await layersShown()).every((v) => !v));
    await inShadow(page, (root) => root.querySelector(".rv-marks").click());
    // Not right: wording, footer line, and what is sent to the server.
    const qn = () => inShadow(page, (root) => { const q = root.querySelector(".rv-qnote"); return q.hidden ? null : q.textContent; });
    assert.equal(await qn(), null, "no footer line while nothing is queued");
    const nr = await inShadow(page, (root) => { const b = root.querySelector(".rv-card[data-q='k=1'] .rv-nr"); b.click(); const a = root.querySelector(".rv-card[data-q='a=1'] .rv-nr"); a.click(); return [b.textContent, a.textContent, root.querySelector(".rv-more").textContent]; });
    assert.deepEqual(nr, ["Queued for next round", "Queued for next round", "Next round with 2 notes"], "the pressed button says Queued for next round");
    assert.equal(await qn(), "Nothing is undone yet. Queued notes go to Claude when you press Send.", "the footer says nothing is undone");
    const bodyBefore = await page.evaluate(() => document.body.innerHTML);
    const rv0 = review; // the stand-in drops it on More feedback, like the server
    posted.length = 0;
    await inShadow(page, (root) => root.querySelector(".rv-more").click());
    await page.waitForEvent("load");
    await page.waitForFunction(() => window.__inkback && window.__inkback.ready);
    assert.deepEqual(posted.find((p) => p[0] === "/review/more")[1], { notRight: ["k=1", "a=1"] }, "More feedback sends the Not right picks");
    assert.equal(await page.evaluate(() => document.body.innerHTML), bodyBefore, "the page itself is unchanged after Not right (nothing is undone before Send)");
    // Looks good, close
    review = { ...rv0, items: rv0.items.slice(0, 1) };
    await page.reload(); await page.waitForFunction(() => document.querySelector("inkback-overlay").shadowRoot.querySelector(".rv-close"));
    posted.length = 0;
    await inShadow(page, (root) => root.querySelector(".rv-close").click());
    await sleep(200);
    assert.ok(posted.some((p) => p[0] === "/review/close"), "Looks good, close still closes the round");
    review = null;
    await page.close();
    console.log("✓ result screen: thumbnails with labels, marks on Before only (cut at the divider), My marks on/off everywhere and remembered, labels unchanged, Not right wording, slider, zoom, close");
  }

  // ---------------------------------------------------------------------------
  // "Your ink comes back": the returned mark on the page
  // ---------------------------------------------------------------------------
  {
    const ring = Array.from({ length: 60 }, (_, i) => [370 + 120 * Math.cos(i / 9.4), 272 + 60 * Math.sin(i / 9.4)]);
    const queuedState = () => ({
      shapes: [
        { id: "rm1", type: "pen", color: "sage", points: ring.map((p) => p.slice()), ctx: null, batch: null, returned: { batch: 1, n: 1, note: "nr1" } },
        { id: "rm2", type: "rect", color: "sage", x: 600, y: 120, w: 150, h: 90, ctx: null, batch: null, returned: { batch: 1, n: null, note: "nr1" } },
      ],
      notes: [{ id: "nr1", n: 2, x: 490, y: 212, color: "sage", text: "Put this back the way it was", refs: [], status: "draft", ctx: null, batch: null, shapeId: "rm1",
        restore: { x: 0, y: 0, w: 900, h: 440 }, from: { n: 1, text: "make this bigger" } }],
    });
    initial = queuedState(); saved = queuedState();
    const page = await open("#fff");
    const look = () => inShadow(page, (root) => {
      const g = root.querySelector("g.shape[data-id='rm1']"), r = root.querySelector("g.shape[data-id='rm2']");
      const q = g && g.querySelector(".qline"), area = r && r.querySelector(".area");
      const pin = root.querySelector(".pin[data-id='nr1']"), tag = pin && pin.querySelector(".tag");
      return {
        queued: !!(g && g.classList.contains("queued")), boxQueued: !!(r && r.classList.contains("queued")),
        fill: q ? getComputedStyle(q).fill : g && getComputedStyle(g.querySelector(".brush")).fill,
        dash: q ? getComputedStyle(q).strokeDasharray : "none", boxDash: area ? getComputedStyle(area).strokeDasharray : "",
        words: tag ? tag.textContent : "", wordsShown: tag ? getComputedStyle(tag).opacity === "1" : false,
        toasts: [...root.querySelectorAll(".toast")].map((t) => t.textContent), undo: root.querySelector("[data-act='undo'] .kbd").textContent,
      };
    });
    await sleep(300);
    const q1 = await look();
    assert.ok(q1.queued && q1.boxQueued, "returned marks are drawn queued");
    assert.equal(q1.fill, "none", "hollow: outline only");
    assert.notEqual(q1.dash, "none", "dashed"); assert.notEqual(q1.boxDash, "1px", "the box is dashed too");
    assert.match(q1.words, /^Queued · not sent/, "the note carries the words Queued · not sent");
    assert.ok(q1.wordsShown, "the words show without hovering");
    assert.ok(q1.toasts.includes("2 marks are back on the page, queued. Nothing has been undone: press Send to ask Claude."), "a one-time message says what happened");
    assert.equal(q1.undo, "Undo my last mark⌘Z", "the Undo tooltip says Undo my last mark");
    await sleep(300);
    assert.ok(saved.shapes.every((s) => s.returned.seen), "each returned mark is looked at once");
    assert.equal(saved.shapes.find((s) => s.id === "rm1").ctx.selector, "button#b", "the page fills in which element a returned mark sits on");
    assert.equal(await page.locator("#b").textContent(), "Buy now", "the page itself is unchanged");
    // The message shows once: reopening with the saved state says nothing again.
    initial = JSON.parse(JSON.stringify(saved));
    await page.reload(); await page.waitForFunction(() => window.__inkback && window.__inkback.ready); await sleep(300);
    assert.equal((await look()).toasts.length, 0, "the message is not repeated");
    // Send: then it looks like any sent mark.
    await inShadow(page, (root) => root.querySelector("[data-act='send']").click());
    await sleep(500);
    const q2 = await look();
    assert.ok(!q2.queued && !q2.boxQueued, "after Send the mark is not queued any more");
    assert.equal(q2.fill.startsWith("url("), true, "and is drawn as a normal filled stroke");
    assert.doesNotMatch(q2.words, /Queued/, "the words are gone after Send");
    await page.close();
    // Deleting the queued note removes its marks too.
    initial = queuedState(); saved = queuedState();
    const p2 = await open("#fff");
    await sleep(300);
    await inShadow(p2, (root) => { const d = root.querySelector(".pin[data-id='nr1'] .dot"); const r = d.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }).then(([x, y]) => p2.mouse.click(x, y));
    await sleep(250);
    await inShadow(p2, (root) => root.querySelector(".pop .del").click());
    await sleep(500);
    assert.equal(saved.notes.length, 0, "the queued note is deleted");
    assert.equal(saved.shapes.length, 0, "and every mark it brought back goes with it");
    await p2.close();
    initial = { shapes: [], notes: [] }; saved = { shapes: [], notes: [] };
    console.log("✓ returned marks: hollow and dashed, Queued · not sent, one message, page untouched, normal after Send, deleted with their note");
  }
} finally {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}
