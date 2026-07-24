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

export type BackendConfig = {
  baseUrl: string;
  /** Shared secret sent as x-marketer-key. Prefer MARKETER_INGEST_KEY env or backend.local.json. */
  ingestKey?: string;
};

export type MarketerConfig = {
  /** Dedicated automation profile dir (never Andy's live Chrome profile). */
  profileDir: string;
  chrome: ChromeConfig;
  behavior: Behavior;
  backend: BackendConfig;
};
