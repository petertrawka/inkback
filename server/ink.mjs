// "Your ink comes back with the answer": plain functions, testable without a browser (see test/ink.mjs).
//
// inkForCluster: at Send, a copy of the user's marks and pins in one picture strip, and which mark belongs
//   to which note number. Kept on the batch's compare entry, so later edits or deletes cannot change what
//   the result screen shows.
// viewInk: the same copy for the result screen, long strokes thinned (it is only for showing).
// returnMarks: after "Not right", copies of those marks for the next round: new ids, not sent, flagged as
//   returned, moved by the distance the marked element moved.
// followUp: which note(s) of the last round a "Not right" note follows, for the text Claude reads.

import crypto from "node:crypto";

const copy = (v) => JSON.parse(JSON.stringify(v));
const GEOM = { pen: ["points"], rect: ["x", "y", "w", "h"], ellipse: ["x", "y", "w", "h"], arrow: ["x1", "y1", "x2", "y2"], line: ["x1", "y1", "x2", "y2"] };

function geometry(s) {
  const keys = GEOM[s.type];
  if (!keys) return null;
  const g = { type: s.type };
  for (const k of keys) g[k] = copy(s[k]);
  return g;
}

export function inkForCluster(cluster) {
  const notes = (cluster && cluster.notes) || [], shapes = (cluster && cluster.shapes) || [];
  const marks = [];
  for (const s of shapes) {
    const g = geometry(s);
    if (!g) continue;
    if (g.type === "pen" && !(Array.isArray(g.points) && g.points.length > 1)) continue;
    const owner = notes.filter((n) => n.shapeId === s.id).sort((a, b) => a.n - b.n)[0];
    marks.push({ ...g, color: s.color || "sage", n: owner ? owner.n : null });
  }
  const pins = notes.map((n) => ({ n: n.n, x: Math.round(n.x), y: Math.round(n.y), text: String(n.text || "") })).sort((a, b) => a.n - b.n);
  return { marks, pins };
}

// Every k-th point plus the last, so a stroke has at most max points.
export function thin(points, max = 400) {
  if (!Array.isArray(points) || points.length <= max) return points;
  const step = (points.length - 1) / (max - 1), out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

export function viewInk(ink, max = 400) {
  if (!ink) return null;
  return {
    marks: (ink.marks || []).map((m) => (m.type === "pen" ? { ...m, points: thin(m.points, max) } : { ...m })),
    pins: (ink.pins || []).map((p) => ({ n: p.n, x: p.x, y: p.y })),
  };
}

export function shiftShape(s, dx, dy) {
  if (!dx && !dy) return s;
  if (s.type === "pen") s.points = s.points.map(([x, y]) => [x + dx, y + dy]);
  else if (s.type === "arrow" || s.type === "line") { s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }
  else { s.x += dx; s.y += dy; }
  return s;
}

// item: a compare entry ({ ink, shift? }). Returns { shapes, shapeId }: the marks for the next round and the
// id of the one the ready-made note is tied to (the card's first note's mark, else the card's first mark).
export function returnMarks(item, shift, opts = {}) {
  const ink = item && item.ink;
  if (!ink || !Array.isArray(ink.marks) || !ink.marks.length) return { shapes: [], shapeId: null };
  const dx = Math.round((shift && shift.dx) || 0), dy = Math.round((shift && shift.dy) || 0);
  const newId = opts.newId || (() => `rm${crypto.randomBytes(5).toString("hex")}`);
  const shapes = ink.marks.map((m) => {
    const { n, ...g } = copy(m);
    return shiftShape({ id: newId(), ...g, color: g.color || "sage", ctx: null, batch: null, returned: { batch: opts.batch == null ? null : opts.batch, n: n == null ? null : n, note: opts.note || null } }, dx, dy);
  });
  const firstN = ink.pins && ink.pins.length ? ink.pins[0].n : null;
  const i = firstN == null ? -1 : ink.marks.findIndex((m) => m.n === firstN);
  return { shapes, shapeId: shapes[i >= 0 ? i : 0].id };
}

// What Claude reads for a follow-up note: which note(s) of the last round it follows, and their text.
export function followLines(note, hasMark) {
  if (!note || !note.from) return "";
  const all = [note.from, ...(Array.isArray(note.from.more) ? note.from.more : [])];
  let out = "";
  for (const f of all) out += `follows note ${f.n} of the last round: "${String(f.text || "").replace(/\s+/g, " ").trim()}"\n`;
  if (hasMark) out += "the user's original drawing is back on the page (moved along if the element moved); if the page moved, the attached picture is the source of truth\n";
  return out;
}

// The original note(s) a "Not right" card stands for: { n, text } of the first, the others in more.
export function followUp(item) {
  const pins = (item && item.ink && item.ink.pins) || [];
  if (!pins.length) return null;
  const [first, ...rest] = pins;
  const f = { n: first.n, text: first.text };
  if (rest.length) f.more = rest.map((p) => ({ n: p.n, text: p.text }));
  return f;
}
