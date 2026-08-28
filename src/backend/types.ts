import type { Action } from "../executors";

/** What the agent reports on every tick. */
export type Heartbeat = {
  status: "idle" | "working";
  hostname: string;
  platform: string;
  currentActionId: string | null;
  wantAction: boolean;
  sessions: unknown;
};

export type PollResponse = { action?: Action | null };

export type Completion = { ok: boolean; result: unknown; error: string | null };

/**
 * The agent's entire dependency on "the backend" is these two calls. Implement them and
 * the agent runs — against a server (remote) or a JSON file (local). Nothing else in the
 * codebase knows which one it is talking to.
 */
export interface Transport {
  /** One line naming this transport, for the startup log. */
  readonly describe: string;
  /** Heartbeat, and claim an action when `wantAction`. */
  poll(hb: Heartbeat): Promise<PollResponse>;
  /** Report the outcome of a claimed action. */
  complete(actionId: string, c: Completion): Promise<void>;
}
