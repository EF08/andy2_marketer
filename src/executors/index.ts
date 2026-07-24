import { MarketerConfig } from "../config/types";
import { runCheckSession, SessionCheckResult } from "./checkSession";
import { runScrape } from "./scrape";

export type Action = {
  actionId: string;
  type: string;
  platform: string | null;
  params: Record<string, any>;
};

export type ActionResult = {
  ok: boolean;
  result?: any;
  error?: string;
  /** When the action was a session check, the sweep results ride the next heartbeat too. */
  sessions?: SessionCheckResult;
};

/**
 * Dispatch an action to its executor. Phase 0/1 handles the read side; act types
 * (post/reply/...) land in Phase 2 as per-platform adapters with verify-after-act.
 */
export async function executeAction(action: Action, config: MarketerConfig): Promise<ActionResult> {
  switch (action.type) {
    case "check_session":
      return runCheckSession(action, config);
    case "scrape":
      return runScrape(action, config);
    default:
      return { ok: false, error: `No executor for action type '${action.type}' yet (Phase 2).` };
  }
}
