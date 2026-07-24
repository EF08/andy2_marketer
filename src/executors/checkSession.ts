import { MarketerConfig } from "../config/types";
import { launchSession } from "../browser/session";
import { randomWait } from "../browser/humanize";
import { PLATFORM_DEFS, PLATFORMS, Platform } from "../platforms";
import type { Action, ActionResult } from "./index";

export type SessionCheckResult = Record<string, { loggedIn: boolean | null; checkedAt: string; note?: string }>;

/**
 * Login-health sweep: open each platform's home page in the automation profile and
 * detect whether we're still signed in. The whole point of the profile-based auth
 * model is that this should stay green for months — this catches it when it doesn't.
 */
export async function runCheckSession(action: Action, config: MarketerConfig): Promise<ActionResult> {
  const requested: Platform[] = (action.params.platforms ?? PLATFORMS).filter((p: string) =>
    (PLATFORMS as string[]).includes(p),
  );
  const sessions: SessionCheckResult = {};

  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    for (const platform of requested) {
      const def = PLATFORM_DEFS[platform];
      try {
        await page.goto(def.home, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
        await randomWait(2_500, 4_500); // let client-side hydration settle
        const loggedIn = await def.detectLoggedIn(page);
        sessions[platform] = { loggedIn, checkedAt: new Date().toISOString() };
        console.log(`[check_session] ${platform}: ${loggedIn === null ? "unclear" : loggedIn ? "logged in" : "LOGGED OUT"}`);
      } catch (e) {
        sessions[platform] = { loggedIn: null, checkedAt: new Date().toISOString(), note: (e as Error).message };
        console.warn(`[check_session] ${platform} failed: ${(e as Error).message}`);
      }
      await randomWait(1_000, 2_500);
    }
  } finally {
    await session.close();
  }

  const loggedOut = Object.entries(sessions).filter(([, s]) => s.loggedIn === false).map(([p]) => p);
  return {
    ok: true,
    sessions,
    result: { sessions, loggedOut, note: loggedOut.length ? `LOGGED OUT of: ${loggedOut.join(", ")} — run npm run login to fix.` : "all checked sessions look healthy" },
  };
}
