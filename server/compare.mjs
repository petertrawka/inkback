// Before/after picture comparison, done inside the browser (no image library needed).
// "same" = the pictures are effectively identical: a few pixels off by a hair (anti-aliasing,
// sub-pixel text) do not count. "changed" = a real number of pixels moved clearly.
import fsp from "node:fs/promises";

export const CHANNEL_TOLERANCE = 24; // a pixel only counts when one colour channel moved by more than this (of 255)
export const MIN_PIXELS = 12;        // ...and at least this many pixels, or this share of the picture, must count
export const MIN_SHARE = 0.0005;

// Runs in the page. Takes two base64 PNGs, answers { same, differing, total }.
export async function pagePixelDiff(args) {
  const { a, b, tol, minPx, minShare } = args;
  const bmp = async (b64) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: "image/png" }));
  };
  const [ia, ib] = await Promise.all([bmp(a), bmp(b)]);
  if (ia.width !== ib.width || ia.height !== ib.height) return { same: false, differing: -1, total: 0, sizes: true };
  const px = (im) => {
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0);
    return g.getImageData(0, 0, im.width, im.height).data;
  };
  const da = px(ia), db = px(ib);
  let differing = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (Math.abs(da[i] - db[i]) > tol || Math.abs(da[i + 1] - db[i + 1]) > tol || Math.abs(da[i + 2] - db[i + 2]) > tol || Math.abs(da[i + 3] - db[i + 3]) > tol) differing++;
  }
  const total = ia.width * ia.height;
  return { same: differing < Math.max(minPx, total * minShare), differing, total };
}

// Resolves "same" | "changed". Throws when it cannot tell (caller treats that as "couldn't check").
export async function compareFiles(page, fileA, fileB) {
  const [a, b] = (await Promise.all([fsp.readFile(fileA), fsp.readFile(fileB)])).map((x) => x.toString("base64"));
  const r = await page.evaluate(pagePixelDiff, { a, b, tol: CHANNEL_TOLERANCE, minPx: MIN_PIXELS, minShare: MIN_SHARE });
  return r.same ? "same" : "changed";
}

// ---------------------------------------------------------------------------
// Whole-page comparison for "Also changed": which areas moved away from the user's notes.
// ---------------------------------------------------------------------------
export const BLOCK = 8;          // the picture is checked in 8x8 pixel blocks
export const BLOCK_MIN = 3;      // a block counts when at least this many of its pixels moved clearly
export const MAX_REGIONS = 8;    // more than this and nearby boxes are joined (never dropped)
export const REGION_PAD = 24;    // the picture shown around a box

// Runs in the page. Takes two whole-page PNGs (base64) and the rectangles the user's notes already cover
// ({x,y,w,h} in page pixels, those are blanked out in both). Answers the boxes where the rest differs,
// each with a before and an after crop (base64 PNG). A taller or wider page counts the extra area as changed.
export async function pageRegions(args) {
  const { a, b, tol, excl, blk, blkMin, minPx, maxRegions, padPx } = args;
  const bmp = async (b64) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: "image/png" }));
  };
  const [ia, ib] = await Promise.all([bmp(a), bmp(b)]);
  const W = Math.max(ia.width, ib.width), H = Math.max(ia.height, ib.height);
  const px = (im) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0);
    g.fillStyle = "#000"; // the noted areas: same colour in both, so they never differ
    for (const r of excl) g.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);
    return g.getImageData(0, 0, W, H).data;
  };
  const da = px(ia), db = px(ib);
  const gw = Math.ceil(W / blk), gh = Math.ceil(H / blk), cnt = new Uint32Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = y * W, grow = Math.floor(y / blk) * gw;
    for (let x = 0; x < W; x++) {
      const i = (row + x) * 4;
      if (Math.abs(da[i] - db[i]) > tol || Math.abs(da[i + 1] - db[i + 1]) > tol || Math.abs(da[i + 2] - db[i + 2]) > tol || Math.abs(da[i + 3] - db[i + 3]) > tol) cnt[grow + Math.floor(x / blk)]++;
    }
  }
  // Group active blocks that sit within 2 blocks of each other (flood fill), keep a box and a pixel count per group.
  const seen = new Uint8Array(gw * gh), boxes = [];
  for (let s = 0; s < cnt.length; s++) {
    if (cnt[s] < blkMin || seen[s]) continue;
    const q = [s]; seen[s] = 1;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1, n = 0;
    while (q.length) {
      const v = q.pop(), vx = v % gw, vy = (v - vx) / gw;
      n += cnt[v]; if (vx < x0) x0 = vx; if (vx > x1) x1 = vx; if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = vx + dx, ny = vy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (!seen[k] && cnt[k] >= blkMin) { seen[k] = 1; q.push(k); }
      }
    }
    boxes.push({ x0: x0 * blk, y0: y0 * blk, x1: Math.min(W, (x1 + 1) * blk), y1: Math.min(H, (y1 + 1) * blk), n });
  }
  // Join boxes that touch or nearly touch; if there are still too many, widen the gap until it fits.
  const near = (p, q, gap) => p.x0 < q.x1 + gap && q.x0 < p.x1 + gap && p.y0 < q.y1 + gap && q.y0 < p.y1 + gap;
  let gap = 16;
  for (;;) {
    let joined = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (!near(boxes[i], boxes[j], gap)) continue;
      const p = boxes[i], q = boxes[j];
      boxes[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1), n: p.n + q.n };
      boxes.splice(j, 1); joined = true; break outer;
    }
    if (joined) continue;
    if (boxes.length <= maxRegions) break;
    gap *= 2;
  }
  const keep = boxes.filter((r) => r.n >= minPx).sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
  const crop = (im, cx, cy, cw, ch) => {
    const c = document.createElement("canvas"); c.width = cw; c.height = ch;
    c.getContext("2d").drawImage(im, cx, cy, cw, ch, 0, 0, cw, ch);
    return c.toDataURL("image/png").split(",")[1];
  };
  return keep.map((r) => {
    const cx = Math.max(0, r.x0 - padPx), cy = Math.max(0, r.y0 - padPx);
    const cw = Math.min(W, r.x1 + padPx) - cx, ch = Math.min(H, r.y1 + padPx) - cy;
    return { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0, cx, cy, cw, ch, before: crop(ia, cx, cy, cw, ch), after: crop(ib, cx, cy, cw, ch) };
  });
}

// Whole-page pictures before and after, with the noted areas left out. Writes each box's two crops as files
// (<prefix><n>-before.png / -after.png) and resolves [{ a, rect, box, before, after }]; box = where the change
// sits inside the crop, as fractions. Throws when it cannot tell (caller says "couldn't check").
export async function compareRegions(page, fileA, fileB, excl, outPrefix, firstN = 1) {
  const [a, b] = (await Promise.all([fsp.readFile(fileA), fsp.readFile(fileB)])).map((x) => x.toString("base64"));
  const rs = await page.evaluate(pageRegions, { a, b, tol: CHANNEL_TOLERANCE, excl, blk: BLOCK, blkMin: BLOCK_MIN, minPx: MIN_PIXELS, maxRegions: MAX_REGIONS, padPx: REGION_PAD });
  const out = [];
  for (const [i, r] of rs.entries()) {
    const n = firstN + i, before = `${outPrefix}${n}-before.png`, after = `${outPrefix}${n}-after.png`;
    await fsp.writeFile(before, Buffer.from(r.before, "base64"));
    await fsp.writeFile(after, Buffer.from(r.after, "base64"));
    out.push({ a: n, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, box: { l: (r.x - r.cx) / r.cw, t: (r.y - r.cy) / r.ch, w: r.w / r.cw, h: r.h / r.ch }, before, after });
  }
  return out;
}
