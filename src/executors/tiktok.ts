/**
 * TikTok adapter — act + read flows for tiktok.com in the logged-in profile.
 *
 * TikTok's web app ships stable `data-e2e` attributes on almost everything
 * (verified live, Jul 2026): profile headers (user-title, followers-count…),
 * video overlays (browse-like-icon, browse-video-desc…), comments
 * (comment-level-1, comment-input, comment-post) and search cards
 * (search_top-item, search-card-user-link). Those are the selector spine here.
 *
 * Not supported: `post` — video upload needs the asset pipeline (separate build).
 * DMs work only where TikTok shows a Message button (mutuals, mostly) and fail
 * honestly otherwise.
 */
import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { humanType, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import {
  ActionError, bodyText, clampLimit, dismissDialogButton, gotoOn, parseCount, pollFor,
  requireHost, toFailure, withPage,
} from "./webCommon";

const TT = "https://www.tiktok.com";
const TT_HOSTS = ["tiktok.com", "m.tiktok.com"];
const MAX_COMMENT_CHARS = 150; // TikTok's own comment limit
const MAX_DM_CHARS = 500;

/* ────────────────────────────── urls + handles ────────────────────────────── */

function requireVideoUrl(raw: unknown): { url: string; videoId: string; author: string } {
  const u = requireHost(raw, TT_HOSTS, "tiktok.com");
  const m = u.pathname.match(/\/@([\w.]+)\/(?:video|photo)\/(\d+)/);
  if (!m) {
    throw new ActionError(
      "bad_params",
      `targetUrl must point at a video (…tiktok.com/@user/video/123…), got ${u.pathname}. Short links (vm.tiktok.com) need expanding first.`,
    );
  }
  const kind = u.pathname.includes("/photo/") ? "photo" : "video";
  return { url: `${TT}/@${m[1]}/${kind}/${m[2]}`, videoId: m[2], author: m[1] };
}

function resolveHandle(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new ActionError("bad_params", "a handle (or profile URL) is required");
  if (/^https?:\/\//i.test(s)) {
    const u = requireHost(s, TT_HOSTS, "tiktok.com");
    s = u.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  s = s.replace(/^@/, "");
  if (!/^[\w.]{1,24}$/.test(s)) throw new ActionError("bad_params", `Not a valid TikTok handle: ${raw}`);
  return s;
}

const profileUrl = (handle: string) => `${TT}/@${handle}`;

/* ────────────────────────────── navigation ────────────────────────────── */

async function gotoTt(page: Page, url: string, config: MarketerConfig): Promise<void> {
  await gotoOn(page, "tiktok", url, config);
  await clearInterstitials(page);
}

async function clearInterstitials(page: Page): Promise<void> {
  // Captchas are a hard stop — solving them from here is neither possible nor wise.
  const captcha = await page
    .locator('#captcha_container, [class*="captcha_verify"], div[id*="captcha"]')
    .count()
    .catch(() => 0);
  const body = await bodyText(page);
  if (captcha > 0 || /verify to continue|drag the slider|rotate the shapes/i.test(body)) {
    throw new ActionError("blocked", "TikTok is showing a captcha — needs a human touch in the automation profile.");
  }
  if (/too many attempts|try again later/i.test(body)) {
    throw new ActionError("rate_limited", "TikTok is showing a too-many-attempts notice — stopping instead of pushing through.");
  }
  await dismissDialogButton(page, /^(accept all|allow all)$/i);
  // The logged-out nag modal has a dedicated close control.
  const close = page.locator('[data-e2e="modal-close-inner-button"]').first();
  if (await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 4_000 }).catch(() => {});
    await randomWait(500, 1_000);
  }
}

/**
 * Open a video. Direct navigation to /@user/video/<id> sporadically gets an HTTP
 * error from TikTok's edge; the same video opens fine as a client-side overlay from
 * the author's grid — so that's the fallback route.
 */
async function gotoVideo(page: Page, target: { url: string; videoId: string; author: string }, config: MarketerConfig): Promise<void> {
  const transient = /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_ABORTED|ERR_EMPTY_RESPONSE|interrupted by another navigation/i;
  try {
    await gotoTt(page, target.url, config);
    return;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!transient.test(msg)) throw e;
  }
  // Let the error page finish its own navigation before renavigating, or the fallback
  // goto gets "interrupted by another navigation to chrome-error://".
  await randomWait(1_800, 3_000);
  try {
    await gotoTt(page, profileUrl(target.author), config);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!transient.test(msg)) throw e;
    await randomWait(2_200, 3_800);
    await gotoTt(page, profileUrl(target.author), config);
  }
  const link = page.locator(`[data-e2e="user-post-item"] a[href*="/${target.videoId}"]`).first();
  for (let i = 0; i < 3 && !(await link.count()); i++) {
    await page.mouse.wheel(0, 1_500);
    await randomWait(900, 1_600);
  }
  if (!(await link.count())) {
    throw new ActionError("not_found", `The direct video URL failed to load and the video isn't in @${target.author}'s recent grid.`);
  }
  await link.click({ timeout: 10_000 });
  const opened = await pollFor(async () => page.url().includes(target.videoId), (v) => v, 10);
  if (!opened) throw new ActionError("ui_changed", "Clicking the video in the grid never opened it.");
  await randomWait(2_000, 3_200);
  await clearInterstitials(page);
}

async function ownHandle(page: Page): Promise<string | null> {
  return page
    .locator('[data-e2e="nav-profile"]')
    .first()
    .getAttribute("href", { timeout: 6_000 })
    .then((href) => href?.match(/\/@([\w.]+)/)?.[1] ?? null)
    .catch(() => null);
}

function profileMissing(body: string): boolean {
  return /couldn'?t find this account|this account was banned/i.test(body);
}

/* ────────────────────────────── video page helpers ────────────────────────────── */

const LIKE_ICON = '[data-e2e="browse-like-icon"], [data-e2e="like-icon"]';

/**
 * Liked-state detection, layered: aria-pressed on the wrapping button when TikTok
 * provides it, else the heart's fill — the liked heart is TikTok red (#FE2C55),
 * the unliked one monochrome.
 */
async function likeState(page: Page): Promise<boolean | null> {
  return page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const pressed = el.closest("button")?.getAttribute("aria-pressed");
      if (pressed === "true") return true;
      if (pressed === "false") return false;
      const html = el.outerHTML || "";
      if (/fe2c55|rgb\(254,\s*44,\s*85\)/i.test(html)) return true;
      if (/<svg/i.test(html)) return false;
      return null;
    }, LIKE_ICON)
    .catch(() => null);
}

type TtVideoMeta = {
  author: string | null; nickname: string | null; desc: string | null;
  likes: number | null; comments: number | null; favorites: number | null; music: string | null;
};

async function videoMeta(page: Page): Promise<TtVideoMeta> {
  return page
    .evaluate(() => {
      const txt = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim() ?? null;
      return {
        author: txt('[data-e2e="browse-username"]'),
        nickname: txt('[data-e2e="browser-nickname"]'),
        desc: txt('[data-e2e="browse-video-desc"]')?.slice(0, 500) ?? null,
        likesRaw: txt('[data-e2e="browse-like-count"], [data-e2e="like-count"]'),
        commentsRaw: txt('[data-e2e="browse-comment-count"], [data-e2e="comment-count"]'),
        favoritesRaw: txt('[data-e2e="browse-favorite-count"], [data-e2e="undefined-count"]'),
        music: txt('[data-e2e="browse-music"]'),
      };
    })
    .then((m: any) => ({
      author: m.author, nickname: m.nickname, desc: m.desc, music: m.music,
      likes: parseCount(m.likesRaw), comments: parseCount(m.commentsRaw), favorites: parseCount(m.favoritesRaw),
    }))
    .catch(() => ({ author: null, nickname: null, desc: null, likes: null, comments: null, favorites: null, music: null }));
}

type TtComment = { author: string | null; nickname: string | null; text: string; time: string | null; likes: number | null };

/** Top-level comments. Each comment-level-N text node pairs with its container's avatar/username/time. */
async function extractComments(page: Page, max: number): Promise<TtComment[]> {
  return page
    .evaluate((maxItems: number) => {
      const out: any[] = [];
      for (const p of Array.from(document.querySelectorAll('p[data-e2e^="comment-level-"]'))) {
        if (out.length >= maxItems) break;
        // Walk up to the wrapper that carries this comment's identity bits.
        let wrap: HTMLElement | null = p.parentElement;
        for (let i = 0; i < 6 && wrap && !wrap.querySelector('a[data-e2e^="comment-avatar-"]'); i++) wrap = wrap.parentElement;
        if (!wrap) continue;
        const avatar = wrap.querySelector('a[data-e2e^="comment-avatar-"]');
        out.push({
          author: avatar?.getAttribute("href")?.match(/\/@([\w.]+)/)?.[1] ?? null,
          nickname: (wrap.querySelector('span[data-e2e^="comment-username-"]') as HTMLElement | null)?.innerText?.trim() ?? null,
          text: ((p as HTMLElement).innerText ?? "").trim().slice(0, 400),
          time: (wrap.querySelector('span[data-e2e^="comment-time-"]') as HTMLElement | null)?.innerText?.trim() ?? null,
          likesRaw: (wrap.querySelector('[data-e2e="comment-like-count"]') as HTMLElement | null)?.innerText?.trim() ?? null,
        });
      }
      return out;
    }, max)
    .then((rows: any[]) => rows.map((r) => ({ author: r.author, nickname: r.nickname, text: r.text, time: r.time, likes: parseCount(r.likesRaw) })))
    .catch(() => []);
}

/**
 * The direct /video/ page loads with the comment panel closed (only the count icon);
 * the browse overlay usually has it open. Ensure it's open before reading or writing.
 */
async function openCommentPanel(page: Page): Promise<boolean> {
  const open = async () =>
    (await page.locator('[data-e2e="comment-input"], p[data-e2e^="comment-level-"]').count()) > 0;
  if (await open()) return true;
  const icon = page.locator('[data-e2e="comment-icon"]').first();
  if (!(await icon.count())) return open();
  await icon.click({ timeout: 8_000 }).catch(() => {});
  return pollFor(open, (v) => v, 10);
}

/** Scroll the comment rail until `want` comments render (or it stops growing). */
async function scrollForComments(page: Page, want: number, maxScrolls = 10): Promise<void> {
  const count = () => page.locator('p[data-e2e^="comment-level-"]').count();
  let seen = await count();
  const rail = page.locator('p[data-e2e^="comment-level-"]').first();
  const box = await rail.boundingBox().catch(() => null);
  for (let i = 0; i < maxScrolls && seen < want; i++) {
    if (box) await page.mouse.move(box.x + 20, box.y + 20).catch(() => {});
    await page.mouse.wheel(0, 1_100 + Math.floor(Math.random() * 700));
    await randomWait(900, 1_700);
    const now = await count();
    if (now === seen) break;
    seen = now;
  }
}

/* ────────────────────────────── act: like ────────────────────────────── */

async function ttLike(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const target0 = requireVideoUrl(action.params.targetUrl);
    const { url } = target0;
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoVideo(page, target0, config);
      const body = await bodyText(page);
      if (/video currently unavailable|couldn'?t find this video/i.test(body)) {
        throw new ActionError("not_found", "No video at that URL (deleted, private, or wrong link).");
      }

      const icon = page.locator(LIKE_ICON).first();
      await icon.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "No like control on the video page — TikTok's layout may have changed.");
      });
      const meta = await videoMeta(page);
      const target = { url, author: meta.author, text: meta.desc?.slice(0, 200) ?? null };

      const wasLiked = await likeState(page);
      const wanted = !undo;
      if (wasLiked === wanted) {
        return {
          ok: true,
          result: {
            platform: "tiktok", action: undo ? "unlike" : "like", targetUrl: url,
            changed: false, liked: wasLiked, verified: true, target,
            note: `already ${wasLiked ? "liked" : "not liked"} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "tiktok", action: undo ? "unlike" : "like", dryRun: true, targetUrl: url,
            changed: false, liked: wasLiked, verified: null, target,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      // Prefer the wrapping button; the bare icon span still bubbles if there isn't one.
      const btn = icon.locator("xpath=ancestor-or-self::button[1]");
      await ((await btn.count()) ? btn : icon).click({ timeout: 10_000 });
      const nowLiked = await pollFor(() => likeState(page), (v) => v === wanted);
      const verified = nowLiked === wanted;
      console.log(`[like] tiktok: ${undo ? "unlike" : "like"} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the heart never flipped state — the like may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "tiktok", action: undo ? "unlike" : "like", targetUrl: url,
          changed: verified, liked: nowLiked ?? wasLiked, verified, target,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: comment ────────────────────────────── */

async function ttComment(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const target0 = requireVideoUrl(action.params.targetUrl);
    const { url } = target0;
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_COMMENT_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over TikTok's ${MAX_COMMENT_CHARS} comment limit`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoVideo(page, target0, config);
      const handle = await ownHandle(page);
      const meta = await videoMeta(page);
      const target = { url, author: meta.author, text: meta.desc?.slice(0, 200) ?? null };

      await openCommentPanel(page);
      // The comment rail renders a beat after the video — give the box a real wait.
      const input = page.locator('[data-e2e="comment-input"]').first();
      const boxThere = await input.waitFor({ state: "visible", timeout: 12_000 }).then(() => true).catch(() => false);
      if (!boxThere) {
        const body2 = await bodyText(page);
        if (/comments are turned off|be the first to comment/i.test(body2) && !(await input.count())) {
          throw new ActionError("blocked", "No comment box on this video — comments are off.");
        }
        throw new ActionError("blocked", "No comment box on this video — comments are off (or the panel never rendered).");
      }
      await input.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" });
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "tiktok", action: "comment", dryRun: true, targetUrl: url, chars: text.length,
            sent: false, verified: null, target, note: "dryRun — comment box filled, nothing was sent.",
          },
        };
      }

      const post = page.locator('[data-e2e="comment-post"]').first();
      await post.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
        throw new ActionError("ui_changed", "The comment Post button never appeared.");
      });
      let enabled = false;
      for (let i = 0; i < 12 && !enabled; i++) {
        enabled = (await post.getAttribute("aria-disabled").catch(() => null)) !== "true" && (await post.isEnabled().catch(() => false));
        if (!enabled) await randomWait(300, 600);
      }
      if (!enabled) throw new ActionError("ambiguous", "TikTok's comment Post button never enabled — nothing was sent.");
      await post.click({ timeout: 10_000 });
      console.log(`[comment] tiktok: clicked Post (${text.length} chars)`);

      // Verify-after-act: the fresh comment surfaces at the top of the rail.
      const snippet = text.split("\n")[0].slice(0, 40);
      const verified = await pollFor(
        async () => {
          const body = await bodyText(page);
          if (/comment failed|couldn'?t post/i.test(body)) return false;
          const comments = await extractComments(page, 12);
          return comments.some((c) => c.text.includes(snippet) && (!handle || c.author === handle || c.author === null));
        },
        (v) => v,
        14,
      );
      console.log(`[comment] tiktok: sent verified=${verified}`);

      return {
        ok: true,
        result: {
          platform: "tiktok", action: "comment", handle, chars: text.length,
          sent: true, verified, permalink: url, targetUrl: url, target,
          note: verified ? undefined : "sent, but the comment could not be found in the rail afterwards — TikTok may be holding it for review",
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: follow ────────────────────────────── */

async function ttFollow(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoTt(page, profileUrl(handle), config);
      const body = await bodyText(page);
      if (profileMissing(body)) throw new ActionError("not_found", `@${handle} doesn't exist (or was banned).`);

      // The header's follow button — NOT the sidebar suggestions, which reuse the same testid.
      const btn = page.locator('[data-e2e="user-page"] [data-e2e="follow-button"]').first();
      await btn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", `No follow button on @${handle}'s profile — layout changed, or this is our own profile.`);
      });

      const readState = async (): Promise<boolean | null> => {
        const t = ((await btn.innerText().catch(() => "")) || "").trim().toLowerCase();
        if (/^(following|friends)$/.test(t)) return true;
        if (/^follow( back)?$/.test(t)) return false;
        return null;
      };
      const was = await readState();
      if (was === null) throw new ActionError("ui_changed", "Follow button text was unrecognizable.");

      const wanted = !undo;
      if (was === wanted) {
        return {
          ok: true,
          result: {
            platform: "tiktok", action: undo ? "unfollow" : "follow", handle, profileUrl: profileUrl(handle),
            changed: false, following: was, verified: true,
            note: `already ${was ? "following" : "not following"} @${handle} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "tiktok", action: undo ? "unfollow" : "follow", dryRun: true, handle,
            changed: false, following: was, verified: null,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await btn.click({ timeout: 10_000 });
      await randomWait(800, 1_500);
      await dismissDialogButton(page, /^unfollow$/i); // some accounts raise a confirm sheet

      const now = await pollFor(readState, (v) => v === wanted);
      const verified = now === wanted;
      console.log(`[follow] tiktok: ${undo ? "unfollow" : "follow"} @${handle} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the follow may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "tiktok", action: undo ? "unfollow" : "follow", handle, profileUrl: profileUrl(handle),
          changed: verified, following: now ?? was, verified,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: dm ────────────────────────────── */

async function ttDm(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_DM_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_DM_CHARS} cap`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoTt(page, profileUrl(handle), config);
      const body = await bodyText(page);
      if (profileMissing(body)) throw new ActionError("not_found", `@${handle} doesn't exist (or was banned).`);

      const msgBtn = page.locator('[data-e2e="user-page"] [data-e2e="message-button"]').first();
      if (!(await msgBtn.count())) {
        throw new ActionError(
          "blocked",
          `No Message button on @${handle}'s profile — TikTok web only offers DMs where the account allows them (usually mutual follows).`,
        );
      }
      await msgBtn.click({ timeout: 10_000 });

      const onMessages = await pollFor(async () => page.url().includes("/messages"), (v) => v, 12);
      if (!onMessages) {
        throw new ActionError("blocked", `Clicking Message never opened a conversation — @${handle} may not accept DMs from this account.`);
      }
      await randomWait(1_500, 2_500);

      const composer = page.locator('div[contenteditable="true"]').first();
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "DM composer never appeared on the messages page.");
      });
      await composer.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" }); // Enter would fire a half-written DM
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "tiktok", action: "dm", dryRun: true, handle, chars: text.length,
            sent: false, verified: null, conversationUrl: page.url(),
            note: "dryRun — the DM was typed into the composer but NOT sent.",
          },
        };
      }

      const send = page.locator('[data-e2e="message-send"]').first();
      if (await send.count()) {
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
      console.log(`[dm] tiktok: @${handle} verified=${verified}`);

      if (!verified) {
        return {
          ok: false,
          error: "ambiguous: sent the DM but it never showed in the thread. It MAY have sent — check Messages before retrying.",
          result: { failureCode: "ambiguous", platform: "tiktok", action: "dm", handle, conversationUrl },
        };
      }
      return {
        ok: true,
        result: { platform: "tiktok", action: "dm", handle, chars: text.length, sent: true, verified: true, conversationUrl },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: search ────────────────────────────── */

type TtTab = "top" | "videos" | "accounts";

async function ttSearch(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const query = String(action.params.query ?? "").trim();
    if (!query) throw new ActionError("bad_params", "params.query is required");
    if (query.length > 150) throw new ActionError("bad_params", "params.query is too long (max 150 chars)");

    const rawTab = String(action.params.tab ?? "top").toLowerCase();
    const tab: TtTab = /^(accounts?|people|users?)$/.test(rawTab) ? "accounts" : rawTab === "videos" ? "videos" : "top";
    const limit = clampLimit(action.params.limit, 20, 40);

    const path = tab === "accounts" ? "/search/user" : tab === "videos" ? "/search/video" : "/search";
    const url = `${TT}${path}?q=${encodeURIComponent(query)}`;

    return await withPage(config, async (page) => {
      await gotoTt(page, url, config);

      // Poll result-container COUNTS — a visibility wait on a broad locator can pin
      // itself to the header's hidden search input and time out while results sit there.
      const resultSel = tab === "accounts"
        ? '[data-e2e="search-user-container"], [data-e2e="search-user-item"], [data-e2e^="search-user-info"]'
        : '[data-e2e="search_top-item"], [data-e2e="search_video-item"]';
      const rendered = await pollFor(async () => (await page.locator(resultSel).count()) > 0, (v) => v, 24);
      if (!rendered) {
        const body = await bodyText(page);
        if (/no results found|couldn'?t find any results/i.test(body)) {
          return { ok: true, result: { platform: "tiktok", query, tab, count: 0, results: [], searchUrl: url, note: "TikTok returned no results for this query." } };
        }
        if (tab !== "accounts") throw new ActionError("ui_changed", "No search results rendered and no empty-state message.");
      }

      for (let i = 0; i < 6; i++) {
        const have = await page.locator('[data-e2e="search_top-item"], [data-e2e="search-user-container"]').count();
        if (have >= limit) break;
        await page.mouse.wheel(0, 1_400);
        await randomWait(900, 1_700);
      }

      if (tab === "accounts") {
        const users: any[] = await page.evaluate((max: number) => {
          const out: any[] = [];
          const seen = new Set<string>();
          const containers = Array.from(document.querySelectorAll('[data-e2e="search-user-container"], [data-e2e="search-user-item"]'));
          const scopes = containers.length ? containers : Array.from(document.querySelectorAll("main, body"));
          for (const scope of scopes) {
            for (const a of Array.from(scope.querySelectorAll('a[href^="/@"]'))) {
              if (out.length >= max) break;
              const handle = a.getAttribute("href")?.match(/^\/@([\w.]+)/)?.[1];
              if (!handle || seen.has(handle)) continue;
              const lines = ((a as HTMLElement).innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
              if (!lines.length) continue; // avatar-only anchors
              seen.add(handle);
              out.push({
                handle,
                nickname: lines.find((l) => l !== handle) ?? null,
                subtitle: lines.slice(1).join(" · ").slice(0, 150) || null,
                profileUrl: "https://www.tiktok.com/@" + handle,
              });
            }
          }
          return out;
        }, limit).catch(() => []);
        console.log(`[search] tiktok: "${query}" (accounts) → ${users.length} users`);
        return { ok: true, result: { platform: "tiktok", query, tab, count: users.length, users, searchUrl: url } };
      }

      const results: any[] = await page.evaluate((max: number) => {
        const out: any[] = [];
        const seen = new Set<string>();
        for (const item of Array.from(document.querySelectorAll('[data-e2e="search_top-item"], [data-e2e="search_video-item"]'))) {
          if (out.length >= max) break;
          const a = item.querySelector('a[href*="/video/"], a[href*="/photo/"]') ?? (item.closest('a[href*="/video/"]') as Element | null);
          const href = a?.getAttribute("href") ?? null;
          if (!href || seen.has(href)) continue;
          seen.add(href);

          // The caption/user block is a sibling card — climb until both live under one roof.
          let wrap: HTMLElement | null = item as HTMLElement;
          for (let i = 0; i < 4 && wrap && !wrap.querySelector('[data-e2e="search-card-user-link"]'); i++) wrap = wrap.parentElement;
          const scope = wrap ?? (item as HTMLElement);
          const user = scope.querySelector('[data-e2e="search-card-user-link"]');
          const desc = scope.querySelector('[data-e2e="search-card-video-caption"], [data-e2e="search-card-desc"]') as HTMLElement | null;

          out.push({
            permalink: href.startsWith("http") ? href.split("?")[0] : "https://www.tiktok.com" + href.split("?")[0],
            authorHandle: user?.getAttribute("href")?.match(/\/@([\w.]+)/)?.[1] ?? href.match(/\/@([\w.]+)\//)?.[1] ?? null,
            text: (desc?.innerText ?? "").split("\n").filter((l) => l.trim()).join(" ").slice(0, 300) || null,
            viewsRaw: (item.querySelector('[data-e2e="video-views"]') as HTMLElement | null)?.innerText?.trim() ?? null,
            isLive: !!item.querySelector('[data-e2e="browse-live-player"]'),
          });
        }
        return out;
      }, limit).catch(() => []);

      const videos = results
        .filter((r) => !r.isLive)
        .map((r) => ({ permalink: r.permalink, authorHandle: r.authorHandle, text: r.text, views: parseCount(r.viewsRaw) }));
      console.log(`[search] tiktok: "${query}" (${tab}) → ${videos.length} videos`);
      return {
        ok: true,
        result: {
          platform: "tiktok", query, tab, count: videos.length, results: videos, searchUrl: url,
          liveFiltered: results.length - videos.length || undefined,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: scrape ────────────────────────────── */

async function ttScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const what = String(action.params.what ?? "").toLowerCase();
  try {
    switch (what) {
      case "profile":
        return await scrapeProfile(action, config);
      case "thread":
      case "video":
      case "comments":
        return await scrapeVideo(action, config, what === "comments");
      case "post_metrics":
        return await scrapePostMetrics(action, config);
      default:
        throw new ActionError("bad_params", `for tiktok, params.what must be profile|thread|comments|post_metrics|page (got '${what}')`);
    }
  } catch (e) {
    return toFailure(e);
  }
}

async function scrapeProfile(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 12, 30);

  return withPage(config, async (page) => {
    await gotoTt(page, profileUrl(handle), config);
    const body = await bodyText(page);
    if (profileMissing(body)) throw new ActionError("not_found", `@${handle} doesn't exist (or was banned).`);

    await page.locator('[data-e2e="user-title"]').first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      throw new ActionError("ui_changed", "Profile header never rendered.");
    });
    for (let i = 0; i < 4; i++) {
      if ((await page.locator('[data-e2e="user-post-item"]').count()) >= limit) break;
      await page.mouse.wheel(0, 1_400);
      await randomWait(900, 1_600);
    }

    const data: any = await page.evaluate((max: number) => {
      const txt = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim() ?? null;
      const videos: any[] = [];
      for (const item of Array.from(document.querySelectorAll('[data-e2e="user-post-item"]'))) {
        if (videos.length >= max) break;
        const a = item.querySelector('a[href*="/video/"], a[href*="/photo/"]');
        const href = a?.getAttribute("href");
        if (!href) continue;
        videos.push({
          url: href.startsWith("http") ? href.split("?")[0] : "https://www.tiktok.com" + href.split("?")[0],
          viewsRaw: (item.querySelector('[data-e2e="video-views"]') as HTMLElement | null)?.innerText?.trim() ?? null,
          pinned: !!item.querySelector('[data-e2e="video-card-badge"]'),
          alt: item.querySelector("img")?.getAttribute("alt")?.slice(0, 200) ?? null,
        });
      }
      return {
        nickname: txt('[data-e2e="user-title"]'),
        handle: txt('[data-e2e="user-subtitle"]'),
        followingRaw: txt('[data-e2e="following-count"]'),
        followersRaw: txt('[data-e2e="followers-count"]'),
        likesRaw: txt('[data-e2e="likes-count"]'),
        bio: txt('[data-e2e="user-bio"]'),
        link: document.querySelector('[data-e2e="user-link"]')?.textContent?.trim() ?? null,
        videos,
      };
    }, limit).catch(() => ({ videos: [] }));

    const videos = (data.videos ?? []).map((v: any) => ({ url: v.url, views: parseCount(v.viewsRaw), pinned: v.pinned, alt: v.alt }));
    console.log(`[scrape] tiktok profile @${handle}: ${videos.length} videos, ${data.followersRaw ?? "?"} followers`);
    return {
      ok: true,
      result: {
        what: "profile", platform: "tiktok", handle, profileUrl: profileUrl(handle),
        nickname: data.nickname ?? null, bio: data.bio ?? null, website: data.link ?? null,
        followers: parseCount(data.followersRaw), following: parseCount(data.followingRaw), totalLikes: parseCount(data.likesRaw),
        videoCount: videos.length, recentVideos: videos,
      },
    };
  });
}

async function scrapeVideo(action: Action, config: MarketerConfig, commentsOnly: boolean): Promise<ActionResult> {
  const target0 = requireVideoUrl(action.params.targetUrl);
  const { url } = target0;
  const limit = clampLimit(action.params.limit, 25, 80);

  return withPage(config, async (page) => {
    await gotoVideo(page, target0, config);
    const body = await bodyText(page);
    if (/video currently unavailable|couldn'?t find this video/i.test(body)) {
      throw new ActionError("not_found", "No video at that URL (deleted, private, or wrong link).");
    }

    await openCommentPanel(page);
    await scrollForComments(page, limit);
    const meta = await videoMeta(page);
    const comments = (await extractComments(page, limit)).slice(0, limit);

    console.log(`[scrape] tiktok ${commentsOnly ? "comments" : "thread"}: ${comments.length} comments`);
    return {
      ok: true,
      result: commentsOnly
        ? { what: "comments", platform: "tiktok", url, count: comments.length, comments }
        : {
            what: "thread", platform: "tiktok", url,
            video: { author: meta.author, nickname: meta.nickname, desc: meta.desc, likes: meta.likes, commentCount: meta.comments, favorites: meta.favorites, music: meta.music, url },
            commentCount: comments.length, comments,
            note: "top-level comments only — replies stay collapsed on TikTok web",
          },
    };
  });
}

/**
 * Engagement for a batch of our own videos in one session. The video overlay carries likes,
 * comments and saves; per-video view counts live on the author's grid, so a sweep reads the
 * grid once and matches by video id rather than opening every video twice.
 */
async function scrapePostMetrics(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const raw = action.params.urls ?? [];
  if (!Array.isArray(raw) || !raw.length) {
    throw new ActionError("bad_params", "what:'post_metrics' needs params.urls — an array of TikTok video URLs");
  }
  const targets = raw.slice(0, 25).map((u: unknown) => requireVideoUrl(u));

  return withPage(config, async (page) => {
    const out: any[] = [];
    const viewsByAuthor = new Map<string, Map<string, number | null>>();

    for (const target of targets) {
      try {
        // Grid views, fetched once per author and reused across that author's videos.
        if (!viewsByAuthor.has(target.author)) {
          const map = new Map<string, number | null>();
          try {
            await gotoTt(page, profileUrl(target.author), config);
            for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1_400); await randomWait(800, 1_500); }
            const grid: any[] = await page.evaluate(() => {
              const rows: any[] = [];
              for (const item of Array.from(document.querySelectorAll('[data-e2e="user-post-item"]'))) {
                const href = item.querySelector('a[href*="/video/"], a[href*="/photo/"]')?.getAttribute("href") ?? "";
                const id = href.match(/\/(?:video|photo)\/(\d+)/)?.[1];
                if (!id) continue;
                rows.push({ id, viewsRaw: (item.querySelector('[data-e2e="video-views"]') as HTMLElement | null)?.innerText?.trim() ?? null });
              }
              return rows;
            }).catch(() => []);
            for (const g of grid) map.set(g.id, parseCount(g.viewsRaw));
          } catch { /* grid unreadable — views stay null, the rest still works */ }
          viewsByAuthor.set(target.author, map);
        }

        await gotoVideo(page, target, config);
        const meta = await videoMeta(page);
        const views = viewsByAuthor.get(target.author)?.get(target.videoId) ?? null;
        out.push({
          permalink: target.url,
          metrics: { views, likes: meta.likes, comments: meta.comments, saves: meta.favorites },
        });
      } catch (e) {
        out.push({ permalink: target.url, error: (e as Error).message.slice(0, 120) });
      }
      await randomWait(1_500, 3_000);
    }
    const read = out.filter((o) => o.metrics).length;
    console.log(`[scrape] tiktok post_metrics: ${read}/${out.length} read`);
    return { ok: true, result: { what: "post_metrics", platform: "tiktok", count: out.length, read, posts: out } };
  });
}

/* ────────────────────────────── adapter surface ────────────────────────────── */

export const tiktokAdapter = {
  like: ttLike,
  comment: ttComment,
  follow: ttFollow,
  dm: ttDm,
  search: ttSearch,
  scrape: ttScrape,
};
