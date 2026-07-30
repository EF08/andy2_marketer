import { MarketerConfig } from "../config/types";
import { randomWait } from "../browser/humanize";
import { adapterExec, platformsSupporting } from "./adapters";
import type { Action, ActionResult } from "./index";
import {
  ActionError, evidence, extractTweets, focalTweet, gotoX, requireStatusUrl, toFailure,
  waitForTweets, withX,
} from "./xCommon";

/**
 * Like (or, with params.undo, un-like) a post on X.
 *
 * Idempotent by construction: X renders `unlike` in place of `like` once a post is
 * liked, so an already-liked target is a no-op success rather than a double-tap.
 */
export async function runLike(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const impl = adapterExec(action.platform, "like");
    if (impl) return await impl(action, config);
    if (action.platform !== "twitter") {
      throw new ActionError("bad_params", `like isn't implemented for '${action.platform ?? "none"}' (supported: ${platformsSupporting("like").join(", ")})`);
    }
    const { url, statusId } = requireStatusUrl(action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withX(config, async (page) => {
      await gotoX(page, url, config);
      await waitForTweets(page);

      const focal = await focalTweet(page, statusId);
      const target = (await extractTweets(page, 10)).find((t) => t.permalink?.includes(statusId)) ?? null;

      const likeBtn = focal.locator('[data-testid="like"]').first();
      const unlikeBtn = focal.locator('[data-testid="unlike"]').first();
      const wasLiked = (await unlikeBtn.count()) > 0;
      if (!wasLiked && !(await likeBtn.count())) {
        throw new ActionError("ui_changed", "Neither a like nor an unlike button on the focal post — X's layout may have changed.");
      }

      const wanted = !undo;
      if (wasLiked === wanted) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: undo ? "unlike" : "like", targetUrl: url,
            changed: false, liked: wasLiked, verified: true,
            ...evidence(target, { note: `already ${wasLiked ? "liked" : "not liked"} — nothing to do` }),
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: undo ? "unlike" : "like", dryRun: true, targetUrl: url,
            changed: false, liked: wasLiked, verified: null,
            ...evidence(target, { note: "dryRun — the button was found but not clicked." }),
          },
        };
      }

      await (undo ? unlikeBtn : likeBtn).click({ timeout: 10_000 });
      await randomWait(900, 1_800);

      // Verify by the swap: like ⇄ unlike. Poll — the optimistic UI can lag a beat.
      let nowLiked = wasLiked;
      for (let i = 0; i < 8; i++) {
        nowLiked = (await focal.locator('[data-testid="unlike"]').count()) > 0;
        if (nowLiked === wanted) break;
        await randomWait(400, 800);
      }
      const verified = nowLiked === wanted;
      console.log(`[like] twitter: ${undo ? "unlike" : "like"} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the action may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "twitter", action: undo ? "unlike" : "like", targetUrl: url,
          changed: verified, liked: nowLiked, verified,
          ...evidence(target),
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}
