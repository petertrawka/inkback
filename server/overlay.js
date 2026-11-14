/* Annotate — in-page overlay.
 *
 * Injected into every page of the annotation browser before the page's own scripts
 * run (window.__CLAUDE_ANNOTATE__ carries endpoint + token). Everything lives in a
 * Shadow DOM on a host appended to <html>, so the page's CSS never touches it and ours
 * never leaks out. Document coordinates everywhere, so marks stay put while scrolling.
 *
 * ponytail: marks assume the window is the scroller. A page that scrolls <body> or a wrapper
 * instead of the viewport keeps scrollX/Y at 0 and pins stick to the viewport. Upgrade path:
 * anchor each mark to the nearest scroll container of its element.
 */
(() => {
  if (window.top !== window) return; // never inside iframes
  const CFG = window.__CLAUDE_ANNOTATE__;
  try { delete window.__CLAUDE_ANNOTATE__; } catch { window.__CLAUDE_ANNOTATE__ = undefined; } // the token never stays on the page
  if (!CFG || window.__claudeAnnotate) return;
  // Local development hosts only: a third-party page in this profile must never see the bridge.
  if (!isLocalHost(location.hostname)) return;
  const F = window.fetch.bind(window), ES = window.EventSource; // taken before page scripts can patch them
  const RENDER_ONLY = !!CFG.renderOnly || !!window.__CLAUDE_ANNOTATE_RENDER_ONLY__;

  function isLocalHost(h) {
    return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/.test(h) || /\.(localhost|test|local|internal)$/.test(h);
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const INKS = [
    { id: "sage", hex: "#9cc3a9", dark: "#f5f5f4" }, // single ink: soft sage fading into gold along the stroke (see #ca-ink)
  ];
  const TOOLS = ["pen", "arrow", "line", "rect", "ellipse", "note", "select"];
  const KEYS = { p: "pen", a: "rect", n: "note", s: "select" }; // arrow/line/box/circle removed from the bar (Peter, 2026-11-13)
  const ICON = {
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    pen: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    arrow: '<path d="M5 19 19 5"/><path d="M9 5h10v10"/>',
    line: '<path d="M5 19 19 5"/>',
    rect: '<rect x="3.5" y="4.5" width="17" height="15" rx="4" stroke-dasharray="3.2 3"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
    select: '<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  };
  const svgIcon = (name, size = 18) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const api = { ready: false };
  window.__claudeAnnotate = api;

  const pageUrl = () => location.href;
  let shapes = []; // { id, type, color, ...geometry, ctx, batch }
  let notes = []; // { id, n, x, y, color, text, status, ctx, batch, result }
  let tool = "note"; // comments are the default tool
  let ink = INKS[0];
  let mode = "browse"; // draw | browse. Browse first: the page stays usable until a tool is picked
  let selected = null;
  let draft = null;
  const undo = [];
  const redo = [];
  let totals = { notes: 0, shapes: 0, pages: 0, unsent: 0, open: 0, batches: 0 };
  let linkState = "connecting"; // connecting | on | off
  let phase = "idle"; // idle | sending | sent | done
  let clearArmed = null;
  let sse = null;
  let quietTimer = null; // fires the "/annotate pull" hint when a Send gets no reaction

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  const H = { "Content-Type": "application/json", "X-Annot-Token": CFG.token };
  const req = async (method, p, body) => {
    const r = await F(CFG.endpoint + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    const url = pageUrl(); // not when the timer fires: an SPA navigation may happen in between
    saveTimer = setTimeout(async () => {
      try {
        const r = await req("PUT", "/state", { url, shapes, notes });
        if (r.totals) { totals = r.totals; renderToolbar(); }
      } catch { setLink("off"); }
    }, 120);
  };

  // ---------------------------------------------------------------------------
  // DOM scaffold
  // ---------------------------------------------------------------------------
  let spotEl = null, freshId = null;
  let host, root, docLayer, svg, shapesG, draftG, pinsLayer, chrome, bar, popover, toasts, ticker, rim;

  const CSS = `

/* Tokens: same palette as Peter's summary extension (stone/zinc, black-or-white accent, sage + gold) */
:host {
  --bg: #fafaf9; --card: #fff; --fg: #1c1917; --secondary: #666; --tertiary: #707077; --line: #e7e5e4;
  --glass: rgba(255,255,255,.86); --accent: #1c1917; --on-accent: #fafaf9;
  --go: #3d6b52; --on-go: #fff; --stop: #dc2626; --warn: #9a7a45;
  --shadow: 0 0 0 1px rgba(0,0,0,.08), 0 16px 48px -16px rgba(0,0,0,.22);
  --font: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --ease: cubic-bezier(.32,.72,0,1); --jelly: cubic-bezier(.34,1.56,.64,1);
}
/* Dark is the default (Peter, 2026-11-13) */
:host {
  --bg: #1c1917; --card: #1c1c1f; --fg: #f5f5f4; --secondary: #a1a1a8; --tertiary: #a3a3a3; --line: #44403c;
  --glass: rgba(28,28,31,.9); --accent: #f5f5f4; --on-accent: #1c1917;
  --go: #6f9a80; --on-go: #0f1a14; --stop: #f87171; --warn: #b39a6c;
  --shadow: 0 0 0 1px #34343a, 0 16px 48px -16px rgba(0,0,0,.7);
}
:host { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; display: block; }
*, *::before, *::after { box-sizing: border-box; }
.doc { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
svg.ink { position: absolute; top: 0; left: 0; display: block; overflow: visible; pointer-events: none; touch-action: none; }
:host(.draw) svg.ink { pointer-events: auto; cursor: var(--cursor, crosshair); }
:host(.draw.t-select) svg.ink { cursor: default; }
svg.ink .hit { stroke: transparent; fill: none; stroke-width: 16; pointer-events: none; }
:host(.draw.t-select) svg.ink .hit { pointer-events: stroke; cursor: grab; }
:host(.draw.t-select) svg.ink rect.hit, :host(.draw.t-select) svg.ink ellipse.hit { pointer-events: all; }
:host(.dragging) svg.ink .hit, :host(.dragging) .pin .dot { cursor: grabbing !important; }
:host(.draw.t-select) svg.ink g.shape:hover .halo { stroke: color-mix(in srgb, var(--fg) 55%, transparent); }
svg.ink g.shape.selected .halo { stroke: var(--fg); stroke-dasharray: 6 5; stroke-width: 7; }
svg.ink .halo { fill: none; stroke: color-mix(in srgb, var(--bg) 42%, transparent); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
svg.ink .line { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
svg.ink .head { stroke: color-mix(in srgb, var(--bg) 42%, transparent); stroke-width: 2; stroke-linejoin: round; }
svg.ink g.draft { opacity: .9; }
:host(.capturing) svg.ink .hit, :host(.capturing) .chrome, :host(.capturing) .pop, :host(.capturing) g.shape.selected .halo { display: none !important; }
:host(.capturing) .pin .tag { white-space: normal; width: max-content; max-width: 260px; border-radius: 12px; }
:host(.capturing) .pin .dot { animation: none; }

.pins { position: absolute; top: 0; left: 0; pointer-events: none; }
.pin { position: absolute; width: 0; height: 0; pointer-events: none; }
.pin .dot {
  pointer-events: auto; position: absolute; left: -15px; top: -15px; width: 30px; height: 30px; border-radius: 999px;
  display: grid; place-items: center; cursor: grab; border: 0; padding: 0; touch-action: none;
  background: var(--ink); color: var(--ink-dark);
  font: 700 13px/1 var(--font); font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2.5px var(--glass), 0 6px 16px -8px rgba(0,0,0,.35);
  transition: transform .15s var(--ease);
  animation: pop .3s var(--jelly) both;
}
.pin .dot:hover { transform: scale(1.1); }
.pin .dot:active { transform: scale(.94); }
.pin .dot:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.pin .ring { position: absolute; left: -19px; top: -19px; width: 38px; height: 38px; border-radius: 999px; border: 2px solid transparent; border-top-color: var(--ink); opacity: 0; pointer-events: none; }
.pin.working .ring { opacity: 1; animation: spin 1s linear infinite; }
.pin.working .dot { animation: pulse 1.4s ease-in-out infinite; }
.pin.done .dot { background: var(--go); color: var(--on-go); }
.pin.done .dot .n { display: none; }
.pin.done .dot .ic { display: block; }
.pin .dot .ic { display: none; }
.pin.skipped .dot { background: var(--tertiary); color: var(--fg); }
.pin.pending .dot { box-shadow: 0 0 0 2.5px var(--glass), 0 0 0 5px var(--ink-soft), 0 6px 16px -8px rgba(0,0,0,.35); }
.pin .tag {
  position: absolute; left: 20px; top: -13px; max-width: 220px; padding: 5px 10px 6px; border-radius: 999px;
  background: var(--glass); color: var(--fg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
  font: 500 12.5px/1.25 var(--font); letter-spacing: .005em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: auto; cursor: pointer;
  animation: slide .3s var(--ease) both;
}
.pin.done .tag .txt { text-decoration: line-through; color: color-mix(in srgb, var(--fg) 55%, transparent); }
.pin.skipped .tag .txt { color: color-mix(in srgb, var(--fg) 60%, transparent); }
.pin .tag .res { display: block; color: var(--go); margin-top: 3px; font-size: 11.5px; }
.pin.skipped .tag .res { color: var(--secondary); }
.pin .tag .res:empty { display: none; }
.pin:has(.res:not(:empty)) .tag { white-space: normal; width: max-content; max-width: 260px; border-radius: 12px; padding: 7px 11px 8px; top: -15px; }

.chrome { position: fixed; inset: 0; pointer-events: none; color: var(--fg); font-family: var(--font); font-size: 13px; }
.chrome > * { pointer-events: auto; }
.rim { pointer-events: none; position: fixed; inset: 0; box-shadow: inset 0 0 0 3px var(--ink); opacity: 0; }
.rim.flash { animation: rimflash .7s var(--ease) both; }

.bar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 2px; padding: 6px; border-radius: 999px;
  background: var(--glass); backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: var(--shadow);
  animation: rise .35s var(--ease) both; user-select: none; -webkit-user-select: none;
}
.bar { width: max-content; } /* left: 50% would otherwise give it half the viewport and squeeze the buttons */
.bar > * { flex-shrink: 0; }
.bar.dragging { transition: none; }
.bar .grip { color: color-mix(in srgb, var(--fg) 35%, transparent); cursor: grab; padding: 0 2px 0 4px; display: grid; place-items: center; }
.bar .grip:active { cursor: grabbing; }
.sep { width: 1px; height: 22px; background: color-mix(in srgb, var(--fg) 8%, transparent); margin: 0 4px; }
.tb {
  position: relative; width: 36px; height: 36px; border-radius: 999px; border: 0; padding: 0; display: grid; place-items: center;
  background: transparent; color: color-mix(in srgb, var(--fg) 72%, transparent); cursor: pointer;
  transition: background .15s var(--ease), color .15s, transform .15s, box-shadow .15s;
}
.tb:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
.tb:active { transform: scale(.94); }
.tb:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
.tb.on { background: color-mix(in srgb, var(--fg) 16%, transparent); color: var(--fg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 30%, transparent); }
.tb .kbd { position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translate(-50%, 4px); opacity: 0; pointer-events: none;
  padding: 4px 8px; border-radius: 8px; background: var(--glass); color: var(--fg); font-size: 11.5px; font-weight: 600; white-space: nowrap;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--fg) 8%, transparent); transition: opacity .15s, transform .15s var(--ease); }
.tb .kbd b { color: color-mix(in srgb, var(--fg) 50%, transparent); font-weight: 600; margin-left: 6px; }
.tb:hover .kbd, .tb:focus-visible .kbd { opacity: 1; transform: translate(-50%, 0); transition-delay: .35s; }
.mode { position: relative; }
.mode .st { position: absolute; right: 6px; top: 6px; width: 7px; height: 7px; border-radius: 999px; background: var(--tertiary); box-shadow: 0 0 0 2px var(--glass); }
.mode.on .st, .mode .st { transition: background .3s; }
:host(.link-on) .mode .st { background: var(--go); }
:host(.link-connecting) .mode .st { background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
:host(.link-off) .mode .st { background: var(--stop); }
:host(.browse) .mode { background: color-mix(in srgb, var(--fg) 12%, transparent); color: var(--fg); }

.inks { display: flex; gap: 9px; padding: 0 8px; }
.inkb { width: 22px; height: 22px; border-radius: 999px; border: 0; padding: 0; cursor: pointer; background: var(--c);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 35%, transparent), 0 0 0 2px transparent; transition: transform .15s var(--ease), box-shadow .15s; }
.inkb:hover { transform: scale(1.12); }
.inkb:active { transform: scale(.94); }
.inkb.on { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 35%, transparent), 0 0 0 2px var(--glass), 0 0 0 3.5px var(--c); }
.inkb:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

.send {
  height: 36px; padding: 0 14px; margin-left: 2px; border: 0; border-radius: 999px; display: flex; align-items: center; gap: 8px;
  background: var(--accent); color: var(--on-accent); cursor: pointer; font: 600 13px/1 inherit; font-family: inherit; letter-spacing: .005em;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 35%, transparent); transition: transform .15s var(--ease), filter .15s, background .3s, color .3s;
}
.send:hover { filter: brightness(1.06); }
.send:active { transform: scale(.96); }
.send:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.send:disabled { cursor: default; filter: saturate(.6); opacity: .85; }
.send:has(.cnt):not(.sending, .sent) { padding-right: 6px; } /* tight against the count bubble, which sending/sent hide */
.send .cnt { min-width: 24px; height: 24px; padding: 0 7px; border-radius: 999px; display: grid; place-items: center; background: var(--on-accent); color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; transition: transform .2s var(--jelly); }
.send .cnt.bump { animation: bump .35s var(--jelly); }
.send .cnt .ic { display: none; }
.send .live { width: 8px; height: 8px; border-radius: 999px; background: var(--on-accent); display: none; }
.send.sending .live, .send.sent .live { display: block; animation: pulse 1.2s ease-in-out infinite; }
.send.sending .cnt, .send.sent .cnt { display: none; }
.send.done { background: var(--go); color: var(--on-go); }
.send.done .cnt { background: var(--on-go); }
.send.done .cnt .ic { display: block; }
.send.done .cnt .num { display: none; }
.danger { color: color-mix(in srgb, var(--fg) 55%, transparent); }
.danger:hover { color: var(--stop); background: color-mix(in srgb, var(--stop) 14%, transparent); }
.danger.armed { width: auto; padding: 0 12px; gap: 6px; display: flex; align-items: center; color: var(--stop); background: color-mix(in srgb, var(--stop) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--stop) 40%, transparent); font-weight: 600; }
.danger.glow { animation: glow 1.6s ease-in-out infinite; color: var(--fg); }

.ticker { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px; white-space: nowrap;
  background: var(--glass); color: color-mix(in srgb, var(--fg) 80%, transparent); font-size: 12px; font-weight: 500; letter-spacing: .01em;
  box-shadow: var(--shadow); opacity: 0; transition: opacity .3s; pointer-events: none; }
.ticker.show { opacity: 1; }
.ticker .mono { font-family: var(--mono); font-size: 11.5px; color: var(--fg); }

.toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.toast { max-width: min(560px, 90vw); padding: 10px 14px 11px; border-radius: 14px; background: var(--glass); color: var(--fg); font-size: 13px; line-height: 1.35; font-weight: 500;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow);
  animation: drop .35s var(--ease) both; display: flex; gap: 10px; align-items: flex-start; }
.toast.out { animation: lift .25s var(--ease) both; }
.toast .ic { flex: none; margin-top: 1px; color: var(--ink); }
.toast.ok .ic { color: var(--go); }

.pop { position: fixed; width: min(292px, calc(100vw - 24px)); padding: 10px 10px 8px; border-radius: 14px; background: var(--glass); color: var(--fg);
  backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: var(--shadow);
  transform-origin: var(--ox, 0) var(--oy, 0); animation: popin .22s var(--jelly) both; }
.pop.hidden { display: none; }
.pop .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
.pop .num { width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center; background: var(--accent); color: var(--on-accent); font-weight: 700; font-size: 12px; }
.pop .title { font-weight: 600; font-size: 12.5px; color: color-mix(in srgb, var(--fg) 72%, transparent); flex: 1; }
.pop .del { width: 26px; height: 26px; }
.pop textarea { width: 100%; min-height: 60px; max-height: 180px; resize: none; border: 0; outline: 0; border-radius: 9px; padding: 9px 10px; margin: 0;
  background: color-mix(in srgb, var(--fg) 6%, transparent); color: var(--fg); font: 500 13.5px/1.4 var(--font); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 8%, transparent); transition: box-shadow .15s; }
.pop textarea:focus { box-shadow: inset 0 0 0 1.5px var(--ink); }
.pop textarea::placeholder { color: color-mix(in srgb, var(--fg) 40%, transparent); }
.pop .hint { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; padding: 0 2px; font-size: 10.5px; color: color-mix(in srgb, var(--fg) 45%, transparent); font-weight: 500; white-space: nowrap; }
.pop .hint kbd { font: inherit; color: color-mix(in srgb, var(--fg) 70%, transparent); }
.pop .ok { height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: var(--accent); color: var(--on-accent); font: 600 12px/1 inherit; font-family: inherit; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: transform .15s, filter .15s; }
.pop .ok:hover { filter: brightness(1.06); }
.pop .ok:active { transform: scale(.96); }

.sel { position: absolute; pointer-events: none; }
.sel .del { position: absolute; right: -14px; top: -44px; width: 28px; height: 28px; border-radius: 999px; border: 0; padding: 0; display: grid; place-items: center; cursor: pointer; pointer-events: auto;
  background: var(--glass); color: var(--stop); box-shadow: var(--shadow); animation: pop .2s var(--jelly) both; }
.sel .del:hover { background: color-mix(in srgb, var(--stop) 20%, transparent); }
.sel .hdl { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 999px; background: var(--card); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bg) 60%, transparent), 0 2px 6px rgba(0,0,0,.4); pointer-events: auto; cursor: move; }
.sel .hdl.nw, .sel .hdl.se { cursor: nwse-resize; }
.sel .hdl.ne, .sel .hdl.sw { cursor: nesw-resize; }

@keyframes pop { from { transform: scale(.4); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes slide { from { transform: translateX(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes rise { from { transform: translate(-50%, 12px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
@keyframes drop { from { transform: translateY(-10px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes lift { to { transform: translateY(-8px); opacity: 0; } }
@keyframes popin { from { transform: scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
@keyframes rimflash { 0% { opacity: 0; } 20% { opacity: .9; } 100% { opacity: 0; } }
@keyframes glow { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--stop) 0%, transparent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--stop) 35%, transparent); } }
@keyframes wiggle { 0% { transform: none; } 30% { transform: translateY(-6px) scale(1.12); } 60% { transform: translateY(0) scale(.96); } 100% { transform: none; } }
.pin .dot.wiggle { animation: wiggle .5s var(--jelly) both; }
@keyframes riseN { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }
/* Narrow windows: the bar wraps into rows, centred and inside the viewport. Keep 720 in sync with NARROW. */
@media (max-width: 720px) {
  .bar { left: 8px; right: 8px; bottom: 8px; width: fit-content; max-width: calc(100vw - 16px); margin: 0 auto; transform: none; animation-name: riseN;
    flex-wrap: wrap; justify-content: center; row-gap: 4px; border-radius: 24px; }
  .bar .grip, .bar .sep { display: none; }
  .ticker { bottom: 108px; max-width: calc(100vw - 24px); overflow: hidden; text-overflow: ellipsis; }
}

/* Motion: soft "plastic" feel. Strong ease-out, UI under 300ms, transform/opacity only.
   Press = sink 1px + flatten the shadow; release eases back. New pins only animate once. */
:host { --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1); }

/* Plastic surface: faint top highlight, soft bottom shade */
.tb, .send, .pop .ok, .pin .dot, .inkb {
  transition: transform 200ms var(--ease-out), box-shadow 200ms var(--ease-out), background-color 150ms ease, color 150ms ease, filter 150ms ease;
}
.send, .pop .ok {
  background-image: linear-gradient(to bottom, rgba(255,255,255,.14), rgba(255,255,255,0) 60%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 0 rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.18), 0 4px 10px -4px rgba(0,0,0,.25);
}
.pin .dot { box-shadow: inset 0 1px 0 rgba(255,255,255,.28), inset 0 -1.5px 0 rgba(0,0,0,.18), 0 0 0 2px var(--glass), 0 6px 14px -6px rgba(0,0,0,.4); }
.inkb { box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.2); }

/* Press feedback (frequent): quick sink, 120ms */
.tb:active, .inkb:active, .pop .ok:active, .send:active { transform: translateY(1px) scale(.96); transition-duration: 120ms; }
.send:active, .pop .ok:active { box-shadow: inset 0 1px 2px rgba(0,0,0,.25), 0 0 0 rgba(0,0,0,0); filter: brightness(.97); }
.pin .dot:active { transform: translateY(1px) scale(.94); transition-duration: 120ms; }

/* Hover only on real pointers (touch fires false hovers) */
.tb:hover, .inkb:hover, .send:hover { transform: none; }
@media (hover: hover) and (pointer: fine) {
  .inkb:hover { transform: translateY(-1px); }
  .send:hover, .pop .ok:hover { transform: translateY(-1px); filter: brightness(1.04); }
  .pin .dot:hover { transform: translateY(-1px) scale(1.04); }
}

/* Entrances */
.pin .dot, .pin .tag { animation: none; }
.pin.new .dot { animation: pinIn 220ms var(--ease-out) both; }
.pin.new .tag { animation: tagIn 240ms var(--ease-out) 40ms both; }
@keyframes pinIn { from { transform: translateY(4px) scale(.9); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes tagIn { from { transform: translateX(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
.pop { animation: popIn 180ms var(--ease-out) both; }
@keyframes popIn { from { transform: scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }
.pop textarea { transition: box-shadow 150ms ease, background-color 150ms ease; }
.pop textarea:focus { box-shadow: inset 0 0 0 1.5px var(--fg); }
.bar { animation-duration: 280ms; animation-timing-function: var(--ease-out); }
.send .cnt.bump { animation: bump 260ms var(--ease-out); }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.18); } 100% { transform: scale(1); } }
/* Claude finished a note: rare, so a small celebration is allowed */
.pin .dot.wiggle { animation: doneIn 420ms var(--ease-out) both; }
@keyframes doneIn { 0% { transform: scale(1); } 35% { transform: translateY(-3px) scale(1.12); } 100% { transform: none; } }

/* Toasts: transitions, so a quick second toast retargets instead of restarting */
.toast { animation: none; transition: transform 240ms var(--ease-out), opacity 240ms var(--ease-out); }
@starting-style { .toast { transform: translateY(-8px); opacity: 0; } }
.toast.out { animation: none; transform: translateY(-8px); opacity: 0; transition-duration: 200ms; }

.bar, .pop, .toast { backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%); }
.inkb { outline: 1px solid color-mix(in srgb, var(--fg) 22%, transparent); outline-offset: 0; }

/* Minimal surfaces, matched to the summary extension panel (Peter, 2026-11-13):
   solid dark card, 1px hairline border, one bold thing at most, regular-weight labels,
   outline buttons, generous padding. No gloss, no white fills. */
:host { --surface: #1c1c1f; --hair: #34343a; --hair-strong: #45454d; --label: #a1a1a8; --faint: #707077; --r-card: 14px; --r-ctl: 8px; }
.pop, .bar, .toast, .pin .tag, .ticker, .sel .del {
  background: var(--surface); backdrop-filter: none; -webkit-backdrop-filter: none;
  border: 1px solid var(--hair); box-shadow: 0 16px 40px -16px rgba(0,0,0,.6);
}
/* Popover */
.pop { width: min(320px, calc(100vw - 24px)); padding: 16px; border-radius: var(--r-card); }
.pop .head { gap: 10px; margin: 0 0 12px; }
.pop .num { width: auto; height: auto; min-width: 22px; padding: 2px 7px; border-radius: 6px; background: transparent; color: var(--label);
  box-shadow: inset 0 0 0 1px var(--hair-strong); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.pop .title { font-size: 13.5px; font-weight: 500; color: var(--fg); letter-spacing: -.005em; }
.pop .del { width: 28px; height: 28px; border-radius: var(--r-ctl); color: var(--faint); }
.pop textarea { min-height: 72px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.03);
  box-shadow: inset 0 0 0 1px var(--hair); font: 400 14px/1.55 var(--font); color: var(--fg); }
.pop textarea:focus { box-shadow: inset 0 0 0 1px var(--hair-strong); background: rgba(255,255,255,.05); }
.pop textarea::placeholder { color: var(--faint); }
.pop .hint { margin-top: 12px; padding: 0; font-size: 11.5px; font-weight: 400; color: var(--faint); letter-spacing: .01em; }
.pop .hint kbd { color: var(--label); }
.pop .ok, .send {
  background: transparent; background-image: none; color: var(--fg); border: 1px solid var(--hair-strong);
  box-shadow: none; border-radius: var(--r-ctl); font-weight: 500;
}
.pop .ok { height: 30px; padding: 0 12px; font-size: 13px; gap: 6px; }
.pop .ok:active, .send:active { box-shadow: none; filter: none; background: rgba(255,255,255,.06); }
@media (hover: hover) and (pointer: fine) {
  .pop .ok:hover, .send:not(:disabled):hover { transform: none; filter: none; background: rgba(255,255,255,.06); }
}
/* Toolbar */
.bar { padding: 6px; gap: 2px; border-radius: var(--r-card); }
.tb { width: 34px; height: 34px; border-radius: var(--r-ctl); color: var(--label); }
.tb.on { background: rgba(255,255,255,.08); color: var(--fg); box-shadow: none; }
.sep { background: var(--hair); height: 20px; }
.send { height: 34px; padding: 0 14px; font-size: 13px; margin-left: 4px; }
.send:disabled { opacity: .45; filter: none; }
.send .cnt { min-width: 20px; height: 20px; padding: 0 6px; background: rgba(255,255,255,.1); color: var(--fg); font-weight: 500; font-size: 11.5px; }
.send.done { background: transparent; color: var(--go); border-color: color-mix(in srgb, var(--go) 50%, transparent); }
.send.done .cnt { background: color-mix(in srgb, var(--go) 18%, transparent); color: var(--go); }
.tb .kbd { background: var(--surface); border: 1px solid var(--hair); box-shadow: none; font-weight: 500; color: var(--fg); border-radius: 6px; }
.tb .kbd b { font-weight: 400; color: var(--faint); }
/* Pins */
.pin .dot { width: 26px; height: 26px; left: -13px; top: -13px; font-size: 12px; font-weight: 600;
  box-shadow: 0 0 0 2px var(--surface), 0 4px 10px -4px rgba(0,0,0,.5); }
.pin .tag { left: 18px; top: -12px; padding: 4px 10px; border-radius: var(--r-ctl); font-size: 12.5px; font-weight: 400; color: var(--fg); }
.pin.done .tag .txt { color: var(--faint); }
.pin .tag .res { color: var(--go); font-size: 12px; margin-top: 4px; }
:host(.capturing) .pin .tag, .pin:has(.res:not(:empty)) .tag { border-radius: 10px; padding: 8px 12px; }
/* Toasts + ticker */
.toast { padding: 12px 16px; border-radius: 12px; font-size: 13.5px; font-weight: 400; line-height: 1.5; }
.ticker { border-radius: var(--r-ctl); font-weight: 400; color: var(--label); }
/* Pins: quiet neutral chips, hairline border, label only on hover (Peter, 2026-11-13) */
.pin .dot { background: var(--surface); color: var(--fg); box-shadow: 0 0 0 1px var(--hair-strong), 0 2px 8px -2px rgba(0,0,0,.35); }
.pin.done .dot { background: var(--surface); color: var(--go); box-shadow: 0 0 0 1px color-mix(in srgb, var(--go) 55%, transparent), 0 2px 8px -2px rgba(0,0,0,.35); }
.pin.skipped .dot { background: var(--surface); color: var(--faint); }
.pin.pending .dot { box-shadow: 0 0 0 1px var(--fg), 0 2px 8px -2px rgba(0,0,0,.35); }
.pin .tag { opacity: 0; visibility: hidden; transform: translateX(-4px); transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out), visibility 0s linear 150ms; }
.pin.new .tag { animation: none; }
.pin:hover .tag, .pin:focus-within .tag, :host(.capturing) .pin .tag { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }
.pin:has(.txt:empty):not(:has(.res:not(:empty))) .tag { display: none; }
/* Marks are always clickable: hover shows it, click selects, ⌫ or × deletes */
svg.ink .hit { pointer-events: stroke; cursor: pointer; }
:host(.dragging) svg.ink .hit { cursor: grabbing; }
svg.ink g.shape:hover .halo { stroke: rgba(255,255,255,.55); }
.sel .del { width: 30px; height: 30px; color: var(--fg); }
.sel .del:hover { color: var(--stop); }
/* Reference images in a note */
.pop .refs { display: none; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.pop .ref { position: relative; width: 52px; height: 52px; border-radius: var(--r-ctl); overflow: hidden; box-shadow: inset 0 0 0 1px var(--hair); background: rgba(255,255,255,.03); }
.pop .ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pop .ref .ph { display: grid; place-items: center; height: 100%; font-size: 11px; color: var(--faint); }
.pop .ref button { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border: 0; padding: 0; border-radius: 999px; display: grid; place-items: center;
  background: rgba(0,0,0,.65); color: #fff; cursor: pointer; opacity: 0; transition: opacity 150ms ease; }
.pop .ref:hover button, .pop .ref button:focus-visible { opacity: 1; }
/* Open / close: the popup grows out of its pin and folds back into it.
   Enter 200ms, exit 160ms, strong ease-out, a touch of blur so it reads as a material arriving/leaving. */
.pop { animation: popIn 200ms var(--ease-out) both; }
@keyframes popIn { from { opacity: 0; transform: scale(.94); filter: blur(3px); } to { opacity: 1; transform: none; filter: none; } }
.pop.closing { animation: popOut 160ms var(--ease-out) forwards; pointer-events: none; }
@keyframes popOut { from { opacity: 1; transform: none; filter: none; } to { opacity: 0; transform: scale(.94); filter: blur(2px); } }
/* Saved: the pin takes the note in, a soft ring spreads once */
.pin .dot.absorb { animation: absorb 200ms var(--ease-out); }
@keyframes absorb { 0% { transform: scale(1); } 40% { transform: scale(1.06); } 100% { transform: scale(1); } }
/* Removing a pin, a mark or a selection box */
.pin.leaving .dot { transition: transform 150ms var(--ease-out), opacity 150ms var(--ease-out); transform: scale(.9); opacity: 0; }
.pin.leaving .tag, .sel.leaving { transition: opacity 120ms ease; opacity: 0; }
svg.ink g.shape { transition: opacity 160ms var(--ease-out); }
svg.ink g.shape.leaving { opacity: 0; }
/* Popover motion (Emil Kowalski rules): anchored to the pin (origin = pin centre, set in placePopover),
   scale .96 + opacity only, never from 0. Enter 180ms, exit 140ms, both strong ease-out, same path back. */
:host(.pop-open) .pin .tag { display: none; }
.pop { transform-origin: var(--ox, 0) var(--oy, 0); animation: popEnter 180ms var(--ease-out) both; }
@keyframes popEnter { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
.pop.closing { animation: popExit 140ms var(--ease-out) forwards; pointer-events: none; }
@keyframes popExit { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(.96); } }
/* No header: just the text box, then hints + delete + Save */
.pop .acts { display: flex; align-items: center; gap: 6px; }
.pop .acts .del { width: 30px; height: 30px; border-radius: var(--r-ctl); color: var(--faint); }
@media (hover: hover) and (pointer: fine) { .pop .acts .del:hover { color: var(--stop); background: rgba(255,255,255,.04); } }
/* Ink brush + spotlight area (Peter, 2026-11-14): subtle, artistic, one moment of glow */
svg.ink .brush { filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
svg.ink g.draft .brush { filter: drop-shadow(0 0 6px rgba(156,195,169,.55)) drop-shadow(0 1px 1.5px rgba(0,0,0,.3)); }
svg.ink g.shape.fresh .brush { animation: inkSettle 520ms var(--ease-out) both; }
@keyframes inkSettle {
  from { filter: drop-shadow(0 0 7px rgba(156,195,169,.6)) drop-shadow(0 1px 1.5px rgba(0,0,0,.3)); }
  to { filter: drop-shadow(0 0 0 rgba(156,195,169,0)) drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
}
svg.ink g.pen .halo, svg.ink g.rect .halo { stroke: transparent; }
svg.ink g.pen .halo { stroke-width: 12; }
svg.ink .area { fill: none; stroke-width: 1.6; stroke-dasharray: 1; stroke-dashoffset: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
svg.ink g.shape.fresh .area { animation: areaDraw 560ms var(--ease-out) both; }
@keyframes areaDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
svg.ink .area-fill { fill: rgba(214,189,142,.045); stroke: none; }
svg.ink .spotdim { fill: rgba(8,8,10,.42); fill-rule: evenodd; opacity: 0; transition: opacity 240ms var(--ease-out); pointer-events: none; }
svg.ink .spotdim.on { opacity: 1; }
:host(.capturing) svg.ink .spotdim { display: none; }
/* Before / after review (Peter, 2026-11-14) */
.review { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(8,8,10,.55);
  pointer-events: auto; font-family: var(--font); color: var(--fg); animation: rvIn 200ms var(--ease-out) both; }
.review.out { animation: rvOut 160ms var(--ease-out) forwards; }
@keyframes rvIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes rvOut { to { opacity: 0; } }
.rv-sheet { width: min(780px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: var(--surface);
  border: 1px solid var(--hair); border-radius: 16px; box-shadow: 0 24px 64px -24px rgba(0,0,0,.8); overflow: hidden;
  animation: rvSheet 220ms var(--ease-out) both; }
@keyframes rvSheet { from { opacity: 0; transform: scale(.97) translateY(6px); } to { opacity: 1; transform: none; } }
.rv-head { padding: 18px 20px 14px; border-bottom: 1px solid var(--hair); }
.rv-title { font-size: 15px; font-weight: 500; color: var(--go); }
.rv-sum { margin-top: 6px; font-size: 13.5px; line-height: 1.5; color: var(--label); }
.rv-body { overflow: auto; padding: 16px 20px; display: grid; gap: 22px; }
.rv-note { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px; font-size: 13.5px; line-height: 1.45; }
.rv-n { flex: none; min-width: 22px; padding: 1px 6px; border-radius: 6px; text-align: center; font-size: 12px; font-weight: 500; color: var(--label); box-shadow: inset 0 0 0 1px var(--hair-strong); }
.rv-t { color: var(--fg); }
.rv-r { margin-top: 2px; font-size: 12.5px; color: var(--go); }
.rv-r.skip { color: var(--warn); }
.cmp { position: relative; border-radius: 10px; overflow: hidden; background: #111113; box-shadow: inset 0 0 0 1px var(--hair); min-height: 120px; }
.cmp img { display: block; width: 100%; height: auto; opacity: 0; transition: opacity 220ms var(--ease-out); user-select: none; -webkit-user-drag: none; }
.cmp.ready img { opacity: 1; }
.cmp img.a { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--pos)); }
.cmp .bar-h { position: absolute; top: 0; bottom: 0; left: var(--pos); width: 2px; margin-left: -1px; background: linear-gradient(#9cc3a9, #d6bd8e); box-shadow: 0 0 0 1px rgba(0,0,0,.25); pointer-events: none; opacity: 0; transition: opacity 200ms; }
.cmp.ready .bar-h { opacity: 1; }
.cmp .knob { position: absolute; top: 50%; left: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; background: var(--surface); border: 1px solid var(--hair-strong); box-shadow: 0 4px 12px -4px rgba(0,0,0,.6); }
.cmp .knob::before, .cmp .knob::after { content: ""; position: absolute; top: 50%; width: 5px; height: 5px; margin-top: -3px; border: solid var(--label); border-width: 0 0 1.5px 1.5px; }
.cmp .knob::before { left: 7px; transform: rotate(45deg); }
.cmp .knob::after { right: 7px; transform: rotate(-135deg); }
.cmp .tag-b, .cmp .tag-a { position: absolute; top: 10px; padding: 3px 8px; border-radius: 6px; font-size: 11.5px; color: var(--fg); background: rgba(28,28,31,.82); border: 1px solid var(--hair); pointer-events: none; }
.cmp .tag-b { left: 10px; } .cmp .tag-a { right: 10px; }
.cmp input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; }
.cmp.missing::after { content: "No after picture for this spot"; position: absolute; inset: 0; display: grid; place-items: center; font-size: 12.5px; color: var(--faint); }
.rv-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--hair); }
.rv-foot button { height: 34px; padding: 0 14px; border-radius: var(--r-ctl); font: 500 13px var(--font); cursor: pointer; transition: background-color 150ms, transform 120ms var(--ease-out); }
.rv-more { background: transparent; color: var(--fg); border: 1px solid var(--hair-strong); }
.rv-close { background: var(--fg); color: #1c1917; border: 1px solid var(--fg); }
.rv-foot button:active { transform: scale(.97); }
.rv-foot button:disabled { opacity: .6; cursor: default; }
@media (hover: hover) and (pointer: fine) { .rv-more:hover { background: rgba(255,255,255,.06); } .rv-close:hover { background: #fff; } }
:host(.capturing) .review { display: none !important; }
/* Reduced motion: keep fades, drop movement */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-property: opacity, background-color, color, box-shadow !important; }
  .pin.new .dot, .pin.new .tag, .pop, .bar, .send .cnt.bump, .pin .dot.wiggle { animation: fadeOnly 150ms ease both !important; }
  .pin.working .ring { animation: none; }
  .toast, .toast.out { transform: none !important; }
  .tb:active, .inkb:active, .pop .ok:active, .send:active, .pin .dot:active { transform: none; }
  .pop.closing { animation: fadeOut 120ms ease forwards !important; }
  .pin .dot.absorb { animation: none !important; }
  svg.ink g.shape.fresh .brush, svg.ink g.shape.fresh .area { animation: none !important; }
  .rv-sheet { animation: rvIn 160ms ease both !important; }
}
@keyframes fadeOnly { from { opacity: 0; } to { opacity: 1; } }
@keyframes fadeOut { to { opacity: 0; } }
`;

  function mount() {
    if (host) return;
    host = document.createElement("claude-annotate");
    host.setAttribute("data-claude-annotate", "");
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    docLayer = el("div", "doc");
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink");
    // Ink brush gradient (sage → gold, per mark's bounding box) and the spotlight dim layer.
    svg.innerHTML = '<defs><linearGradient id="ca-ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9cc3a9"/><stop offset="1" stop-color="#d6bd8e"/></linearGradient></defs>' +
      '<path class="spotdim"/><g class="shapes"></g><g class="draftg"></g>';
    spotEl = svg.querySelector(".spotdim");
    shapesG = svg.querySelector("g.shapes");
    draftG = svg.querySelector("g.draftg");
    docLayer.appendChild(svg);
    pinsLayer = el("div", "pins");
    docLayer.appendChild(pinsLayer);
    root.appendChild(docLayer);

    chrome = el("div", "chrome");
    rim = el("div", "rim");
    chrome.appendChild(rim);
    toasts = el("div", "toasts");
    toasts.setAttribute("aria-live", "polite");
    chrome.appendChild(toasts);
    ticker = el("div", "ticker");
    ticker.setAttribute("aria-live", "polite");
    chrome.appendChild(ticker);
    popover = el("div", "pop hidden");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Note");
    chrome.appendChild(popover);
    bar = el("div", "bar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Annotate");
    chrome.appendChild(bar);
    root.appendChild(chrome);

    document.documentElement.appendChild(host);
    if (RENDER_ONLY) host.classList.add("capturing");
    applyInk();
    setMode(mode);
    renderToolbar();
    sizeDoc();
    bindEvents();
    restoreBarPos();
    hydrate().finally(() => { api.ready = true; }); // the server screenshots temp pages once ready
    connectSse();
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }



  // ---------------------------------------------------------------------------
  // Sizing / coordinates
  // ---------------------------------------------------------------------------
  function docSize() {
    // Body, not <html>: our own layer is a child of <html> and would hold the old size forever.
    const d = document.documentElement, b = document.body;
    return { w: Math.max(b ? b.scrollWidth : 0, d.clientWidth), h: Math.max(b ? b.scrollHeight : 0, d.clientHeight) };
  }
  let lastSize = { w: 0, h: 0 };
  function sizeDoc() {
    const s = docSize();
    if (s.w === lastSize.w && s.h === lastSize.h) return;
    lastSize = s;
    docLayer.style.width = s.w + "px";
    docLayer.style.height = s.h + "px";
    svg.setAttribute("width", s.w);
    svg.setAttribute("height", s.h);
    svg.setAttribute("viewBox", `0 0 ${s.w} ${s.h}`);
  }
  const toDoc = (e) => [Math.round(e.clientX + scrollX), Math.round(e.clientY + scrollY)];

  // ---------------------------------------------------------------------------
  // Element context (what is under a point)
  // ---------------------------------------------------------------------------
  function elementAt(x, y) {
    host.style.visibility = "hidden"; // takes the host out of hit testing
    const e = document.elementFromPoint(clamp(x - scrollX, 0, innerWidth - 1), clamp(y - scrollY, 0, innerHeight - 1));
    host.style.visibility = "";
    return !e || e === document.documentElement ? null : e;
  }
  function shortSel(e) {
    if (!e || e.nodeType !== 1) return "";
    let s = e.tagName.toLowerCase();
    if (e.id) return `${s}#${e.id}`;
    const cls = [...e.classList].filter((c) => !/^(css-|sc-|_)/.test(c) && c.length < 40).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const role = e.getAttribute("role");
    if (role) s += `[role=${role}]`;
    const dt = e.getAttribute("data-testid");
    if (dt) s += `[data-testid=${dt}]`;
    return s;
  }
  function reactInfo(e) {
    const out = { components: [], source: null };
    try {
      let node = e, fiber = null;
      for (let i = 0; i < 6 && node && !fiber; i++) {
        const k = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
        if (k) fiber = node[k];
        else node = node.parentElement;
      }
      if (!fiber) return out;
      const isLibFile = (file) => /node_modules|\/@(?!fs\/)|react-dom|react-refresh|chunk-|\.vite\//.test(file);
      // ponytail: React 19 line numbers are post-transform (esbuild-shifted under Vite, chunk
      // offsets under Turbopack). The file is right, the line is a hint. React 18 is exact.
      // Where this fiber was created: React <19 keeps _debugSource, React 19 keeps the
      // owner stack. Returns { src, user } with src like "src/App.tsx:12".
      const callSite = (f) => {
        if (f._debugSource && f._debugSource.fileName) {
          const file = f._debugSource.fileName;
          return { src: `${relPath(file)}:${f._debugSource.lineNumber}`, user: !isLibFile(file) };
        }
        const st = f._debugStack;
        const stack = typeof st === "string" ? st : st && st.stack;
        if (!stack) return null;
        const frames = [...stack.matchAll(/\(?((?:https?:\/\/[^\s)]+?)|(?:\/[^\s)]+?)):(\d+):(\d+)\)?/g)].map((x) => ({ file: x[1], line: x[2] }));
        const user = frames.find((fr) => !isLibFile(fr.file));
        if (user) return { src: `${relPath(user.file)}:${user.line}`, user: true };
        return frames.length ? { src: null, user: false } : null;
      };
      const nameOf = (t) => (typeof t === "function" ? (t.displayName || t.name) : t && typeof t === "object" ? (t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name))) : null) || null;
      const NOISE = /Slot|Collection|Provider|Consumer|Context|Impl$|^Primitive|Presence|Portal|FocusScope|Dismissable|RovingFocus|^Fragment$|^Suspense$|^StrictMode$|^Profiler$|^Root$/;
      let f = fiber;
      for (let depth = 0; f && depth < 80; depth++, f = f.return) {
        const name = nameOf(f.type);
        const site = callSite(f);
        if (!out.source && site && site.user) out.source = site.src;
        if (name && !name.startsWith("_") && !NOISE.test(name) && out.components.length < 5 && !out.components.includes(name)) {
          // Keep components that appear in the user's own JSX (or whose origin is unknown).
          if (!site || site.user) out.components.push(name);
        }
        if (out.components.length >= 5 && out.source) break;
      }
    } catch { /* not react */ }
    return out;
  }
  function relPath(p) {
    if (!/^https?:/.test(p)) return p.replace(/^\/\.\//, ""); // FS path (React 18) or webpack-internal "/./app/page.tsx"
    try { p = new URL(p).pathname; } catch { return p; } // Vite: drop origin and ?t=
    return p.startsWith("/@fs/") ? p.slice(4) : p.replace(/^\//, ""); // /@fs/abs → /abs, /src/x.tsx → src/x.tsx
  }

  function describe(e) {
    if (!e || e === document.body || e === document.documentElement) return null;
    const r = e.getBoundingClientRect();
    const text = (e.innerText || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
    const chain = [];
    let p = e.parentElement;
    while (p && p !== document.body && chain.length < 3) { chain.unshift(shortSel(p)); p = p.parentElement; }
    return {
      selector: shortSel(e), text,
      rect: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
      chain: chain.join(" > "), react: reactInfo(e),
    };
  }
  function ctxAtPoint(x, y) { return describe(elementAt(x, y)); }
  function ctxForBox(x, y, w, h) {
    const c = ctxAtPoint(x + w / 2, y + h / 2);
    const inside = [];
    try {
      const hasOwnText = (n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      const cands = [];
      for (const n of document.body.querySelectorAll("*")) {
        if (n.closest("svg")) continue;
        const interactive = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|IMG|LABEL)$/.test(n.tagName) || n.getAttribute("role") === "button";
        if (!interactive && !hasOwnText(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const nx = r.left + scrollX, ny = r.top + scrollY;
        if (nx >= x - 4 && ny >= y - 4 && nx + r.width <= x + w + 4 && ny + r.height <= y + h + 4) {
          const t = (n.textContent || n.getAttribute("alt") || n.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40);
          const fs = parseFloat(getComputedStyle(n).fontSize) || 0;
          cands.push({ n, t, fs, area: r.width * r.height });
        }
      }
      cands.sort((a, b) => b.fs - a.fs || b.area - a.area);
      const seen = new Set();
      for (const c of cands) {
        const key = `${shortSel(c.n)}|${c.t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inside.push(`<${shortSel(c.n)}>${c.t ? ` "${c.t}"` : ""}`);
        if (inside.length >= 6) break;
      }
    } catch { /* ignore */ }
    if (c) c.inside = inside;
    return c;
  }
  function ctxForShape(s) {
    const b = bbox(s);
    if (s.type === "arrow") return ctxAtPoint(s.x2, s.y2);
    if (s.type === "rect" || s.type === "ellipse") return ctxForBox(b.x, b.y, b.w, b.h);
    return ctxForBox(b.x, b.y, b.w, b.h); // pen: usually a circle around something
  }

  // ---------------------------------------------------------------------------
  // Geometry + rendering of marks
  // ---------------------------------------------------------------------------
  function bbox(s) {
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
  function penPath(pts) {
    if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]}`;
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
    }
    const l = pts[pts.length - 1];
    d += ` L${l[0]} ${l[1]}`;
    return d;
  }
  // Ink brush: a filled outline around the stroke. Fast segments draw thinner, slow ones fuller,
  // and both ends taper, so a quick circle reads like a brush pen rather than a marker.
  function brushPath(raw) {
    if (raw.length < 2) return "";
    const pts = raw.map((p, i) => { // light smoothing so the outline doesn't jitter
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
    const n = pts.length, BASE = 5.2;
    let w = BASE;
    const L = [], R = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const speed = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
      w += (BASE * clamp(1.3 - speed / 18, 0.42, 1.2) - w) * 0.35;
      const taper = Math.min(1, 0.35 + i / 5, 0.25 + (n - 1 - i) / 7);
      const half = (w * taper) / 2;
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      L.push([pts[i][0] - dy * half, pts[i][1] + dx * half]);
      R.push([pts[i][0] + dy * half, pts[i][1] - dx * half]);
    }
    const f = (v) => Math.round(v * 10) / 10;
    const curve = (arr) => {
      let d = "";
      for (let i = 1; i < arr.length - 1; i++) d += ` Q${f(arr[i][0])} ${f(arr[i][1])} ${f((arr[i][0] + arr[i + 1][0]) / 2)} ${f((arr[i][1] + arr[i + 1][1]) / 2)}`;
      const l = arr[arr.length - 1];
      return d + ` L${f(l[0])} ${f(l[1])}`;
    };
    const Rr = R.slice().reverse();
    const capEnd = Math.max(0.6, Math.hypot(L[n - 1][0] - R[n - 1][0], L[n - 1][1] - R[n - 1][1]) / 2);
    const capStart = Math.max(0.6, Math.hypot(L[0][0] - R[0][0], L[0][1] - R[0][1]) / 2);
    return `M${f(L[0][0])} ${f(L[0][1])}${curve(L)} A${f(capEnd)} ${f(capEnd)} 0 0 1 ${f(Rr[0][0])} ${f(Rr[0][1])}${curve(Rr)} A${f(capStart)} ${f(capStart)} 0 0 1 ${f(L[0][0])} ${f(L[0][1])}Z`;
  }
  // Spotlight: while an area is being drawn, or its note is open, the rest of the page dims.
  function roundRectD(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }
  function updateSpot() {
    if (!spotEl) return;
    const box = draft && draft.type === "rect" && draft.w > 2 && draft.h > 2 ? draft
      : popNote && popNote.shapeId ? shapes.find((k) => k.id === popNote.shapeId && k.type === "rect") : null;
    if (box) {
      const W = Math.max(lastSize.w, innerWidth + scrollX), H = Math.max(lastSize.h, innerHeight + scrollY);
      spotEl.setAttribute("d", `M0 0H${W}V${H}H0Z ${roundRectD(box.x, box.y, box.w, box.h, 12)}`);
    }
    spotEl.classList.toggle("on", !!box);
  }
  function arrowParts(s) {
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const size = 15;
    const bx = s.x2 - Math.cos(a) * size * 0.75, by = s.y2 - Math.sin(a) * size * 0.75;
    const p1 = [s.x2 - size * Math.cos(a - 0.5), s.y2 - size * Math.sin(a - 0.5)];
    const p2 = [s.x2 - size * Math.cos(a + 0.5), s.y2 - size * Math.sin(a + 0.5)];
    return { line: `M${s.x1} ${s.y1} L${bx} ${by}`, head: `${s.x2},${s.y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}` };
  }
  function shapeSvg(s, cls = "shape") {
    const hex = (INKS.find((i) => i.id === s.color) || INKS[0]).hex;
    let body = "", hit = "";
    if (s.type === "pen") {
      const d = penPath(s.points);
      body = `<path class="halo" d="${d}"/><path class="brush" fill="url(#ca-ink)" d="${brushPath(s.points)}"/>`;
      hit = `<path class="hit" d="${d}"/>`;
    } else if (s.type === "rect") {
      const a = `x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="12"`;
      body = `<rect class="halo" ${a}/><rect class="area-fill" ${a}/><rect class="area" pathLength="1" stroke="url(#ca-ink)" ${a}/>`;
      hit = `<rect class="hit" ${a}/>`;
    } else if (s.type === "ellipse") {
      const a = `cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}"`;
      body = `<ellipse class="halo" ${a}/><ellipse class="line" stroke="${hex}" ${a}/>`;
      hit = `<ellipse class="hit" ${a}/>`;
    } else if (s.type === "arrow") {
      const { line, head } = arrowParts(s);
      body = `<path class="halo" d="${line}"/><path class="line" stroke="${hex}" d="${line}"/><polygon class="head" fill="${hex}" points="${head}"/>`;
      hit = `<path class="hit" d="M${s.x1} ${s.y1} L${s.x2} ${s.y2}"/>`;
    } else if (s.type === "line") {
      const d = `M${s.x1} ${s.y1} L${s.x2} ${s.y2}`;
      body = `<path class="halo" d="${d}"/><path class="line" stroke="${hex}" d="${d}"/>`;
      hit = `<path class="hit" d="${d}"/>`;
    }
    return `<g class="${cls} ${s.type}${selected === s.id ? " selected" : ""}${freshId === s.id && cls === "shape" ? " fresh" : ""}" data-id="${s.id}">${body}${hit}</g>`;
  }
  function renderInk() {
    shapesG.innerHTML = shapes.map((s) => shapeSvg(s)).join("");
    renderDraft();
    renderSelection();
  }
  function renderDraft() { draftG.innerHTML = draft ? shapeSvg(draft, "draft") : ""; updateSpot(); }
  function renderShape(s) { // one committed shape, while it is being moved
    const g = shapesG.querySelector(`g.shape[data-id="${s.id}"]`);
    if (g) g.outerHTML = shapeSvg(s); else renderInk();
    renderSelection();
  }
  let selBox = null;
  function renderSelection() {
    if (selBox) { selBox.remove(); selBox = null; }
    const s = shapes.find((x) => x.id === selected);
    if (!s) return;
    const b = bbox(s);
    selBox = el("div", "sel");
    selBox.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    const del = el("button", "del", svgIcon("x", 15));
    del.title = "Delete (⌫)";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteSelected(); });
    selBox.appendChild(del);
    for (const [k, hx, hy] of handlesOf(s)) {
      const h = el("span", `hdl ${k}`);
      h.style.left = hx - b.x + "px"; h.style.top = hy - b.y + "px";
      h.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        const [x, y] = toDoc(e);
        drag = { kind: "shape", handle: k, s, orig: JSON.parse(JSON.stringify(s)), x, y, before: snapshot(), moved: false };
        svg.setPointerCapture(e.pointerId); // onMove/onUp on the svg take it from here
      });
      selBox.appendChild(h);
    }
    pinsLayer.appendChild(selBox);
  }

  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------
  function renderPins() {
    const keep = selBox;
    const seen = new Set([...pinsLayer.querySelectorAll(".pin")].map((x) => x.dataset.id));
    pinsLayer.innerHTML = "";
    for (const n of notes) {
      const inkDef = INKS.find((i) => i.id === n.color) || INKS[0];
      const p = el("div", `pin ${n.status || "draft"}${seen.has(n.id) ? "" : " new"}`);
      p.dataset.id = n.id;
      p.style.cssText = `left:${n.x}px;top:${n.y}px;--ink:${inkDef.hex};--ink-dark:${inkDef.dark};--ink-soft:${inkDef.hex}55`;
      p.innerHTML = `<span class="ring"></span><button class="dot" type="button" aria-label="Note ${n.n}"><span class="n">${n.n}</span>${svgIcon("check", 15)}</button><span class="tag" title="${esc(n.text)}">${tagHtml(n)}</span>`;
      pinsLayer.appendChild(p);
    }
    if (keep) pinsLayer.appendChild(keep);
  }
  function tagHtml(n) { return `<span class="txt">${esc(n.text || "")}</span>${n.result ? `<span class="res">${esc(n.result)}</span>` : ""}`; }
  function updatePin(n) {
    const p = pinsLayer.querySelector(`.pin[data-id="${n.id}"]`);
    if (!p) return renderPins();
    p.className = `pin ${n.status || "draft"}`;
    p.querySelector(".tag").innerHTML = tagHtml(n);
  }
  function wigglePins(stagger = 50) {
    [...pinsLayer.querySelectorAll(".pin .dot")].forEach((d, i) => {
      setTimeout(() => { d.classList.remove("wiggle"); void d.offsetWidth; d.classList.add("wiggle"); }, i * stagger);
    });
  }

  // ---------------------------------------------------------------------------
  // Popover (note text)
  // ---------------------------------------------------------------------------
  let popNote = null;
  // The dev server may full-reload the page mid-sentence; keep the open note's text so mount can reopen it.
  const DRAFT_KEY = "claude-annotate:draft";
  const stashDraft = (v) => { try { v ? sessionStorage.setItem(DRAFT_KEY, JSON.stringify(v)) : sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };
  function reopenDraft() {
    let d; try { d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { return; }
    if (!d || d.url !== pageUrl() || popNote) return;
    let note = notes.find((k) => k.id === d.note.id);
    if (!note) { if (!d.isNew) return stashDraft(null); note = d.note; notes.push(note); renderPins(); }
    openPopover(note, d.isNew, d.text);
  }
  function openPopover(note, isNew = false, text = note.text) {
    clearTimeout(closeTimer);
    host.classList.add("pop-open");
    if (popover.classList.contains("closing")) { popover.classList.remove("closing"); popover.style.animation = "none"; void popover.offsetWidth; popover.style.animation = ""; }
    popNote = note;
    updateSpot();
    const inkDef = INKS.find((i) => i.id === note.color) || INKS[0];
    popover.style.setProperty("--ink", inkDef.hex);
    popover.style.setProperty("--ink-dark", inkDef.dark);
    popover.innerHTML = `
      <textarea placeholder="What should change? Paste a link or an image as a reference." rows="2" maxlength="2000"></textarea>
      <div class="refs"></div>
      <div class="hint"><span><kbd>↵</kbd> save · <kbd>⇧↵</kbd> line · <kbd>esc</kbd> ${isNew ? "discard" : "close"}</span><span class="acts"><button class="tb del" type="button" title="Delete note" aria-label="Delete note">${svgIcon("trash", 15)}</button><button class="ok" type="button">${svgIcon("check", 13)} Save</button></span></div>`;
    const ta = popover.querySelector("textarea");
    ta.value = text || "";
    popRefs = Array.isArray(note.refs) ? [...note.refs] : [];
    renderRefs();
    const takeImages = (files) => {
      const imgs = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
      if (!imgs.length) return false;
      for (const f of imgs) attachImage(f);
      return true;
    };
    ta.addEventListener("paste", (e) => { if (e.clipboardData && takeImages(e.clipboardData.files)) e.preventDefault(); });
    ta.addEventListener("dragover", (e) => e.preventDefault());
    ta.addEventListener("drop", (e) => { if (e.dataTransfer && takeImages(e.dataTransfer.files)) e.preventDefault(); });
    popover.classList.remove("hidden");
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(180, ta.scrollHeight) + "px"; };
    ta.addEventListener("input", grow);
    const url = pageUrl();
    ta.addEventListener("input", () => stashDraft({ url, note, isNew, text: ta.value }));
    grow();
    placePopover();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitPopover(); }
      if (e.key === "Escape") { e.preventDefault(); cancelPopover(isNew); }
    });
    popover.querySelector(".ok").addEventListener("click", commitPopover);
    popover.querySelector(".del").addEventListener("click", () => {
      const pinEl = pinsLayer.querySelector(`.pin[data-id="${note.id}"]`);
      const markEl = note.shapeId && note.text ? shapesG.querySelector(`g.shape[data-id="${note.shapeId}"]`) : null;
      closePopover();
      if (markEl) markEl.classList.add("leaving");
      leaveThen(pinEl, () => deleteNote(note.id));
    });
  }
  // Reference images pasted or dropped into a note: uploaded to the local bridge, listed for Claude with the note
  let popRefs = [];
  const refThumbs = new Map(); // ref name -> small data URL, only for showing chips in this tab
  function renderRefs() {
    const box = popover.querySelector(".refs");
    if (!box) return;
    box.innerHTML = popRefs.map((r, i) => `<span class="ref">${refThumbs.has(r) ? `<img src="${refThumbs.get(r)}" alt="">` : `<span class="ph">img</span>`}<button type="button" data-i="${i}" aria-label="Remove image">${svgIcon("x", 11)}</button></span>`).join("")
;
    box.style.display = popRefs.length ? "flex" : "none";
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { popRefs.splice(Number(b.dataset.i), 1); renderRefs(); placePopover(); }));
    placePopover();
  }
  function attachImage(file) {
    if (popRefs.length >= 4) { toast("Up to 4 images per note."); return; }
    if (file.size > 5e6) { toast("That image is over 5 MB."); return; }
    const forNote = popNote;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const { ref } = await req("POST", "/attach", { dataUrl: r.result });
        refThumbs.set(ref, r.result);
        if (popNote === forNote) { popRefs.push(ref); renderRefs(); }
      } catch (e) { toast(`Couldn't attach the image: ${e.message}`); }
    };
    r.readAsDataURL(file);
  }
  function placePopover() {
    if (!popNote || popover.classList.contains("hidden")) return;
    const px = popNote.x - scrollX, py = popNote.y - scrollY;
    const w = popover.offsetWidth || 292, h = popover.offsetHeight || 150;
    let left = px + 24, top = py - 14;
    let ox = "0", oy = "0";
    if (left + w > innerWidth - 12) { left = px - 24 - w; ox = "100%"; }
    const br = bar && bar.getBoundingClientRect();
    const fl = clamp(left, 12, innerWidth - w - 12);
    const under = br && br.width && fl < br.right && fl + w > br.left; // would the popover overlap the toolbar horizontally?
    const floor = under ? Math.min(innerHeight, br.top) - 12 : innerHeight - 12; // keep it above the toolbar
    if (top + h > floor) { top = Math.max(12, py - h + 14); oy = "100%"; }
    const ft = clamp(top, 12, floor - h);
    popover.style.left = fl + "px";
    popover.style.top = ft + "px";
    popover.style.setProperty("--ox", Math.round(px - fl) + "px"); // the pin's centre, in popover coordinates
    popover.style.setProperty("--oy", Math.round(py - ft) + "px");
  }
  function commitPopover() {
    if (!popNote) return;
    const ta = popover.querySelector("textarea");
    const t = (ta.value || "").trim();
    if (!t && !popRefs.length) { deleteNote(popNote.id); closePopover(); return; }
    pushUndo();
    popNote.text = t || "(see attached image)";
    popNote.refs = [...popRefs];
    const savedId = popNote.id;
    closePopover();
    renderPins();
    setTimeout(() => pulsePin(savedId), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100);
    save();
  }
  function cancelPopover(isNew) {
    const n = popNote;
    closePopover();
    if (isNew && n && !n.text) {
      const pinEl = pinsLayer.querySelector(`.pin[data-id="${n.id}"]`);
      setTimeout(() => leaveThen(pinEl, () => deleteNote(n.id, true)), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100);
    }
  }
  function pulsePin(id) {
    const d = pinsLayer.querySelector(`.pin[data-id="${id}"] .dot`);
    if (!d) return;
    d.classList.remove("absorb"); void d.offsetWidth; d.classList.add("absorb");
    setTimeout(() => d.classList.remove("absorb"), 400);
  }
  // Fade an element out before the data change that removes it
  function leaveThen(elm, fn, ms = 160) {
    if (!elm || matchMedia("(prefers-reduced-motion: reduce)").matches) return fn();
    elm.classList.add("leaving");
    setTimeout(fn, ms);
  }
  let closeTimer = null;
  function closePopover() {
    const was = popNote;
    popNote = null;
    updateSpot();
    stashDraft(null);
    if (!popover.classList.contains("hidden") && !popover.classList.contains("closing")) {
      popover.classList.add("closing"); // shrinks back toward its pin (see .pop.closing)
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { popover.classList.add("hidden"); popover.classList.remove("closing"); popover.innerHTML = ""; host.classList.remove("pop-open"); }, 150);
    } else if (popover.classList.contains("hidden")) {
      host.classList.remove("pop-open");
    }
    if (was) { const d = pinsLayer.querySelector(`.pin[data-id="${was.id}"] .dot`); if (d) d.focus({ preventScroll: true }); }
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------
  function snapshot() { return JSON.stringify({ shapes, notes }); }
  function pushUndo() { undo.push(snapshot()); if (undo.length > 60) undo.shift(); redo.length = 0; renderToolbar(); }
  function restore(json) { const s = JSON.parse(json); shapes = s.shapes; notes = s.notes; selected = null; renderInk(); renderPins(); save(); renderToolbar(); }
  function doUndo() { if (!undo.length) return; redo.push(snapshot()); restore(undo.pop()); }
  function doRedo() { if (!redo.length) return; undo.push(snapshot()); restore(redo.pop()); }
  function addShape(s) {
    pushUndo(); s.ctx = ctxForShape(s); shapes.push(s);
    freshId = s.id; // the settle / draw-on animation plays once, on the new mark only
    renderInk(); save();
    setTimeout(() => { if (freshId === s.id) freshId = null; }, 700);
  }
  function translateShape(s, o, dx, dy) {
    if (s.type === "pen") s.points = o.points.map(([x, y]) => [x + dx, y + dy]);
    else if (s.type === "arrow" || s.type === "line") { s.x1 = o.x1 + dx; s.y1 = o.y1 + dy; s.x2 = o.x2 + dx; s.y2 = o.y2 + dy; }
    else { s.x = o.x + dx; s.y = o.y + dy; }
  }
  function handlesOf(s) {
    if (s.type === "arrow" || s.type === "line") return [["p1", s.x1, s.y1], ["p2", s.x2, s.y2]];
    if (s.type === "rect" || s.type === "ellipse") return [["nw", s.x, s.y], ["ne", s.x + s.w, s.y], ["sw", s.x, s.y + s.h], ["se", s.x + s.w, s.y + s.h]];
    return []; // pen strokes only move
  }
  // ⇧ on a line or arrow: the free end snaps to 15° steps around the fixed one, keeping its length
  function snap15(ax, ay, x, y) {
    const len = Math.hypot(x - ax, y - ay), step = Math.PI / 12;
    const a = Math.round(Math.atan2(y - ay, x - ax) / step) * step;
    return [Math.round(ax + Math.cos(a) * len), Math.round(ay + Math.sin(a) * len)];
  }
  function resizeShape(s, o, h, x, y, square) {
    if (h === "p1") { [s.x1, s.y1] = square ? snap15(o.x2, o.y2, x, y) : [x, y]; return; }
    if (h === "p2") { [s.x2, s.y2] = square ? snap15(o.x1, o.y1, x, y) : [x, y]; return; }
    const ax = h.includes("w") ? o.x + o.w : o.x, ay = h.includes("n") ? o.y + o.h : o.y; // the opposite corner stays put
    let w = Math.max(8, Math.abs(x - ax)), hh = Math.max(8, Math.abs(y - ay));
    if (square) w = hh = Math.max(w, hh);
    s.x = x < ax ? ax - w : ax; s.y = y < ay ? ay - hh : ay; s.w = w; s.h = hh;
  }
  function deleteSelected() {
    if (!selected) return;
    const g = shapesG.querySelector(`g.shape[data-id="${selected}"]`);
    if (g && !g.classList.contains("leaving") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      g.classList.add("leaving");
      if (selBox) selBox.classList.add("leaving");
      for (const n of notes.filter((k) => k.shapeId === selected)) { const p = pinsLayer.querySelector(`.pin[data-id="${n.id}"]`); if (p) p.classList.add("leaving"); }
      setTimeout(deleteSelected, 160);
      return;
    }
    pushUndo();
    const gone = selected;
    shapes = shapes.filter((s) => s.id !== gone);
    notes = notes.filter((n) => n.shapeId !== gone);
    selected = null;
    renderInk(); renderPins();
    save();
  }
  function deleteNote(id, silent = false) {
    if (!silent) pushUndo();
    const n0 = notes.find((n) => n.id === id);
    notes = notes.filter((n) => n.id !== id);
    if (n0 && n0.shapeId && n0.text) { shapes = shapes.filter((s) => s.id !== n0.shapeId); renderInk(); } // a saved note's trash takes its circle too; a cancelled new note keeps the mark
    renderPins();
    save();
  }
  let creating = false;
  async function createNote(x, y, extra = null) {
    if (creating) return;
    creating = true;
    try {
      let n;
      const localNext = Math.max(0, ...notes.map((k) => k.n)) + 1; // this page, including notes not saved yet
      try { n = Math.max((await req("POST", "/note/next")).n, localNext); } catch { n = localNext; }
      const note = { id: uid(), n, x, y, color: ink.id, text: "", status: "draft", ctx: ctxAtPoint(x, y), batch: null, ...(extra || {}) };
      notes.push(note);
      renderPins();
      openPopover(note, true);
    } finally { creating = false; }
  }
  async function clearAll() {
    pushUndo();
    shapes = []; notes = []; selected = null; phase = "idle";
    renderInk(); renderPins(); renderToolbar();
    try { await req("POST", "/clear"); toast("Cleared. Fresh page.", "ok"); } catch (e) { toast(e.message === "busy" ? "Still sending, clear again in a moment." : `Couldn't clear: ${e.message}`); }
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  function applyInk() {
    host.style.setProperty("--ink", ink.hex);
    host.style.setProperty("--ink-dark", ink.dark);
    const cur = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><circle cx='11' cy='11' r='6.5' fill='${ink.hex}' stroke='rgba(10,8,14,.75)' stroke-width='2'/></svg>`)}") 11 11, crosshair`;
    host.style.setProperty("--cursor", tool === "note" ? "copy" : tool === "rect" ? "crosshair" : cur);
  }
  function setMode(m) {
    mode = m;
    host.classList.toggle("draw", m === "draw");
    host.classList.toggle("browse", m === "browse");
    for (const t of TOOLS) host.classList.toggle("t-" + t, m === "draw" && tool === t);
    if (m === "browse") { selected = null; renderSelection(); }
    renderToolbar();
  }
  function setTool(t) {
    tool = t;
    if (t !== "select") { selected = null; renderSelection(); }
    setMode("draw");
    applyInk();
  }
  function setLink(s) {
    linkState = s;
    host.classList.toggle("link-on", s === "on");
    host.classList.toggle("link-connecting", s === "connecting");
    host.classList.toggle("link-off", s === "off");
  }
  function sendLabel() {
    const unsent = totals.unsent;
    if (phase === "sending") return { label: "Sending…", cls: "sending", disabled: true };
    if (phase === "sent" && totals.open > 0 && unsent === 0) return { label: "Claude is on it", cls: "sent", disabled: true };
    if (phase === "done" && unsent === 0) return { label: "All done", cls: "done", disabled: true };
    if (unsent === 0 && totals.notes + totals.shapes === 0) return { label: "Send to Claude", cls: "", disabled: true };
    if (totals.batches > 0 && unsent > 0) return { label: `Send ${unsent} more`, cls: "", disabled: false, count: unsent };
    return { label: "Send to Claude", cls: "", disabled: false, count: unsent };
  }
  let lastBar = "";
  function renderToolbar() {
    if (!bar) return;
    const s = sendLabel();
    const btn = (name, title, key, extra = "") =>
      `<button class="tb ${extra}" type="button" data-${name.startsWith("act:") ? "act" : "tool"}="${name.replace("act:", "")}" aria-label="${title}">${svgIcon(name.replace("act:", "") === "undo" ? "undo" : name.replace("act:", ""))}<span class="kbd">${title}${key ? `<b>${key}</b>` : ""}</span></button>`;
    const html = `
      <span class="grip" title="Drag">${svgIcon("grip", 16)}</span>
      <button class="tb mode${mode === "browse" ? " on" : ""}" type="button" data-act="mode" aria-label="Browse the page">${svgIcon("hand")}<span class="st"></span><span class="kbd">${mode === "browse" ? "Back to drawing" : "Browse the page"}<b>V · esc</b></span></button>
      <span class="sep"></span>
      ${btn("pen", "Pen", "P", tool === "pen" && mode === "draw" ? "on" : "")}
      ${btn("rect", "Area", "A", tool === "rect" && mode === "draw" ? "on" : "")}
      ${btn("note", "Note", "N", tool === "note" && mode === "draw" ? "on" : "")}
      ${btn("select", "Select", "S", tool === "select" && mode === "draw" ? "on" : "")}
      <span class="sep"></span>
      <button class="tb" type="button" data-act="undo" aria-label="Undo" ${undo.length ? "" : "disabled style='opacity:.35'"}>${svgIcon("undo")}<span class="kbd">Undo<b>⌘Z</b></span></button>
      <span class="sep"></span>
      <button class="send ${s.cls}" type="button" data-act="send" ${s.disabled ? "disabled" : ""}><span class="live"></span><span class="label">${s.label}</span>${s.count || s.cls === "done" ? `<span class="cnt"><span class="num">${s.count || ""}</span>${svgIcon("check", 13)}</span>` : ""}</button>
      <button class="tb danger${clearArmed ? " armed" : ""}${phase === "done" && !clearArmed ? " glow" : ""}" type="button" data-act="clear" aria-label="Clear everything">${svgIcon("trash")}${clearArmed ? "<span>Sure?</span>" : `<span class="kbd">Clear all pages</span>`}</button>`;
    if (html !== lastBar) { lastBar = html; bar.innerHTML = html; }
  }

  // ---------------------------------------------------------------------------
  // Toolbar position (draggable, remembered per origin)
  // ---------------------------------------------------------------------------
  const POS_KEY = "claude-annotate:bar";
  const NARROW = matchMedia("(max-width: 720px)"); // the CSS lays the bar out there; no dragging
  function restoreBarPos() {
    if (NARROW.matches) { bar.removeAttribute("style"); return; }
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && typeof p.x === "number") placeBar(p.x, p.y);
    } catch { /* ignore */ }
  }
  function placeBar(x, y) {
    bar.style.animation = "none"; // the rise keyframes keep translateX(-50%) applied and would shift a positioned bar
    const w = bar.offsetWidth || 560, h = bar.offsetHeight || 48;
    x = clamp(x, 8, innerWidth - w - 8);
    y = clamp(y, 8, innerHeight - h - 8);
    bar.style.left = x + "px";
    bar.style.top = y + "px";
    bar.style.bottom = "auto";
    bar.style.transform = "none";
  }
  function bindDrag() {
    let start = null;
    bar.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".grip")) return;
      const r = bar.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.classList.add("dragging");
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => { if (start) placeBar(e.clientX - start.dx, e.clientY - start.dy); });
    const stop = () => {
      if (!start) return;
      start = null;
      bar.classList.remove("dragging");
      const r = bar.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top })); } catch { /* ignore */ }
    };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bindEvents() {
    // Toolbar clicks (delegated; toolbar re-renders often)
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.tool) return setTool(b.dataset.tool);
      if (b.dataset.ink) { ink = INKS.find((i) => i.id === b.dataset.ink); applyInk(); if (mode !== "draw") setMode("draw"); renderToolbar(); return; }
      switch (b.dataset.act) {
        case "mode": return setMode(mode === "draw" ? "browse" : "draw");
        case "undo": return doUndo();
        case "send": return send();
        case "clear": return armClear();
      }
    });
    bindDrag();

    // Drawing
    svg.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerdown", (e) => {
      if (selected && !e.composedPath().includes(host)) { selected = null; renderInk(); }
    }, true);
    document.addEventListener("dblclick", (e) => {
      if (RENDER_ONLY || mode !== "browse" || e.button !== 0) return;
      if (e.composedPath().includes(host)) return; // our own toolbar/pins/popover
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // let the page's fields work
      e.preventDefault();
      try { getSelection().removeAllRanges(); } catch {}
      if (!popover.classList.contains("hidden")) commitPopover();
      const [x, y] = toDoc(e);
      createNote(x, y);
    }, true);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("contextmenu", (e) => { if (mode === "draw") e.preventDefault(); });

    // Pins: press opens the note, drag moves it (any mode)
    pinsLayer.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".dot, .tag");
      const pin = e.target.closest(".pin");
      if (!handle || !pin || e.button !== 0) return;
      const n = notes.find((k) => k.id === pin.dataset.id);
      if (!n) return;
      e.preventDefault();
      e.stopPropagation();
      const [x, y] = toDoc(e);
      drag = { kind: "pin", n, pin, ox: n.x, oy: n.y, x, y, before: snapshot(), moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    pinsLayer.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "pin") return;
      const [x, y] = toDoc(e);
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; host.classList.add("dragging"); closePopover(); }
      drag.n.x = Math.round(drag.ox + dx); drag.n.y = Math.round(drag.oy + dy);
      drag.pin.style.left = drag.n.x + "px"; drag.pin.style.top = drag.n.y + "px";
    });
    const endPinDrag = () => {
      if (!drag || drag.kind !== "pin") return;
      const d = drag; drag = null;
      host.classList.remove("dragging");
      if (d.moved && d.linked && d.linked.length) { for (const l of d.linked) { l.n.x = l.x + (d.dx || 0); l.n.y = l.y + (d.dy || 0); } renderPins(); }
      if (d.moved) { undo.push(d.before); if (undo.length > 60) undo.shift(); redo.length = 0; d.n.ctx = ctxAtPoint(d.n.x, d.n.y); renderPins(); save(); renderToolbar(); }
      else openPopover(d.n, false);
    };
    pinsLayer.addEventListener("pointerup", endPinDrag);
    pinsLayer.addEventListener("pointercancel", endPinDrag);

    // Keyboard
    window.addEventListener("keydown", onKey, true);

    // Keep things aligned
    window.addEventListener("scroll", placePopover, { passive: true });
    window.addEventListener("resize", () => { sizeDoc(); placePopover(); restoreBarPos(); }, { passive: true });
    const ro = new ResizeObserver(() => sizeDoc());
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
    setInterval(() => {
      if (!host.isConnected) document.documentElement.appendChild(host); // hydration or innerHTML replaced <html>'s children
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body); // idempotent; re-arms after a body swap
      sizeDoc();
    }, 1500);

    // SPA navigation: same document, new URL → reload state for the new URL
    const fire = () => setTimeout(onUrlChange, 50);
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function (...a) { const r = orig.apply(this, a); fire(); return r; };
    }
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
  }
  let currentUrl = location.href;
  function onUrlChange() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    closePopover();
    selected = null;
    hydrate();
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const hitG = e.composedPath().find((n) => n instanceof Element && n.classList && n.classList.contains("shape"));
    if (hitG && tool !== "select") { // a mark was clicked: select it whatever tool is active
      if (!popover.classList.contains("hidden")) commitPopover();
      const [x, y] = toDoc(e);
      selected = hitG.dataset.id; renderInk();
      const s = shapes.find((k) => k.id === selected);
      if (s) { drag = { kind: "shape", s, orig: JSON.parse(JSON.stringify(s)), x, y, before: snapshot(), moved: false, linked: notes.filter((n) => n.shapeId === s.id).map((n) => ({ n, x: n.x, y: n.y })) }; svg.setPointerCapture(e.pointerId); }
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (mode !== "draw") return;
    if (selected && tool !== "select") { selected = null; renderInk(); }
    if (!popover.classList.contains("hidden")) { commitPopover(); }
    const [x, y] = toDoc(e);
    if (tool === "note") { e.preventDefault(); createNote(x, y); return; }
    if (tool === "select") {
      const g = e.composedPath().find((n) => n instanceof Element && n.classList && n.classList.contains("shape"));
      selected = g ? g.dataset.id : null;
      renderInk();
      if (selected) {
        const s = shapes.find((k) => k.id === selected);
        drag = { kind: "shape", s, orig: JSON.parse(JSON.stringify(s)), x, y, before: snapshot(), moved: false };
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      return;
    }
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    if (tool === "pen") draft = { id: uid(), type: "pen", color: ink.id, points: [[x, y]] };
    else if (tool === "arrow" || tool === "line") draft = { id: uid(), type: tool, color: ink.id, x1: x, y1: y, x2: x, y2: y };
    else draft = { id: uid(), type: tool, color: ink.id, x, y, w: 0, h: 0, _ox: x, _oy: y };
    sizeDoc();
    renderDraft();
  }
  let drag = null; // { kind: "shape"|"pin", ... } while something is being moved
  function onMove(e) {
    if (drag && drag.kind === "shape") {
      const [x, y] = toDoc(e);
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      host.classList.add("dragging");
      if (drag.handle) resizeShape(drag.s, drag.orig, drag.handle, x, y, e.shiftKey);
      else { translateShape(drag.s, drag.orig, dx, dy); drag.dx = dx; drag.dy = dy; }
      renderShape(drag.s);
      return;
    }
    if (!draft) return;
    const [x, y] = toDoc(e);
    if (draft.type === "pen") {
      const l = draft.points[draft.points.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) >= 2.5) draft.points.push([x, y]);
    } else if (draft.type === "arrow" || draft.type === "line") { [draft.x2, draft.y2] = e.shiftKey ? snap15(draft.x1, draft.y1, x, y) : [x, y]; }
    else {
      draft.x = Math.min(draft._ox, x); draft.y = Math.min(draft._oy, y);
      draft.w = Math.abs(x - draft._ox); draft.h = Math.abs(y - draft._oy);
      if (e.shiftKey) { const m = Math.max(draft.w, draft.h); draft.w = draft.h = m; }
    }
    renderDraft();
  }
  function onUp() {
    if (drag && drag.kind === "shape") {
      const d = drag; drag = null;
      host.classList.remove("dragging");
      if (d.moved) { undo.push(d.before); if (undo.length > 60) undo.shift(); redo.length = 0; d.s.ctx = ctxForShape(d.s); renderInk(); save(); renderToolbar(); }
      return;
    }
    if (!draft) return;
    const d = draft; draft = null;
    let ok = false;
    if (d.type === "pen") ok = d.points.length >= 3;
    else if (d.type === "arrow" || d.type === "line") ok = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 12;
    else { ok = d.w >= 8 && d.h >= 8; delete d._ox; delete d._oy; }
    if (!ok) { renderDraft(); return; }
    addShape(d);
    if (d.type === "pen" || d.type === "rect") {
      const b = bbox(d);
      // An area's note sits on its lower-right corner so the comment box opens below it, not over it.
      createNote(Math.round(b.x + b.w), Math.round(d.type === "rect" ? b.y + b.h : b.y), { shapeId: d.id, ctx: d.ctx });
    }
  }
  function onKey(e) {
    if (RENDER_ONLY) return;
    const target = e.composedPath()[0];
    const inOurs = host && (target === host || host.shadowRoot.contains(target));
    const editing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (editing && !inOurs) return; // the page's own inputs
    if (inOurs && editing) return; // our textarea handles itself
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (meta && e.key === "Enter") { e.preventDefault(); send(); return; }
    if (meta || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") { if (clearArmed) disarmClear(); else if (mode === "draw") setMode("browse"); return; } // never steals the page's own Escape
    if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); deleteSelected(); return; }
    if (mode === "browse" && !(k in KEYS) && k !== "v") return;
    if (k === "v") { setMode(mode === "draw" ? "browse" : "draw"); return; }
    if (k in KEYS) { setTool(KEYS[k]); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); deleteSelected(); }
  }

  // ---------------------------------------------------------------------------
  // Send / clear
  // ---------------------------------------------------------------------------
  async function send() {
    if (phase === "sending") return;
    if (!popover.classList.contains("hidden")) commitPopover();
    phase = "sending";
    renderToolbar();
    clearTimeout(saveTimer);
    try { await req("PUT", "/state", { url: pageUrl(), shapes, notes }); } catch { /* fallthrough */ }
    try {
      const r = await req("POST", "/send");
      for (const n of notes) if (!n.batch) { n.batch = r.batch; n.status = "pending"; }
      for (const s of shapes) if (!s.batch) s.batch = r.batch;
      totals = r.totals || totals;
      phase = "sent";
      renderPins();
      renderToolbar();
      wigglePins();
      rim.classList.remove("flash"); void rim.offsetWidth; rim.classList.add("flash");
      const where = r.pages > 1 ? ` across ${r.pages} pages` : "";
      toast(`Sent ${r.notes} note${r.notes === 1 ? "" : "s"}${where}. The pins update as Claude works.`, "ok");
      // The server cannot tell whether the channel is on. If nothing comes back, say what to do.
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (phase === "sent") toast("Nothing from Claude yet? In the session, type /annotate pull."); }, 20000);
    } catch (e) {
      phase = "idle";
      renderToolbar();
      toast(e.message === "Nothing to send yet." ? "Draw something or drop a note first." : e.message === "busy" ? "Still sending the last batch, one moment." : `Couldn't send: ${e.message}`);
    }
  }
  function armClear() {
    if (clearArmed) { disarmClear(); clearAll(); return; }
    clearArmed = setTimeout(disarmClear, 2200);
    renderToolbar();
  }
  function disarmClear() { clearTimeout(clearArmed); clearArmed = null; renderToolbar(); }

  // ---------------------------------------------------------------------------
  // Toasts / ticker
  // ---------------------------------------------------------------------------
  function toast(text, kind = "") {
    const t = el("div", `toast ${kind}`, `${svgIcon(kind === "ok" ? "check" : "note", 16)}<span>${esc(text)}</span>`);
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, kind === "ok" ? 3800 : 6000);
  }
  let tickerTimer = null;
  function tick(text, mono) {
    ticker.innerHTML = mono ? `Claude · <span class="mono">${esc(text)}</span>` : esc(text);
    ticker.classList.add("show");
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(() => ticker.classList.remove("show"), 6000);
  }

  // ---------------------------------------------------------------------------
  // Server link
  // ---------------------------------------------------------------------------
  async function hydrate() {
    try {
      const r = await req("GET", `/state?url=${encodeURIComponent(pageUrl())}`);
      shapes = r.shapes || [];
      notes = r.notes || [];
      totals = r.totals || totals;
      if (totals.open > 0) phase = "sent";
      else if (totals.batches > 0 && totals.unsent === 0) phase = "done";
      renderInk(); renderPins(); renderToolbar();
      reopenDraft();
      if (r.review) showReview();
    } catch { setLink("off"); }
  }
  function connectSse() {
    setLink("connecting");
    sse = new ES(`${CFG.endpoint}/events?t=${CFG.token}`);
    sse.onopen = () => setLink("on");
    sse.onerror = () => setLink("off");
    sse.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "progress" || m.type === "done" || m.type === "status" || m.type === "toast") clearTimeout(quietTimer);
      switch (m.type) {
        case "hello": setLink("on"); if (m.totals) { totals = m.totals; renderToolbar(); } break;
        case "progress": {
          const n = notes.find((k) => k.n === m.n);
          if (n) { n.status = m.status; if (m.message) n.result = m.message; updatePin(n); }
          tick(m.status === "working" ? `working on note ${m.n}` : m.status === "done" ? `note ${m.n} done${m.message ? " · " + m.message : ""}` : `note ${m.n} skipped${m.message ? " · " + m.message : ""}`);
          if (m.status === "done") { const d = pinsLayer.querySelector(`.pin[data-id="${n ? n.id : ""}"] .dot`); if (d) d.classList.add("wiggle"); }
          break;
        }
        case "status": tick(m.text, true); break;
        case "toast": toast(m.text); break;
        case "sent": if (!draft && !popNote && !drag) hydrate(); break; // another tab sent; don't clobber work in progress
        case "done":
          for (const n of notes) if (n.batch && (!m.batch || n.batch === m.batch) && (n.status === "pending" || n.status === "working")) { n.status = "done"; updatePin(n); }
          phase = "done";
          totals.open = 0;
          renderToolbar();
          if (m.review) showReview();
          else toast(m.summary ? `Done. ${m.summary}` : "Done.", "ok");
          wigglePins(70);
          break;
        case "clear":
          hideReview();
          shapes = []; notes = []; selected = null; phase = "idle"; undo.length = 0; redo.length = 0;
          totals = { notes: 0, shapes: 0, pages: 0, unsent: 0, open: 0, batches: 0 };
          closePopover(); renderInk(); renderPins(); renderToolbar();
          break;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Public hooks for the server
  // ---------------------------------------------------------------------------
  // Before/after anchoring: remember which element sits at a page point, and find it again after the change,
  // so the "after" picture follows the element even when content above it grew or shrank.
  function elPath(e) {
    const parts = [];
    for (let n = e; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll(`#${window.CSS.escape(n.id)}`).length === 1) { parts.unshift(`#${window.CSS.escape(n.id)}`); break; }
      let i = 1; for (let k = n.previousElementSibling; k; k = k.previousElementSibling) if (k.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(" > ");
  }
  const docRect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
  const textOf = (e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  api.anchor = (x, y) => {
    const sx = scrollX, sy = scrollY;
    scrollTo({ left: Math.max(0, x - innerWidth / 2), top: Math.max(0, y - innerHeight / 2), behavior: "instant" });
    let e = document.elementFromPoint(clamp(x - scrollX, 0, innerWidth - 1), clamp(y - scrollY, 0, innerHeight - 1));
    scrollTo({ left: sx, top: sy, behavior: "instant" });
    if (!e || e === document.documentElement || e === document.body) return null;
    return { path: elPath(e), tag: e.tagName, text: textOf(e), rect: docRect(e) };
  };
  api.locate = (a) => {
    if (!a) return null;
    let e = null;
    try { e = document.querySelector(a.path); } catch { /* bad selector */ }
    if (e && e.tagName !== a.tag) e = null;
    if (a.text && (!e || textOf(e) !== a.text)) { // moved in the tree: same tag and same text elsewhere wins
      const twin = [...document.getElementsByTagName(a.tag)].find((k) => textOf(k) === a.text);
      if (twin) e = twin;
    }
    return e ? docRect(e) : null;
  };
  api.hide = (on) => { if (host) host.style.display = on ? "none" : ""; }; // clean before/after pictures: nothing of ours on the page

  // ---------------------------------------------------------------------------
  // Before / after (after Claude's annotate_done)
  // ---------------------------------------------------------------------------
  let reviewEl = null, reviewUrls = [];
  async function loadImg(k, which) {
    const r = await F(`${CFG.endpoint}/review/img?k=${k}&which=${which}`, { headers: H }); // token in a header, never in a URL
    if (!r.ok) throw new Error("image");
    const u = URL.createObjectURL(await r.blob());
    reviewUrls.push(u);
    return u;
  }
  function hideReview() {
    if (!reviewEl) return;
    const el0 = reviewEl; reviewEl = null;
    el0.classList.add("out");
    setTimeout(() => { el0.remove(); for (const u of reviewUrls.splice(0)) URL.revokeObjectURL(u); }, 180);
  }
  async function showReview() {
    if (RENDER_ONLY || reviewEl) return;
    let rv;
    try { rv = (await req("GET", "/review")).review; } catch { return; }
    if (!rv || !rv.items.length || reviewEl) return;
    if (!popover.classList.contains("hidden")) commitPopover();
    reviewEl = el("div", "review");
    reviewEl.setAttribute("role", "dialog");
    reviewEl.setAttribute("aria-label", "Before and after");
    const cards = rv.items.map((it) => {
      const label = it.notes.length
        ? it.notes.map((n) => `<div class="rv-note"><span class="rv-n">${n.n}</span><div><div class="rv-t">${esc(n.text || "(no text)")}</div>${n.result ? `<div class="rv-r${n.status === "skipped" ? " skip" : ""}">${n.status === "skipped" ? "Skipped · " : ""}${esc(n.result)}</div>` : ""}</div></div>`).join("")
        : `<div class="rv-note"><span class="rv-n">·</span><div class="rv-t">Marked area</div></div>`;
      return `<section class="rv-card" data-k="${it.k}">${label}
        <div class="cmp" style="--pos:50%"><img class="b" alt="Before"><img class="a" alt="After"><span class="bar-h"><span class="knob"></span></span>
          <span class="tag-b">Before</span><span class="tag-a">After</span>
          <input type="range" min="0" max="100" value="50" aria-label="Compare before and after"></div></section>`;
    }).join("");
    reviewEl.innerHTML = `<div class="rv-sheet">
      <header class="rv-head"><div class="rv-title">Done</div>${rv.summary ? `<div class="rv-sum">${esc(rv.summary)}</div>` : ""}</header>
      <div class="rv-body">${cards}</div>
      <footer class="rv-foot"><button type="button" class="rv-more">More feedback</button><button type="button" class="rv-close">Looks good, close</button></footer>
    </div>`;
    chrome.appendChild(reviewEl);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const card of reviewEl.querySelectorAll(".rv-card")) {
      const k = card.dataset.k, cmp = card.querySelector(".cmp"), range = card.querySelector("input");
      range.addEventListener("input", () => cmp.style.setProperty("--pos", range.value + "%"));
      Promise.all([loadImg(k, "before"), loadImg(k, "after")]).then(([b, a]) => {
        const ib = card.querySelector("img.b"), ia = card.querySelector("img.a");
        ib.src = b; ia.src = a;
        ib.decode().catch(() => {}).then(() => {
          cmp.classList.add("ready");
          if (reduce) return;
          // One gentle sweep so the change announces itself, then it rests in the middle.
          const t0 = performance.now(), path = [[0, 50], [450, 88], [1100, 12], [1600, 50]];
          const ease = (x) => 0.5 - Math.cos(Math.PI * x) / 2;
          const step = (now) => {
            const t = now - t0;
            if (!reviewEl || range.matches(":active")) return;
            let i = 1; while (i < path.length - 1 && t > path[i][0]) i++;
            const [ta, va] = path[i - 1], [tb, vb] = path[i];
            const v = t >= path[path.length - 1][0] ? 50 : va + (vb - va) * ease(Math.min(1, (t - ta) / (tb - ta)));
            range.value = v; cmp.style.setProperty("--pos", v + "%");
            if (t < path[path.length - 1][0]) requestAnimationFrame(step);
          };
          setTimeout(() => requestAnimationFrame((n) => step(n)), 250);
        });
      }).catch(() => { cmp.classList.add("missing"); });
    }
    reviewEl.querySelector(".rv-close").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = "Closing…";
      try { await req("POST", "/review/close"); } catch { toast("Couldn't close. Close the window yourself."); }
    });
    reviewEl.querySelector(".rv-more").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try { await req("POST", "/review/more"); } catch { /* reload anyway */ }
      hideReview();
      setTimeout(() => location.reload(), 160); // annotate the new version of the page
    });
  }

  api.capture = (on) => { if (!host) return; host.classList.toggle("capturing", !!on); if (on) { selected = null; renderSelection(); } };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
