/**
 * Outward-facing action types. These mutate the world, so they carry the extra guardrails:
 * nothing here runs without an approval stamp, whichever queue it came from.
 *
 * Kept in its own module so the local CLI can import it without pulling in Playwright.
 */
export const ACT_TYPES = ["post", "reply", "comment", "like", "follow", "dm", "ads_mutate"];

export const isActType = (type: string): boolean => ACT_TYPES.includes(type);
