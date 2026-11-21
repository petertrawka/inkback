// Smoke test: no browser. Starts the server over stdio the way Claude Code does,
// checks the channel capability, the tool list, the HTTP bridge and the cleanup.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of ["server/index.mjs", "server/overlay.js", "server/ink.mjs", "server/settings.mjs", "scripts/ticker.mjs"]) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
  assert.equal(r.status, 0, `${f} does not parse:\n${r.stderr}`);
}
console.log("✓ syntax");

// The hook must exit 0 and stay silent with nothing to talk to.
const hook = spawnSync(process.execPath, [path.join(root, "scripts/ticker.mjs")], { input: JSON.stringify({ tool_name: "Edit", cwd: root, tool_input: { file_path: path.join(root, "x.ts") } }), encoding: "utf8" });
assert.equal(hook.status, 0, "hook exit code");
assert.equal(hook.stdout + hook.stderr, "", "hook must be silent");
console.log("✓ hook is silent without a session");

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/index.mjs")], stderr: "pipe" });
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
let stderr = "";
await client.connect(transport);
transport.stderr.on("data", (d) => (stderr += d));

const caps = client.getServerCapabilities();
assert.ok(caps.experimental && caps.experimental["claude/channel"], "declares claude/channel");
assert.ok(caps.tools, "declares tools");
assert.match(client.getInstructions() || "", /inkback_progress/, "instructions mention the protocol");
console.log("✓ channel capability + instructions");

const names = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(names, ["inkback_clear", "inkback_close", "inkback_done", "inkback_open", "inkback_progress", "inkback_pull", "inkback_reply", "inkback_screenshot", "inkback_wait"]);
console.log("✓ 9 tools, no debug tool without INKBACK_DEBUG");

const pull = await client.callTool({ name: "inkback_pull", arguments: {} });
assert.match(pull.content[0].text, /"status": "empty"/);
await assert.rejects(client.callTool({ name: "inkback_open", arguments: { url: "ftp://nope" } }), /http/, "rejects non-http urls");
await assert.rejects(client.callTool({ name: "inkback_open", arguments: { url: "https://example.com/" } }), /local development hosts only/, "rejects non-local hosts");
const waited = await client.callTool({ name: "inkback_wait", arguments: { timeout_s: 5 } });
assert.match(waited.content[0].text, /"status": "closed"/, "wait reports closed when no browser is open");
console.log("✓ pull is empty, bad and non-local urls rejected, wait says closed");

// Session file for the hook, keyed by the parent pid (this process).
const sessions = path.join(os.homedir(), ".cache", "inkback", "sessions");
const sessionFile = path.join(sessions, `${process.pid}.json`);
for (let i = 0; i < 50 && !fs.existsSync(sessionFile); i++) await sleep(100);
assert.ok(fs.existsSync(sessionFile), "session file written");
const { endpoint, token } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);

const unauth = await fetch(`${endpoint}/state?url=x`);
assert.equal(unauth.status, 403, "bridge needs the token");
const viaQuery = await fetch(`${endpoint}/state?url=x&t=${token}`);
assert.equal(viaQuery.status, 403, "query token only works for /events");
const H = { "Content-Type": "application/json", "X-Inkback-Token": token };
const url = "http://localhost:1/";
const put = await (await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [{ id: "s", type: "rect", color: "pink", x: 1, y: 1, w: 10, h: 10, returned: { batch: 3, n: 1, note: "n" } }], notes: [{ id: "n", n: 1, x: 2, y: 2, color: "pink", text: "hi", from: { n: 1, text: "make this bigger" } }] }) })).json();
assert.deepEqual(put.totals, { notes: 1, shapes: 1, pages: 1, unsent: 2, open: 0, batches: 0 });
const next = await (await fetch(`${endpoint}/note/next`, { method: "POST", headers: H })).json();
assert.equal(next.n, 2, "note numbering continues after the highest stored note");
const got = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
assert.equal(got.notes[0].text, "hi");
assert.deepEqual(got.shapes[0].returned, { batch: 3, n: 1, note: "n" }, "a returned mark keeps its flag");
assert.deepEqual(got.notes[0].from, { n: 1, text: "make this bigger" }, "a follow-up note keeps which note it follows");
assert.equal(got.mode, "poll", "poll is the default delivery");
await client.callTool({ name: "inkback_progress", arguments: { note: 1, status: "working" } });
const after = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
assert.equal(after.notes[0].status, "working", "progress mutates the stored note");
console.log("✓ bridge: token gate, state round trip (returned marks and follow-up notes too), note numbering, progress");

// The hook finds the session by parent pid and posts a status line: watch it arrive on the SSE stream.
const events = await fetch(`${endpoint}/events?t=${token}`);
const reader = events.body.getReader();
const dec = new TextDecoder();
const hook2 = spawnSync(process.execPath, [path.join(root, "scripts/ticker.mjs")], { input: JSON.stringify({ tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, "src/x.ts") } }), encoding: "utf8" });
assert.equal(hook2.status, 0);
let seen = "";
for (let i = 0; i < 20 && !/wrote src\/x\.ts/.test(seen); i++) {
  const { value, done } = await Promise.race([reader.read(), sleep(200).then(() => ({ value: null, done: false }))]);
  if (done) break;
  if (value) seen += dec.decode(value);
}
assert.match(seen, /wrote src\/x\.ts/, `hook status reached the page stream:\n${seen}`);
await reader.cancel().catch(() => {});
console.log("✓ hook reaches the bridge and the page");

await client.close();

// First-use prompt: a second server with its own throwaway home. A finished round writes one line to settings.json.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "inkback-home-"));
  const t2 = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/index.mjs")], env: { ...process.env, HOME: home, INKBACK_FIRST_RUN: "" }, stderr: "pipe" });
  const c2 = new Client({ name: "smoke2", version: "0.0.0" }, { capabilities: {} });
  await c2.connect(t2);
  const sf = path.join(home, ".cache", "inkback", "sessions", `${process.pid}.json`);
  for (let i = 0; i < 50 && !fs.existsSync(sf); i++) await sleep(100);
  const s2 = JSON.parse(fs.readFileSync(sf, "utf8"));
  const H2 = { "Content-Type": "application/json", "X-Inkback-Token": s2.token };
  const u2 = "http://localhost:2/";
  const st = async () => (await (await fetch(`${s2.endpoint}/state?url=${encodeURIComponent(u2)}`, { headers: H2 })).json()).firstRun;
  assert.equal(await st(), true, "no settings file: the prompt is on");
  await fetch(`${s2.endpoint}/state`, { method: "PUT", headers: H2, body: JSON.stringify({ url: u2, shapes: [], notes: [{ id: "n", n: 1, x: 2, y: 2, color: "pink", text: "hi" }] }) });
  await fetch(`${s2.endpoint}/send`, { method: "POST", headers: H2, body: JSON.stringify({ url: u2 }) });
  assert.equal(await st(), true, "sent but not finished: the prompt stays");
  assert.ok(!fs.existsSync(path.join(home, ".cache", "inkback", "settings.json")), "nothing saved before the round finishes");
  await c2.callTool({ name: "inkback_done", arguments: { summary: "ok" } });
  const saved2 = fs.readFileSync(path.join(home, ".cache", "inkback", "settings.json"), "utf8");
  assert.equal(JSON.parse(saved2).firstRoundDone, true, "finished round saved as one line");
  assert.equal(await st(), false, "the prompt is gone once the round has finished");
  await c2.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✓ first-use setting: on without a file, stays while a round is open, saved when Claude finishes");
}
for (let i = 0; i < 50 && fs.existsSync(sessionFile); i++) await sleep(100);
assert.ok(!fs.existsSync(sessionFile), "session file removed on shutdown");
assert.doesNotMatch(stderr, /error/i, `server stderr clean:\n${stderr}`);
console.log("✓ clean shutdown");
console.log("all good");
