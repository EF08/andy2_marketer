import { MarketerConfig } from "../config/types";
import { launchSession } from "../browser/session";
import { humanizePage, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";

const MAX_TEXT_CHARS = 20_000;

const ALLOWED_HOSTS = [
  "x.com", "twitter.com", "instagram.com", "tiktok.com", "facebook.com", "youtube.com",
];

/**
 * Generic page scrape: navigate, humanize, return title + visible text (capped).
 * Phase 1 replaces this with proper per-platform adapters (structured posts/comments/
 * metrics like andy2_crawler's); this generic version already answers "what's on X page".
 */
export async function runScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const targetUrl = String(action.params.targetUrl ?? "");
  let url: URL;
  try { url = new URL(targetUrl); } catch { return { ok: false, error: `Bad targetUrl: ${targetUrl}` }; }
  const allowed = url.protocol === "https:" &&
    ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
  if (!allowed) return { ok: false, error: `Host not allowed: ${url.hostname}. Allowed: ${ALLOWED_HOSTS.join(", ")}` };

  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
    await randomWait(2_000, 4_000);
    await humanizePage(page, config.behavior);

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const squeezed = text.replace(/\n{3,}/g, "\n\n").trim();
    return {
      ok: true,
      result: {
        url: page.url(),
        title,
        chars: squeezed.length,
        truncated: squeezed.length > MAX_TEXT_CHARS,
        text: squeezed.slice(0, MAX_TEXT_CHARS),
      },
    };
  } finally {
    await session.close();
  }
}
