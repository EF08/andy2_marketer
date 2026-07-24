/**
 * Opens the automation profile in real Chrome (no automation flags at all) so Andy can
 * sign in to TikTok / Instagram / X / Facebook / YouTube once. Sessions persist in the
 * profile; the agent reuses them forever after. Cross-platform.
 *
 *   npm run login
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/loader";
import { detectChromeExecutable } from "../src/browser/chromePaths";

const ROOT = path.resolve(__dirname, "..");
const config = loadConfig(path.join(ROOT, "marketer.config.json"));
const userDataDir = path.resolve(ROOT, config.profileDir);
fs.mkdirSync(userDataDir, { recursive: true });

const chrome = detectChromeExecutable(config.chrome.chromeExecutablePath);
console.log(`Opening login Chrome with profile: ${userDataDir}`);
console.log("Sign in to x.com, instagram.com, tiktok.com, facebook.com, youtube.com — then just close the window.");

const child = spawn(chrome, [
  `--user-data-dir=${userDataDir}`,
  `--profile-directory=${config.chrome.profileDirectory ?? "Default"}`,
  "--no-first-run",
  "--no-default-browser-check",
  "https://x.com/home",
], { stdio: "ignore", detached: true });
child.unref();
