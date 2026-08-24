// Debug: crop a region of an image (scaled 2x) to eyeball exact pixel geometry.
// Usage: node scripts/crop-peek.cjs <png> <x> <y> <w> <h> <out>
const fs = require("fs");
const { chromium } = require("playwright");
const [src, x, y, w, h, out] = [process.argv[2], ...process.argv.slice(3, 7).map(Number), process.argv[7]];
const b64 = (p) => "data:image/png;base64," + fs.readFileSync(p).toString("base64");
(async () => {
  const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  try {
    const page = await browser.newPage();
    const data = await page.evaluate(async ({ srcData, x, y, w, h }) => {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = srcData; });
      const c = document.createElement("canvas");
      c.width = w * 2; c.height = h * 2;
      const g = c.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(img, x, y, w, h, 0, 0, w * 2, h * 2);
      return c.toDataURL("image/png");
    }, { srcData: b64(src), x, y, w, h });
    fs.writeFileSync(out, Buffer.from(data.split(",")[1], "base64"));
    console.log("wrote " + out);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
