import { MarketerConfig } from "../config/types";
import { runCheckSession, SessionCheckResult } from "./checkSession";
import { runScrape } from "./scrape";
import { runSearch } from "./search";
import { runPost } from "./post";
import { runReply } from "./reply";
import { runLike } from "./like";
import { runFollow } from "./follow";
import { runDm } from "./dm";
import { runGenerateMedia } from "./generateMedia";
import { runAdsReport, runAdsMutate } from "./googleAds";
import { setActionContext } from "./identity";
import { ACT_TYPES } from "../actTypes";

export type Action = {
  actionId: string;
  type: string;
  platform: string | null;
  params: Record<string, any>;
  /** Server-side approval stamp; act types refuse to run without it (defense in depth). */
  approvedAt?: string | null;
  status?: string;
  /** Which brand is acting. One profile is one identity, so this matters — see identity.ts. */
  brandId?: string | null;
  /** The handle this brand declared for the platform; outward acts refuse to run as anyone else. */
  expectedHandle?: string | null;
  /** Claim-time stamp of the brand's ad account + money cap (the expectedHandle of the paid surface). */
  googleAds?: { customerId?: string | null; maxDailyBudget?: number | null } | null;
};

export type ActionResult = {
  ok: boolean;
  result?: any;
  error?: string;
  /** When the action was a session check, the sweep results ride the next heartbeat too. */
  sessions?: SessionCheckResult;
};

/** Outward-facing types. These mutate the world, so they carry the extra guardrails.
 *  ads_mutate belongs here: it spends money through an API instead of posting through
 *  a browser, but "never runs without a server-side approval stamp" applies the same. */
// Defined in ../actTypes so the local CLI can import it without loading Playwright.
export { ACT_TYPES };

/**
 * Dispatch an action to its executor.
 *
 * Two rails apply before anything runs:
 *  - act types must carry a server-side approvedAt stamp, so a bug (or a prompt-injected
 *    tool call) upstream can't make the agent act unapproved;
 *  - every executor re-validates its own params and hosts, never trusting the queue.
 */
export async function executeAction(action: Action, config: MarketerConfig): Promise<ActionResult> {
  if (ACT_TYPES.includes(action.type) && !action.approvedAt) {
    return {
      ok: false,
      error: `refused: '${action.type}' arrived without a server-side approval stamp — the agent never acts unapproved.`,
      result: { failureCode: "not_approved" },
    };
  }

  // Publish the action so each platform's navigation helper can enforce the identity guard
  // (see identity.ts) without every flow having to remember to ask.
  setActionContext(action);
  try {
    return await dispatch(action, config);
  } finally {
    setActionContext(null);
  }
}

async function dispatch(action: Action, config: MarketerConfig): Promise<ActionResult> {
  switch (action.type) {
    case "check_session":
      return runCheckSession(action, config);
    case "scrape":
      return runScrape(action, config);
    case "search":
      return runSearch(action, config);
    case "post":
      return runPost(action, config);
    case "reply":
    case "comment": // the same act everywhere we run: a comment on the target post/video
      return runReply(action, config);
    case "like":
      return runLike(action, config);
    case "follow":
      return runFollow(action, config);
    case "dm":
      return runDm(action, config);
    case "generate_media": // produces a local file via chatgpt.com — publishes nothing
      return runGenerateMedia(action, config);
    case "ads_report": // Google Ads API read — no browser involved
      return runAdsReport(action, config);
    case "ads_mutate": // Google Ads API act — spends money; approval enforced above
      return runAdsMutate(action, config);
    default:
      return { ok: false, error: `No executor for action type '${action.type}'.` };
  }
}
