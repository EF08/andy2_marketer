/**
 * Facebook adapter — act + read flows for facebook.com in the logged-in profile.
 *
 * Facebook's DOM is hashed-class div soup, but its accessibility layer is rich and
 * stable (verified live, Jul 2026): posts carry aria-label="Actions for this post
 * by <name>", the action bar's Like button is div[aria-label="Like"][role=button]
 * (aria flips to "Remove Like" once liked), comments are div[role=article]
 * [aria-label^="Comment by "], the comment box is div[role=textbox]
 * [aria-label^="Write a comment"], and page headers expose Follow/Message buttons
 * by those exact aria names. That layer is the selector spine here.
 *
 * Not supported: `post` — composing to a timeline/page is a separate flow with the
 * weakest verification story on any platform; it lands with the asset build.
 */
import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { humanType, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import {
  ActionError, bodyText, clampLimit, dismissDialogButton, gotoOn, parseCount, pollFor,
  requireHost, toFailure, withPage,
} from "./webCommon";

const FB = "https://www.facebook.com";
const FB_HOSTS = ["facebook.com", "m.facebook.com", "web.facebook.com", "fb.com"];
const MAX_COMMENT_CHARS = 8_000;
const MAX_DM_CHARS = 900;

const RESERVED = new Set([
  "search", "groups", "watch", "marketplace", "reel", "reels", "photo", "photos", "gaming",
  "events", "friends", "messages", "notifications", "settings", "login", "stories", "share",
]);

/** Query params that identify the target — everything else (trackers) gets dropped. */
const KEEP_PARAMS = new Set(["story_fbid", "id", "fbid", "set", "v"]);

/* ────────────────────────────── urls + targets ────────────────────────────── */

function cleanUrl(u: URL): string {
  u.protocol = "https:";
  u.hostname = "www.facebook.com";
  u.hash = "";
  for (const key of Array.from(u.searchParams.keys())) {
    if (!KEEP_PARAMS.has(key)) u.searchParams.delete(key);
  }
  return u.toString().replace(/\/$/, "");
}

/** Require a link to a specific post/reel/video/photo and normalize it. */
function requirePostUrl(raw: unknown): { url: string } {
  const u = requireHost(raw, FB_HOSTS, "facebook.com");
  const p = u.pathname;
  const postShaped =
    /\/posts\/|\/reel\/|\/videos\/|\/watch|photo(\.php)?|permalink\.php|\/share\/p\//.test(p) ||
    u.searchParams.has("story_fbid") || u.searchParams.has("fbid") || u.searchParams.has("v");
  if (!postShaped) {
    throw new ActionError("bad_params", `targetUrl must point at a specific Facebook post/reel/video (got ${p})`);
  }
  return { url: cleanUrl(u) };
}

/** Accept a page slug, "profile.php?id=…", or any profile/page URL → canonical URL. */
function resolveProfileUrl(raw: unknown): { url: string; label: string } {
  let s = String(raw ?? "").trim();
  if (!s) throw new ActionError("bad_params", "a page/profile (slug or URL) is required");
  if (/^https?:\/\//i.test(s)) {
    const u = requireHost(s, FB_HOSTS, "facebook.com");
    if (u.pathname === "/profile.php" && u.searchParams.get("id")) {
      return { url: `${FB}/profile.php?id=${u.searchParams.get("id")}`, label: `profile.php?id=${u.searchParams.get("id")}` };
    }
    const slug = u.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!slug || RESERVED.has(slug.toLowerCase())) throw new ActionError("bad_params", `Not a profile/page URL: ${s}`);
    return { url: `${FB}/${slug}`, label: slug };
  }
  s = s.replace(/^@/, "");
  if (/^profile\.php\?id=\d+$/.test(s)) return { url: `${FB}/${s}`, label: s };
  if (!/^[A-Za-z0-9.\-]{3,60}$/.test(s)) throw new ActionError("bad_params", `Not a valid Facebook page/profile slug: ${raw}`);
  if (RESERVED.has(s.toLowerCase())) throw new ActionError("bad_params", `'${s}' is a Facebook system page, not a profile`);
  return { url: `${FB}/${s}`, label: s };
}

/* ────────────────────────────── navigation ────────────────────────────── */

async function gotoFb(page: Page, url: string, config: MarketerConfig): Promise<void> {
  await gotoOn(page, "facebook", url, config);
  await clearInterstitials(page);
}

async function clearInterstitials(page: Page): Promise<void> {
  const url = page.url();
  if (/\/checkpoint\/|\/login\//.test(url)) {
    throw new ActionError("login_required", "Facebook redirected to a login/checkpoint page — the session needs a human touch (`npm run login`).");
  }
  const body = await bodyText(page);
  if (/temporarily blocked|you can'?t use this feature right now/i.test(body)) {
    throw new ActionError("rate_limited", "Facebook is showing a temporary block notice — stopping instead of pushing through.");
  }
  // The push-notifications nag and similar dialog cards.
  await dismissDialogButton(page, /^not now$/i);
  await dismissDialogButton(page, /^(close|dismiss)$/i);
}

function pageMissing(body: string): boolean {
  return /this content isn'?t available|page isn'?t available|content not found/i.test(body);
}

/**
 * Refuse to act unless we are truly on ONE post's page.
 *
 * Facebook does something genuinely dangerous here: a `pfbid…` permalink that has
 * expired (those tokens are session-scoped) renders the HOME FEED at the same URL
 * instead of a 404. Without this guard a `like` aimed at a stale link would silently
 * like whatever random post happened to be at the top of the feed. Signals: the feed
 * carries the "Create a post" composer region, and it stacks many post-action menus
 * where a permalink has at most one.
 */
async function assertFocalPost(page: Page): Promise<void> {
  const shape = await page.evaluate(() => {
    const main = document.querySelector('[role="main"]') ?? document.body;
    return {
      composer: !!main.querySelector('div[role="region"][aria-label="Create a post"]') ||
        /What'?s on your mind/i.test((main as HTMLElement).innerText ?? ""),
      postMenus: main.querySelectorAll('div[aria-label^="Actions for this post by "]').length,
      likes: main.querySelectorAll('div[aria-label="Like"][role="button"], div[aria-label="Remove Like"][role="button"]').length,
    };
  }).catch(() => ({ composer: false, postMenus: 0, likes: 1 }));

  if (shape.composer || shape.postMenus > 1) {
    throw new ActionError(
      "not_found",
      "That URL did not open a single post — Facebook rendered the feed instead. Expired 'pfbid…' permalinks do this; " +
      "re-scrape the post to get a fresh link (numeric /reel/<id>/ and photo.php?fbid= links are stable).",
    );
  }
  if (shape.likes === 0) {
    throw new ActionError("not_found", "No post content at that URL (deleted, restricted, or wrong link).");
  }
}

/* ────────────────────────────── post page helpers ────────────────────────────── */

const LIKE_SEL = '[role="main"] div[aria-label="Like"][role="button"]';
const UNLIKE_SEL = '[role="main"] div[aria-label="Remove Like"][role="button"]';

async function likeState(page: Page): Promise<boolean | null> {
  if (await page.locator(UNLIKE_SEL).count()) return true;
  if (await page.locator(LIKE_SEL).count()) return false;
  return null;
}

type FbPostMeta = { author: string | null; text: string | null; reactions: number | null; reactionsByType: Record<string, number> };

async function postMeta(page: Page): Promise<FbPostMeta> {
  return page
    .evaluate(() => {
      const main = document.querySelector('[role="main"]') ?? document.body;
      const actions = main.querySelector('div[aria-label^="Actions for this post by "]');
      // Reel pages carry no post-actions menu — their author is the header profile link.
      const author = actions?.getAttribute("aria-label")?.replace(/^Actions for this post by /, "")
        ?? (() => {
          for (const a of Array.from(main.querySelectorAll('h2 a[href], h3 a[href], a[href]'))) {
            const href = a.getAttribute("href") ?? "";
            const name = ((a as HTMLElement).innerText ?? "").trim();
            if (name && name.length < 60 && /^(https:\/\/www\.facebook\.com)?\/[A-Za-z0-9.\-]+\/?$/.test(href.split("?")[0])) return name;
          }
          return null;
        })();

      const msg = main.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]') as HTMLElement | null;
      let text = msg?.innerText?.trim() ?? null;
      if (!text) {
        // Fall back to the longest text block that isn't a comment.
        const blocks = Array.from(main.querySelectorAll("div[dir='auto'], span[dir='auto']"))
          .filter((el) => !el.closest('div[role="article"]'))
          .map((el) => ((el as HTMLElement).innerText ?? "").trim())
          .filter((t) => t.length > 30);
        text = blocks.sort((a, b) => b.length - a.length)[0] ?? null;
      }

      const totalM = Array.from(main.querySelectorAll("[aria-label]"))
        .map((el) => el.getAttribute("aria-label") ?? "")
        .find((l) => /^[\d.,KMB]+ reactions; see who reacted/i.test(l));
      const byType: Record<string, string> = {};
      for (const el of Array.from(main.querySelectorAll('div[aria-label*=" people"], div[aria-label*=" person"]'))) {
        const m = el.getAttribute("aria-label")?.match(/^(Like|Love|Care|Haha|Wow|Sad|Angry): ([\d.,KMB]+) (people|person)$/i);
        if (m && !el.closest('div[role="article"]')) byType[m[1].toLowerCase()] = m[2];
      }
      return { author, text: text?.slice(0, 500) ?? null, totalRaw: totalM?.match(/^([\d.,KMB]+)/)?.[1] ?? null, byType };
    })
    .then((m: any) => {
      const reactionsByType: Record<string, number> = {};
      for (const [k, v] of Object.entries(m.byType ?? {})) {
        const n = parseCount(v);
        if (n !== null) reactionsByType[k] = n;
      }
      const summed = Object.values(reactionsByType).reduce((a, b) => a + b, 0);
      return { author: m.author, text: m.text, reactions: parseCount(m.totalRaw) ?? (summed || null), reactionsByType };
    })
    .catch(() => ({ author: null, text: null, reactions: null, reactionsByType: {} }));
}

type FbComment = { author: string | null; text: string; time: string | null; reactions: number | null };

/** Comments: div[role=article][aria-label="Comment by <name> <relative time>"]. */
async function extractComments(page: Page, max: number): Promise<FbComment[]> {
  return page
    .evaluate((maxItems: number) => {
      const out: any[] = [];
      for (const c of Array.from(document.querySelectorAll('div[role="article"][aria-label^="Comment by "]'))) {
        if (out.length >= maxItems) break;
        const aria = c.getAttribute("aria-label") ?? "";
        const m = aria.match(/^Comment by (.+?)( (\d+ (?:seconds?|minutes?|hours?|days?|weeks?) ago|yesterday|just now|\d+ ?[smhdw]))?$/i);
        const author = (m?.[1] ?? aria.replace(/^Comment by /, "")).trim() || null;
        const time = m?.[2]?.trim() ?? null;

        const lines = ((c as HTMLElement).innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        const text = lines
          .filter((l) =>
            l !== author &&
            !/^(Like|Reply|Share|Follow|Edited|See translation|Author|Top fan|Verified account)$/i.test(l) &&
            !/^\d+\s?[smhdwy]$/.test(l) && !/^(\d+ (seconds?|minutes?|hours?|days?|weeks?) ago|yesterday|just now)$/i.test(l) &&
            !/^[\d.,KMB]+$/.test(l),
          )
          .join(" ")
          .trim();
        if (!text) continue;
        const rx = c.querySelector('div[aria-label$="see who reacted to this"], span[aria-label$="see who reacted to this"]');
        out.push({
          author, text: text.slice(0, 400), time,
          reactionsRaw: rx?.getAttribute("aria-label")?.match(/^([\d.,KMB]+)/)?.[1] ?? null,
        });
      }
      return out;
    }, max)
    .then((rows: any[]) => rows.map((r) => ({ author: r.author, text: r.text, time: r.time, reactions: parseCount(r.reactionsRaw) })))
    .catch(() => []);
}

/* ────────────────────────────── act: like ────────────────────────────── */

async function fbLike(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url } = requirePostUrl(action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoFb(page, url, config);
      if (pageMissing(await bodyText(page))) {
        throw new ActionError("not_found", "No post at that URL (deleted, restricted, or wrong link).");
      }

      const anyBtn = page.locator(`${LIKE_SEL}, ${UNLIKE_SEL}`).first();
      await anyBtn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "No Like control on the post — Facebook's layout may have changed.");
      });
      await assertFocalPost(page);
      const meta = await postMeta(page);
      const target = { url, author: meta.author, text: meta.text?.slice(0, 200) ?? null };

      const wasLiked = await likeState(page);
      if (wasLiked === null) throw new ActionError("ui_changed", "Neither a Like nor a Remove Like control on the post.");

      const wanted = !undo;
      if (wasLiked === wanted) {
        return {
          ok: true,
          result: {
            platform: "facebook", action: undo ? "unlike" : "like", targetUrl: url,
            changed: false, liked: wasLiked, verified: true, target,
            note: `already ${wasLiked ? "liked" : "not liked"} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "facebook", action: undo ? "unlike" : "like", dryRun: true, targetUrl: url,
            changed: false, liked: wasLiked, verified: null, target,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await page.locator(undo ? UNLIKE_SEL : LIKE_SEL).first().click({ timeout: 10_000 });
      const nowLiked = await pollFor(() => likeState(page), (v) => v === wanted);
      const verified = nowLiked === wanted;
      console.log(`[like] facebook: ${undo ? "unlike" : "like"} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the like may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "facebook", action: undo ? "unlike" : "like", targetUrl: url,
          changed: verified, liked: nowLiked ?? wasLiked, verified, target,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: comment ────────────────────────────── */

async function fbComment(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url } = requirePostUrl(action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_COMMENT_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_COMMENT_CHARS} cap`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoFb(page, url, config);
      if (pageMissing(await bodyText(page))) {
        throw new ActionError("not_found", "No post at that URL (deleted, restricted, or wrong link).");
      }
      await assertFocalPost(page);
      const meta = await postMeta(page);
      const target = { url, author: meta.author, text: meta.text?.slice(0, 200) ?? null };

      let box = page.locator('div[role="textbox"][aria-label^="Write a comment"]').first();
      if (!(await box.count())) {
        // Some layouts only open the composer after tapping the comment action.
        const leave = page.locator('div[aria-label="Leave a comment"][role="button"]').first();
        if (await leave.count()) {
          await leave.click({ timeout: 8_000 }).catch(() => {});
          await randomWait(1_200, 2_200);
          box = page.locator('div[role="textbox"][aria-label^="Write a comment"]').first();
        }
      }
      if (!(await box.count())) {
        throw new ActionError("blocked", "No comment box on this post — comments are off or limited.");
      }
      await box.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" }); // Enter SUBMITS a Facebook comment
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "facebook", action: "comment", dryRun: true, targetUrl: url, chars: text.length,
            sent: false, verified: null, target, note: "dryRun — comment box filled, nothing was sent.",
          },
        };
      }

      const submit = page.locator('div[aria-label="Comment"][role="button"]').first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: 10_000 });
      } else {
        await page.keyboard.press("Enter");
      }
      console.log(`[comment] facebook: submitted (${text.length} chars)`);

      // Verify-after-act: our comment article shows up with the text snippet.
      const snippet = text.split("\n")[0].slice(0, 40);
      const verified = await pollFor(
        async () => {
          const comments = await extractComments(page, 30);
          return comments.some((c) => c.text.includes(snippet));
        },
        (v) => v,
        14,
      );
      console.log(`[comment] facebook: sent verified=${verified}`);

      return {
        ok: true,
        result: {
          platform: "facebook", action: "comment", chars: text.length,
          sent: true, verified, permalink: url, targetUrl: url, target,
          note: verified ? undefined : "sent, but the comment could not be found in the list afterwards — check manually",
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: follow ────────────────────────────── */

async function fbFollow(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url, label } = resolveProfileUrl(action.params.handle ?? action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoFb(page, url, config);
      if (pageMissing(await bodyText(page))) throw new ActionError("not_found", `${label} doesn't exist (or the page is unavailable).`);

      const main = page.locator('[role="main"]');
      const readState = async (): Promise<boolean | null> => {
        if (await main.locator('div[aria-label="Following"][role="button"]').count()) return true;
        if (await main.locator('div[aria-label="Follow"][role="button"]').count()) return false;
        return null;
      };
      const was = await pollFor(readState, (v) => v !== null, 10);
      if (was === null) {
        const addFriend = await main.locator('div[aria-label="Add friend"][role="button"]').count();
        throw new ActionError(
          "ui_changed",
          addFriend
            ? `${label} is a personal profile without a Follow button (friend requests aren't automated).`
            : `No Follow control on ${label} — layout changed, or this is our own page.`,
        );
      }

      const wanted = !undo;
      if (was === wanted) {
        return {
          ok: true,
          result: {
            platform: "facebook", action: undo ? "unfollow" : "follow", target: label, profileUrl: url,
            changed: false, following: was, verified: true,
            note: `already ${was ? "following" : "not following"} ${label} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "facebook", action: undo ? "unfollow" : "follow", dryRun: true, target: label,
            changed: false, following: was, verified: null,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await main.locator(`div[aria-label="${undo ? "Following" : "Follow"}"][role="button"]`).first().click({ timeout: 10_000 });
      if (undo) {
        // "Following" opens a menu; Unfollow lives inside it (sometimes plus a confirm).
        await randomWait(800, 1_500);
        const item = page.getByRole("menuitem", { name: /unfollow/i }).first();
        if (await item.count().catch(() => 0)) {
          await item.click({ timeout: 8_000 }).catch(() => {});
          await randomWait(600, 1_200);
        }
        await dismissDialogButton(page, /^unfollow$/i);
      }

      const now = await pollFor(readState, (v) => v === wanted);
      const verified = now === wanted;
      console.log(`[follow] facebook: ${undo ? "unfollow" : "follow"} ${label} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the follow may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "facebook", action: undo ? "unfollow" : "follow", target: label, profileUrl: url,
          changed: verified, following: now ?? was, verified,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: dm ────────────────────────────── */

async function fbDm(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url, label } = resolveProfileUrl(action.params.handle ?? action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_DM_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_DM_CHARS} cap`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoFb(page, url, config);
      if (pageMissing(await bodyText(page))) throw new ActionError("not_found", `${label} doesn't exist (or the page is unavailable).`);

      const msgBtn = page.locator('[role="main"] div[aria-label="Message"][role="button"]').first();
      if (!(await msgBtn.count())) {
        throw new ActionError("blocked", `No Message button on ${label} — they may not accept messages from this account.`);
      }
      await msgBtn.click({ timeout: 10_000 });
      await randomWait(2_000, 3_500);

      // The Messenger popup composer: aria-label "Write to <name>", placeholder "Aa".
      const composer = page.locator('div[role="textbox"][aria-label^="Write to "], div[role="textbox"][aria-placeholder="Aa"]').first();
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "Messenger composer never appeared after clicking Message.");
      });
      await composer.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" }); // Enter would fire a half-written DM
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "facebook", action: "dm", dryRun: true, target: label, chars: text.length,
            sent: false, verified: null, conversationUrl: page.url(),
            note: "dryRun — the DM was typed into the composer but NOT sent.",
          },
        };
      }

      const send = page.locator('div[aria-label="Press enter to send"], div[aria-label="Send message"][role="button"], div[aria-label="Send"][role="button"]').first();
      if (await send.isVisible().catch(() => false)) {
        await send.click({ timeout: 10_000 });
      } else {
        await page.keyboard.press("Enter");
      }

      const snippet = text.split("\n")[0].slice(0, 40);
      const verified = await pollFor(
        async () => {
          const left = (await composer.innerText().catch(() => null))?.trim();
          return left === "" && (await bodyText(page)).includes(snippet);
        },
        (v) => v,
        14,
      );
      const conversationUrl = page.url();
      console.log(`[dm] facebook: ${label} verified=${verified}`);

      if (!verified) {
        return {
          ok: false,
          error: "ambiguous: sent the DM but it never showed in the thread. It MAY have sent — check Messenger before retrying.",
          result: { failureCode: "ambiguous", platform: "facebook", action: "dm", target: label, conversationUrl },
        };
      }
      return {
        ok: true,
        result: { platform: "facebook", action: "dm", target: label, chars: text.length, sent: true, verified: true, conversationUrl },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: search ────────────────────────────── */

type FbTab = "posts" | "people" | "pages";

async function fbSearch(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const query = String(action.params.query ?? "").trim();
    if (!query) throw new ActionError("bad_params", "params.query is required");
    if (query.length > 200) throw new ActionError("bad_params", "params.query is too long (max 200 chars)");

    const rawTab = String(action.params.tab ?? "posts").toLowerCase();
    const tab: FbTab = /^(people|users?|accounts?)$/.test(rawTab) ? "people" : /^pages?$/.test(rawTab) ? "pages" : "posts";
    const limit = clampLimit(action.params.limit, 15, 30);
    const url = `${FB}/search/${tab}/?q=${encodeURIComponent(query)}`;

    return await withPage(config, async (page) => {
      await gotoFb(page, url, config);

      const anySignal = tab === "posts" ? 'div[aria-label^="Actions for this post by "]' : '[role="main"] a[href]';
      const rendered = await pollFor(async () => (await page.locator(anySignal).count()) > 0, (v) => v, 20);
      if (!rendered) {
        const body = await bodyText(page);
        if (/we didn'?t find any results|no results found/i.test(body)) {
          return { ok: true, result: { platform: "facebook", query, tab, count: 0, results: [], searchUrl: url, note: "Facebook returned no results for this query." } };
        }
        throw new ActionError("ui_changed", "No search results rendered and no empty-state message.");
      }
      for (let i = 0; i < 5; i++) {
        const have = await page.locator(tab === "posts" ? 'div[aria-label^="Actions for this post by "]' : '[role="main"] a[href]').count();
        if (have >= limit) break;
        await page.mouse.wheel(0, 1_500);
        await randomWait(1_000, 1_800);
      }

      if (tab === "posts") {
        const posts: any[] = await page.evaluate((max: number) => {
          const out: any[] = [];
          const seen = new Set<Element>();
          for (const btn of Array.from(document.querySelectorAll('div[aria-label^="Actions for this post by "]'))) {
            if (out.length >= max) break;
            const author = btn.getAttribute("aria-label")?.replace(/^Actions for this post by /, "") ?? null;
            // Climb to the smallest wrapper that holds the whole post unit.
            let wrap: HTMLElement | null = btn.parentElement;
            for (let i = 0; i < 14 && wrap; i++) {
              if (wrap.querySelector('div[aria-label="Like"][role="button"], div[aria-label="Remove Like"][role="button"]')) break;
              wrap = wrap.parentElement;
            }
            if (!wrap || seen.has(wrap)) continue;
            seen.add(wrap);

            const linkEl =
              wrap.querySelector('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="story_fbid"], a[href*="photo"], a[href*="/stories/"]') ??
              Array.from(wrap.querySelectorAll("a[aria-label]")).find((a) => /\bat\b .*\d{1,2}:\d{2}|20\d\d/.test(a.getAttribute("aria-label") ?? ""));
            const href = linkEl?.getAttribute("href") ?? null;

            // The author's profile link is always present, even when the post permalink isn't.
            const authorA = Array.from(wrap.querySelectorAll("a[href]")).find((a) =>
              /^(https:\/\/www\.facebook\.com)?\/[A-Za-z0-9.\-]+(\?|$)/.test(a.getAttribute("href") ?? "") &&
              (a.getAttribute("aria-label") === author || ((a as HTMLElement).innerText ?? "").trim() === author),
            );

            const msg = wrap.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]') as HTMLElement | null;
            const text = (msg?.innerText ?? "").trim() ||
              ((wrap.innerText ?? "").split("\n").map((s) => s.trim()).filter((l) => l.length > 40)[0] ?? "");
            out.push({ author, href, authorHref: authorA?.getAttribute("href") ?? null, text: text.slice(0, 300) || null });
          }
          return out;
        }, limit).catch(() => []);

        const clean = (href: string | null): string | null => {
          if (!href) return null;
          try {
            return cleanUrl(new URL(href.startsWith("http") ? href : FB + href));
          } catch {
            return null;
          }
        };
        const results = posts.map((p) => ({
          author: p.author,
          authorUrl: clean(p.authorHref),
          permalink: clean(p.href),
          text: p.text,
        }));
        const withoutLink = results.filter((r) => !r.permalink).length;
        console.log(`[search] facebook: "${query}" (posts) → ${results.length} results (${withoutLink} without a permalink)`);
        return {
          ok: true,
          result: {
            platform: "facebook", query, tab, count: results.length, results, searchUrl: url,
            note: withoutLink
              ? `${withoutLink} of ${results.length} results carry no post permalink — Facebook omits them from search cards. Scrape the author's page (what:'profile') to get actionable post URLs.`
              : undefined,
          },
        };
      }

      // people / pages: rows of profile links in the results main region.
      const rows: any[] = await page.evaluate((max: number) => {
        const out: any[] = [];
        const seen = new Set<string>();
        const main = document.querySelector('[role="main"]') ?? document.body;
        for (const a of Array.from(main.querySelectorAll("a[href]"))) {
          if (out.length >= max) break;
          const href = (a.getAttribute("href") ?? "").split("?")[0].replace(/\/$/, "");
          const m = href.match(/^https:\/\/www\.facebook\.com\/([A-Za-z0-9.\-]+)$/) ?? href.match(/^\/([A-Za-z0-9.\-]+)$/);
          const name = ((a as HTMLElement).innerText ?? "").split("\n")[0].trim();
          if (!m || !name || name.length < 2) continue;
          const slug = m[1];
          if (["search", "friends", "groups", "watch", "marketplace", "reel", "photo", "home.php", "profile.php"].includes(slug)) continue;
          if (seen.has(slug)) continue;
          seen.add(slug);
          // The row wrapper carries the subtitle (mutuals, category, follower count).
          let rowEl: HTMLElement | null = a.parentElement;
          for (let i = 0; i < 6 && rowEl && rowEl.innerText.trim() === name; i++) rowEl = rowEl.parentElement;
          const sub = (rowEl?.innerText ?? "").split("\n").map((s) => s.trim()).filter((l) => l && l !== name && !/^(Add friend|Follow|Message|Like)$/i.test(l)).slice(0, 2).join(" · ");
          out.push({ slug, name, subtitle: sub.slice(0, 120) || null, url: "https://www.facebook.com/" + slug });
        }
        return out;
      }, limit).catch(() => []);

      console.log(`[search] facebook: "${query}" (${tab}) → ${rows.length} results`);
      return { ok: true, result: { platform: "facebook", query, tab, count: rows.length, results: rows, searchUrl: url } };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: scrape ────────────────────────────── */

async function fbScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const what = String(action.params.what ?? "").toLowerCase();
  try {
    switch (what) {
      case "profile":
        return await scrapeProfile(action, config);
      case "thread":
      case "post":
      case "comments":
        return await scrapePost(action, config, what === "comments");
      case "post_metrics":
        return await scrapePostMetrics(action, config);
      default:
        throw new ActionError("bad_params", `for facebook, params.what must be profile|thread|comments|post_metrics|page (got '${what}')`);
    }
  } catch (e) {
    return toFailure(e);
  }
}

async function scrapeProfile(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const { url, label } = resolveProfileUrl(action.params.handle ?? action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 8, 20);

  return withPage(config, async (page) => {
    await gotoFb(page, url, config);
    const body = await bodyText(page);
    if (pageMissing(body)) throw new ActionError("not_found", `${label} doesn't exist.`);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1_400);
      await randomWait(900, 1_600);
    }

    const data: any = await page.evaluate((max: number) => {
      const main = document.querySelector('[role="main"]') ?? document.body;
      // Page headers render the name as plain text, not an h1 — and an UNSCOPED h1 grabs
      // the notifications dialog's heading, so the first line of main is the reliable read.
      const mainText = (main as HTMLElement).innerText ?? "";
      const name = mainText.split("\n").map((s) => s.trim()).filter(Boolean)[0]?.slice(0, 100) ?? null;
      const followers = mainText.match(/([\d.,KMB]+) followers/i)?.[1] ?? null;
      const likes = mainText.match(/([\d.,KMB]+) likes/i)?.[1] ?? null;
      const category = mainText.split("\n").map((s) => s.trim())
        .find((l) => /^(Sports league|Sports team|Athlete|Company|Product\/service|Local business|.*(League|Team|Club|Shop|Store|Restaurant))$/i.test(l)) ?? null;

      const seen = new Set<string>();
      const posts: any[] = [];
      for (const a of Array.from(main.querySelectorAll('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"]'))) {
        if (posts.length >= max) break;
        const href = (a.getAttribute("href") ?? "").split("?")[0];
        if (!href || seen.has(href) || href.endsWith("/posts/") || href.endsWith("/reel/")) continue;
        seen.add(href);
        posts.push({ url: href.startsWith("http") ? href : "https://www.facebook.com" + href });
      }
      return { name, followers, likes, category, intro: mainText.slice(0, 400), posts };
    }, limit).catch(() => ({ posts: [] }));

    console.log(`[scrape] facebook profile ${label}: ${data.posts?.length ?? 0} post links, ${data.followers ?? "?"} followers`);
    return {
      ok: true,
      result: {
        what: "profile", platform: "facebook", target: label, profileUrl: url,
        name: data.name ?? null, category: data.category ?? null,
        followers: parseCount(data.followers), pageLikes: parseCount(data.likes),
        postCount: data.posts?.length ?? 0, recentPosts: data.posts ?? [],
        note: "Facebook page post text isn't in the grid links — scrape a post URL (what:'thread') for content + comments.",
      },
    };
  });
}

async function scrapePost(action: Action, config: MarketerConfig, commentsOnly: boolean): Promise<ActionResult> {
  const { url } = requirePostUrl(action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 20, 60);

  return withPage(config, async (page) => {
    await gotoFb(page, url, config);
    if (pageMissing(await bodyText(page))) {
      throw new ActionError("not_found", "No post at that URL (deleted, restricted, or wrong link).");
    }

    await assertFocalPost(page);

    // Comments hydrate late and page in on scroll.
    await randomWait(1_500, 2_500);
    for (let i = 0; i < 5; i++) {
      if ((await page.locator('div[role="article"][aria-label^="Comment by "]').count()) >= limit) break;
      await page.mouse.wheel(0, 1_300);
      await randomWait(900, 1_700);
    }

    const meta = await postMeta(page);
    const comments = (await extractComments(page, limit)).slice(0, limit);

    // The Reels viewer renders its counts as bare numbers with no aria labels, and keeps
    // comments behind a panel — say so rather than reporting a confident zero.
    const isReel = /\/reel\//.test(url);
    const note = isReel
      ? "Reels viewer: reaction/comment counts and the comment list aren't exposed the way feed posts expose them — treat empty values as 'not read', not zero."
      : "comment set follows Facebook's 'Most relevant' ordering unless the post page was opened with all comments expanded";

    console.log(`[scrape] facebook ${commentsOnly ? "comments" : "thread"}: ${comments.length} comments${isReel ? " (reel)" : ""}`);
    return {
      ok: true,
      result: commentsOnly
        ? { what: "comments", platform: "facebook", url, count: comments.length, comments, note: isReel ? note : undefined }
        : {
            what: "thread", platform: "facebook", url,
            post: { author: meta.author, text: meta.text, reactions: meta.reactions, reactionsByType: meta.reactionsByType, url },
            commentCount: comments.length, comments, note,
          },
    };
  });
}

/**
 * Engagement for a batch of our own posts in one session. Every URL goes through the same
 * focal-post guard as an act does, so a stale `pfbid` link reports an error instead of
 * quietly recording the feed's top post as ours.
 */
async function scrapePostMetrics(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const raw = action.params.urls ?? [];
  if (!Array.isArray(raw) || !raw.length) {
    throw new ActionError("bad_params", "what:'post_metrics' needs params.urls — an array of Facebook post/reel URLs");
  }
  const targets = raw.slice(0, 25).map((u: unknown) => requirePostUrl(u));

  return withPage(config, async (page) => {
    const out: any[] = [];
    for (const { url } of targets) {
      try {
        await gotoFb(page, url, config);
        if (pageMissing(await bodyText(page))) { out.push({ permalink: url, error: "not_found" }); continue; }
        await assertFocalPost(page);
        const meta = await postMeta(page);
        const comments = await page.locator('div[role="article"][aria-label^="Comment by "]').count().catch(() => 0);
        out.push({ permalink: url, metrics: { reactions: meta.reactions, likes: meta.reactionsByType?.like ?? null, comments } });
      } catch (e) {
        out.push({ permalink: url, error: (e as Error).message.slice(0, 160) });
      }
      await randomWait(1_500, 3_000);
    }
    const read = out.filter((o) => o.metrics).length;
    console.log(`[scrape] facebook post_metrics: ${read}/${out.length} read`);
    return { ok: true, result: { what: "post_metrics", platform: "facebook", count: out.length, read, posts: out } };
  });
}

/* ────────────────────────────── adapter surface ────────────────────────────── */

export const facebookAdapter = {
  like: fbLike,
  comment: fbComment,
  follow: fbFollow,
  dm: fbDm,
  search: fbSearch,
  scrape: fbScrape,
};
