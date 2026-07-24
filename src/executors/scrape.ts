import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { launchSession } from "../browser/session";
import { humanizePage, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import {
  ActionError, extractTweets, focalTweet, gotoX, normalizeXUrl, profileUrl, resolveHandle,
  scrollForTweets, statusIdOf, toFailure, waitForTweets, withX,
} from "./xCommon";

const MAX_TEXT_CHARS = 20_000;

const ALLOWED_HOSTS = [
  "x.com", "twitter.com", "instagram.com", "tiktok.com", "facebook.com", "youtube.com",
];

/**
 * Read side. `params.what` picks the shape:
 *
 *   thread   — an X post plus the replies under it (structured)
 *   comments — the same, replies only
 *   profile  — an X profile's header stats plus recent posts
 *   feed     — the X home timeline
 *   page     — (default) any allowed page: title + visible text
 *
 * The structured modes are X-only for now; `page` still works on all five platforms,
 * which is what makes "read that IG profile" answerable today.
 */
export async function runScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const what = String(action.params.what ?? "page").toLowerCase();
  try {
    switch (what) {
      case "thread":
      case "comments":
        return await scrapeThread(action, config, what === "comments");
      case "profile":
        return await scrapeProfile(action, config);
      case "feed":
        return await scrapeFeed(action, config);
      case "page":
      case "":
        return await scrapePage(action, config);
      default:
        throw new ActionError("bad_params", `params.what must be page|thread|comments|profile|feed (got '${what}')`);
    }
  } catch (e) {
    return toFailure(e);
  }
}

/* ── generic: any allowed host, title + visible text ── */

async function scrapePage(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const targetUrl = String(action.params.targetUrl ?? "");
  let url: URL;
  try { url = new URL(targetUrl); } catch { throw new ActionError("bad_params", `Bad targetUrl: ${targetUrl}`); }
  const allowed = url.protocol === "https:" &&
    ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
  if (!allowed) throw new ActionError("bad_params", `Host not allowed: ${url.hostname}. Allowed: ${ALLOWED_HOSTS.join(", ")}`);

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
        what: "page", url: page.url(), title, chars: squeezed.length,
        truncated: squeezed.length > MAX_TEXT_CHARS, text: squeezed.slice(0, MAX_TEXT_CHARS),
      },
    };
  } finally {
    await session.close();
  }
}

/* ── X: thread / comments ── */

async function scrapeThread(action: Action, config: MarketerConfig, commentsOnly: boolean): Promise<ActionResult> {
  const url = normalizeXUrl(action.params.targetUrl);
  const statusId = statusIdOf(url);
  if (!statusId) throw new ActionError("bad_params", `what=${commentsOnly ? "comments" : "thread"} needs a post URL (…/status/123…)`);
  const limit = clamp(action.params.limit, 25, 100);

  return withX(config, async (page) => {
    await gotoX(page, url, config);
    await waitForTweets(page);
    await scrollForTweets(page, limit + 1);

    const focal = await focalTweet(page, statusId);
    const focalHandle = (await focal.locator('a[href*="/status/"]').first().getAttribute("href").catch(() => null))
      ?.match(/^\/([A-Za-z0-9_]+)\//)?.[1] ?? null;

    const all = await extractTweets(page, limit + 15);
    const idx = all.findIndex((t) => t.permalink?.includes(statusId));
    const post = idx >= 0 ? all[idx] : null;
    const replies = (idx >= 0 ? all.slice(idx + 1) : all).filter((t) => !t.isPromoted).slice(0, limit);

    console.log(`[scrape] twitter ${commentsOnly ? "comments" : "thread"}: ${replies.length} replies`);
    return {
      ok: true,
      result: commentsOnly
        ? { what: "comments", url, count: replies.length, comments: replies }
        : {
            what: "thread", url,
            post: post ?? { note: "focal post could not be matched by id", authorHandle: focalHandle },
            replyCount: replies.length, replies,
          },
    };
  });
}

/* ── X: profile ── */

async function scrapeProfile(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
  const limit = clamp(action.params.limit, 15, 60);
  // X's Posts tab excludes replies, so an account that mostly replies looks empty there.
  const includeReplies = action.params.includeReplies === true;
  const timelineUrl = includeReplies ? `${profileUrl(handle)}/with_replies` : profileUrl(handle);

  return withX(config, async (page) => {
    await gotoX(page, timelineUrl, config);
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (/this account doesn.t exist/i.test(body)) throw new ActionError("not_found", `@${handle} doesn't exist.`);

    const header = await readProfileHeader(page);
    let posts: Awaited<ReturnType<typeof extractTweets>> = [];
    if (await waitForTweets(page, 20_000).catch(() => false)) {
      await scrollForTweets(page, limit);
      posts = (await extractTweets(page, limit + 5)).filter((t) => !t.isPromoted).slice(0, limit);
    }

    console.log(`[scrape] twitter profile @${handle}: ${posts.length} posts, ${header.followers ?? "?"} followers`);
    return {
      ok: true,
      result: {
        what: "profile", handle, profileUrl: profileUrl(handle), timelineUrl, includeReplies,
        ...header, postCount: posts.length, posts,
        note: posts.length === 0 && !includeReplies
          ? "The Posts tab is empty — this account may only ever reply. Re-run with includeReplies:true to see those."
          : undefined,
      },
    };
  });
}

/** Header stats. Counts come from the following/followers links, which carry the raw number. */
async function readProfileHeader(page: Page) {
  return page.evaluate(() => {
    const txt = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim() ?? null;
    const countFrom = (hrefEnd: string) => {
      const a = Array.from(document.querySelectorAll("a")).find((x) => (x.getAttribute("href") ?? "").endsWith(hrefEnd));
      const m = (a as HTMLElement | undefined)?.innerText?.trim().match(/^([\d.,]+)\s*([KMB])?/i);
      if (!m) return null;
      const base = parseFloat(m[1].replace(/,/g, ""));
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
      return Math.round(base * mult);
    };
    const name = (txt('[data-testid="UserName"]') ?? "").split("\n")[0] || null;
    return {
      name,
      bio: txt('[data-testid="UserDescription"]'),
      location: txt('[data-testid="UserLocation"]'),
      joined: txt('[data-testid="UserJoinDate"]'),
      website: (document.querySelector('[data-testid="UserUrl"]') as HTMLAnchorElement | null)?.href ?? null,
      following: countFrom("/following"),
      followers: countFrom("/verified_followers") ?? countFrom("/followers"),
    };
  });
}

/* ── X: home feed ── */

async function scrapeFeed(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const limit = clamp(action.params.limit, 20, 60);
  return withX(config, async (page) => {
    await gotoX(page, "https://x.com/home", config);
    await waitForTweets(page);
    await scrollForTweets(page, limit);
    const posts = (await extractTweets(page, limit + 10)).filter((t) => !t.isPromoted).slice(0, limit);
    console.log(`[scrape] twitter feed: ${posts.length} posts`);
    return { ok: true, result: { what: "feed", count: posts.length, posts } };
  });
}

function clamp(raw: unknown, dflt: number, max: number): number {
  const n = parseInt(String(raw ?? dflt), 10);
  return Math.min(Math.max(isNaN(n) ? dflt : n, 1), max);
}
