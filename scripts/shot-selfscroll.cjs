// Verify the postMessage scroll demo: sample the EMBEDDED site's own
// window.scrollY during the animation, then capture mid-demo + nudge frames.
const { chromium } = require("playwright");
const path = require("path");
const OUT = path.join("data", "media", "playersites", "getstarted-v2");

(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4399/get-started", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500); // let the iframe load; demo fires on load+visible
  const abri = page.frames().find(f => f.url().includes("abrifazliu"));
  if (!abri) { console.error("abri frame not found"); process.exit(1); }
  const samples = [];
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(400);
    samples.push(await abri.evaluate(() => Math.round(window.scrollY)).catch(() => -1));
    if (i === 6) await page.screenshot({ path: path.join(OUT, "selfscroll-mid.png") });
  }
  await page.screenshot({ path: path.join(OUT, "selfscroll-after.png") });
  console.log("abri window.scrollY samples (every 400ms):", samples.join(", "));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
