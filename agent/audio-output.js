// Can the replies actually be heard?
//
// A browser cannot see the operating system's mute switch, so a page can play every
// reply to the end into a muted speaker and look perfectly healthy. The daemon runs on
// the same Windows machine, so it asks Windows directly (agent/windows-audio.ps1,
// read-only) and tells the capture page, which then says so on screen.
//
// Elsewhere (macOS, Linux, a remote daemon) this reports nothing and the page shows nothing.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "windows-audio.ps1");
const QUIET_PERCENT = 5;        // at or below this a reply is effectively silent

/** Turns the raw device list into what the page needs to decide on a warning. */
export function summarise(devices) {
  if (!Array.isArray(devices) || !devices.length) return null;
  const silent = d => d.muted || d.volume <= QUIET_PERCENT;
  const outputs = devices.map(d => ({ name: d.name, volume: d.volume, muted: d.muted, isDefault: d.isDefault, silent: silent(d) }));
  const def = outputs.find(d => d.isDefault) ?? null;
  return { outputs, default: def, allSilent: outputs.every(d => d.silent), checkedAt: new Date().toISOString() };
}

/** One reading, or null when unavailable. Never throws. */
export function readOutputs() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { timeout: 8000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        try { resolve(summarise(JSON.parse(String(stdout).trim()))); } catch { resolve(null); }
      });
  });
}

/** Polls Windows and calls onChange with the new state whenever mute or volume changes. */
export function watchOutputs(onChange, intervalMs = 10_000) {
  let last = "", current = null, stopped = false;
  const tick = async () => {
    const state = await readOutputs();
    const key = JSON.stringify(state?.outputs ?? null);
    current = state;
    if (key !== last) { last = key; onChange(state); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 0);
  return { get: () => current, stop: () => { stopped = true; clearTimeout(timer); } };
}
