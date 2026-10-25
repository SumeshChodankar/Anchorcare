// Opens the capture page as an unattended, always-listening kiosk.
//
//   npm run agent:kiosk
//
// A normal Chrome window will not run audio until someone clicks the page once, so
// the capture page shows "Click anywhere to start". For a device nobody touches,
// this launches Chrome with that rule lifted and the microphone prompt pre-accepted,
// in a separate profile so your everyday Chrome is unaffected. The daemon must
// already be running (npm run agent).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (existsSync(".env")) process.loadEnvFile(".env");

const HERE = dirname(fileURLToPath(import.meta.url));
const url = `http://${process.env.AGENT_HOST || "127.0.0.1"}:${process.env.AGENT_PORT || 4319}/capture`;
const profile = join(HERE, "..", ".kiosk-profile");

const candidates = [
  process.env.CHROME_PATH,
  join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean);
const chrome = candidates.find(p => existsSync(p));
if (!chrome) {
  console.error("Chrome not found. Set CHROME_PATH to chrome.exe and run again.");
  process.exit(1);
}

const health = await fetch(url.replace("/capture", "/status")).catch(() => null);
if (!health?.ok) {
  console.error(`The daemon is not answering at ${url}. Start it first: npm run agent`);
  process.exit(1);
}

mkdirSync(profile, { recursive: true });
spawn(chrome, [
  `--user-data-dir=${profile}`,                   // flags only apply to a fresh profile process
  "--autoplay-policy=no-user-gesture-required",   // listen and speak without a first click
  "--use-fake-ui-for-media-stream",               // accept the mic prompt; the real mic is used
  "--no-first-run",
  `--app=${url}`
], { detached: true, stdio: "ignore" }).unref();

console.log(`Kiosk opened: ${url}\nProfile: ${profile}`);
