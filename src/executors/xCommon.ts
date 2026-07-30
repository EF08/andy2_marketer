/**
 * Shared X/Twitter machinery for the act + read executors.
 *
 * Everything that touches x.com goes through here so the flows stay consistent:
 * one session lifecycle, one login gate, one interstitial handler, one tweet
 * extractor, one failure taxonomy. Adding a new X action should be ~60 lines of
 * flow, not another copy of the boilerplate.
 */
import { Locator, Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { launchSession } from "../browser/session";
import { randomWait } from "../browser/humanize";
import { PLATFORM_DEFS } from "../platforms";
import { guardOutward } from "./identity";
import type { ActionResult } from "./index";

/** Structured failure taxonomy — the backend routes on these instead of parsing prose. */
export type FailureCode =
  | "bad_params"
  | "login_required"
  | "not_found"
  | "ui_changed"
  | "rate_limited"
  | "blocked"
  | "ambiguous"
  | "platform_error";

export class ActionError extends Error {
  constructor(public code: FailureCode, message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/** Turn a thrown error into an ActionResult that always carries a machine-readable code. */
export function toFailure(e: unknown): ActionResult {
  const err = e as Error;
  const code: FailureCode = e instanceof ActionError ? e.code : "platform_error";
  return { ok: false, error: `${code}: ${err?.message ?? String(e)}`, result: { failureCode: code } };
}

/* ────────────────────────────── session ────────────────────────────── */

/** Launch Chrome, hand the callback a fresh page, always close. One action = one browser. */
export async function withX<T>(config: MarketerConfig, fn: (page: Page) => Promise<T>): Promise<T> {
  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    page.setDefaultTimeout(20_000);
    return await fn(page);
  } finally {
    await session.close();
  }
}

/** Navigate, let X hydrate, clear interstitials, and refuse to act while logged out. */
export async function gotoX(page: Page, url: string, config: MarketerConfig): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
  await randomWait(2_200, 3_800); // client-side render
  await clearInterstitials(page, config);
  await assertLoggedIn(page);
  await guardOutward(page, "twitter"); // never act as an account this brand doesn't own
}

/**
 * X's soft-failure states. "Something went wrong" is usually transient and one Retry
 * fixes it; a rate-limit banner is not something we should push through, so it throws.
 */
export async function clearInterstitials(page: Page, config: MarketerConfig): Promise<void> {
  const body = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";

  if (/rate limit exceeded|over the daily limit|you are unable to (post|follow)/i.test(body)) {
    throw new ActionError("rate_limited", "X is showing a rate-limit notice — stopping instead of pushing through.");
  }

  if (/something went wrong|try again|retry/i.test(body)) {
    const retry = page.getByRole("button", { name: /^\s*(retry|try again)\s*$/i });
    if (await retry.count().catch(() => 0)) {
      await retry.first().click({ timeout: 5_000 }).catch(() => {});
      await randomWait(2_000, 3_500);
    }
  }

  // Cookie/consent sheets occasionally block clicks on a cold profile.
  const accept = page.getByRole("button", { name: /^(accept all cookies|accept all)$/i });
  if (await accept.count().catch(() => 0)) {
    await accept.first().click({ timeout: 4_000 }).catch(() => {});
    await randomWait(600, 1_400);
  }
}

export async function assertLoggedIn(page: Page): Promise<void> {
  const state = await PLATFORM_DEFS.twitter.detectLoggedIn(page).catch(() => null);
  if (state === false) {
    throw new ActionError("login_required", "Not logged in to X in the automation profile — run `npm run login`.");
  }
}

/** Our own @handle, needed to verify that a post/reply actually landed. */
export async function ownHandle(page: Page): Promise<string | null> {
  const fromNav = await page
    .locator('[data-testid="AppTabBar_Profile_Link"]')
    .first()
    .getAttribute("href", { timeout: 6_000 })
    .then((href) => href?.match(/^\/([A-Za-z0-9_]+)$/)?.[1] ?? null)
    .catch(() => null);
  if (fromNav) return fromNav;

  // Narrow windows collapse the sidebar to icons; the account switcher still carries the text.
  return page
    .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
    .first()
    .innerText({ timeout: 6_000 })
    .then((t) => t.match(/@([A-Za-z0-9_]+)/)?.[1] ?? null)
    .catch(() => null);
}

/* ────────────────────────────── urls + handles ────────────────────────────── */

const X_HOSTS = ["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"];

/** Validate an X URL and normalize it to https://x.com/... (drops trackers + fragments). */
export function normalizeXUrl(raw: unknown): string {
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
  if (!X_HOSTS.includes(host)) {
    throw new ActionError("bad_params", `targetUrl must be an x.com/twitter.com link (got ${u.hostname})`);
  }
  u.protocol = "https:";
  u.hostname = "x.com";
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

export function statusIdOf(url: string): string | null {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}

/** Require a link to a specific tweet (reply/like targets), not just any X page. */
export function requireStatusUrl(raw: unknown): { url: string; statusId: string } {
  const url = normalizeXUrl(raw);
  const statusId = statusIdOf(url);
  if (!statusId) throw new ActionError("bad_params", `targetUrl must point at a specific post (…/status/123…), got ${url}`);
  return { url: `https://x.com${new URL(url).pathname.replace(/\/(photo|video|analytics)\/?\d*$/, "")}`, statusId };
}

const RESERVED_PATHS = new Set([
  "home", "explore", "notifications", "messages", "search", "settings", "i", "compose", "intent",
]);

/** Accept "@handle", "handle", or a profile/status URL → bare handle. */
export function resolveHandle(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new ActionError("bad_params", "a handle (or profile URL) is required");
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(normalizeXUrl(s));
    s = u.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  s = s.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) throw new ActionError("bad_params", `Not a valid X handle: ${raw}`);
  if (RESERVED_PATHS.has(s.toLowerCase())) throw new ActionError("bad_params", `'${s}' is an X system page, not a profile`);
  return s;
}

export const profileUrl = (handle: string) => `https://x.com/${handle}`;

/* ────────────────────────────── tweet extraction ────────────────────────────── */

export type TweetSummary = {
  permalink: string | null;
  authorHandle: string | null;
  authorName: string | null;
  text: string;
  postedAt: string | null;
  metrics: { replies: number | null; reposts: number | null; likes: number | null; views: number | null };
  isPromoted: boolean;
};

/**
 * Read the rendered timeline. Runs in the page so one round-trip returns everything;
 * engagement numbers come from the action bar's aria-label ("12 replies, 3 reposts, …"),
 * which stays stable even when X reshuffles the visible count markup.
 */
export async function extractTweets(page: Page, max: number): Promise<TweetSummary[]> {
  return page.evaluate((maxItems: number) => {
    const out: any[] = [];
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    for (const a of articles) {
      if (out.length >= maxItems) break;

      const textEl = a.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
      const text = (textEl?.innerText ?? "").trim();

      const timeEl = a.querySelector("time") as HTMLTimeElement | null;
      const link = timeEl?.closest("a") as HTMLAnchorElement | null;
      const href = link?.getAttribute("href") ?? null;
      const permalink = href && href.includes("/status/") ? "https://x.com" + href : null;
      const authorHandle = href?.match(/^\/([A-Za-z0-9_]+)\/status\//)?.[1] ?? null;

      const nameEl = a.querySelector('[data-testid="User-Name"]') as HTMLElement | null;
      const authorName = (nameEl?.innerText ?? "").split("\n")[0]?.trim() || null;

      // X's action-bar aria-label reads "2 reposts, 2 likes, 33 views" — and OMITS any
      // metric that is zero. So inside a label that exists, a missing word means 0;
      // no label at all means we genuinely don't know.
      const label = (a.querySelector('[role="group"][aria-label]') as HTMLElement | null)?.getAttribute("aria-label") ?? "";
      const num = (word: string) => {
        if (!label) return null;
        const m = label.match(new RegExp("([\\d,]+)\\s+" + word, "i"));
        return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
      };

      const isPromoted = /(^|\n)(Promoted|Ad)(\n|$)/.test((a as HTMLElement).innerText ?? "");

      if (!text && !permalink) continue; // skeleton/placeholder cell
      out.push({
        permalink,
        authorHandle,
        authorName,
        text,
        postedAt: timeEl?.getAttribute("datetime") ?? null,
        metrics: { replies: num("repl"), reposts: num("repost"), likes: num("like"), views: num("view") },
        isPromoted,
      });
    }
    return out;
  }, max);
}

/** Wait for the timeline to paint. Returns false on a legitimately empty result set. */
export async function waitForTweets(page: Page, timeoutMs = 20_000): Promise<boolean> {
  try {
    await page.locator('article[data-testid="tweet"]').first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (/no results for|didn't return any results|doesn.t exist|this account doesn/i.test(body)) return false;
    throw new ActionError("ui_changed", "No posts rendered and no empty-state message — X's layout may have changed.");
  }
}

/** Scroll the timeline until `want` tweets are rendered (or it stops growing). */
export async function scrollForTweets(page: Page, want: number, maxScrolls = 12): Promise<void> {
  let seen = await page.locator('article[data-testid="tweet"]').count();
  for (let i = 0; i < maxScrolls && seen < want; i++) {
    await page.mouse.wheel(0, 1_200 + Math.floor(Math.random() * 900));
    await randomWait(900, 1_800);
    const now = await page.locator('article[data-testid="tweet"]').count();
    if (now === seen) break; // hit the end (or a load stall) — don't spin
    seen = now;
  }
}

/**
 * The tweet a /status/ URL is actually about. It is NOT always the first article:
 * when the target is itself a reply, X renders the parent above it. Layered detection —
 * a self-link to the id, then the focal tweet's tabindex marker, then position.
 */
export async function focalTweet(page: Page, statusId: string): Promise<Locator> {
  const articles = page.locator('article[data-testid="tweet"]');
  const count = await articles.count();
  if (count === 0) throw new ActionError("not_found", "No post rendered at that URL (deleted, protected, or wrong link).");

  for (let i = 0; i < count; i++) {
    const a = articles.nth(i);
    if (await a.locator(`a[href*="/status/${statusId}"]`).count()) return a;
  }
  for (let i = 0; i < count; i++) {
    const a = articles.nth(i);
    if ((await a.getAttribute("tabindex")) === "-1") return a;
  }
  return articles.first();
}

export async function tweetText(article: Locator): Promise<string> {
  return (await article.locator('[data-testid="tweetText"]').first().innerText().catch(() => "")).trim();
}

/**
 * Find a post by a snippet of its text (optionally restricted to one author) and return
 * its permalink — this is how every act type proves it actually landed.
 */
export async function findPermalinkByText(
  page: Page,
  snippet: string,
  authorHandle?: string | null,
): Promise<string | null> {
  const tweets = await extractTweets(page, 40);
  const needle = snippet.trim().slice(0, 60);
  const hit = tweets.find(
    (t) => t.text.includes(needle) && (!authorHandle || t.authorHandle?.toLowerCase() === authorHandle.toLowerCase()),
  );
  return hit?.permalink ?? null;
}

/* ────────────────────────────── composer ────────────────────────────── */

/**
 * Press X's send button for whichever composer is open — the inline one (home timeline,
 * status pages) or the modal one. Refuses to fall back to Ctrl+Enter after a click,
 * because a double-send is worse than a failed send.
 */
export async function submitComposer(page: Page): Promise<void> {
  for (const sel of ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]']) {
    const btn = page.locator(sel).last();
    if (!(await btn.count())) continue;
    if (!(await btn.isVisible().catch(() => false))) continue;

    // The button enables a beat after the last keystroke lands in the draft state.
    // X marks it aria-disabled rather than disabled, so check both.
    let enabled = false;
    for (let i = 0; i < 12 && !enabled; i++) {
      const aria = await btn.getAttribute("aria-disabled").catch(() => null);
      enabled = aria !== "true" && (await btn.isEnabled().catch(() => false));
      if (!enabled) await randomWait(300, 600);
    }
    if (!enabled) throw new ActionError("ambiguous", "X's send button never enabled — nothing was sent.");
    await btn.click({ timeout: 10_000 });
    return;
  }
  throw new ActionError("ui_changed", "Could not find X's send button (neither tweetButtonInline nor tweetButton).");
}

export type SendOutcome = { sent: boolean; permalink: string | null; toast: string | null };

/**
 * Did it actually go out?
 *
 * Evidence order matters here. X's success toast carries a "View" link straight to the new
 * post — that link is proof AND the permalink, so it's what we want. An error toast is
 * proof of the opposite. Only if no toast appears at all do we fall back to "the composer
 * emptied", which is the weakest signal: a strict-mode locator error used to make that read
 * as an empty composer and report a post that never happened.
 */
export async function waitForSendConfirmation(page: Page, composer: Locator, tries = 24): Promise<SendOutcome> {
  let composerCleared = false;
  let clearedAt = -1;

  for (let i = 0; i < tries; i++) {
    await randomWait(400, 800);

    const toast = page.locator('[data-testid="toast"]').first();
    if (await toast.count().catch(() => 0)) {
      const toastText = ((await toast.innerText({ timeout: 1_500 }).catch(() => "")) || "").trim();
      const href = await toast.locator('a[href*="/status/"]').first()
        .getAttribute("href", { timeout: 1_500 }).catch(() => null);
      if (href) return { sent: true, permalink: "https://x.com" + href.split("?")[0], toast: toastText };
      if (/went wrong|whoops|could ?n.t|try again|failed|error|not sent|over the limit/i.test(toastText)) {
        return { sent: false, permalink: null, toast: toastText };
      }
      return { sent: true, permalink: null, toast: toastText };
    }

    // Composer gone entirely (modal closed) or visibly emptied.
    if ((await composer.count().catch(() => 1)) === 0) {
      composerCleared = true;
    } else {
      const left = (await composer.innerText({ timeout: 1_500 }).catch(() => null))?.trim();
      if (left === "") composerCleared = true;
    }
    if (composerCleared && clearedAt < 0) clearedAt = i;
    // Give the toast a few more beats to appear before trusting the weaker signal alone.
    if (composerCleared && i - clearedAt >= 5) break;
  }
  return { sent: composerCleared, permalink: null, toast: null };
}

/** Compact evidence for the ledger — what the agent was looking at when it acted. */
export function evidence(article: TweetSummary | null, extra: Record<string, unknown> = {}) {
  return {
    target: article
      ? { permalink: article.permalink, author: article.authorHandle, text: article.text.slice(0, 200) }
      : null,
    ...extra,
  };
}
