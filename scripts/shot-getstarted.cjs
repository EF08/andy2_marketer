// Screenshot the local /get-started draft (collapsed + expanded) and the
// /get-started-info copy, desktop and iPhone sizes, for review.
// Usage: node scripts/shot-getstarted.cjs [baseUrl]   (default http://localhost:4399)
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://localhost:4399";
const OUT = path.join("data", "media", "playersites", "getstarted-v2");
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  try {
    // ── Desktop ──
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
    const dp = await desk.newPage();
    await dp.goto(BASE + "/get-started", { waitUntil: "networkidle", timeout: 60_000 });
    await dp.waitForTimeout(4000); // let the abrifazliu iframe paint
    await dp.screenshot({ path: path.join(OUT, "desktop-fold.png") });
    await dp.screenshot({ path: path.join(OUT, "desktop-full.png"), fullPage: true });
    await dp.click("#gs-more-btn");
    await dp.waitForTimeout(2500); // reveal + google demo typing
    await dp.screenshot({ path: path.join(OUT, "desktop-expanded-full.png"), fullPage: true });
    await dp.locator("#info-money").scrollIntoViewIfNeeded();
    await dp.waitForTimeout(1200);
    await dp.screenshot({ path: path.join(OUT, "desktop-stakes-viewport.png") });
    await desk.close();

    // ── iPhone ──
    const mob = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
    const mp = await mob.newPage();
    await mp.goto(BASE + "/get-started", { waitUntil: "networkidle", timeout: 60_000 });
    await mp.waitForTimeout(4000);
    await mp.screenshot({ path: path.join(OUT, "mobile-fold.png") });
    await mp.screenshot({ path: path.join(OUT, "mobile-full.png"), fullPage: true });
    await mp.click("#gs-more-btn");
    await mp.waitForTimeout(2500);
    await mp.screenshot({ path: path.join(OUT, "mobile-expanded-full.png"), fullPage: true });
    await mob.close();

    // ── Sanity: the info copy still renders ──
    const chk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cp = await chk.newPage();
    await cp.goto(BASE + "/get-started-info", { waitUntil: "networkidle", timeout: 60_000 });
    await cp.waitForTimeout(3000);
    await cp.screenshot({ path: path.join(OUT, "info-copy-fold.png") });
    await chk.close();

    console.log("wrote screenshots to " + OUT);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
