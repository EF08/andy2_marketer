/**
 * Instagram adapter — act + read flows for instagram.com in the logged-in profile.
 *
 * IG's DOM carries no test ids, so everything hangs off the accessibility layer
 * (svg[aria-label], role=button names, input aria-labels), which has been far more
 * stable than its class soup. Selectors verified live against the logged-in web
 * app (Jul 2026): action bar = the section containing the Comment svg; comment box
 * = textarea[aria-label="Add a comment…"]; nav search opens a flyout with
 * input[aria-label="Search input"].
 *
 * Not supported here: `post` — feed posts require media, and the asset pipeline
 * is a separate build (BRIEF decision #8 covers the imageUrl bridge).
 */
import { Locator, Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { humanType, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import {
  ActionError, bodyText, clampLimit, dismissDialogButton, gotoOn, parseCount, pollFor,
  requireHost, toFailure, withPage,
} from "./webCommon";

const IG = "https://www.instagram.com";
const IG_HOSTS = ["instagram.com", "m.instagram.com"];
const MAX_COMMENT_CHARS = 2_200;
const MAX_DM_CHARS = 900;

const RESERVED = new Set([
  "p", "reel", "reels", "tv", "explore", "direct", "stories", "accounts", "about", "developer",
]);

/* ────────────────────────────── urls + handles ────────────────────────────── */

/** Require a link to a specific post/reel and normalize it. */
function requirePostUrl(raw: unknown): { url: string; shortcode: string; kind: string } {
  const u = requireHost(raw, IG_HOSTS, "instagram.com");
  const m = u.pathname.match(/\/(?:[A-Za-z0-9._]+\/)?(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) {
    throw new ActionError("bad_params", `targetUrl must point at a post or reel (…instagram.com/p/<code>/ or /reel/<code>/), got ${u.pathname}`);
  }
  const kind = m[1] === "tv" ? "reel" : m[1];
  return { url: `${IG}/${kind}/${m[2]}/`, shortcode: m[2], kind };
}

/** Accept "@handle", "handle", or a profile URL → bare handle. */
function resolveHandle(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new ActionError("bad_params", "a handle (or profile URL) is required");
  if (/^https?:\/\//i.test(s)) {
    const u = requireHost(s, IG_HOSTS, "instagram.com");
    s = u.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  s = s.replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) throw new ActionError("bad_params", `Not a valid Instagram handle: ${raw}`);
  if (RESERVED.has(s.toLowerCase())) throw new ActionError("bad_params", `'${s}' is an Instagram system page, not a profile`);
  return s;
}

const profileUrl = (handle: string) => `${IG}/${handle}/`;

/* ────────────────────────────── navigation ────────────────────────────── */

async function gotoIg(page: Page, url: string, config: MarketerConfig): Promise<void> {
  await gotoOn(page, "instagram", url, config);
  await clearInterstitials(page);
}

/** IG's soft-failure states: consent sheets, the notifications nag, action blocks. */
async function clearInterstitials(page: Page): Promise<void> {
  await dismissDialogButton(page, /^(allow all cookies|accept all)$/i);
  await dismissDialogButton(page, /^not now$/i);

  const url = page.url();
  if (/\/challenge\//.test(url) || /\/accounts\/login/.test(url)) {
    throw new ActionError("login_required", "Instagram redirected to a login/challenge page — the session needs a human touch (`npm run login`).");
  }
  const body = await bodyText(page);
  if (/we limit how often|try again later|action blocked/i.test(body)) {
    throw new ActionError("rate_limited", "Instagram is showing an action-block notice — stopping instead of pushing through.");
  }
}

function pageUnavailable(body: string): boolean {
  return /sorry, this page isn't available/i.test(body);
}

/** Our own handle, read from the sidebar's Profile link. */
async function ownHandle(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") ?? "";
        if (!/^\/[A-Za-z0-9._]{1,30}\/$/.test(href)) continue;
        if ((a.textContent ?? "").includes("Profile")) return href.replace(/\//g, "");
      }
      return null;
    })
    .catch(() => null);
}

/* ────────────────────────────── post page helpers ────────────────────────────── */

/** The post's action bar — the (innermost) section holding Like/Comment/Share/Save. */
function actionBar(page: Page): Locator {
  return page
    .locator("section")
    .filter({ has: page.locator('svg[aria-label="Comment"]') })
    .last();
}

async function likeState(bar: Locator): Promise<boolean | null> {
  if (await bar.locator('svg[aria-label="Unlike"]').count()) return true;
  if (await bar.locator('svg[aria-label="Like"]').count()) return false;
  return null;
}

type IgPostMeta = { author: string | null; caption: string | null; likes: number | null; postedAt: string | null };

/** Author, caption, likes, timestamp of the open post (page or modal). */
async function postMeta(page: Page): Promise<IgPostMeta> {
  const author = await page
    .evaluate((reserved: string[]) => {
      const scope = document.querySelector('div[role="dialog"]') ?? document.querySelector("main") ?? document.body;
      for (const a of Array.from(scope.querySelectorAll('header a[href^="/"], a[href^="/"]'))) {
        const m = a.getAttribute("href")?.match(/^\/([A-Za-z0-9._]{1,30})\/$/);
        if (m && !reserved.includes(m[1].toLowerCase())) return m[1];
      }
      return null;
    }, Array.from(RESERVED))
    .catch(() => null);

  // The first time-bearing row is the caption (it shares the post's author).
  const { rows, postLikesRaw } = await extractRows(page, 3);
  const captionRow = rows[0]?.author && rows[0].author === author ? rows[0] : null;
  return {
    author,
    caption: captionRow?.text?.slice(0, 500) ?? null,
    likes: parseCount(postLikesRaw),
    postedAt: captionRow?.postedAt ?? rows[0]?.postedAt ?? null,
  };
}

type IgComment = { author: string | null; text: string; postedAt: string | null; likes: number | null };

/**
 * Caption + comments under the open post. IG renders two different layouts (the
 * modal is UL/LI, the standalone /p/ page is plain divs), but in both every
 * caption/comment row carries a <time> — so rows are found by walking up from each
 * time element to the wrapper that also holds the author's profile link. The first
 * row is the caption. Row text reads [author, "Edited", "•", age, …text…, "N likes",
 * "Reply"], so the chrome gets stripped line-wise.
 */
async function extractRows(page: Page, max: number): Promise<{ rows: IgComment[]; postLikesRaw: string | null }> {
  return page
    .evaluate((maxItems: number) => {
      const scope = document.querySelector('div[role="dialog"]') ?? document.querySelector("main") ?? document.body;
      const seen = new Set<Element>();
      const rows: any[] = [];
      for (const t of Array.from(scope.querySelectorAll("time"))) {
        // The row wrapper is the ancestor that holds the avatar IMAGE — stopping at the
        // first profile LINK lands on the bare username strip and loses the text.
        // Keep walking even past maxItems: `seen` must cover every row so the post-likes
        // scan below can exclude ALL comment like-counts, not just the returned rows'.
        let node: HTMLElement | null = t.parentElement;
        let wrap: HTMLElement | null = null;
        for (let i = 0; i < 8 && node; i++) {
          if (node.querySelector('a[href^="/"] img, img[alt*="profile picture"]')) { wrap = node; break; }
          node = node.parentElement;
        }
        if (!wrap || seen.has(wrap)) continue;
        seen.add(wrap);
        if (rows.length >= maxItems) continue;

        const authorA = Array.from(wrap.querySelectorAll('a[href^="/"]')).find((x) =>
          /^\/[A-Za-z0-9._]{1,30}\/?$/.test(x.getAttribute("href") ?? ""),
        );
        const author = authorA?.getAttribute("href")?.match(/^\/([A-Za-z0-9._]+)\/?/)?.[1] ?? null;
        if (!author) continue;

        const lines = (wrap.innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        const text = lines
          .filter((l) =>
            l !== author && l !== "•" && l !== "Verified" &&
            !/^(Edited|Original audio|Follow)$/i.test(l) &&
            !/^(\d+\s?[smhdwy])(\s*·\s*Edited)?$/i.test(l) && !/^[\d,.]+[KMB]? likes?$/i.test(l) &&
            !/^Reply$/i.test(l) && !/^(View all \d+ replies|View replies.*|Hide replies)$/i.test(l),
          )
          .join(" ")
          .trim();
        const likesM = (wrap.innerText ?? "").match(/([\d,.]+[KMB]?) likes?/i);
        rows.push({ author, text: text.slice(0, 500), postedAt: t.getAttribute("datetime"), likesRaw: likesM?.[1] ?? null });
      }

      // The post's own like count lives OUTSIDE the caption/comment rows: the modal's
      // liked_by link, or a bare "N likes" node on the standalone layout.
      let postLikesRaw: string | null =
        (scope.querySelector('a[href*="/liked_by/"]') as HTMLElement | null)?.innerText?.match(/([\d.,]+[KMB]?)\s*likes?/i)?.[1] ?? null;
      if (!postLikesRaw) {
        for (const el of Array.from(scope.querySelectorAll("span, a"))) {
          const m = (el.textContent ?? "").trim().match(/^([\d.,]+[KMB]?) likes$/i);
          if (!m) continue;
          let inRow = false;
          for (const w of seen) if (w.contains(el)) { inRow = true; break; }
          if (!inRow) { postLikesRaw = m[1]; break; }
        }
      }
      return { rows, postLikesRaw };
    }, max)
    .then((r: any) => ({
      rows: r.rows.map((x: any) => ({ author: x.author, text: x.text, postedAt: x.postedAt, likes: parseCount(x.likesRaw) })),
      postLikesRaw: r.postLikesRaw,
    }))
    .catch(() => ({ rows: [], postLikesRaw: null }));
}

/* ────────────────────────────── act: like ────────────────────────────── */

async function igLike(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url } = requirePostUrl(action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoIg(page, url, config);
      if (pageUnavailable(await bodyText(page))) {
        throw new ActionError("not_found", "No post at that URL (deleted, private, or wrong link).");
      }

      const bar = actionBar(page);
      await bar.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "The post's action bar never rendered — IG's layout may have changed.");
      });
      const meta = await postMeta(page);
      const wasLiked = await likeState(bar);
      if (wasLiked === null) throw new ActionError("ui_changed", "Neither a Like nor an Unlike control on the post.");

      const wanted = !undo;
      const target = { url, author: meta.author, text: meta.caption?.slice(0, 200) ?? null };
      if (wasLiked === wanted) {
        return {
          ok: true,
          result: {
            platform: "instagram", action: undo ? "unlike" : "like", targetUrl: url,
            changed: false, liked: wasLiked, verified: true, target,
            note: `already ${wasLiked ? "liked" : "not liked"} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "instagram", action: undo ? "unlike" : "like", dryRun: true, targetUrl: url,
            changed: false, liked: wasLiked, verified: null, target,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await bar.locator(`svg[aria-label="${undo ? "Unlike" : "Like"}"]`).first().click({ timeout: 10_000 });
      const nowLiked = await pollFor(() => likeState(bar), (v) => v === wanted);
      const verified = nowLiked === wanted;
      console.log(`[like] instagram: ${undo ? "unlike" : "like"} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the control never flipped state — the action may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "instagram", action: undo ? "unlike" : "like", targetUrl: url,
          changed: verified, liked: nowLiked ?? wasLiked, verified, target,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: comment ────────────────────────────── */

async function igComment(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const { url } = requirePostUrl(action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_COMMENT_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over Instagram's ${MAX_COMMENT_CHARS} limit`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoIg(page, url, config);
      if (pageUnavailable(await bodyText(page))) {
        throw new ActionError("not_found", "No post at that URL (deleted, private, or wrong link).");
      }
      const handle = await ownHandle(page);
      const meta = await postMeta(page);
      const target = { url, author: meta.author, text: meta.caption?.slice(0, 200) ?? null };

      const box = page.locator('textarea[aria-label*="Add a comment"]').first();
      if (!(await box.count())) {
        throw new ActionError("blocked", "No comment box on this post — comments are off or limited.");
      }
      await box.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" }); // Enter would post a half-written comment
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "instagram", action: "comment", dryRun: true, targetUrl: url, chars: text.length,
            sent: false, verified: null, target, note: "dryRun — comment box filled, nothing was sent.",
          },
        };
      }

      // The Post control enables once the draft is non-empty.
      const post = page.getByRole("button", { name: /^post$/i }).first();
      await post.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
        throw new ActionError("ui_changed", "The comment Post button never appeared.");
      });
      await post.click({ timeout: 10_000 });
      console.log(`[comment] instagram: clicked Post (${text.length} chars)`);

      // Verify-after-act: our comment (own handle + text snippet) shows up in the list.
      const snippet = text.split("\n")[0].slice(0, 40);
      const appeared = await pollFor(
        async () => {
          const body = await bodyText(page);
          if (/couldn'?t post comment|try again/i.test(body)) return "failed";
          const { rows } = await extractRows(page, 30);
          return rows.some((c) => c.text.includes(snippet) && (!handle || c.author === handle)) ? "found" : "pending";
        },
        (v) => v !== "pending",
        14,
      );
      const verified = appeared === "found";
      console.log(`[comment] instagram: sent verified=${verified}`);

      if (appeared === "failed") {
        return {
          ok: false,
          error: "platform_error: Instagram rejected the comment (\"Couldn't post comment\").",
          result: { failureCode: "platform_error", platform: "instagram", action: "comment", targetUrl: url, target },
        };
      }
      return {
        ok: true,
        result: {
          platform: "instagram", action: "comment", handle, chars: text.length,
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

async function igFollow(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      await gotoIg(page, profileUrl(handle), config);
      if (pageUnavailable(await bodyText(page))) {
        throw new ActionError("not_found", `@${handle} doesn't exist (or the page is unavailable).`);
      }

      const header = page.locator("header").first();
      await header.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "No profile header rendered — IG's layout may have changed.");
      });

      const readState = async (): Promise<"following" | "requested" | "none" | null> => {
        if (await header.getByRole("button", { name: /^following$/i }).count()) return "following";
        if (await header.getByRole("button", { name: /^requested$/i }).count()) return "requested";
        if (await header.getByRole("button", { name: /^follow( back)?$/i }).count()) return "none";
        return null;
      };
      const was = await readState();
      if (was === null) {
        throw new ActionError("ui_changed", `No follow control on @${handle}'s profile — layout changed, or this is our own profile.`);
      }

      const wantedFollowing = !undo;
      const isFollowing = was === "following" || was === "requested";
      if (isFollowing === wantedFollowing) {
        return {
          ok: true,
          result: {
            platform: "instagram", action: undo ? "unfollow" : "follow", handle, profileUrl: profileUrl(handle),
            changed: false, following: isFollowing, requested: was === "requested", verified: true,
            note: `already ${was === "none" ? "not following" : was} @${handle} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "instagram", action: undo ? "unfollow" : "follow", dryRun: true, handle,
            changed: false, following: isFollowing, verified: null,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      if (undo) {
        await header.getByRole("button", { name: was === "requested" ? /^requested$/i : /^following$/i }).first().click({ timeout: 10_000 });
        await randomWait(800, 1_500);
        // Unfollow raises a confirmation sheet.
        await dismissDialogButton(page, /^unfollow$/i);
      } else {
        await header.getByRole("button", { name: /^follow( back)?$/i }).first().click({ timeout: 10_000 });
      }

      const now = await pollFor(readState, (v) => (wantedFollowing ? v === "following" || v === "requested" : v === "none"));
      const nowFollowing = now === "following" || now === "requested";
      const verified = nowFollowing === wantedFollowing;
      console.log(`[follow] instagram: ${undo ? "unfollow" : "follow"} @${handle} verified=${verified}${now === "requested" ? " (requested — private account)" : ""}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the action may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "instagram", action: undo ? "unfollow" : "follow", handle, profileUrl: profileUrl(handle),
          changed: verified, following: nowFollowing, requested: now === "requested", verified,
          note: now === "requested" ? "private account — follow request sent, awaiting approval" : undefined,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── act: dm ────────────────────────────── */

async function igDm(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_DM_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_DM_CHARS} cap`);
    }
    const dryRun = action.params.dryRun === true;

    return await withPage(config, async (page) => {
      let route: "profile" | "compose" = "profile";
      await gotoIg(page, profileUrl(handle), config);
      if (pageUnavailable(await bodyText(page))) {
        throw new ActionError("not_found", `@${handle} doesn't exist (or the page is unavailable).`);
      }

      const msgBtn = page.locator("header").getByRole("button", { name: /^message$/i }).first();
      if (await msgBtn.count()) {
        await msgBtn.click({ timeout: 10_000 });
        await randomWait(2_000, 3_500);
      } else {
        // No Message button (private, restricted) — the New Message dialog can still reach them.
        route = "compose";
        await gotoIg(page, `${IG}/direct/new/`, config);
        const search = page.locator('input[name="searchInput"]').first();
        await search.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
          throw new ActionError("ui_changed", "The DM compose view didn't render its recipient search.");
        });
        await search.click();
        await randomWait(400, 900);
        await humanType(page, handle);
        await randomWait(2_000, 3_200);

        const row = page.getByText(handle, { exact: true }).first();
        if (!(await row.count())) {
          throw new ActionError("not_found", `@${handle} did not appear in DM recipient search — they may not accept messages from this account.`);
        }
        await row.click({ timeout: 10_000 });
        await randomWait(600, 1_200);
        const chat = page.getByRole("button", { name: /^(chat|next)$/i }).first();
        if (await chat.count()) await chat.click({ timeout: 8_000 });
        await randomWait(1_800, 3_000);
      }

      const body = await bodyText(page);
      if (/you can'?t message this account|unable to send message/i.test(body)) {
        throw new ActionError("blocked", `Instagram won't allow messaging @${handle} from this account.`);
      }

      const composer = page.locator('div[contenteditable="true"][aria-label*="Message"], div[role="textbox"][contenteditable="true"]').first();
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "DM composer never appeared — IG may have changed the thread view.");
      });
      await composer.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" }); // Enter would fire a half-written DM
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "instagram", action: "dm", dryRun: true, handle, route, chars: text.length,
            sent: false, verified: null, conversationUrl: page.url(),
            note: "dryRun — the DM was typed into the composer but NOT sent.",
          },
        };
      }

      // A "Send" control appears once the draft is non-empty; Enter is the fallback.
      const send = page.getByRole("button", { name: /^send$/i }).first();
      if (await send.count()) {
        await send.click({ timeout: 10_000 });
      } else {
        await page.keyboard.press("Enter");
      }

      const snippet = text.split("\n")[0].slice(0, 40);
      const verified = await pollFor(
        async () => {
          const left = (await composer.innerText().catch(() => null))?.trim();
          const shown = (await bodyText(page)).includes(snippet);
          return left === "" && shown;
        },
        (v) => v,
        14,
      );
      const conversationUrl = page.url();
      console.log(`[dm] instagram: @${handle} via ${route} verified=${verified}`);

      if (!verified) {
        return {
          ok: false,
          error: "ambiguous: clicked Send but the message never showed in the thread. It MAY have sent — check DMs before retrying.",
          result: { failureCode: "ambiguous", platform: "instagram", action: "dm", handle, route, conversationUrl },
        };
      }
      return {
        ok: true,
        result: { platform: "instagram", action: "dm", handle, route, chars: text.length, sent: true, verified: true, conversationUrl },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: search ────────────────────────────── */

/**
 * IG web has no results URL worth scraping — the nav search opens a flyout whose
 * suggestions ARE the result set (accounts + hashtags). Type, wait for the debounce,
 * harvest the panel. Pressing Enter would navigate away and lose the list.
 */
async function igSearch(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const query = String(action.params.query ?? "").trim();
    if (!query) throw new ActionError("bad_params", "params.query is required");
    if (query.length > 150) throw new ActionError("bad_params", "params.query is too long (max 150 chars)");
    const limit = clampLimit(action.params.limit, 12, 25);

    return await withPage(config, async (page) => {
      await gotoIg(page, IG, config);

      await page.locator('a:has(svg[aria-label="Search"]), div[role="button"]:has(svg[aria-label="Search"])').first()
        .click({ timeout: 10_000 });
      const input = page.locator('input[aria-label="Search input"], input[placeholder="Search"]').first();
      await input.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
        throw new ActionError("ui_changed", "The search flyout never opened.");
      });
      // A decorative div[role=button] overlays the input and eats pointer events — focus instead.
      await input.focus();
      await randomWait(300, 700);
      await humanType(page, query);
      await randomWait(2_500, 3_800); // debounce + fetch

      const rows: any[] = await page.evaluate(() => {
        const out: any[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const r = a.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.left > 700) continue; // only the flyout panel
          const href = a.getAttribute("href") ?? "";
          const lines = ((a as HTMLElement).innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
          if (/^\/explore\/tags\//.test(href) || lines[0]?.startsWith("#")) {
            out.push({ kind: "hashtag", href, lines });
          } else if (/^\/[A-Za-z0-9._]{1,30}\/$/.test(href) && lines.length) {
            out.push({ kind: "account", href, lines });
          }
        }
        return out;
      });

      const seen = new Set<string>();
      const accounts: any[] = [];
      const hashtags: any[] = [];
      for (const r of rows) {
        if (seen.has(r.href)) continue;
        seen.add(r.href);
        if (r.kind === "account") {
          const handle = r.href.replace(/\//g, "");
          // Result rows read as [handle, subtitle…]; nav links ("HomeHome", "Profile") don't.
          if (RESERVED.has(handle.toLowerCase()) || r.lines[0] !== handle) continue;
          if (accounts.length >= limit) continue;
          accounts.push({
            handle,
            name: r.lines.find((l: string) => l !== handle && !/following|follower/i.test(l)) ?? null,
            subtitle: r.lines.slice(1).join(" · ").slice(0, 120) || null,
            profileUrl: `${IG}/${handle}/`,
          });
        } else if (hashtags.length < limit) {
          hashtags.push({ tag: r.lines[0] ?? null, url: `${IG}${r.href}` });
        }
      }

      console.log(`[search] instagram: "${query}" → ${accounts.length} accounts, ${hashtags.length} hashtags`);
      return {
        ok: true,
        result: {
          platform: "instagram", query, count: accounts.length + hashtags.length, accounts, hashtags,
          note: "IG web search returns accounts + hashtags (no post search on web). Scrape a profile for its posts.",
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── read: scrape ────────────────────────────── */

async function igScrape(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const what = String(action.params.what ?? "").toLowerCase();
  try {
    switch (what) {
      case "profile":
        return await scrapeProfile(action, config);
      case "thread":
      case "comments":
      case "post":
        return await scrapePost(action, config, what === "comments");
      case "post_metrics":
        return await scrapePostMetrics(action, config);
      default:
        throw new ActionError("bad_params", `for instagram, params.what must be profile|thread|comments|post_metrics|page (got '${what}')`);
    }
  } catch (e) {
    return toFailure(e);
  }
}

async function scrapeProfile(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 12, 24);

  return withPage(config, async (page) => {
    await gotoIg(page, profileUrl(handle), config);
    const body = await bodyText(page);
    if (pageUnavailable(body)) throw new ActionError("not_found", `@${handle} doesn't exist.`);

    const header = await page
      .evaluate(() => {
        const h = document.querySelector("header");
        const text = h ? (h as HTMLElement).innerText : "";
        const m = (re: RegExp) => text.match(re)?.[1] ?? null;
        const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
        const countIdx = lines.findIndex((l) => /posts$/i.test(l));
        return {
          username: lines[0] ?? null,
          name: countIdx > 1 ? lines[1] : null,
          postsRaw: m(/([\d.,KMB]+)\s+posts/i),
          followersRaw: m(/([\d.,KMB]+)\s+followers/i),
          followingRaw: m(/([\d.,KMB]+)\s+following/i),
          bio: lines
            .slice(countIdx + 3 > 0 ? countIdx + 3 : 2)
            .filter((l) => !/^(follow|following|message|requested)$/i.test(l))
            .join("\n")
            .slice(0, 500) || null,
        };
      })
      .catch(() => ({ username: handle, name: null, postsRaw: null, followersRaw: null, followingRaw: null, bio: null }));

    const isPrivate = /this account is private/i.test(body);
    const posts: any[] = await page.evaluate((max: number) => {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const a of Array.from(document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]'))) {
        const href = a.getAttribute("href") ?? "";
        const m = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (!m || seen.has(m[2]) || out.length >= max) continue;
        seen.add(m[2]);
        out.push({
          url: `https://www.instagram.com/${m[1]}/${m[2]}/`,
          kind: m[1] === "reel" ? "reel" : "post",
          alt: a.querySelector("img")?.getAttribute("alt")?.slice(0, 200) ?? null,
        });
      }
      return out;
    }, limit).catch(() => []);

    console.log(`[scrape] instagram profile @${handle}: ${posts.length} posts, ${header.followersRaw ?? "?"} followers`);
    return {
      ok: true,
      result: {
        what: "profile", platform: "instagram", handle, profileUrl: profileUrl(handle),
        name: header.name, bio: header.bio, isPrivate,
        posts: parseCount(header.postsRaw), followers: parseCount(header.followersRaw), following: parseCount(header.followingRaw),
        postCount: posts.length, recentPosts: posts,
        note: isPrivate ? "private account — header stats only, grid not visible" : undefined,
      },
    };
  });
}

async function scrapePost(action: Action, config: MarketerConfig, commentsOnly: boolean): Promise<ActionResult> {
  const { url } = requirePostUrl(action.params.targetUrl);
  const limit = clampLimit(action.params.limit, 25, 80);

  return withPage(config, async (page) => {
    await gotoIg(page, url, config);
    if (pageUnavailable(await bodyText(page))) {
      throw new ActionError("not_found", "No post at that URL (deleted, private, or wrong link).");
    }

    // Comments hydrate well after the shell — wait for the timestamp, then let the list settle.
    await page.locator("time[datetime]").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    await randomWait(2_000, 3_200);
    await page.mouse.wheel(0, 400);
    await randomWait(1_000, 1_800);

    // Comments load in pages — the "+" button (aria-label "Load more comments") pulls more.
    for (let i = 0; i < 4; i++) {
      const more = page.locator('svg[aria-label="Load more comments"]').first();
      if (!(await more.count().catch(() => 0))) break;
      if ((await extractRows(page, limit + 5)).rows.length > limit) break;
      await more.click({ timeout: 6_000 }).catch(() => {});
      await randomWait(1_500, 2_500);
    }

    const meta = await postMeta(page);
    // Row 0 is the caption when it shares the post's author — everything after is comments.
    const { rows } = await extractRows(page, limit + 1);
    const comments = (rows[0]?.author === meta.author ? rows.slice(1) : rows).slice(0, limit);

    console.log(`[scrape] instagram ${commentsOnly ? "comments" : "thread"}: ${comments.length} comments`);
    return {
      ok: true,
      result: commentsOnly
        ? { what: "comments", platform: "instagram", url, count: comments.length, comments }
        : {
            what: "thread", platform: "instagram", url,
            post: { author: meta.author, caption: meta.caption, likes: meta.likes, postedAt: meta.postedAt, url },
            commentCount: comments.length, comments,
          },
    };
  });
}

/**
 * Engagement for a batch of our own posts, one browser session for the lot. IG's web post
 * page exposes likes and (by counting) comments; view counts are only on reels and only in
 * the app, so `views` is honestly absent rather than guessed at.
 */
async function scrapePostMetrics(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const raw = action.params.urls ?? [];
  if (!Array.isArray(raw) || !raw.length) {
    throw new ActionError("bad_params", "what:'post_metrics' needs params.urls — an array of post/reel URLs");
  }
  const targets = raw.slice(0, 25).map((u: unknown) => requirePostUrl(u));

  return withPage(config, async (page) => {
    const out: any[] = [];
    for (const { url } of targets) {
      try {
        await gotoIg(page, url, config);
        if (pageUnavailable(await bodyText(page))) { out.push({ permalink: url, error: "not_found" }); continue; }
        const meta = await postMeta(page);
        const { rows } = await extractRows(page, 60);
        const comments = Math.max(0, rows.length - 1); // row 0 is the caption
        out.push({ permalink: url, metrics: { likes: meta.likes, comments } });
      } catch (e) {
        out.push({ permalink: url, error: (e as Error).message.slice(0, 120) });
      }
      await randomWait(1_500, 3_000);
    }
    const read = out.filter((o) => o.metrics).length;
    console.log(`[scrape] instagram post_metrics: ${read}/${out.length} read`);
    return { ok: true, result: { what: "post_metrics", platform: "instagram", count: out.length, read, posts: out, note: "Instagram web exposes no view count for feed posts — views are absent, not zero." } };
  });
}

/* ────────────────────────────── adapter surface ────────────────────────────── */

export const instagramAdapter = {
  like: igLike,
  comment: igComment,
  follow: igFollow,
  dm: igDm,
  search: igSearch,
  scrape: igScrape,
};
