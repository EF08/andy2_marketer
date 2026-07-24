/**
 * Browser smoke test: launch Chrome via the CDP session (stealth applied), open x.com,
 * print the page title and detected login state, close. Proves the Mac/PC can drive
 * Chrome before wiring anything else.
 *
 *   npm run smoke
 */
import path from "node:path";
import { loadConfig } from "../src/config/loader";
import { launchSession } from "../src/browser/session";
import { randomWait } from "../src/browser/humanize";
import { PLATFORM_DEFS } from "../src/platforms";

async function main() {
  const ROOT = path.resolve(__dirname, "..");
  const config = loadConfig(path.join(ROOT, "marketer.config.json"));
  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    await page.goto(PLATFORM_DEFS.twitter.home, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
    await randomWait(3_000, 5_000);
    const loggedIn = await PLATFORM_DEFS.twitter.detectLoggedIn(page);
    console.log(`\n=== SMOKE OK ===\nurl:      ${page.url()}\ntitle:    ${await page.title()}\nloggedIn: ${loggedIn === null ? "unclear" : loggedIn}\n`);
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exit(1); });
