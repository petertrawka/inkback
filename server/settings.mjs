// The one saved setting that lives on the user's machine, not in the browser (the browser's own storage is per address):
// ~/.cache/inkback/settings.json = { "firstRoundDone": true }. A missing or broken file means "not done yet" and never throws.
import fs from "node:fs";
import path from "node:path";

const file = (dir) => path.join(dir, "settings.json");

export function readSettings(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(file(dir), "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

export const firstRoundDone = (dir) => readSettings(dir).firstRoundDone === true;

// Returns true when saved. Never throws: if the folder can't be written the prompt simply shows again next time.
export function markFirstRoundDone(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(dir), JSON.stringify({ ...readSettings(dir), firstRoundDone: true }) + "\n");
    return true;
  } catch { return false; }
}

// INKBACK_FIRST_RUN=1 forces the prompt on (recording the demo GIF on a machine long past its first round).
export const firstRunOn = (dir, env = process.env) => env.INKBACK_FIRST_RUN === "1" || !firstRoundDone(dir);
