import fs from "node:fs";
import path from "node:path";
import { MarketerConfig } from "./types";

const DEFAULTS: MarketerConfig = {
  profileDir: "profiles/automation-profile",
  chrome: { mode: "cdp", cdpPort: 9223, profileDirectory: "Default" },
  behavior: { navigationTimeoutMs: 45_000, waitMinMs: 2_000, waitMaxMs: 5_000 },
  backend: { baseUrl: "https://a1a2-command-center.onrender.com" },
};

export function loadConfig(configPath: string): MarketerConfig {
  let raw: Partial<MarketerConfig> = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return {
    profileDir: raw.profileDir ?? DEFAULTS.profileDir,
    chrome: { ...DEFAULTS.chrome, ...(raw.chrome ?? {}) },
    behavior: { ...DEFAULTS.behavior, ...(raw.behavior ?? {}) },
    backend: { ...DEFAULTS.backend, ...(raw.backend ?? {}) },
  };
}

/** Ingest key: env → backend.local.json (gitignored) → config. Same pattern as andy2_crawler. */
export function resolveIngestKey(root: string, config: MarketerConfig): string | null {
  if (process.env.MARKETER_INGEST_KEY) return process.env.MARKETER_INGEST_KEY;
  const localPath = path.join(root, "backend.local.json");
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, "utf-8"));
      if (local.ingestKey) return String(local.ingestKey);
    } catch { /* fall through */ }
  }
  return config.backend.ingestKey ?? null;
}
