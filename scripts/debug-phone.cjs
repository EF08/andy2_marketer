// Measure the phone wrapper/element geometry at mobile width to find why it collapses.
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4399/get-started", { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el ? { w: el.clientWidth, h: el.clientHeight, rect: el.getBoundingClientRect().toJSON(), display: getComputedStyle(el).display, width: getComputedStyle(el).width } : null;
    return {
      main: r(q('.gs-main')),
      phoneCol: r(q('.gs-phone-col')),
      fit: r(q('#iph-fit')),
      iph: r(q('#iph')),
      iphTransform: q('#iph') ? getComputedStyle(q('#iph')).transform : null,
      fitStyleHeight: q('#iph-fit') ? q('#iph-fit').style.height : null,
      gridCols: q('.gs-main') ? getComputedStyle(q('.gs-main')).gridTemplateColumns : null,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
