import { MarketerConfig } from "../config/types";
import { randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import { ActionError, gotoX, profileUrl, resolveHandle, toFailure, withX } from "./xCommon";

/**
 * Follow (or, with params.undo, unfollow) an account on X.
 *
 * The follow button lives in the profile header, but X renders identical buttons in the
 * "Who to follow" rail — so everything is scoped to the primary column and re-identified
 * by the button's own `<userId>-follow` testid, which is what we verify against.
 */
export async function runFollow(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    if (action.platform !== "twitter") {
      throw new ActionError("bad_params", `follow is only implemented for 'twitter' (got '${action.platform ?? "none"}')`);
    }
    const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
    const undo = action.params.undo === true;
    const dryRun = action.params.dryRun === true;

    return await withX(config, async (page) => {
      await gotoX(page, profileUrl(handle), config);

      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (/this account doesn.t exist|account suspended/i.test(body)) {
        throw new ActionError("not_found", `@${handle} doesn't exist or is suspended.`);
      }
      if (/you.re blocked|has blocked you/i.test(body)) {
        throw new ActionError("blocked", `@${handle} has blocked this account.`);
      }

      const column = page.locator('[data-testid="primaryColumn"]');
      await column.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
      const followBtn = column.locator('button[data-testid$="-follow"]').first();
      const unfollowBtn = column.locator('button[data-testid$="-unfollow"]').first();

      const wasFollowing = (await unfollowBtn.count()) > 0;
      if (!wasFollowing && !(await followBtn.count())) {
        throw new ActionError("ui_changed", `No follow/unfollow button on @${handle}'s profile — layout changed, or this is our own profile.`);
      }
      const testId = await (wasFollowing ? unfollowBtn : followBtn).getAttribute("data-testid");
      const userId = testId?.replace(/-(un)?follow$/, "") ?? null;

      const wanted = !undo;
      if (wasFollowing === wanted) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: undo ? "unfollow" : "follow", handle, userId,
            changed: false, following: wasFollowing, verified: true,
            note: `already ${wasFollowing ? "following" : "not following"} @${handle} — nothing to do`,
          },
        };
      }
      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: undo ? "unfollow" : "follow", dryRun: true, handle, userId,
            changed: false, following: wasFollowing, verified: null,
            note: "dryRun — the button was found but not clicked.",
          },
        };
      }

      await (undo ? unfollowBtn : followBtn).click({ timeout: 10_000 });
      // Unfollow raises a confirmation sheet; follow does not.
      if (undo) {
        const confirm = page.locator('[data-testid="confirmationSheetConfirm"]');
        if (await confirm.count().catch(() => 0)) {
          await randomWait(500, 1_100);
          await confirm.first().click({ timeout: 8_000 }).catch(() => {});
        }
      }
      await randomWait(1_200, 2_200);

      const expected = userId ? `button[data-testid="${userId}-${wanted ? "unfollow" : "follow"}"]` : `button[data-testid$="-${wanted ? "unfollow" : "follow"}"]`;
      let verified = false;
      for (let i = 0; i < 8 && !verified; i++) {
        verified = (await column.locator(expected).count()) > 0;
        if (!verified) await randomWait(400, 900);
      }
      console.log(`[follow] twitter: ${undo ? "unfollow" : "follow"} @${handle} verified=${verified}`);

      return {
        ok: verified,
        error: verified ? undefined : "ambiguous: clicked but the button never flipped state — the follow may not have registered.",
        result: {
          failureCode: verified ? undefined : "ambiguous",
          platform: "twitter", action: undo ? "unfollow" : "follow", handle, userId,
          profileUrl: profileUrl(handle), changed: verified, following: verified ? wanted : wasFollowing, verified,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}
