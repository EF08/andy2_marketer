import fs from "node:fs";
import path from "node:path";
import { BrowserContext, chromium } from "playwright";
import { MarketerConfig } from "../config/types";
import { applyStealthPatches } from "./stealth";
import { launchChromeAndConnectOverCdp, CdpChromeSession } from "./chromeCdp";
import { closeProfileChrome } from "./closeProfileChrome";

export type BrowserSession = {
  context: BrowserContext;
  close: () => Promise<void>;
};

// Playwright injects these by default. They scream "automation" to every
// bot-detection system. We strip them and only keep the harmless ones.
const ARGS_TO_STRIP = [
  "--enable-automation",
  "--disable-extensions",
  "--disable-default-apps",
  "--disable-component-update",
  "--disable-component-extensions-with-background-pages",
  "--no-service-autorun",
  "--disable-background-networking",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-client-side-phishing-detection",
  "--disable-field-trial-config",
  "--disable-infobars",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-renderer-backgrounding",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--enable-unsafe-swiftshader",
  "--metrics-recording-only",
  "--no-sandbox",
  "--password-store=basic",
  "--use-mock-keychain",
  "--export-tagged-pdf",
  "--unsafely-disable-devtools-self-xss-warnings",
];

async function applyContextSetup(context: BrowserContext): Promise<void> {
  await applyStealthPatches(context);
  await context.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
}

/** Playwright persistent context fallback (shows the automation banner; cdp preferred). */
async function launchPersistent(userDataDir: string, config: MarketerConfig): Promise<BrowserSession> {
  await closeProfileChrome(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 900 },
    timeout: config.behavior.navigationTimeoutMs,
    locale: "en-US",
    ignoreDefaultArgs: ARGS_TO_STRIP,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
      "--start-maximized",
    ],
  });
  return {
    context,
    close: async () => { await context.close(); console.log("[session] Browser closed."); },
  };
}

/** Spawns real Chrome with a debugging port, then attaches Playwright over CDP. */
async function launchCdp(userDataDir: string, config: MarketerConfig): Promise<BrowserSession> {
  const cdp: CdpChromeSession = await launchChromeAndConnectOverCdp({
    userDataDir,
    profileDirectory: config.chrome.profileDirectory ?? "Default",
    navigationTimeoutMs: config.behavior.navigationTimeoutMs,
    cdpPort: config.chrome.cdpPort ?? 9223,
    chromeExecutablePath: config.chrome.chromeExecutablePath,
  });
  return {
    context: cdp.context,
    close: async () => {
      await cdp.browser.close();
      // browser.close() only disconnects Playwright over CDP — kill Chrome too.
      if (!cdp.chromeProcess.killed) cdp.chromeProcess.kill();
      console.log("[session] Browser closed.");
    },
  };
}

export async function launchSession(config: MarketerConfig): Promise<BrowserSession> {
  const userDataDir = path.resolve(config.profileDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const mode = config.chrome.mode ?? "cdp";

  console.log(`[session] Launching with user-data-dir: ${userDataDir} (mode: ${mode})`);
  const session = mode === "cdp"
    ? await launchCdp(userDataDir, config)
    : await launchPersistent(userDataDir, config);

  await applyContextSetup(session.context);
  console.log(`[session] Browser ready. pages=${session.context.pages().length}`);
  return session;
}
