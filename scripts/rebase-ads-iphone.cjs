// Rebase the 12 live playersites ads onto the master iPhone-demo asset
// (data/media/playersites/refs/iphone-demo-reference.png — the /get-started
// phone). Two modes: 'phone' replaces the ad's whole device (master drawn
// cover-fit over the old phone's bbox, rounded-corner clipped so its corners
// stay transparent), 'screen' pastes only the master's screen (inside-bezel
// crop) into an ad's existing device — used where a hand holds the phone.
// 'copy' passes ads with no iPhone through unchanged so the set stays
// complete. Rects are FRACTIONS of the ad's own dimensions.
// Usage: node scripts/rebase-ads-iphone.cjs
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SRC = "C:\\Users\\andyf\\OneDrive\\Desktop\\Ads\\playersites\\_LIVE SET";
const OUT = "C:\\Users\\andyf\\OneDrive\\Desktop\\Ads\\playersites\\_LIVE SET v2 - master iphone base";
const MASTER = path.join("data", "media", "playersites", "refs", "iphone-demo-reference.png");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// Master geometry: 402x845 CSS phone at 3x; outer radius 62*3, bezel 11*3.
const M = { w: 1206, h: 2535, r: 186, bezel: 33 };

const ADS = [
  { file: "01 - google - googled nothing vs everything.png", mode: "phone", rect: { x: .700, y: .578, w: .183, h: .342 } },
  { file: "02 - coach-google - coach googles your player.png", mode: "copy" },   // MacBook, no iPhone demo
  { file: "03 - dms - highlight links get lost in dms.png", mode: "phone", rect: { x: .616, y: .242, w: .333, h: .622 } },
  { file: "04 - offers - one website multiple prep offers.png", mode: "screen", rect: { x: .348, y: .363, w: .312, h: .527 }, rFrac: .032 },
  { file: "05 - roi - numbers on the table.png", mode: "copy" },                 // typography only
  { file: "06 - cost - cost ladder.png", mode: "phone", rect: { x: .285, y: .222, w: .428, h: .722 } },
  { file: "07 - site - found on abrifazliu.png", mode: "phone", rect: { x: .277, y: .140, w: .448, h: .755 } },
  { file: "08 - reply - one link reply.png", mode: "copy" },                     // chat mock, no phone
  { file: "09 - career - his career one link.png", mode: "phone", rect: { x: .266, y: .185, w: .468, h: .778 } },
  { file: "10 - camera - you film every game.png", mode: "phone", rect: { x: .166, y: .341, w: .320, h: .560 } },
  // moves: relocate the section callouts — the master's Chrome bar pushes the
  // site content ~110px down, so each label slides to keep pointing at its
  // section (accolades / stats / film). Blocks include their connector lines;
  // the vacated rect is patched with sampled background.
  { file: "11 - find - make this what coaches find.png", mode: "phone", rect: { x: .271, y: .100, w: .458, h: .838 },
    moves: [
      { x: .050, y: .404, w: .210, h: .052, dy: .1375 },  // "Every accolade" -> accolade pills
      { x: .748, y: .580, w: .222, h: .060, dy: .170 },   // "Verified stats — tap any number" -> stats rows
      { x: .044, y: .721, w: .220, h: .047, dy: .142 },   // "Game film" -> film strip
    ] },
  { file: "12 - easy - be easy to recruit.png", mode: "phone", rect: { x: .553, y: .178, w: .343, h: .620 } },
];

const b64 = (p) => "data:image/png;base64," + fs.readFileSync(p).toString("base64");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const masterSrc = b64(MASTER);

  for (const ad of ADS) {
    const src = path.join(SRC, ad.file);
    const dst = path.join(OUT, ad.file);
    if (ad.mode === "copy") { fs.copyFileSync(src, dst); console.log(`copied    ${ad.file}`); continue; }
    const out = await page.evaluate(async ({ adSrc, masterSrc, ad, M }) => {
      const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = s; });
      const img = await load(adSrc);
      const master = await load(masterSrc);
      const W = img.naturalWidth, H = img.naturalHeight;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const R = { x: ad.rect.x * W, y: ad.rect.y * H, w: ad.rect.w * W, h: ad.rect.h * H };
      g.save();
      if (ad.mode === "phone") {
        // Cover the old device: center master on its bbox, scaled to cover.
        const s = Math.max(R.w / M.w, R.h / M.h);
        const dw = M.w * s, dh = M.h * s;
        const dx = R.x + R.w / 2 - dw / 2, dy = R.y + R.h / 2 - dh / 2;
        g.beginPath(); g.roundRect(dx, dy, dw, dh, M.r * s); g.clip();
        g.drawImage(master, dx, dy, dw, dh);
      } else { // screen: inside-bezel crop of master into the ad's screen rect
        const sx = M.bezel, sy = M.bezel, sw = M.w - 2 * M.bezel, sh = M.h - 2 * M.bezel;
        const s = R.w / sw;
        g.beginPath(); g.roundRect(R.x, R.y, R.w, R.h, (ad.rFrac || .03) * W); g.clip();
        g.drawImage(master, sx, sy, sw, sh, R.x, R.y, R.w, sh * s); // width-fit, top-crop
      }
      g.restore();
      for (const m of (ad.moves || [])) {
        const bx = Math.round(m.x * W), by = Math.round(m.y * H),
              bw = Math.round(m.w * W), bh = Math.round(m.h * H),
              dy = Math.round(m.dy * H);
        const block = g.getImageData(bx, by, bw, bh);
        // Patch color comes from the block's OUTER side — the side away from
        // the image center is guaranteed background, never phone bezel.
        const sampleX = (bx + bw / 2 < W / 2) ? Math.max(0, bx - 12) : Math.min(W - 1, bx + bw + 12);
        const s = g.getImageData(sampleX, by + Math.round(bh / 2), 1, 1).data;
        g.fillStyle = `rgb(${s[0]},${s[1]},${s[2]})`;
        g.fillRect(bx, by, bw, bh);
        g.putImageData(block, bx, by + dy);
      }
      return c.toDataURL("image/png");
    }, { adSrc: b64(src), masterSrc, ad, M });
    fs.writeFileSync(dst, Buffer.from(out.split(",")[1], "base64"));
    console.log(`rebased   ${ad.file} (${ad.mode})`);
  }
  await browser.close();
  console.log("done -> " + OUT);
})().catch((e) => { console.error(e.message); process.exit(1); });
