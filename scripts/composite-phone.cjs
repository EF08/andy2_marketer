// Deterministic product-pixel paste: composite a REAL screenshot into a rendered ad's
// device screen (rounded-rect clip, width-fit, top-crop). Replaces AI-generated screen
// content — glitchy micro-text, duplicate elements — with the truth.
// Usage: node scripts/composite-phone.cjs <adPng> <shotPng> <outPng> <x> <y> <w> <h> <radius>
const fs = require("fs");
const { chromium } = require("playwright");

const [adPath, shotPath, outPath] = process.argv.slice(2, 5);
const [x, y, w, h, r] = process.argv.slice(5, 10).map(Number);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const b64 = (p) => "data:image/png;base64," + fs.readFileSync(p).toString("base64");

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const out = await page.evaluate(
      async ({ adSrc, shotSrc, x, y, w, h, r }) => {
        const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
        const ad = await load(adSrc);
        const shot = await load(shotSrc);
        const c = document.createElement("canvas");
        c.width = ad.naturalWidth; c.height = ad.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(ad, 0, 0);
        g.save();
        g.beginPath();
        g.roundRect(x, y, w, h, r);
        g.clip();
        const scale = w / shot.naturalWidth; // width-fit, top-crop
        g.drawImage(shot, x, y, w, shot.naturalHeight * scale);
        g.restore();
        return {
          png: c.toDataURL("image/png"),
          debug: `ad ${ad.naturalWidth}x${ad.naturalHeight}, shot ${shot.naturalWidth}x${shot.naturalHeight}, drawn ${w}x${Math.round(shot.naturalHeight * scale)} at ${x},${y} -> bottom ${y + Math.round(shot.naturalHeight * scale)}, clip bottom ${y + h}`,
        };
      },
      { adSrc: b64(adPath), shotSrc: b64(shotPath), x, y, w, h, r },
    );
    fs.writeFileSync(outPath, Buffer.from(out.png.split(",")[1], "base64"));
    console.log(out.debug);
    console.log(`wrote ${outPath} (screen rect ${x},${y} ${w}x${h} r${r})`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error("composite failed: " + e.message); process.exit(1); });
