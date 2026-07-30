/**
 * YouTube adapter — act + read flows for youtube.com in the logged-in profile.
 *
 * YouTube's polymer DOM exposes stable custom-element tags and ids (verified live,
 * Jul 2026): like-button-view-model button carries aria-pressed; the subscribe
 * button flips its text Subscribe⇄Subscribed; comments live in
 * ytd-comment-thread-renderer with #author-text/#content-text; the comment box is
 * ytd-comment-simplebox-renderer (#placeholder-area → #contenteditable-root →
 * #submit-button). Comments lazy-load on scroll, so every comment flow scrolls first.
 *
 * follow == subscribe here. Not supported: `dm` (YouTube removed direct messages
 * in 2019) and `post` (uploads are planned to go through the official Data API —
 * MASTERPLAN decision #3 — and community posts need channel-level access).
 */
import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { humanType, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import {
  ActionError, bodyText, clampLimit, gotoOn, parseCount, pollFor, requireHost, toFailure, withPage,
} from "./webCommon";

const YT = "https://www.youtube.com";
const YT_HOSTS = ["youtube.com", "m.youtube.com", "youtu.be"];
const MAX_COMMENT_CHARS = 5_000;

/* ────────────────────────────── urls + handles ────────────────────────────── */

function requireVideoUrl(raw: unknown): { url: string; videoId: string } {
  const u = requireHost(raw, YT_HOSTS, "youtube.com");
  const id =
    u.hostname.replace(/^www\./, "") === "youtu.be"
      ? u.pathname.split("/").filter(Boolean)[0]
      : u.pathname.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,15})/)?.[1] ?? u.searchParams.get("v") ?? undefined;
  if (!id || !/^[A-Za-z0-9_-]{6,15}$/.test(id)) {
    throw new ActionError("bad_params", `targetUrl must point at a video (watch?v=…, youtu.be/…, or /shorts/…), got ${String(raw)}`);
  }
  return { url: `${YT}/watch?v=${id}`, videoId: id };
}

/** Accept "@handle", a /channel/UC… id, or any channel URL → canonical channel URL. */
function resolveChannelUrl(raw: unknown): { url: string; label: string } {
  let s = String(raw ?? "").trim();
  if (!s) throw new ActionError("bad_params", "a channel (@handle or URL) is required");
  if (/^https?:\/\//i.test(s)) {
    const u = requireHost(s, YT_HOSTS, "youtube.com");
    const m = u.pathname.match(/^\/(@[\w.\-]{3,31}|channel\/UC[\w-]{10,}|c\/[\w.\-]+|user\/[\w.\-]+)/);
    if (!m) throw new ActionError("bad_params", `Not a channel URL: ${s}`);
    return { url: `${YT}/${m[1]}`, label: m[1] };
  }
  if (/^UC[\w-]{10,}$/.test(s)) return { url: `${YT}/channel/${s}`, label: s };
  s = s.startsWith("@") ? s : `@${s}`;
  if (!/^@[\w.\-]{3,31}$/.test(s)) throw new ActionError("bad_params", `Not a valid YouTube handle: ${raw}`);
  return { url: `${YT}/${s}`, label: s };
}

/* ────────────────────────────── navigation ────────────────────────────── */

async function gotoYt(page: Page, url: string, config: MarketerConfig): Promise<void> {
  await gotoOn(page, "youtube", url, config);
  const body = await bodyText(page);
  if (/before you continue to youtube/i.test(body)) {
    // The consent wall (rare on a logged-in US profile, but a hard blocker when it shows).
    const accept = page.getByRole("button", { name: /^accept all$/i }).first();
    if (await accept.count()) {
      await accept.click({ timeout: 6_000 }).catch(() => {});
      await randomWait(1_500, 2_500);
    }
  }
}

/* ────────────────────────────── watch page helpers ────────────────────────────── */

// Scoped to the watch-metadata action row: YouTube's AI-summary section carries its
// own (sometimes hidden) like-button-view-model that an unscoped selector grabs first.
const LIKE_BTN = "ytd-watch-metadata like-button-view-model button, ytd-watch-metadata #segmented-like-button button, #top-level-buttons-computed like-button-view-model button";
const SUB_BTN = "#subscribe-button button, yt-subscribe-button-view-model button, ytd-subscribe-button-renderer button";

async function likeState(page: Page): Promise<boolean | null> {
  const pressed = await page.locator(LIKE_BTN).first().getAttribute("aria-pressed").catch(() => null);
  return pressed === null ? null : pressed === "true";
}

type YtVideoMeta = { title: string | null; channel: string | null; channelUrl: string | null; subscribers: string | null; info: string | null; likes: number | null };

async function videoMeta(page: Page): Promise<YtVideoMeta> {
  return page
    .evaluate(() => {
      const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      const likeBtn = q("ytd-watch-metadata like-button-view-model button, ytd-watch-metadata #segmented-like-button button, #top-level-buttons-computed like-button-view-model button");
      const likeAria = likeBtn?.getAttribute("aria-label") ?? "";
      return {
        title: q("ytd-watch-metadata h1")?.innerText?.trim() ?? null,
        channel: q("#owner ytd-channel-name a")?.innerText?.trim() ?? null,
        channelHref: q("#owner ytd-channel-name a")?.getAttribute("href") ?? null,
        subscribers: q("#owner-sub-count")?.innerText?.trim() ?? null,
        info: q("ytd-watch-info-text, #info-container")?.innerText?.replace(/\s+/g, " ")?.trim()?.slice(0, 200) ?? null,
        likesRaw: likeAria.match(/([\d,.]+[KMB]?)\s+other people/i)?.[1] ?? likeBtn?.innerText?.trim() ?? null,
      };
    })
    .then((m: any) => ({
      title: m.title, channel: m.channel, subscribers: m.subscribers, info: m.info,
      channelUrl: m.channelHref ? YT + m.channelHref : null,
      likes: parseCount(m.likesRaw),
    }))
    .catch(() => ({ title: null, channel: null, channelUrl: null, subscribers: null, info: null, likes: null }));
}

type YtComment = { author: string | null; text: string; time: string | null; likes: number | null };

async function extractComments(page: Page, max: number): Promise<YtComment[]> {
  return page
    .evaluate((maxItems: number) => {
      const out: any[] = [];
      for (const t of Array.from(document.querySelectorAll("ytd-comment-thread-renderer"))) {
        if (out.length >= maxItems) break;
        const text = (t.querySelector("#content-text") as HTMLElement | null)?.innerText?.trim();
        if (!text) continue;
        out.push({
          author: (t.querySelector("#author-text") as HTMLElement | null)?.innerText?.trim() ?? null,
          text: text.slice(0, 400),
          time: (t.querySelector("#published-time-text, .published-time-text") as HTMLElement | null)?.innerText?.trim() ?? null,
          likesRaw: (t.querySelector("#vote-count-middle") as HTMLElement | null)?.innerText?.trim() ?? null,
        });
      }
      return out;
    }, max)
    .then((rows: any[]) => rows.map((r) => ({ author: r.author, text: r.text, time: r.time, likes: parseCount(r.likesRaw) })))
    .catch(() => []);
}

/** Comments only mount after the page scrolls — get the section rendered, then feed it. */
async function scrollToComments(page: Page, want: number, maxScrolls = 12): Promise<boolean> {
  for (let i = 0; i < maxScrolls; i++) {
    const threads = await page.locator("ytd-comment-thread-renderer").count();
    const boxThere = (await page.locator("ytd-comment-simplebox-renderer").count()) > 0;
    if ((threads >= want && want > 0) || (want === 0 && boxThere)) return true;
    if (boxThere && threads > 0 && want > 0) {
      const grew = threads;
      await page.mouse.wheel(0, 1_500 + Math.floor(Math.random() * 800));
      await randomWait(1_000, 1_800);
      if ((await page.locator("ytd-comment-thread-renderer").count()) === grew && i > 3) return true; // stopped growing
      continue;
    }
    await page.mouse.wheel(0, 900 + Math.floor(Math.random() * 600));
    await randomWait(800, 1_500);

    const body = await bodyText(page);
    if (/comments are turned off/i.test(body)) return false;
  }
  return (await page.locator("ytd-comment-simplebox-renderer").count()) > 0;
}

/* ────────────────────────────── act: like ────────────────────────────── */

async function ytLike(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url } = requireVideoUrl(action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoYt(page, url, config);
      const body = await bodyText(page);
      if (/video unavailable|this video is private/i.test(body)) {
        throw new ActionError("not_found", "No video at that URL (deleted, private, or wrong link).");
      }

      const btn = page.locator(LIKE_BTN).first();
      await btn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "No like button on the watch page — YouTube's layout may have changed.");
      });
      const meta = await videoMeta(page);
      const target = { url, author: meta.channel, text: meta.title?.slice(0, 200) ?? null };

      const wasLiked = await likeState(page);
      if (wasLiked === null) throw new ActionError("ui_changed", "The like button carries no aria-pressed state.");

      const wanted = !undo;
      if (wasLiked === wanted) {
        return {
          ok: true,
          result: {
            platform: "youtube", action: undo ? "unlike" : "like", targetUrl: url,
            changed: false, liked: wasLiked, verified: true, target,
            note: `already ${wasLiked ? "liked" : "not liked"} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "youtube", action: undo ? "unlike" : "like", dryRun: true, targetUrl: url,
            changed: false, liked: wasLiked, verified: null, target,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await btn.click({ timeout: 10_000 });
      const nowLiked = await pollFor(() => likeState(page), (v) => v === wanted);
      const verified = nowLiked === wanted;
      console.log(`[like] youtube: ${undo ? "unlike" : "like"} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but aria-pressed never flipped — the like may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "youtube", action: undo ? "unlike" : "like", targetUrl: url,
          changed: verified, liked: nowLiked ?? wasLiked, verified, target,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: comment ────────────────────────────── */

async function ytComment(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url } = requireVideoUrl(action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_COMMENT_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_COMMENT_CHARS} cap`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoYt(page, url, config);
      const body = await bodyText(page);
      if (/video unavailable|this video is private/i.test(body)) {
        throw new ActionError("not_found", "No video at that URL (deleted, private, or wrong link).");
      }
      const meta = await videoMeta(page);
      const target = { url, author: meta.channel, text: meta.title?.slice(0, 200) ?? null };

      const boxRendered = await scrollToComments(page, 0);
      if (!boxRendered) {
        throw new ActionError("blocked", "Comments are turned off on this video.");
      }

      const box = page.locator("ytd-comment-simplebox-renderer").first();
      await box.locator("#placeholder-area").first().click({ timeout: 10_000 });
      const editable = box.locator("#contenteditable-root").first();
      await editable.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
        throw new ActionError("ui_changed", "The comment editor never opened after clicking the placeholder.");
      });
      await randomWait(400, 900);
      await humanType(page, text); // submit is a button — Enter just breaks lines here
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "youtube", action: "comment", dryRun: true, targetUrl: url, chars: text.length,
            sent: false, verified: null, target, note: "dryRun — comment editor filled, nothing was sent.",
          },
        };
      }

      const submit = box.locator("#submit-button button, #submit-button").first();
      let enabled = false;
      for (let i = 0; i < 12 && !enabled; i++) {
        enabled = (await submit.getAttribute("aria-disabled").catch(() => null)) !== "true" && (await submit.isEnabled().catch(() => false));
        if (!enabled) await randomWait(300, 600);
      }
      if (!enabled) throw new ActionError("ambiguous", "YouTube's Comment button never enabled — nothing was sent.");
      await submit.click({ timeout: 10_000 });
      console.log(`[comment] youtube: clicked Comment (${text.length} chars)`);

      // Verify-after-act: fresh comments render at the top of the thread list.
      const snippet = text.split("\n")[0].slice(0, 40);
      const verified = await pollFor(
        async () => (await extractComments(page, 8)).some((c) => c.text.includes(snippet)),
        (v) => v,
        14,
      );
      console.log(`[comment] youtube: sent verified=${verified}`);

      return {
        ok: true,
        result: {
          platform: "youtube", action: "comment", chars: text.length,
          sent: true, verified, permalink: url, targetUrl: url, target,
          note: verified ? undefined : "sent, but the comment could not be found at the top of the thread — YouTube may be holding it for review",
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: follow (subscribe) ────────────────────────────── */

async function ytFollow(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const rawTarget = action.params.handle ?? action.params.targetUrl;
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    // A watch URL works too — the subscribe button lives in the owner row.
    let navUrl: string;
    let label: string;
    const asVideo = (() => { try { return requireVideoUrl(rawTarget); } catch { return null; } })();
    if (asVideo) {
      navUrl = asVideo.url;
      label = asVideo.url;
    } else {
      const ch = resolveChannelUrl(rawTarget);
      navUrl = ch.url;
      label = ch.label;
    }

    return await withPage(config, async (page) => {
      await gotoYt(page, navUrl, config);
      const body = await bodyText(page);
      if (/this page isn'?t available|404 not found/i.test(body)) {
        throw new ActionError("not_found", `${label} doesn't exist.`);
      }

      const btn = page.locator(SUB_BTN).first();
      await btn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "No subscribe button rendered — layout changed, or this is our own channel.");
      });

      const readState = async (): Promise<boolean | null> => {
        const t = ((await btn.innerText().catch(() => "")) || "").trim().toLowerCase();
        if (/^subscribed/.test(t)) return true;
        if (/^subscribe/.test(t)) return false;
        return null;
      };
      const was = await readState();
      if (was === null) throw new ActionError("ui_changed", "Subscribe button text was unrecognizable.");

      const channelName = await page
        .locator("#owner ytd-channel-name a, yt-page-header-view-model h1")
        .first()
        .innerText()
        .then((t) => t.trim())
        .catch(() => null);

      const wanted = !undo;
      if (was === wanted) {
        return {
          ok: true,
          result: {
            platform: "youtube", action: undo ? "unsubscribe" : "subscribe", channel: channelName, target: label,
            changed: false, following: was, verified: true,
            note: `already ${was ? "subscribed" : "not subscribed"} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "youtube", action: undo ? "unsubscribe" : "subscribe", dryRun: true, channel: channelName, target: label,
            changed: false, following: was, verified: null,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await btn.click({ timeout: 10_000 });
      if (undo) {
        // Subscribed → menu with "Unsubscribe" → confirm dialog.
        await randomWait(700, 1_300);
        const menuItem = page.getByRole("menuitem", { name: /unsubscribe/i }).first();
        if (await menuItem.count().catch(() => 0)) {
          await menuItem.click({ timeout: 8_000 }).catch(() => {});
          await randomWait(600, 1_200);
        }
        const confirm = page.locator("#confirm-button button, #confirm-button").last();
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.click({ timeout: 8_000 }).catch(() => {});
        }
      }

      const now = await pollFor(readState, (v) => v === wanted);
      const verified = now === wanted;
      console.log(`[follow] youtube: ${undo ? "unsubscribe" : "subscribe"} ${label} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the subscription may not have changed.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "youtube", action: undo ? "unsubscribe" : "subscribe", channel: channelName, target: label,
          changed: verified, following: now ?? was, verified,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: search ────────────────────────────── */

async function ytSearch(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const query = String(action.params.query ?? "").trim();
    if (!query) throw new ActionError("bad_params", "params.query is required");
    if (query.length > 200) throw new ActionError("bad_params", "params.query is too long (max 200 chars)");

    const rawTab = String(action.params.tab ?? "videos").toLowerCase();
    const tab = /^channels?$/.test(rawTab) ? "channels" : "videos";
    const limit = clampLimit(action.params.limit, 15, 40);
    const url = `${YT}/results?search_query=${encodeURIComponent(query)}${tab === "channels" ? "&sp=EgIQAg%3D%3D" : ""}`;

    return await withPage(config, async (page) => {
      await gotoYt(page, url, config);

      const anyResult = page.locator("ytd-video-renderer, ytd-channel-renderer").first();
      const rendered = await anyResult.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
      if (!rendered) {
        const body = await bodyText(page);
        if (/no results found/i.test(body)) {
          return { ok: true, result: { platform: "youtube", query, tab, count: 0, results: [], searchUrl: url, note: "YouTube returned no results for this query." } };
        }
        throw new ActionError("ui_changed", "No search results rendered and no empty-state message.");
      }
      for (let i = 0; i < 6; i++) {
        if ((await page.locator("ytd-video-renderer, ytd-channel-renderer").count()) >= limit) break;
        await page.mouse.wheel(0, 1_500);
        await randomWait(900, 1_600);
      }

      if (tab === "channels") {
        const channels: any[] = await page.evaluate((max: number) => {
          const out: any[] = [];
          for (const c of Array.from(document.querySelectorAll("ytd-channel-renderer"))) {
            if (out.length >= max) break;
            const info = ((c as HTMLElement).innerText ?? "").replace(/\s+/g, " ");
            out.push({
              name: (c.querySelector("ytd-channel-name #text") as HTMLElement | null)?.innerText?.trim() ?? null,
              href: c.querySelector("a#main-link")?.getAttribute("href") ?? null,
              handle: info.match(/@[\w.\-]+/)?.[0] ?? null,
              subscribersRaw: info.match(/([\d.,]+[KMB]?) subscribers/i)?.[1] ?? null,
              bio: info.split("subscribers").slice(1).join(" ").replace(/Subscribe(d)?\s*$/i, "").trim().slice(0, 200) || null,
            });
          }
          return out;
        }, limit).catch(() => []);
        const users = channels.map((c) => ({
          name: c.name, handle: c.handle, bio: c.bio,
          subscribers: parseCount(c.subscribersRaw),
          channelUrl: c.href ? (c.href.startsWith("http") ? c.href : YT + c.href) : null,
        }));
        console.log(`[search] youtube: "${query}" (channels) → ${users.length} channels`);
        return { ok: true, result: { platform: "youtube", query, tab, count: users.length, channels: users, searchUrl: url } };
      }

      const vids: any[] = await page.evaluate((max: number) => {
        const out: any[] = [];
        for (const v of Array.from(document.querySelectorAll("ytd-video-renderer"))) {
          if (out.length >= max) break;
          const a = v.querySelector("a#video-title");
          const href = a?.getAttribute("href") ?? null;
          if (!href) continue;
          const meta = Array.from(v.querySelectorAll("#metadata-line span")).map((s) => (s as HTMLElement).innerText.trim());
          out.push({
            title: (a as HTMLElement).innerText?.trim()?.slice(0, 150) ?? null,
            permalink: "https://www.youtube.com" + href.split("&")[0],
            channel: (v.querySelector("ytd-channel-name a") as HTMLElement | null)?.innerText?.trim() ?? null,
            channelUrl: v.querySelector("ytd-channel-name a")?.getAttribute("href") ?? null,
            viewsRaw: meta.find((m) => /view|watching/i.test(m)) ?? null,
            age: meta.find((m) => /ago|streamed/i.test(m)) ?? null,
          });
        }
        return out;
      }, limit).catch(() => []);

      const results = vids.map((v) => ({
        title: v.title, permalink: v.permalink, channel: v.channel,
        channelUrl: v.channelUrl ? YT + v.channelUrl : null,
        views: parseCount(v.viewsRaw), age: v.age,
        isLive: /watching/i.test(v.viewsRaw ?? ""),
      }));
      console.log(`[search] youtube: "${query}" (videos) → ${results.length} results`);
      return { ok: true, result: { platform: "youtube", query, tab, count: results.length, results, searchUrl: url } };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: scrape ────────────────────────────── */

async function ytScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const what = String(action.params.what ?? "").toLowerCase();
  try {
    switch (what) {
      case "thread":
      case "video":
      case "comments":
        return await scrapeVideo(action, config, what === "comments");
      case "profile":
      case "channel":
        return await scrapeChannel(action, config);
      case "post_metrics":
        return await scrapePostMetrics(action, config);
      default:
        throw new ActionError("bad_params", `for youtube, params.what must be video|thread|comments|channel|profile|post_metrics|page (got '${what}')`);
    }
  } catch (e) {
    return toFailure(e);
  }
}

async function scrapeVideo(action: Action, config: MarketerConfig, commentsOnly: boolean): Promise<ActionResult> {
  const { url } = requireVideoUrl(action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 25, 80);

  return withPage(config, async (page) => {
    await gotoYt(page, url, config);
    const body = await bodyText(page);
    if (/video unavailable|this video is private/i.test(body)) {
      throw new ActionError("not_found", "No video at that URL (deleted, private, or wrong link).");
    }

    const commentsOn = await scrollToComments(page, limit);
    const meta = await videoMeta(page);
    const comments = commentsOn ? (await extractComments(page, limit)).slice(0, limit) : [];
    const commentCount = await page
      .locator("ytd-comments-header-renderer #count")
      .first()
      .innerText()
      .then((t) => parseCount(t))
      .catch(() => null);

    console.log(`[scrape] youtube ${commentsOnly ? "comments" : "thread"}: ${comments.length} comments`);
    return {
      ok: true,
      result: commentsOnly
        ? { what: "comments", platform: "youtube", url, count: comments.length, comments, note: commentsOn ? undefined : "comments are turned off on this video" }
        : {
            what: "thread", platform: "youtube", url,
            video: { title: meta.title, channel: meta.channel, channelUrl: meta.channelUrl, subscribers: meta.subscribers, info: meta.info, likes: meta.likes, commentCount, url },
            commentCountShown: comments.length, comments,
            note: commentsOn ? undefined : "comments are turned off on this video",
          },
    };
  });
}

async function scrapeChannel(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const { url, label } = resolveChannelUrl(action.params.handle ?? action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 12, 30);

  return withPage(config, async (page) => {
    await gotoYt(page, `${url}/videos`, config);
    const body = await bodyText(page);
    if (/this page isn'?t available|404 not found/i.test(body)) {
      throw new ActionError("not_found", `${label} doesn't exist.`);
    }
    for (let i = 0; i < 4; i++) {
      if ((await page.locator("ytd-rich-item-renderer").count()) >= limit) break;
      await page.mouse.wheel(0, 1_500);
      await randomWait(900, 1_600);
    }

    const data: any = await page.evaluate((max: number) => {
      const header = document.querySelector("yt-page-header-view-model, #page-header, ytd-c4-tabbed-header-renderer");
      const headerText = header ? (header as HTMLElement).innerText.replace(/\s+/g, " ").trim() : "";
      const vids: any[] = [];
      for (const item of Array.from(document.querySelectorAll("ytd-rich-item-renderer"))) {
        if (vids.length >= max) break;
        const a = item.querySelector('a[href*="/watch"], a[href*="/shorts/"]');
        const href = a?.getAttribute("href");
        if (!a || !href) continue;
        const lines = ((item as HTMLElement).innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        // First line is usually the duration badge ("6:09") — the title is the first
        // line that isn't a duration, a view count, an age, or a LIVE tag.
        const lineTitle = lines.find((l) => !/^\d+(:\d+)+$/.test(l) && !/views?\b|watching\b/i.test(l) && !/ago$/i.test(l) && !/^(LIVE|SHORTS|Streamed.*)$/i.test(l)) ?? null;
        const titled = item.querySelector('a[title]:not([title=""])');
        vids.push({
          url: "https://www.youtube.com" + href.split("&")[0],
          title: (titled?.getAttribute("title") || lineTitle || "").slice(0, 150) || null,
          viewsRaw: lines.find((l) => /views?$/i.test(l) || /views/i.test(l)) ?? null,
          age: lines.find((l) => /ago$/i.test(l)) ?? null,
        });
      }
      return {
        headerText: headerText.slice(0, 500),
        name: headerText.split("@")[0].trim() || null,
        handle: headerText.match(/@[\w.\-]+/)?.[0] ?? null,
        subscribersRaw: headerText.match(/([\d.,]+[KMB]?) subscribers/i)?.[1] ?? null,
        videoTotalRaw: headerText.match(/([\d.,]+[KMB]?) videos/i)?.[1] ?? null,
        vids,
      };
    }, limit).catch(() => ({ vids: [] }));

    const videos = (data.vids ?? []).map((v: any) => ({ url: v.url, title: v.title, views: parseCount(v.viewsRaw), age: v.age }));
    console.log(`[scrape] youtube channel ${label}: ${videos.length} videos, ${data.subscribersRaw ?? "?"} subscribers`);
    return {
      ok: true,
      result: {
        what: "channel", platform: "youtube", channelUrl: url,
        name: data.name ?? null, handle: data.handle ?? null,
        subscribers: parseCount(data.subscribersRaw), totalVideos: parseCount(data.videoTotalRaw),
        bio: data.headerText?.split("subscribers").slice(1).join(" ").slice(0, 300) || null,
        videoCount: videos.length, recentVideos: videos,
      },
    };
  });
}

/**
 * Engagement for a batch of videos in one session. Views come out of the watch-info line
 * ("214,772 views"), likes off the like button's own label, comments from the comments
 * header — no scrolling to the comment list, which keeps a 25-video sweep to a few minutes.
 */
async function scrapePostMetrics(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const raw = action.params.urls ?? [];
  if (!Array.isArray(raw) || !raw.length) {
    throw new ActionError("bad_params", "what:'post_metrics' needs params.urls — an array of watch URLs");
  }
  const targets = raw.slice(0, 25).map((u: unknown) => requireVideoUrl(u));

  return withPage(config, async (page) => {
    const out: any[] = [];
    for (const { url } of targets) {
      try {
        await gotoYt(page, url, config);
        const body = await bodyText(page);
        if (/video unavailable|this video is private/i.test(body)) { out.push({ permalink: url, error: "not_found" }); continue; }
        const meta = await videoMeta(page);
        const views = parseCount(meta.info?.match(/([\d,]+)\s+views/i)?.[1] ?? meta.info?.match(/([\d.,]+[KMB]?)\s+views/i)?.[1] ?? null);
        const comments = await page.locator("ytd-comments-header-renderer #count").first().innerText()
          .then((t) => parseCount(t)).catch(() => null);
        out.push({ permalink: url, metrics: { views, likes: meta.likes, comments } });
      } catch (e) {
        out.push({ permalink: url, error: (e as Error).message.slice(0, 120) });
      }
      await randomWait(1_500, 3_000);
    }
    const read = out.filter((o) => o.metrics).length;
    console.log(`[scrape] youtube post_metrics: ${read}/${out.length} read`);
    return { ok: true, result: { what: "post_metrics", platform: "youtube", count: out.length, read, posts: out } };
  });
}

/* ────────────────────────────── adapter surface ────────────────────────────── */

export const youtubeAdapter = {
  like: ytLike,
  comment: ytComment,
  follow: ytFollow,
  search: ytSearch,
  scrape: ytScrape,
  // no dm (YouTube removed direct messages in 2019), no post (uploads go via the Data API later)
};
