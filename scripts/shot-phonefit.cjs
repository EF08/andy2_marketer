// Capture abrifazliu.com mobile at EXACTLY the ad phone-screen aspect (390x975 = 0.4),
// plain viewport screenshot (no clip API), so the composite fits 1:1 with zero cropping.
const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 975 },
      isMobile: true,
      deviceScaleFactor: 2,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
    const page = await ctx.newPage();
    await page.goto("https://www.abrifazliu.com/", { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(2500);
    const out = path.join("data", "media", "playersites", "refs", "abrifazliu-mobile-phonefit.png");
    await page.screenshot({ path: out });
    console.log("wrote " + out);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
