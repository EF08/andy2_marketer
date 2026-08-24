// One-off: capture reusable reference screenshots of www.abrifazliu.com (public site,
// no profile needed) for generate_media referenceImages. Hero-focused: 2x viewport tall.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUT = path.join("data", "media", "playersites", "refs");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const shot of [
      { name: "abrifazliu-mobile.png", viewport: { width: 390, height: 844 }, clipH: 1688, mobile: true },
      { name: "abrifazliu-desktop.png", viewport: { width: 1440, height: 900 }, clipH: 1800, mobile: false },
    ]) {
      const ctx = await browser.newContext({
        viewport: shot.viewport,
        isMobile: shot.mobile,
        deviceScaleFactor: 2,
        userAgent: shot.mobile
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
          : undefined,
      });
      const page = await ctx.newPage();
      await page.goto("https://www.abrifazliu.com/", { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(2500); // fonts, lazy media
      const fullH = await page.evaluate(() => document.body.scrollHeight);
      await page.screenshot({
        path: path.join(OUT, shot.name),
        clip: { x: 0, y: 0, width: shot.viewport.width, height: Math.min(shot.clipH, fullH) },
      });
      console.log(`${shot.name}: ${shot.viewport.width}x${Math.min(shot.clipH, fullH)} (page ${fullH}px tall)`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error("shot failed: " + e.message); process.exit(1); });
