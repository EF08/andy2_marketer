/**
 * Identity guard — the last thing standing between "post for brand A" and "posted from
 * brand B's account".
 *
 * One Chrome profile is one logged-in identity per platform. That is fine for one brand and
 * quietly dangerous for several: a roseacademy post drafted while the profile is signed into
 * circuitstats would go out as circuitstats, and there is no undo. So the backend ships the
 * handle the brand declared (`expectedHandle` on the claimed action) and every outward act
 * checks it here first.
 *
 * The guard is opt-in per platform: declare `channels.<platform>.handle` on the brand and it
 * is enforced; leave it out and nothing is checked. When a handle IS declared but we cannot
 * read who we are signed in as, that is a refusal too — an unverifiable identity is not a
 * verified one.
 */
import { Page } from "playwright";
import { ActionError } from "./xCommon";
import { ownHandle as xOwnHandle } from "./xCommon";

export type IdentityCheck = { expected: string; actual: string | null; verified: boolean };

/** Read the signed-in account's handle. null = "couldn't tell", never "nobody". */
async function readOwnHandle(page: Page, platform: string): Promise<string | null> {
    switch (platform) {
        case "twitter":
            return xOwnHandle(page);

        case "instagram":
            return page
                .evaluate(() => {
                    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
                        const href = a.getAttribute("href") ?? "";
                        if (/^\/[A-Za-z0-9._]{1,30}\/$/.test(href) && (a.textContent ?? "").includes("Profile")) {
                            return href.replace(/\//g, "");
                        }
                    }
                    return null;
                })
                .catch(() => null);

        case "tiktok":
            return page
                .locator('[data-e2e="nav-profile"]')
                .first()
                .getAttribute("href", { timeout: 6_000 })
                .then((href) => href?.match(/\/@([\w.]+)/)?.[1] ?? null)
                .catch(() => null);

        case "youtube":
            // The signed-in channel handle is not in the topbar; it rides in ytcfg, which
            // YouTube populates on every page of the app.
            return page
                .evaluate(() => {
                    const anyWin = window as any;
                    const fromCfg = anyWin.ytcfg?.data_ ?? anyWin.ytcfg?.get?.("INNERTUBE_CONTEXT")?.client;
                    const candidates = [
                        anyWin.ytcfg?.get?.("CHANNEL_HANDLE"),
                        fromCfg?.CHANNEL_HANDLE,
                        fromCfg?.DELEGATED_SESSION_INFO?.handle,
                    ].filter(Boolean) as string[];
                    if (candidates.length) return String(candidates[0]).replace(/^@/, "");
                    // Fallback: the guide's "Your channel" entry, when the guide has rendered.
                    const guide = Array.from(document.querySelectorAll('a[href^="/@"], a[href^="/channel/"]'))
                        .find((a) => /your channel/i.test((a.textContent ?? "") + (a.getAttribute("title") ?? "")));
                    const href = guide?.getAttribute("href") ?? "";
                    return href.startsWith("/@") ? href.slice(2) : null;
                })
                .catch(() => null);

        case "facebook":
            // Facebook pages act as the Page, not the person, so a declared handle is matched
            // against the profile/page slug the composer will publish as.
            return page
                .evaluate(() => {
                    const nav = document.querySelector('[aria-label="Your profile"], [aria-label="Account"]');
                    const label = nav?.getAttribute("aria-label") ?? "";
                    const m = label.match(/^(.*?)(?:'s profile)?$/);
                    return m && m[1] && !/your profile|account/i.test(m[1]) ? m[1].trim() : null;
                })
                .catch(() => null);

        default:
            return null;
    }
}

const norm = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

/* ────────────────────────────── per-action context ────────────────────────────── */

/**
 * The action currently executing. The agent runs one action at a time in-process, so a
 * module-level context is safe here — and it means the guard can live inside each platform's
 * navigation helper instead of being re-threaded through twenty call sites (where the one
 * that got forgotten would be the bug).
 */
type ActionContext = { type: string; platform: string | null; brandId?: string | null; expectedHandle?: string | null };

let current: ActionContext | null = null;
let verifiedFor: string | null = null;

const OUTWARD = new Set(["post", "reply", "comment", "like", "follow", "dm"]);

export function setActionContext(action: ActionContext | null): void {
    current = action;
    verifiedFor = null;
}

/**
 * Called from every platform's goto helper. Checks once per action (the flows navigate
 * several times) and only for outward types — reading a page as the wrong account is
 * harmless, acting as the wrong account is not.
 */
export async function guardOutward(page: Page, platform: string): Promise<void> {
    if (!current || !OUTWARD.has(current.type)) return;
    if (!current.expectedHandle) return;
    if (verifiedFor === platform) return;
    await assertIdentity(page, platform, current.expectedHandle);
    verifiedFor = platform;
}

/**
 * Refuse the action unless the signed-in identity is the one the brand declared.
 * No declared handle → nothing to check, returns null.
 */
export async function assertIdentity(
    page: Page,
    platform: string,
    expectedHandle: string | null | undefined,
): Promise<IdentityCheck | null> {
    if (!expectedHandle) return null;

    const actual = await readOwnHandle(page, platform);
    if (actual === null) {
        throw new ActionError(
            "login_required",
            `Refused: this brand declares the ${platform} handle @${expectedHandle}, but the agent could not read which account is signed in — ` +
            `an unverifiable identity is not a verified one. Check the session (\`npm run login\`), or clear channels.${platform} on the brand to skip the guard.`,
        );
    }
    if (norm(actual) !== norm(expectedHandle)) {
        throw new ActionError(
            "bad_params",
            `wrong_identity: signed in as @${actual} but this action belongs to a brand whose ${platform} handle is @${expectedHandle}. ` +
            `Nothing was sent. Switch the profile's login, or fix the brand's declared handle.`,
        );
    }
    console.log(`[identity] ${platform}: verified as @${actual}`);
    return { expected: expectedHandle, actual, verified: true };
}
