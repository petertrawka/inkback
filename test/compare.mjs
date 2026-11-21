// Picture comparison test: needs Chrome (skips with a notice when it can't launch).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareFiles } from "../server/compare.mjs";

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
await browser.close(); fs.rmSync(dir, { recursive: true, force: true });
