/**
 * Shared machinery for the non-X platform adapters (Instagram, TikTok, YouTube).
 *
 * Mirrors xCommon's role for the rest of the roster: one session lifecycle, one
 * per-platform login gate, and the same failure taxonomy, so the backend routes
 * every platform's failures identically and each adapter stays mostly flow.
 */
import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { launchSession } from "../browser/session";
import { randomWait } from "../browser/humanize";
import { PLATFORM_DEFS, Platform } from "../platforms";
import { guardOutward } from "./identity";
import { ActionError } from "./xCommon";

export { ActionError, toFailure } from "./xCommon";
export type { FailureCode } from "./xCommon";

/** Launch Chrome, hand the callback a fresh page, always close. One action = one browser. */
export async function withPage<T>(config: MarketerConfig, fn: (page: Page) => Promise<T>): Promise<T> {
  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    page.setDefaultTimeout(20_000);
    return await fn(page);
  } finally {
    await session.close();
  }
}

/** Navigate, let the SPA hydrate, and refuse to act while logged out. */
export async function gotoOn(page: Page, platform: Platform, url: string, config: MarketerConfig): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
  await randomWait(2_500, 4_200); // client-side render
  await assertLoggedInOn(page, platform);
  await guardOutward(page, platform); // never act as an account this brand doesn't own
}

export async function assertLoggedInOn(page: Page, platform: Platform): Promise<void> {
  const state = await PLATFORM_DEFS[platform].detectLoggedIn(page).catch(() => null);
  if (state === false) {
    throw new ActionError("login_required", `Not logged in to ${platform} in the automation profile — run \`npm run login\`.`);
  }
}

/** "27.1M" / "1,234" / "685M" / "2789" → number. Null when there's nothing numeric. */
export function parseCount(raw: unknown): number | null {
  const m = String(raw ?? "").trim().match(/^([\d.,]+)\s*([KMB])?/i);
  if (!m || !m[1]) return null;
  const base = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(base)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Math.round(base * mult);
}

export function clampLimit(raw: unknown, dflt: number, max: number): number {
  const n = parseInt(String(raw ?? dflt), 10);
  return Math.min(Math.max(isNaN(n) ? dflt : n, 1), max);
}

/** Validate an https URL against a platform's hosts and hand back the parsed URL. */
export function requireHost(raw: unknown, hosts: string[], label: string): URL {
  const s = String(raw ?? "").trim();
  if (!s) throw new ActionError("bad_params", "targetUrl is required");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ActionError("bad_params", `targetUrl is not a URL: ${s}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ActionError("bad_params", `targetUrl must be http(s): ${s}`);
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  if (!hosts.includes(host)) {
    throw new ActionError("bad_params", `targetUrl must be a ${label} link (got ${u.hostname})`);
  }
  return u;
}

/**
 * Click the first visible dialog/banner button whose name matches — IG's "Not Now"
 * notification nag, cookie sheets, and the like. Returns whether anything was clicked.
 */
export async function dismissDialogButton(page: Page, name: RegExp): Promise<boolean> {
  const btn = page.getByRole("button", { name }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 4_000 }).catch(() => {});
    await randomWait(600, 1_200);
    return true;
  }
  return false;
}

/** The page's visible text — the cheap way to detect soft-failure interstitials. */
export async function bodyText(page: Page): Promise<string> {
  return (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";
}

/**
 * Poll until `read` reports the wanted value (act verification helper). The optimistic
 * UIs on all three platforms lag a beat behind the click, so a single sample lies.
 */
export async function pollFor<T>(
  read: () => Promise<T>,
  wanted: (v: T) => boolean,
  tries = 8,
): Promise<T> {
  let last: T = await read();
  for (let i = 0; i < tries && !wanted(last); i++) {
    await randomWait(450, 900);
    last = await read();
  }
  return last;
}
