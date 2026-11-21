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
