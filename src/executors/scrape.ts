import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { launchSession } from "../browser/session";
import { humanizePage, randomWait } from "../browser/humanize";
import { adapterExec } from "./adapters";
import type { Action, ActionResult } from "./index";
import {
  ActionError, extractTweets, focalTweet, gotoX, normalizeXUrl, profileUrl, requireStatusUrl,
  resolveHandle, scrollForTweets, statusIdOf, toFailure, waitForTweets, withX,
} from "./xCommon";

const MAX_TEXT_CHARS = 20_000;

const ALLOWED_HOSTS = [
  "x.com", "twitter.com", "instagram.com", "tiktok.com", "facebook.com", "youtube.com",
];

/**
 * Read side. `params.what` picks the shape:
 *
 *   thread   — a post/video plus the replies/comments under it (structured)
 *   comments — the same, replies only
 *   profile  — a profile's header stats plus recent posts (youtube: also `channel`)
 *   feed     — the X home timeline (X-only)
 *   page     — (default) any allowed page: title + visible text
 *
 * `page` works on all five platforms from one generic path below; the structured
 * modes dispatch per platform — X inline here, the rest via the adapter registry.
 */
export async function runScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const what = String(action.params.what ?? "page").toLowerCase();
  try {
    if (what === "page" || what === "") return await scrapePage(action, config);

    const impl = adapterExec(action.platform, "scrape");
    if (impl) return await impl(action, config);
    if (action.platform && action.platform !== "twitter") {
      throw new ActionError("bad_params", `structured scrape isn't implemented for '${action.platform}' — use what:'page' for a raw read.`);
    }

    switch (what) {
      case "thread":
      case "comments":
        return await scrapeThread(action, config, what === "comments");
      case "profile":
        return await scrapeProfile(action, config);
      case "feed":
        return await scrapeFeed(action, config);
      case "post_metrics":
        return await scrapePostMetrics(action, config);
      default:
        throw new ActionError("bad_params", `params.what must be page|thread|comments|profile|feed|post_metrics (got '${what}')`);
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

/* ── X: batched post metrics (feeds the posts ledger's time series) ── */

/**
 * Read engagement for a batch of our own permalinks in ONE browser session.
 *
 * One session matters: a 25-post sweep that opened 25 browsers would take ten minutes and
 * hammer the profile. A URL that no longer resolves comes back with an error instead of
 * silently vanishing — a deleted post is a finding, not a gap.
 */
async function scrapePostMetrics(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const raw = action.params.urls ?? action.params.targetUrls ?? [];
  if (!Array.isArray(raw) || !raw.length) {
    throw new ActionError("bad_params", "what:'post_metrics' needs params.urls — an array of permalinks (get them from marketer_metric_targets)");
  }
  const urls = raw.slice(0, 30).map((u: unknown) => requireStatusUrl(u));

  return withX(config, async (page) => {
    const out: any[] = [];
    for (const { url, statusId } of urls) {
      try {
        await gotoX(page, url, config);
        const rendered = await waitForTweets(page, 15_000).catch(() => false);
        if (!rendered) { out.push({ permalink: url, error: "not_found" }); continue; }
        const t = (await extractTweets(page, 10)).find((x) => x.permalink?.includes(statusId));
        if (!t) { out.push({ permalink: url, error: "not_matched" }); continue; }
        // Normalized to the ledger's vocabulary: replies→comments, reposts→shares.
        out.push({
          permalink: url,
          metrics: { views: t.metrics.views, likes: t.metrics.likes, comments: t.metrics.replies, shares: t.metrics.reposts },
        });
      } catch (e) {
        out.push({ permalink: url, error: (e as Error).message.slice(0, 120) });
      }
      await randomWait(1_200, 2_600); // a sweep should read like someone scrolling, not a bot
    }
    const withMetrics = out.filter((o) => o.metrics).length;
    console.log(`[scrape] twitter post_metrics: ${withMetrics}/${out.length} read`);
    return { ok: true, result: { what: "post_metrics", platform: "twitter", count: out.length, read: withMetrics, posts: out } };
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
