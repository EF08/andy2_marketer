export type ChromeConfig = {
  /** "cdp" (spawn real Chrome + attach over CDP — recommended) or "persistent". */
  mode?: "cdp" | "persistent";
  /** CDP debugging port. 9223 by default so we never collide with andy2_crawler's 9222. */
  cdpPort?: number;
  /** Profile directory name inside the user-data-dir. */
  profileDirectory?: string;
  /** Explicit Chrome binary path; auto-detected per-OS when omitted. */
  chromeExecutablePath?: string;
};

export type Behavior = {
  navigationTimeoutMs: number;
  waitMinMs: number;
  waitMaxMs: number;
};

/**
 * Where the action queue lives.
 *
 *  "remote" — an HTTP backend implementing the two agent endpoints (the full system:
 *             MCP tools, dashboard, multi-brand, rate governor).
 *  "local"  — a JSON file under data/local/. No server, no database, no network.
 *             You draft and approve with `npm run local`. Same rails, one machine.
 *
 * Never hardcode a real host here: set MARKETER_BACKEND_BASEURL, or put
 * `{ "baseUrl": "..." }` in the gitignored backend.local.json.
 */
export type BackendConfig = {
  mode?: "remote" | "local";
  /** Required in remote mode. Resolved from env → backend.local.json → this file. */
  baseUrl?: string;
  /** Shared secret sent as x-marketer-key. Prefer MARKETER_INGEST_KEY env or backend.local.json. */
  ingestKey?: string;
};

export type MarketerConfig = {
  /** Dedicated automation profile dir (never your live Chrome profile). */
  profileDir: string;
  chrome: ChromeConfig;
  behavior: Behavior;
  backend: BackendConfig;
};
