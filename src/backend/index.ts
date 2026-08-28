import type { MarketerConfig } from "../config/types";
import { resolveMode, resolveBaseUrl, resolveIngestKey } from "../config/loader";
import { createRemoteTransport } from "./remote";
import { createLocalTransport } from "./local";
import type { Transport } from "./types";

export type { Transport, Heartbeat, PollResponse, Completion } from "./types";

const LOCAL_HINT =
  " — or run without a server: set MARKETER_MODE=local, or backend.mode to \"local\" in " +
  "marketer.config.json (see README).";

/**
 * Pick the queue the agent talks to.
 *
 * Fails loudly with an actionable message rather than starting an agent that can never
 * reach anything — a silent poll loop against a missing host looks identical to an idle
 * queue, and that costs an hour to notice.
 */
export function createTransport(root: string, config: MarketerConfig): Transport {
  if (resolveMode(config) === "local") return createLocalTransport(root);

  const baseUrl = resolveBaseUrl(root, config);
  if (!baseUrl) {
    throw new Error(
      "No backend URL. Set MARKETER_BACKEND_BASEURL, or add a baseUrl to the gitignored " +
        "backend.local.json" +
        LOCAL_HINT,
    );
  }

  const key = resolveIngestKey(root, config);
  if (!key) {
    throw new Error(
      "No ingest key. Set MARKETER_INGEST_KEY, or add an ingestKey to the gitignored " +
        "backend.local.json" +
        LOCAL_HINT,
    );
  }

  return createRemoteTransport(baseUrl, key);
}
