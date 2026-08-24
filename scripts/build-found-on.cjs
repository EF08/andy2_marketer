/**
 * Builds the "found-on" ad WITHOUT any image generation (Andy, 2026-08-10: "no reason to
 * have AI generate an image for this").
 *
 *   1. Screenshot www.abrifazliu.com in a real iPhone viewport (Playwright, mobile UA).
 *   2. Lay that screenshot on a black 4:5 canvas with two lines of type:
 *        top-right  "Get your own today"
 *        bottom     "View full site at www.abrifazliu.com"
 *   3. Screenshot the composed page at 1080x1350 — the finished ad.
 *
 * Everything on the canvas is either the real site or those two lines: no invented UI,
 * no generated pixels. Writes the ad + manifest under data/media/playersites/ and drops
 * a browse copy in OneDrive\Desktop\Ads\playersites, matching the generate_media layout.
 *
 *   npx tsx scripts/build-found-on.cjs      (or: node scripts/build-found-on.cjs)
 */
const { chromium } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const SITE = "https://www.abrifazliu.com/";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// --source <path>: use a real phone screenshot (incl. its own status bar + browser chrome)
// instead of capturing the site with Playwright. The simulated chrome band and island are
// skipped in that mode — the supplied image fills the whole screen.
const SOURCE = (() => { const i = process.argv.indexOf("--source"); return i > -1 ? process.argv[i + 1] : null; })();
const BRAND = "playersites";
const SLUG = "found-on-real";
const AD_W = 1080, AD_H = 1350;

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function uniqueDir(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; ; i++) if (!fs.existsSync(`${base}-${i}`)) return `${base}-${i}`;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // ── 1. the site screenshot: supplied real phone screenshot, or live capture ──
    let shot;
    if (SOURCE) {
      shot = fs.readFileSync(SOURCE);
      console.log(`[found-on] using supplied screenshot ${SOURCE} (${(shot.length / 1024).toFixed(0)} KB)`);
    } else {
      const phone = await browser.newContext({
        viewport: { width: 390, height: 844 },      // iPhone 15 CSS viewport
        isMobile: true,
        deviceScaleFactor: 3,                        // 1170x2532 — plenty to downscale from
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      });
      const sitePage = await phone.newPage();
      await sitePage.goto(SITE, { waitUntil: "networkidle", timeout: 60_000 });
      await sitePage.waitForTimeout(3_000); // let film poster + fonts settle
      shot = await sitePage.screenshot({ type: "png" });
      await phone.close();
      console.log(`[found-on] captured ${SITE} (${(shot.length / 1024).toFixed(0)} KB)`);
    }

    // ── 2. compose the ad ──
    // Styled to match the cost-ladder ad: warm light-gray studio background, the real
    // screenshot seated in a drawn phone body (frame is CSS, screen is the live site).
    const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;
    const html = `<!doctype html><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;800&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${AD_W}px; height:${AD_H}px; background:#ece9e4; overflow:hidden;
         font-family:'Inter','Helvetica Neue',Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  .stage { width:100%; height:100%; display:flex; flex-direction:column; align-items:center;
           padding:66px 56px 56px; }
  .cta { color:#111; font-weight:800; font-size:66px; letter-spacing:-0.025em; text-align:center; }
  /* min-height:0 lets this flex child shrink so the phone is contained, not overflowing.
     (The bottom-cropped "option A" layout was tried 2026-08-11 and rejected by Andy — keep
     the whole phone visible.) */
  .phonewrap { flex:1; min-height:0; display:flex; align-items:center; justify-content:center;
               width:100%; padding:44px 0 38px; }
  .phone { height:100%; padding:13px; background:#1d1d1f; border-radius:58px; position:relative;
           box-shadow:0 42px 70px rgba(0,0,0,.30), 0 10px 24px rgba(0,0,0,.16); }
  /* Simulated iOS status bar + Safari address pill in the band between the phone top and
     the screenshot (Andy 2026-08-11: the empty gap read as dead space — fill it with
     browser chrome showing the URL). */
  .screen { position:relative; height:100%; aspect-ratio:390/844; border-radius:46px;
            overflow:hidden; background:#000; }
  .chrome { position:absolute; top:0; left:0; right:0; height:132px; background:#050505; }
  .sbtime { position:absolute; top:34px; left:46px; color:#fff; font-size:23px; font-weight:600;
            letter-spacing:0; }
  .sbicons { position:absolute; top:37px; right:42px; }
  .urlbar { position:absolute; left:50%; transform:translateX(-50%); bottom:12px;
            display:flex; align-items:center; gap:9px; background:#1c1c1e;
            border-radius:22px; padding:11px 24px; white-space:nowrap; }
  .urlbar span { color:#e9e9ee; font-size:23px; font-weight:600; }
  .foot { color:#111; font-weight:600; font-size:38px; letter-spacing:-0.01em; }
  .foot b { font-weight:800; }
  .screen img { position:absolute; left:0; right:0; top:${SOURCE ? 0 : 132}px; width:100%;
                height:calc(100% - ${SOURCE ? 0 : 132}px); object-fit:cover; object-position:top; display:block; }
  .island { position:absolute; top:34px; left:50%; transform:translateX(-50%);
            width:104px; height:30px; background:#000; border-radius:16px; }
</style>
<div class="stage">
  <div class="cta">Get your own today</div>
  <div class="phonewrap">
    <div class="phone"><div class="screen">
      ${SOURCE ? "" : `<div class="chrome">
        <div class="sbtime">9:41</div>
        <svg class="sbicons" width="86" height="20" viewBox="0 0 86 20" fill="none">
          <rect x="0" y="12" width="4" height="7" rx="1" fill="#fff"/>
          <rect x="7" y="9" width="4" height="10" rx="1" fill="#fff"/>
          <rect x="14" y="5" width="4" height="14" rx="1" fill="#fff"/>
          <rect x="21" y="1" width="4" height="18" rx="1" fill="#fff"/>
          <path d="M41 7c4.5-4.3 11.5-4.3 16 0l-2.6 2.7c-3-2.9-7.8-2.9-10.8 0L41 7z" fill="#fff"/>
          <path d="M45.2 11.3c2.1-2 5.5-2 7.6 0l-2.5 2.6c-.7-.7-1.9-.7-2.6 0l-2.5-2.6z" fill="#fff"/>
          <circle cx="49" cy="16.4" r="2" fill="#fff"/>
          <rect x="63" y="3" width="19" height="12" rx="3.5" stroke="#fff" stroke-width="1.6" opacity="0.5"/>
          <rect x="65.5" y="5.5" width="13" height="7" rx="2" fill="#fff"/>
          <path d="M84 7.5v3.5c1.1-.4 1.1-3.1 0-3.5z" fill="#fff" opacity="0.5"/>
        </svg>
        <div class="urlbar">
          <svg width="15" height="19" viewBox="0 0 16 20" fill="none">
            <rect x="1" y="8" width="14" height="11" rx="3" fill="#9a9aa0"/>
            <path d="M4 8V6a4 4 0 0 1 8 0v2" stroke="#9a9aa0" stroke-width="2" fill="none"/>
          </svg>
          <span>www.abrifazliu.com</span>
        </div>
      </div>`}
      <img src="${dataUrl}">
    </div>${SOURCE ? "" : `<div class="island"></div>`}</div>
  </div>
  <div class="foot">View at <b>www.abrifazliu.com</b></div>
</div>`;

    const canvas = await browser.newContext({ viewport: { width: AD_W, height: AD_H }, deviceScaleFactor: 1 });
    const adPage = await canvas.newPage();
    await adPage.setContent(html, { waitUntil: "networkidle" });
    await adPage.waitForTimeout(1_200); // webfont paint

    const dir = uniqueDir(path.join("data", "media", BRAND, `${dateStamp()}_${SLUG}`));
    fs.mkdirSync(dir, { recursive: true });
    const adPath = path.join(dir, "ad-4x5.png");
    await adPage.screenshot({ path: adPath });
    fs.writeFileSync(path.join(dir, "source-screenshot.png"), shot);

    const bytes = fs.statSync(adPath).size;
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      version: 1,
      assetKind: "static-ad",
      brandId: BRAND,
      title: "Found on abrifazliu.com — real screenshot",
      slug: SLUG,
      generator: "playwright-composite",   // NOT an image model
      method: SOURCE
        ? `Andy's real phone screenshot (${path.basename(SOURCE)}, includes its own status bar + browser chrome) seated full-bleed in a CSS-drawn phone body on a warm light-gray 4:5 canvas. No generated pixels, no simulated UI.`
        : "Live iPhone-viewport screenshot of the real site, seated in a CSS-drawn phone body on a warm light-gray 4:5 canvas (styled to match the cost-ladder ad). Simulated iOS status bar + Safari address pill (www.abrifazliu.com) fill the band above the screenshot — added on Andy's request 2026-08-11. No generated pixels.",
      sourceScreenshot: SOURCE ? path.resolve(SOURCE) : null,
      site: SITE,
      viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
      copyOnImage: ["Get your own today", "View at www.abrifazliu.com"],
      files: [{
        path: path.resolve(adPath), role: "ad", width: AD_W, height: AD_H, ratio: "4:5", bytes,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(adPath)).digest("hex"),
      }],
      context: {
        concept: "The site itself is the ad — real screenshot, not a render",
        decision: "Andy 2026-08-10: liked the found-on concept but wanted a true screenshot instead of a generated image",
      },
      generatedAt: new Date().toISOString(),
    }, null, 2));

    // browse copy, same convention as the generate_media executor
    let exportPath = null;
    try {
      const dest = path.join(os.homedir(), "OneDrive", "Desktop", "Ads", BRAND);
      if (fs.existsSync(path.join(os.homedir(), "OneDrive", "Desktop"))) {
        fs.mkdirSync(dest, { recursive: true });
        exportPath = path.join(dest, `${dateStamp()} - ${SLUG}.png`);
        fs.copyFileSync(adPath, exportPath);
      }
    } catch { /* browse copy is best-effort */ }

    console.log(`[found-on] wrote ${adPath} (${(bytes / 1024).toFixed(0)} KB)`);
    if (exportPath) console.log(`[found-on] exported ${exportPath}`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
