/**
 * Proves Chrome shuts down cleanly.
 *
 * Launches a session, closes it the normal way, then reads the profile's Preferences
 * and checks Chrome recorded exit_type "Normal". Anything else means the next launch
 * greets you with "Restore pages?".
 *
 *   npx tsx scripts/test-graceful-close.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/loader";
import { launchSession } from "../src/browser/session";

async function main() {
  const root = path.resolve(__dirname, "..");
  const config = loadConfig(path.join(root, "marketer.config.json"));
  const prefsPath = path.join(
    path.resolve(config.profileDir),
    config.chrome.profileDirectory ?? "Default",
    "Preferences",
  );

  const session = await launchSession(config);
  const page = await session.context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
  await session.close();

  await new Promise((r) => setTimeout(r, 1_500)); // Preferences is written on the way out
  const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  const exitType = prefs.profile?.exit_type;
  const exitedCleanly = prefs.profile?.exited_cleanly;

  console.log(`[test] exit_type: ${exitType}`);
  console.log(`[test] exited_cleanly: ${exitedCleanly}`);
  if (exitType === "Normal" && exitedCleanly !== false) {
    console.log("[test] PASS — clean shutdown, no restore prompt next launch.");
  } else {
    console.log('[test] FAIL — the profile is still marked as crashed.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
