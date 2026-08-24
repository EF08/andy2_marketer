// Capture the canonical iPhone-demo reference asset: the phone element alone
// (frame + Chrome top + live abrifazliu.com at its top state), 3x density,
// after the self-scroll demo settles and with the URL nudge dismissed.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const OUT = path.join("data", "media", "playersites", "refs");
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4399/get-started", { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(6500);            // let the self-scroll demo finish
  await page.mouse.click(10, 10);             // dismiss the URL nudge
  await page.waitForTimeout(700);             // fade out
  await page.locator("#iph").screenshot({ path: path.join(OUT, "iphone-demo-reference.png") });
  console.log("wrote " + path.join(OUT, "iphone-demo-reference.png"));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
