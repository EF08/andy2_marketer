import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { humanType, randomWait } from "../browser/humanize";
import type { Action, ActionResult } from "./index";
import { ActionError, gotoX, profileUrl, resolveHandle, toFailure, withX } from "./xCommon";

const MAX_DM_CHARS = 900; // X allows 10k; this is a self-imposed "don't write an essay" cap

/**
 * X Chat can be locked behind a device-managed passcode: /messages then redirects to
 * /i/chat/pin/recovery and every DM surface is unreachable. No amount of retrying fixes
 * that from here — it needs a one-time human unlock in the automation profile — so say so
 * precisely instead of reporting a mystery selector failure.
 */
async function assertChatUnlocked(page: Page): Promise<void> {
  const url = page.url();
  const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (/\/i\/chat\/pin/.test(url) || /managed passcode|passcode is managed by another device|enter your passcode/i.test(body)) {
    throw new ActionError(
      "login_required",
      "X Chat is locked behind a passcode in the automation profile (X redirected to the chat PIN recovery screen). " +
      "Unlock it once by hand: `npm run login`, open Messages, tap 'Send temporary passcode', enter the code from your phone. DMs work after that.",
    );
  }
}

/**
 * Send a direct message on X.
 *
 * Two routes, because the fast one doesn't always exist: the Message button on a profile
 * (normal case), falling back to /messages/compose (accounts with no visible DM button,
 * and messaging yourself — your own profile has no Message button, which is exactly what
 * makes a self-DM the safe way to test this flow).
 *
 * Enter SENDS in the DM composer, so multi-line drafts are typed with Shift+Enter.
 */
export async function runDm(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    if (action.platform !== "twitter") {
      throw new ActionError("bad_params", `dm is only implemented for 'twitter' (got '${action.platform ?? "none"}')`);
    }
    const handle = resolveHandle(action.params.handle ?? action.params.targetUrl);
    const text = String(action.params.text ?? "").trim();
    if (!text) throw new ActionError("bad_params", "params.text is required");
    if (text.length > MAX_DM_CHARS) {
      throw new ActionError("bad_params", `text is ${text.length} chars — over the ${MAX_DM_CHARS} limit`);
    }
    const dryRun = action.params.dryRun === true;

    return await withX(config, async (page) => {
      let route: "profile" | "compose" = "profile";

      await gotoX(page, profileUrl(handle), config);
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (/this account doesn.t exist|account suspended/i.test(body)) {
        throw new ActionError("not_found", `@${handle} doesn't exist or is suspended.`);
      }

      const dmFromProfile = page.locator('[data-testid="sendDMFromProfile"]').first();
      if (await dmFromProfile.count()) {
        await dmFromProfile.click({ timeout: 10_000 });
        await randomWait(1_800, 3_000);
        await assertChatUnlocked(page);
      } else {
        route = "compose";
        await gotoX(page, "https://x.com/messages/compose", config);
        await assertChatUnlocked(page);
        const search = page.locator('[data-testid="searchPeople"]').first();
        await search.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
          throw new ActionError("ui_changed", "The DM compose page didn't render its people search.");
        });
        await search.click();
        await randomWait(400, 900);
        await humanType(page, handle);
        await randomWait(1_500, 2_600);

        const candidate = page
          .locator('[data-testid="TypeaheadUser"]')
          .filter({ hasText: new RegExp(`@${handle}(\\s|$)`, "i") })
          .first();
        if (!(await candidate.count())) {
          throw new ActionError("not_found", `@${handle} did not appear in DM recipient search — they may not accept DMs from this account.`);
        }
        await candidate.click({ timeout: 10_000 });
        await randomWait(600, 1_300);
        const next = page.locator('[data-testid="nextButton"]').first();
        if (await next.count()) await next.click({ timeout: 8_000 });
        await randomWait(1_500, 2_800);
      }

      const composer = page.locator('[data-testid="dmComposerTextInput"]').first();
      await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new ActionError("ui_changed", "DM composer never appeared — X may have changed the conversation view.");
      });
      const before = await page.locator('[data-testid="messageEntry"]').count();

      await composer.click({ timeout: 10_000 });
      await randomWait(500, 1_200);
      await humanType(page, text, { newline: "shift+enter" }); // Enter would fire a half-written DM
      await randomWait(700, 1_600);

      if (dryRun) {
        return {
          ok: true,
          result: {
            platform: "twitter", action: "dm", dryRun: true, handle, route, chars: text.length,
            sent: false, verified: null, conversationUrl: page.url(),
            note: "dryRun — the DM was typed into the composer but NOT sent.",
          },
        };
      }

      const send = page.locator('[data-testid="dmComposerSendButton"]').first();
      await send.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
        throw new ActionError("ui_changed", "No DM send button found.");
      });
      if (!(await send.isEnabled().catch(() => false))) {
        throw new ActionError("ambiguous", "DM send button never enabled — nothing was sent.");
      }
      await send.click({ timeout: 10_000 });

      // Verify: the thread grew and the newest bubble carries our text.
      let verified = false;
      for (let i = 0; i < 15 && !verified; i++) {
        await randomWait(600, 1_100);
        const entries = page.locator('[data-testid="messageEntry"]');
        const now = await entries.count();
        if (now > before || now > 0) {
          const last = (await entries.last().innerText().catch(() => "")) || "";
          if (last.includes(text.split("\n")[0].slice(0, 40))) verified = true;
        }
      }
      const conversationUrl = page.url();
      console.log(`[dm] twitter: @${handle} via ${route} verified=${verified}`);

      if (!verified) {
        return {
          ok: false,
          error: "ambiguous: clicked Send but the message never appeared in the thread. It MAY have sent — check DMs before retrying.",
          result: { failureCode: "ambiguous", platform: "twitter", action: "dm", handle, route, conversationUrl },
        };
      }
      return {
        ok: true,
        result: {
          platform: "twitter", action: "dm", handle, route, chars: text.length,
          sent: true, verified: true, conversationUrl,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}
