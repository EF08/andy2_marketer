// Capture the phone's "it's live" hints ~2.5s after load, before they fade.
const { chromium } = require("playwright");
const path = require("path");
const OUT = path.join("data", "media", "playersites", "getstarted-v2");

(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  try {
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
    const dp = await desk.newPage();
    await dp.goto("http://localhost:4399/get-started", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await dp.waitForTimeout(2600);
    await dp.screenshot({ path: path.join(OUT, "hints-desktop.png"), clip: { x: 340, y: 240, width: 640, height: 660 } });
    await desk.close();

    const mob = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
    const mp = await mob.newPage();
    await mp.goto("http://localhost:4399/get-started", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await mp.waitForTimeout(2600);
    await mp.screenshot({ path: path.join(OUT, "hints-mobile.png") });
    await mob.close();
    console.log("wrote hint screenshots");
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
