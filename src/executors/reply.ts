import { MarketerConfig } from "../config/types";
import { humanType, randomWait } from "../browser/humanize";
import { adapterExec, platformsSupporting } from "./adapters";
import type { Action, ActionResult } from "./index";
import {
  ActionError, evidence, extractTweets, findPermalinkByText, focalTweet, gotoX,
  ownHandle, requireStatusUrl, submitComposer, toFailure, waitForSendConfirmation,
  waitForTweets, withX,
} from "./xCommon";

const MAX_REPLY_CHARS = 280;

/**
 * Reply to a post on X (the `comment` action type routes here too — on X they are the
 * same act). Replies are where distribution actually comes from, so this is the flow
 * that gets used most.
 *
 * Like every act type it never retries on ambiguity: a reply that "failed" may still be
 * live, and a retry would double-post. Ambiguous outcomes come back as needs-review.
 */
export async function runReply(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    // On every platform we run, replying and commenting are the same act on a target
    // post/video — the platform adapters expose it as `comment`.
    const impl = adapterExec(action.platform, "comment");
    if (impl) return await impl(action, config);
    if (action.platform !== "twitter") {
      throw new ActionError("bad_params", `reply/comment isn't implemented for '${action.platform ?? "none"}' (supported: ${platformsSupporting("comment").join(", ")})`);
    }
    const { url, statusId } = requireStatusUrl(action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_REPLY_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_REPLY_CHARS} limit`);
    }
    const dryRun = action.params.dryRun === true;

    return await withX(config, async (page) => {
      await gotoX(page, url, config);
      await waitForTweets(page);

      const handle = await ownHandle(page);
      const focal = await focalTweet(page, statusId);
      const target = (await extractTweets(page, 10)).find((t) => t.permalink?.includes(statusId)) ?? null;

      // The inline "Post your reply" box; if X hid it, the reply button opens the modal.
      let composer = page.locator('[data-testid="tweetTextarea_0"]').first();
      if (!(await composer.count())) {
        await focal.locator('[data-testid="reply"]').first().click({ timeout: 10_000 });
        await randomWait(1_200, 2_200);
        composer = page.locator('[data-testid="tweetTextarea_0"]').first();
      }
      await composer.click({ timeout: 10_000 });
      await randomWait(500, 1_300);
      await humanType(page, text);
      await randomWait(700, 1_800);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: "reply", dryRun: true, sent: false, verified: null,
            replyingTo: url, chars: text.length,
            ...evidence(target, { note: "dryRun — composer filled, nothing was sent." }),
          },
        };
      }

      await submitComposer(page);
      const outcome = await waitForSendConfirmation(page, composer);

      // Verify-after-act: the toast's View link, else the thread we're still on, else our
      // own /with_replies timeline.
      let permalink = outcome.permalink;
      if (outcome.sent && !permalink) {
        await randomWait(2_000, 3_500);
        permalink = await findPermalinkByText(page, text, handle);
        if (!permalink && handle) {
          await gotoX(page, `https://x.com/${handle}/with_replies`, config);
          await waitForTweets(page).catch(() => false);
          await randomWait(1_500, 2_500);
          permalink = await findPermalinkByText(page, text, handle);
        }
      }
      const verified = outcome.sent ? permalink !== null : null;
      console.log(`[reply] twitter: sent=${outcome.sent} verified=${verified} permalink=${permalink ?? "none"} toast=${outcome.toast ?? "none"}`);

      if (!outcome.sent) {
        return {
          ok: false,
          error: outcome.toast
            ? `platform_error: X rejected the reply — "${outcome.toast}"`
            : "ambiguous: clicked Reply but never saw send confirmation. It MAY still have posted — check the thread before retrying.",
          result: {
            failureCode: outcome.toast ? "platform_error" : "ambiguous",
            platform: "twitter", action: "reply", replyingTo: url, toast: outcome.toast, ...evidence(target),
          },
        };
      }
      return {
        ok: true,
        result: {
          platform: "twitter", action: "reply", handle, chars: text.length,
          sent: true, verified, permalink, replyingTo: url, toast: outcome.toast,
          ...evidence(target, verified ? {} : { note: "sent, but the reply could not be found afterwards — check manually" }),
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}
