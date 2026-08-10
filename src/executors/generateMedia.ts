/**
 * generate_media — render a static ad image, preferring the OpenAI Image API and falling
 * back to chatgpt.com in the logged-in profile.
 *
 * The one executor that PRODUCES a file instead of touching a social platform.
 *
 * TWO GENERATION PATHS, same contract either way (files under
 * data/media/<brandId>/<YYYY-MM-DD>_<slug>/ + manifest.json + the media_assets rollup):
 *
 *  1. OpenAI API (2026-08-09, "for now" per Andy — ChatGPT web ran out of image credits):
 *     when OPENAI_API_KEY resolves (env or the repo's gitignored .env), call gpt-image-2
 *     directly — images/generations, or images/edits when reference images are attached.
 *     gpt-image-2 accepts arbitrary sizes, so the exact ad ratio is rendered natively and
 *     nothing is cropped. No browser involved.
 *
 *  2. ChatGPT web (the original path, kept intact as fallback when no key is present):
 *     open a fresh chat in the logged-in profile, attach references, submit the prompt,
 *     wait out the render, pull bytes through the page, center-crop in an offscreen canvas.
 *
 * Not an outward act: nothing publishes. No identity guard (neither path has a brand
 * handle); the API's analog of "logged in" is a key that authenticates.
 *
 * DOM notes for path 2, verified live 2026-08-04: composer `#prompt-textarea`
 * (ProseMirror contenteditable), send `[data-testid="send-button"]`, stop
 * `[data-testid="stop-button"]`. Generated images carry `alt="Generated image: <title>"`
 * and a `backend-api/estuary/content` src. chatgpt.com does NOT render
 * `data-message-author-role` on turns — never key detection on it.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "node:child_process";
import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { randomWait } from "../browser/humanize";
import { withPage, bodyText } from "./webCommon";
import { ActionError, toFailure } from "./xCommon";
import { stageImage, StagedImage } from "./imageBridge";
import type { Action, ActionResult } from "./index";

const CHATGPT_HOME = "https://chatgpt.com/";
const GENERATION_BUDGET_MS = 7 * 60 * 1000; // well inside the agent's 15-min action ceiling
const POLL_MS = 3_000;
const MIN_IMAGE_PX = 512; // anything smaller is an icon/avatar, not our render
const MAX_REFERENCES = 4;
const MAX_REF_BYTES = 12 * 1024 * 1024; // the image bridge's cap, applied to local paths too

/** Requested ad ratio → the orientation ChatGPT can natively render, the crop target,
 *  and the exact pixel size the API path requests (gpt-image-2 takes arbitrary sizes). */
// API sizes: gpt-image-2 takes arbitrary sizes but width and height must each be
// divisible by 16 (it rejected 1080x1350 with exactly that message).
const RATIOS: Record<string, { orientation: "square" | "portrait" | "landscape"; w: number; h: number; apiSize: string }> = {
  "1:1": { orientation: "square", w: 1, h: 1, apiSize: "1024x1024" },
  "4:5": { orientation: "portrait", w: 4, h: 5, apiSize: "1024x1280" },
  "2:3": { orientation: "portrait", w: 2, h: 3, apiSize: "1024x1536" },
  "3:2": { orientation: "landscape", w: 3, h: 2, apiSize: "1536x1024" },
  "9:16": { orientation: "portrait", w: 9, h: 16, apiSize: "1152x2048" },
  "16:9": { orientation: "landscape", w: 16, h: 9, apiSize: "2048x1152" },
};

/* ────────────────────────────── OpenAI API path ────────────────────────────── */

const OPENAI_API_BASE = "https://api.openai.com/v1";
const OPENAI_IMAGE_MODEL_DEFAULT = "gpt-image-2";
const API_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Key resolution: env → the repo's gitignored .env, parsed by hand (Andy's rule: no
 * dotenv dependency, ever). null = no key = use the ChatGPT web path.
 */
export function resolveOpenAIKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const envFile = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf-8");
    const m = envFile.match(/^\s*OPENAI_API_KEY\s*=\s*("?)([^"\r\n]+)\1\s*$/m);
    return m ? m[2].trim() : null;
  } catch {
    return null;
  }
}

function openAiImageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL || OPENAI_IMAGE_MODEL_DEFAULT;
}

/** One image out of the API: generations without references, edits with them. */
async function callImagesApi(key: string, model: string, prompt: string, size: string, refs: StagedRef[]): Promise<Buffer> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    let res: Response;
    if (refs.length) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("quality", "high");
      // (gpt-image-1's input_fidelity knob is gone — gpt-image-2 rejected it outright;
      // high-fidelity reference handling is built into the model.)
      for (const r of refs) {
        const type = /\.png$/i.test(r.filePath) ? "image/png" : /\.webp$/i.test(r.filePath) ? "image/webp" : "image/jpeg";
        form.append("image[]", new Blob([new Uint8Array(fs.readFileSync(r.filePath))], { type }), path.basename(r.filePath));
      }
      res = await fetch(`${OPENAI_API_BASE}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: ctrl.signal,
      });
    } else {
      res = await fetch(`${OPENAI_API_BASE}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, size, quality: "high", n: 1 }),
        signal: ctrl.signal,
      });
    }

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      if (res.status === 401) throw new ActionError("login_required", `OpenAI API key rejected — check OPENAI_API_KEY in .env. (${msg})`);
      if (res.status === 429) throw new ActionError("rate_limited", `OpenAI API rate/quota limit: ${msg}`);
      if (res.status === 400 && /content policy|safety|moderation/i.test(msg)) throw new ActionError("blocked", `OpenAI declined the prompt: ${msg}`);
      if (res.status === 400) throw new ActionError("bad_params", `OpenAI API rejected the request: ${msg}`);
      if (res.status === 403) throw new ActionError("blocked", `OpenAI API forbids this: ${msg}`);
      throw new ActionError("platform_error", `OpenAI API error: ${msg}`);
    }
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64) throw new ActionError("platform_error", "OpenAI API returned no image data (data[0].b64_json missing).");
    return Buffer.from(b64, "base64");
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new ActionError("ambiguous", `OpenAI image request exceeded ${API_TIMEOUT_MS / 60000} min — it MAY have been billed; check the usage dashboard before re-running.`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** PNG dimensions straight from the IHDR chunk — no image library needed. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null; // \x89PNG
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * ~300px dashboard thumbnail via System.Drawing (this agent runs on Windows; on anything
 * else we just skip it). Best-effort — a missing thumbnail never fails a real render.
 */
function makeThumbnailDataUrl(pngPath: string): string | null {
  if (process.platform !== "win32") return null;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "Add-Type -AssemblyName System.Drawing;",
    `$img = [System.Drawing.Image]::FromFile('${pngPath.replace(/'/g, "''")}');`,
    "$w = 300; $h = [int]($img.Height * $w / $img.Width);",
    "$b = New-Object System.Drawing.Bitmap($w, $h);",
    "$g = [System.Drawing.Graphics]::FromImage($b);",
    "$g.InterpolationMode = 'HighQualityBicubic';",
    "$g.DrawImage($img, 0, 0, $w, $h);",
    "$ms = New-Object System.IO.MemoryStream;",
    "$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };",
    "$ep = New-Object System.Drawing.Imaging.EncoderParameters(1);",
    "$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 72L);",
    "$b.Save($ms, $enc, $ep);",
    "[Convert]::ToBase64String($ms.ToArray())",
  ].join(" ");
  try {
    const b64 = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return b64 ? `data:image/jpeg;base64,${b64}` : null;
  } catch {
    return null;
  }
}

/**
 * The API path, start to finish: call gpt-image-2 at the exact ad size (nothing to crop),
 * save + manifest + OneDrive export exactly like the browser path, so downstream rollups
 * cannot tell the difference.
 */
async function generateViaOpenAiApi(args: {
  key: string; action: Action; prompt: string; promptSubmitted: string; promptSuffix: string;
  ratioKey: string; title: string; slug: string; brandId: string; stagedRefs: StagedRef[]; dryRun: boolean;
}): Promise<ActionResult> {
  const { key, action, prompt, promptSubmitted, promptSuffix, ratioKey, title, slug, brandId, stagedRefs, dryRun } = args;
  const model = openAiImageModel();
  const apiSize = RATIOS[ratioKey].apiSize;
  const [wantW, wantH] = apiSize.split("x").map(Number);

  if (dryRun) {
    return {
      ok: true,
      result: {
        dryRun: true, generator: model, requestedRatio: ratioKey, apiSize,
        referencesStaged: stagedRefs.map((r) => r.source),
        note: "dry run — API key resolved, request built, nothing sent (and nothing billed)",
      },
    };
  }

  const png = await callImagesApi(key, model, promptSubmitted, apiSize, stagedRefs);
  const dims = pngSize(png) ?? { width: wantW, height: wantH };

  const dir = uniqueDir(path.join("data", "media", brandId, `${dateStamp()}_${slug}`));
  fs.mkdirSync(dir, { recursive: true });
  const adName = `ad-${ratioKey.replace(":", "x")}.png`;
  const adPath = path.join(dir, adName);
  fs.writeFileSync(adPath, png);
  const files = [{
    path: path.resolve(adPath), role: "ad", width: dims.width, height: dims.height, ratio: ratioKey,
    bytes: png.length, sha256: crypto.createHash("sha256").update(png).digest("hex"),
  }];

  const referenceRecord = stagedRefs.map((r) => ({ source: r.source, note: r.note, bytes: r.bytes, sha256: r.sha256 }));
  const manifest = {
    version: 1,
    assetKind: "static-ad",
    brandId, actionId: action.actionId, title, slug,
    generator: model,
    prompt, promptSuffix, promptSubmitted,
    referenceImages: referenceRecord,
    aspect: {
      requested: ratioKey,
      native: `${dims.width}x${dims.height}`,
      cropped: false, // the API rendered the exact ratio — nothing was cut
      cropBox: { x: 0, y: 0, w: dims.width, h: dims.height },
    },
    context: (action.params || {}).context ?? null,
    conversationUrl: null,
    files,
    generatedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const exportPath = exportToDesktopAds(brandId, slug, adPath);

  return {
    ok: true,
    result: {
      exportPath,
      generator: model, slug,
      requestedRatio: ratioKey,
      nativeRatio: `${dims.width}x${dims.height}`,
      cropped: false,
      files,
      referenceImages: referenceRecord,
      savedDir: path.resolve(dir),
      manifestPath: path.resolve(manifestPath),
      conversationUrl: null,
      promptSubmitted,
      thumbnailDataUrl: makeThumbnailDataUrl(path.resolve(adPath)),
      verified: true,
    },
  };
}

type ReferenceParam = { url?: string; path?: string; note?: string };
type StagedRef = { filePath: string; source: string; note: string | null; bytes: number; sha256: string; cleanup: () => void };

export async function runGenerateMedia(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const stagedRefs: StagedRef[] = [];
  try {
    const p = action.params || {};
    const prompt = String(p.prompt ?? "").trim();
    if (!prompt) throw new ActionError("bad_params", "params.prompt is required — the full image-generation prompt.");
    const ratioKey = String(p.aspectRatio ?? "4:5");
    const ratio = RATIOS[ratioKey];
    if (!ratio) throw new ActionError("bad_params", `Unknown aspectRatio '${ratioKey}'. Valid: ${Object.keys(RATIOS).join(", ")}`);
    const title = String(p.title ?? "").trim() || "untitled ad";
    const slug = slugify(String(p.slug ?? "").trim() || title);
    const brandId = action.brandId || "unknown-brand";

    // Stage references BEFORE the browser opens — a bad URL/path should fail in one
    // second as bad_params, not five browser-seconds in.
    for (const ref of normalizeReferences(p.referenceImages)) {
      stagedRefs.push(await stageReference(ref));
    }

    // API first (Andy, 2026-08-09): a resolved OPENAI_API_KEY means no browser at all —
    // gpt-image-2 renders the exact ratio directly. Delete the key from .env to go back
    // to the ChatGPT web path.
    const apiKey = resolveOpenAIKey();
    if (apiKey) {
      const apiSuffix = stagedRefs.length
        ? `\n\nUse the ${stagedRefs.length} attached image(s) as references as instructed above.`
        : "";
      return await generateViaOpenAiApi({
        key: apiKey, action, prompt, promptSubmitted: prompt + apiSuffix, promptSuffix: apiSuffix,
        ratioKey, title, slug, brandId, stagedRefs, dryRun: p.dryRun === true,
      });
    }

    // The deterministic tail: Claude owns the creative prompt; the executor owns "actually
    // produce an image, in this orientation, without a clarifying-question detour".
    const promptSuffix =
      `\n\nGenerate this as a single image now, in ${ratio.orientation} orientation. ` +
      `Do not ask questions and do not describe the image — produce it.` +
      (stagedRefs.length ? ` Use the ${stagedRefs.length} attached image(s) as references as instructed above.` : "");
    const promptSubmitted = prompt + promptSuffix;

    return await withPage(config, async (page) => {
      await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
      await randomWait(2_500, 4_200); // SPA hydration

      await assertChatGptLoggedIn(page);

      if (p.dryRun === true) {
        return {
          ok: true,
          result: {
            dryRun: true, generator: "chatgpt", loggedIn: true, requestedRatio: ratioKey,
            referencesStaged: stagedRefs.map((r) => r.source),
            note: "dry run — composer reachable, nothing submitted",
          },
        };
      }

      // Close any tour/memory popover that would eat the first keystroke.
      await page.keyboard.press("Escape").catch(() => {});

      const composer = page.locator("#prompt-textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "ChatGPT composer (#prompt-textarea) not found — the page may have changed.");
      });

      if (stagedRefs.length) await attachReferences(page, stagedRefs);

      await composer.click();
      await randomWait(400, 900);
      // insertText, not humanType: ad prompts run 1500+ chars and Enter would send mid-prompt.
      await page.keyboard.insertText(promptSubmitted);
      await randomWait(600, 1_200);

      await clickSendWhenReady(page, stagedRefs.length > 0);

      const img = await waitForGeneratedImage(page);

      // Pull the bytes through the page so cookie-gated CDN URLs work, then crop +
      // thumbnail in an offscreen canvas — no native image dependency.
      const processed = await page.evaluate(
        async ({ src, ratioW, ratioH }) => {
          const resp = await fetch(src, { credentials: "include" });
          const blob = await resp.blob();
          const bmp = await createImageBitmap(blob);
          const draw = (w: number, h: number, sx: number, sy: number, sw: number, sh: number, type: string, q?: number) => {
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
            return c.toDataURL(type, q);
          };
          // Largest centered rect of the requested ratio — crop, never stretch.
          const target = ratioW / ratioH;
          let sw = bmp.width, sh = bmp.height;
          if (bmp.width / bmp.height > target) sw = Math.round(bmp.height * target);
          else sh = Math.round(bmp.width / target);
          const sx = Math.round((bmp.width - sw) / 2), sy = Math.round((bmp.height - sh) / 2);
          return {
            nativeW: bmp.width, nativeH: bmp.height,
            cropW: sw, cropH: sh, cropX: sx, cropY: sy,
            adPng: draw(sw, sh, sx, sy, sw, sh, "image/png"),
            sourcePng: draw(bmp.width, bmp.height, 0, 0, bmp.width, bmp.height, "image/png"),
            thumbJpeg: draw(300, Math.round((300 * sh) / sw), sx, sy, sw, sh, "image/jpeg", 0.72),
          };
        },
        { src: img.src, ratioW: ratio.w, ratioH: ratio.h },
      );

      const conversationUrl = page.url().startsWith(CHATGPT_HOME) ? page.url() : null;
      const dir = uniqueDir(path.join("data", "media", brandId, `${dateStamp()}_${slug}`));
      fs.mkdirSync(dir, { recursive: true });

      const adName = `ad-${ratioKey.replace(":", "x")}.png`;
      const files = [
        saveDataUrl(path.join(dir, adName), processed.adPng, { role: "ad", width: processed.cropW, height: processed.cropH, ratio: ratioKey }),
        saveDataUrl(path.join(dir, "source.png"), processed.sourcePng, { role: "source", width: processed.nativeW, height: processed.nativeH, ratio: `${processed.nativeW}:${processed.nativeH}` }),
      ];

      const referenceRecord = stagedRefs.map((r) => ({ source: r.source, note: r.note, bytes: r.bytes, sha256: r.sha256 }));
      const manifest = {
        version: 1,
        assetKind: "static-ad",
        brandId, actionId: action.actionId, title, slug,
        generator: "chatgpt",
        prompt, promptSuffix, promptSubmitted,
        referenceImages: referenceRecord,
        aspect: {
          requested: ratioKey,
          native: `${processed.nativeW}x${processed.nativeH}`,
          cropped: processed.cropW !== processed.nativeW || processed.cropH !== processed.nativeH,
          cropBox: { x: processed.cropX, y: processed.cropY, w: processed.cropW, h: processed.cropH },
        },
        context: p.context ?? null,
        conversationUrl,
        files,
        generatedAt: new Date().toISOString(),
      };
      const manifestPath = path.join(dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Andy's browse copy: every finished ad also lands in the OneDrive Desktop Ads
      // folder, named to sort by date. Best-effort — a missing OneDrive must never fail
      // a successful generation; data/media stays the system of record.
      const exportPath = exportToDesktopAds(brandId, slug, path.join(dir, adName));

      return {
        ok: true,
        result: {
          exportPath,
          generator: "chatgpt", slug,
          requestedRatio: ratioKey,
          nativeRatio: `${processed.nativeW}x${processed.nativeH}`,
          cropped: manifest.aspect.cropped,
          files,
          referenceImages: referenceRecord,
          savedDir: path.resolve(dir),
          manifestPath: path.resolve(manifestPath),
          conversationUrl,
          promptSubmitted,
          thumbnailDataUrl: processed.thumbJpeg,
          verified: true,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  } finally {
    for (const r of stagedRefs) r.cleanup();
  }
}

/* ────────────────────────────── references ────────────────────────────── */

function normalizeReferences(raw: unknown): ReferenceParam[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ActionError("bad_params", "params.referenceImages must be an array of {url|path, note?}.");
  if (raw.length > MAX_REFERENCES) throw new ActionError("bad_params", `At most ${MAX_REFERENCES} reference images.`);
  return raw as ReferenceParam[];
}

/** https URLs go through the image bridge's suspicious download; local paths get the same caps. */
async function stageReference(ref: ReferenceParam): Promise<StagedRef> {
  const note = ref.note ? String(ref.note) : null;
  if (ref.url) {
    const staged: StagedImage = await stageImage(ref.url);
    return { filePath: staged.filePath, source: ref.url, note, bytes: staged.bytes, sha256: sha256File(staged.filePath), cleanup: staged.cleanup };
  }
  if (ref.path) {
    const fp = path.resolve(String(ref.path));
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      throw new ActionError("bad_params", `reference path does not exist: ${fp}`);
    }
    const bytes = fs.statSync(fp).size;
    if (bytes > MAX_REF_BYTES) throw new ActionError("bad_params", `reference ${path.basename(fp)} is over the ${MAX_REF_BYTES / 1048576}MB cap`);
    if (!/\.(png|jpe?g|webp|gif)$/i.test(fp)) throw new ActionError("bad_params", `reference ${path.basename(fp)} is not an image file`);
    return { filePath: fp, source: fp, note, bytes, sha256: sha256File(fp), cleanup: () => {} };
  }
  throw new ActionError("bad_params", "each referenceImages entry needs url (https) or path (local file)");
}

/**
 * Hand the files to the composer's real file input and wait until ChatGPT acknowledges
 * every one — sending while an upload is still going drops the attachment silently.
 */
async function attachReferences(page: Page, refs: StagedRef[]): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  if (!(await input.count())) {
    throw new ActionError("ui_changed", "no file input in the ChatGPT composer — the attachment path may have changed");
  }
  await input.setInputFiles(refs.map((r) => r.filePath));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const previews = await page
      .evaluate(() => document.querySelectorAll('form img[src^="blob:"], form img[src*="estuary"]').length)
      .catch(() => 0);
    if (previews >= refs.length) return;
    await randomWait(800, 1_400);
  }
  throw new ActionError("ui_changed", `attached ${refs.length} reference(s) but the composer never showed them all — refusing to send half a prompt`);
}

/** Send only once the button is genuinely enabled (uploads disable it while in flight). */
async function clickSendWhenReady(page: Page, hasAttachments: boolean): Promise<void> {
  const send = page.locator('[data-testid="send-button"]');
  const deadline = Date.now() + (hasAttachments ? 90_000 : 15_000);
  while (Date.now() < deadline) {
    const visible = await send.isVisible().catch(() => false);
    if (visible && (await send.isEnabled().catch(() => false))) {
      await send.click();
      return;
    }
    await randomWait(700, 1_200);
  }
  if (!hasAttachments) { await page.keyboard.press("Enter"); return; }
  throw new ActionError("ui_changed", "send button never became ready — an upload may be stuck");
}

/* ────────────────────────────── chatgpt specifics ────────────────────────────── */

/**
 * Logged-out chatgpt.com still shows a composer, so the composer proves nothing.
 * The "Log in" button is the honest signal — image generation needs the real account.
 */
async function assertChatGptLoggedIn(page: Page): Promise<void> {
  const loginBtn = page.getByRole("button", { name: /^log in$/i }).or(page.getByRole("link", { name: /^log in$/i }));
  if (await loginBtn.first().isVisible().catch(() => false)) {
    throw new ActionError("login_required", "Not logged in to chatgpt.com in the automation profile — log in there once and retry.");
  }
}

/**
 * Wait out the render. Done means: a real generated image exists (alt "Generated image…",
 * or a big estuary/oaiusercontent img as fallback), the stop button is gone, and the src
 * held stable across two polls (the progressive preview swaps to the final asset at the
 * end). Detection deliberately keys on the image itself, NOT on chat-turn structure —
 * the first live run proved chatgpt.com renders no data-message-author-role attribute.
 */
async function waitForGeneratedImage(page: Page): Promise<{ src: string }> {
  const start = Date.now();
  const deadline = start + GENERATION_BUDGET_MS;
  let lastSrc: string | null = null;

  while (Date.now() < deadline) {
    await randomWait(POLL_MS * 0.8, POLL_MS * 1.2);

    const text = await bodyText(page);
    if (/reached (your|the).{0,40}limit|image generation limit|too many requests/i.test(text)) {
      throw new ActionError("rate_limited", "ChatGPT reports an image-generation limit — the lane will cool off and retry later.");
    }

    const state = await page
      .evaluate(({ minPx }) => {
        const imgs = Array.from(document.images);
        const gen =
          imgs.filter((i) => (i.alt || "").startsWith("Generated image") && i.naturalWidth >= minPx).pop() ||
          imgs.filter((i) => i.naturalWidth >= minPx && /estuary\/content|oaiusercontent/.test(i.src)).pop();
        return {
          src: gen ? gen.src : null,
          streaming: !!document.querySelector('[data-testid="stop-button"]'),
        };
      }, { minPx: MIN_IMAGE_PX })
      .catch(() => null);
    if (!state) continue;

    // Refusal check: only once the model has plainly stopped without producing anything —
    // checked against page text because chat-turn structure is not something we can query.
    if (!state.src && !state.streaming && Date.now() - start > 60_000 &&
        /\b(can't|cannot|won't|unable to) (create|generate|make)\b|content policy/i.test(text)) {
      throw new ActionError("blocked", "ChatGPT declined the prompt — open the conversation to read its reasoning.");
    }

    if (state.src && !state.streaming) {
      if (state.src === lastSrc) return { src: state.src };
      lastSrc = state.src;
    }
  }
  throw new ActionError("ambiguous", "Generation did not finish inside the budget — the image MAY exist in the ChatGPT conversation; check before re-running.");
}

/* ────────────────────────────── files ────────────────────────────── */

/** Copy the finished ad into OneDrive\Desktop\Ads\<brand>\ for easy human browsing. */
function exportToDesktopAds(brandId: string, slug: string, adFile: string): string | null {
  try {
    const dest = path.join(os.homedir(), "OneDrive", "Desktop", "Ads", brandId);
    if (!fs.existsSync(path.join(os.homedir(), "OneDrive", "Desktop"))) return null;
    fs.mkdirSync(dest, { recursive: true });
    const out = path.join(dest, `${dateStamp()} - ${slug}.png`);
    fs.copyFileSync(adFile, out);
    return out;
  } catch {
    return null; // browse copy only — never fail the action over it
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ad";
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Same brand + same day + same slug should never overwrite yesterday's iteration. */
function uniqueDir(base: string): string {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function sha256File(fp: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

function saveDataUrl(
  filePath: string,
  dataUrl: string,
  meta: { role: string; width: number; height: number; ratio: string },
): { path: string; role: string; width: number; height: number; ratio: string; bytes: number; sha256: string } {
  const b64 = dataUrl.split(",")[1] ?? "";
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new ActionError("platform_error", `Image came back empty for ${meta.role} — not saving a zero-byte file.`);
  fs.writeFileSync(filePath, buf);
  return {
    path: path.resolve(filePath), ...meta,
    bytes: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}
