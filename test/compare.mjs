// Picture comparison test: needs Chrome (skips with a notice when it can't launch).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareFiles, compareRegions } from "../server/compare.mjs";

let browser;
try { browser = await chromium.launch({ channel: process.env.INKBACK_BROWSER || "chrome", headless: true }); }
catch (e) { console.log("- compare test skipped: no Chrome to run it in"); process.exit(0); }
const page = await browser.newPage();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkback-cmp-"));
// Draws a 300x200 picture (button on white) and saves it. noise = random +-n on every channel; shift = button colour change.
async function make(name, { noise = 0, button = [51, 102, 204], w = 300, h = 200 } = {}) {
  const b64 = await page.evaluate(({ noise, button, w, h }) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgb(" + button.join(",") + ")"; g.fillRect(40, 60, 120, 50);
    if (noise) { const d = g.getImageData(0, 0, w, h); let s = 7; for (let i = 0; i < d.data.length; i += 4) for (let k = 0; k < 3; k++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d.data[i + k] = Math.max(0, Math.min(255, d.data[i + k] + ((s % (2 * noise + 1)) - noise))); } g.putImageData(d, 0, 0); }
    return c.toDataURL("image/png").split(",")[1];
  }, { noise, button, w, h });
  const f = path.join(dir, name + ".png"); fs.writeFileSync(f, Buffer.from(b64, "base64")); return f;
}
const base = await make("base");
assert.equal(await compareFiles(page, base, await make("same")), "same", "identical pictures");
assert.equal(await compareFiles(page, base, await make("noisy", { noise: 6 })), "same", "anti-aliasing-level noise stays No visible change");
assert.equal(await compareFiles(page, base, await make("red", { button: [238, 51, 51] })), "changed", "a real colour change is Changed");
assert.equal(await compareFiles(page, base, await make("size", { w: 310 })), "changed", "different size is Changed");
console.log("✓ picture comparison: identical, noise, real change, size change");
// "Also changed": whole pages, 300 wide; page = tall page with a button (top), a middle block and a footer (bottom).
async function tall(name, { button = [51, 102, 204], footer = [60, 60, 60], h = 1500 } = {}) {
  const b64 = await page.evaluate(({ button, footer, h }) => {
    const c = document.createElement("canvas"); c.width = 300; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 300, h);
    g.fillStyle = "rgb(" + button.join(",") + ")"; g.fillRect(40, 60, 120, 50);
    g.fillStyle = "#c80"; g.fillRect(40, 700, 120, 50);
    g.fillStyle = "rgb(" + footer.join(",") + ")"; g.fillRect(0, h - 120, 300, 120);
    return c.toDataURL("image/png").split(",")[1];
  }, { button, footer, h });
  const f = path.join(dir, name + ".png"); fs.writeFileSync(f, Buffer.from(b64, "base64")); return f;
}
const noted = [{ x: 0, y: 0, w: 300, h: 200 }]; // the button's strip is what the user marked
const pre = path.join(dir, "also");
const t0 = await tall("t0");
// 1. Only the noted button changed: nothing else.
assert.deepEqual((await compareRegions(page, t0, await tall("t1", { button: [238, 51, 51] }), noted, pre + "a")).length, 0, "changes inside the noted area are not listed again");
// 2. Button and footer changed, footer is far below the visible window: footer is listed, with crops and a box.
const r2 = await compareRegions(page, t0, await tall("t2", { button: [238, 51, 51], footer: [200, 40, 40] }), noted, pre + "b");
assert.equal(r2.length, 1, "the footer is the one other changed area");
assert.ok(r2[0].rect.y >= 1370 && r2[0].rect.y + r2[0].rect.h <= 1500, "the box sits on the footer, found below the first screen");
assert.ok(fs.statSync(r2[0].before).size > 0 && fs.statSync(r2[0].after).size > 0, "before and after crops were written");
// 3. Nothing changed at all: nothing listed.
assert.equal((await compareRegions(page, t0, await tall("t3"), noted, pre + "c")).length, 0, "identical pages list nothing");
// 4. The page grew taller: the new area is listed (never silently ignored).
const r5 = await compareRegions(page, t0, await tall("t5", { h: 1700 }), noted, pre + "e");
assert.ok(r5.length >= 1, "a taller page shows its changed area");
console.log("✓ also-changed: noted area skipped, footer found below the fold, identical lists nothing, taller page listed");
await browser.close(); fs.rmSync(dir, { recursive: true, force: true });
