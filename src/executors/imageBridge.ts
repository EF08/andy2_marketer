/**
 * The lean image bridge — the only media path in this build (BRIEF decision #8).
 *
 * An outward post/reply may carry `params.imageUrl`. The agent downloads it at execute time
 * and hands the file to the platform's own composer. No asset registry, no R2, no video: the
 * brand's own repo renders the image (a card endpoint it owns), core just consumes a URL.
 *
 * Everything here is deliberately suspicious of that URL: https only, content-type must
 * really be an image, size capped, and the temp file is always cleaned up. The server-side
 * linter checks the URL before approval too — this is the second look, at the moment it
 * matters.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Page } from "playwright";
import { ActionError } from "./xCommon";

const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "image/gif": ".gif",
};

export type StagedImage = { filePath: string; contentType: string; bytes: number; cleanup: () => void };

/** Download to a temp file, refusing anything that isn't plainly a reasonable image. */
export async function stageImage(rawUrl: unknown): Promise<StagedImage> {
  const url = String(rawUrl ?? "").trim();
  if (!/^https:\/\//i.test(url)) {
    throw new ActionError("bad_params", `params.imageUrl must be an https URL (got '${url.slice(0, 80)}')`);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    const why = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
    throw new ActionError("bad_params", `could not fetch imageUrl (${why}) — nothing was posted`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new ActionError("bad_params", `imageUrl returned HTTP ${res.status} — nothing was posted`);
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new ActionError("bad_params", `imageUrl serves '${contentType || "unknown"}', not an image — nothing was posted`);
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_BYTES) {
    throw new ActionError("bad_params", `image is ${(declared / 1048576).toFixed(1)}MB — over the ${MAX_BYTES / 1048576}MB cap`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new ActionError("bad_params", `image is ${(buf.byteLength / 1048576).toFixed(1)}MB — over the ${MAX_BYTES / 1048576}MB cap`);
  }
  if (buf.byteLength < 100) throw new ActionError("bad_params", "imageUrl returned an empty body");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marketer-img-"));
  const filePath = path.join(dir, `image${EXT_BY_TYPE[contentType] ?? ".img"}`);
  fs.writeFileSync(filePath, buf);
  console.log(`[image] staged ${(buf.byteLength / 1024).toFixed(0)}KB ${contentType} → ${filePath}`);

  return {
    filePath, contentType, bytes: buf.byteLength,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/**
 * Attach a staged file to whichever composer is open.
 *
 * Composers hide their `input[type=file]`, which is fine — setInputFiles does not need it to
 * be visible, and going through the real input is what makes the upload identical to a human
 * one. Waits for the platform to acknowledge the attachment, because clicking Post while the
 * upload is still going is how you publish a text-only tweet you meant to have a picture on.
 */
export async function attachImage(page: Page, staged: StagedImage, platform: string): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  const count = await input.count();
  if (!count) throw new ActionError("ui_changed", `no file input in ${platform}'s composer — media upload path may have changed`);

  await input.setInputFiles(staged.filePath);

  // Evidence the platform took it: a preview/thumbnail appears in the composer.
  const previewSelectors: Record<string, string> = {
    twitter: '[data-testid="attachments"] img, [data-testid="media"] img, [aria-label="Remove media"]',
    instagram: 'div[role="dialog"] img[src^="blob:"], img[src^="blob:"]',
    tiktok: 'img[src^="blob:"], video[src^="blob:"]',
    facebook: 'div[role="dialog"] img[src^="blob:"], img[src^="blob:"]',
    youtube: 'img[src^="blob:"]',
  };
  const preview = page.locator(previewSelectors[platform] ?? 'img[src^="blob:"]').first();
  const appeared = await preview.waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
  if (!appeared) {
    throw new ActionError("ambiguous", "the image was handed to the composer but no preview appeared — refusing to send in case it posts without the media");
  }
  console.log(`[image] ${platform}: attachment acknowledged`);
}
