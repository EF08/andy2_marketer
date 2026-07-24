import { MarketerConfig } from "../config/types";
import { humanizePage, humanType, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import {
  ActionError, findPermalinkByText, gotoX, ownHandle, submitComposer, toFailure,
  waitForSendConfirmation, waitForTweets, withX,
} from "./xCommon";

const MAX_POST_CHARS = 280;

/**
 * Post to X. Opens the inline composer on /home, types like a human, posts, then
 * verifies the post actually landed on the profile and captures its permalink.
 *
 * Act types must NEVER retry on ambiguity — a "failed" post may still have gone out,
 * and a retry would double-post. Ambiguous outcomes are reported honestly instead.
 */
export async function runPost(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    if (action.platform !== "twitter") {
      throw new ActionError("bad_params", `post is only implemented for 'twitter' so far (got '${action.platform ?? "none"}')`);
    }
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_POST_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_POST_CHARS} limit`);
    }
    if (action.params.assetId) {
      throw new ActionError("bad_params", "media posts aren't supported yet — the asset pipeline is not built.");
    }
    const dryRun = action.params.dryRun === true;

    return await withX(config, async (page) => {
      await gotoX(page, "https://x.com/home", config);
      const handle = await ownHandle(page);
      await humanizePage(page, config.behavior);

      const composer = page.locator('[data-testid="tweetTextarea_0"]').first();
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "The composer never appeared on /home.");
      });
      await composer.click({ timeout: 10_000 });
      await randomWait(600, 1_500);
      await humanType(page, text);
      await randomWait(800, 2_000);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: "post", dryRun: true, handle, chars: text.length,
            sent: false, verified: null, note: "dryRun — composer filled, nothing was sent.",
          },
        };
      }

      await submitComposer(page);
      console.log(`[post] twitter: clicked Post (${text.length} chars)`);
      const outcome = await waitForSendConfirmation(page, composer);

      // Verify-after-act. The toast usually hands us the permalink outright; otherwise go
      // looking on /with_replies, which lists everything — the Posts tab hides replies and
      // is empty on accounts that only ever reply.
      let permalink = outcome.permalink;
      if (outcome.sent && !permalink && handle) {
        await randomWait(2_500, 4_000);
        await gotoX(page, `https://x.com/${handle}/with_replies`, config);
        await waitForTweets(page).catch(() => false);
        await randomWait(1_500, 3_000);
        permalink = await findPermalinkByText(page, text, handle);
      }
      const verified = outcome.sent ? permalink !== null : null;
      console.log(`[post] twitter: sent=${outcome.sent} verified=${verified} permalink=${permalink ?? "none"} toast=${outcome.toast ?? "none"}`);

      if (!outcome.sent) {
        return {
          ok: false,
          error: outcome.toast
            ? `platform_error: X rejected the post — "${outcome.toast}"`
            : "ambiguous: clicked Post but never saw send confirmation. It MAY still have posted — check the profile before retrying.",
          result: {
            failureCode: outcome.toast ? "platform_error" : "ambiguous",
            platform: "twitter", action: "post", handle, chars: text.length, toast: outcome.toast,
          },
        };
      }
      return {
        ok: true,
        result: {
          platform: "twitter", action: "post", handle, chars: text.length,
          sent: true, verified, permalink, toast: outcome.toast,
          note: verified ? undefined : "sent, but it could not be found on the timeline afterwards — check manually",
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}
