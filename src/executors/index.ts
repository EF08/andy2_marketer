import { MarketerConfig } from "../config/types";
import { runCheckSession, SessionCheckResult } from "./checkSession";
import { runScrape } from "./scrape";
import { runSearch } from "./search";
import { runPost } from "./post";
import { runReply } from "./reply";
import { runLike } from "./like";
import { runFollow } from "./follow";
import { runDm } from "./dm";

export type Action = {
  actionId: string;
  type: string;
  platform: string | null;
  params: Record<string, any>;
  /** Server-side approval stamp; act types refuse to run without it (defense in depth). */
  approvedAt?: string | null;
  status?: string;
};

export type ActionResult = {
  ok: boolean;
  result?: any;
  error?: string;
  /** When the action was a session check, the sweep results ride the next heartbeat too. */
  sessions?: SessionCheckResult;
};

/** Outward-facing types. These mutate the world, so they carry the extra guardrails. */
export const ACT_TYPES = ["post", "reply", "comment", "like", "follow", "dm"];

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
    case "comment": // on X these are the same act; other platforms will split them later
      return runReply(action, config);
    case "like":
      return runLike(action, config);
    case "follow":
      return runFollow(action, config);
    case "dm":
      return runDm(action, config);
    default:
      return { ok: false, error: `No executor for action type '${action.type}'.` };
  }
}
