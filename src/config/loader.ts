import fs from "node:fs";
import path from "node:path";
import { MarketerConfig } from "./types";

const DEFAULTS: MarketerConfig = {
  profileDir: "profiles/automation-profile",
  chrome: { mode: "cdp", cdpPort: 9223, profileDirectory: "Default" },
  behavior: { navigationTimeoutMs: 45_000, waitMinMs: 2_000, waitMaxMs: 5_000 },
  // No host here on purpose: a real backend URL is deployment config, not source.
  backend: { mode: "remote" },
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

/** Read the gitignored backend.local.json, if it exists. */
function readLocalBackendFile(root: string): Record<string, any> {
  const p = path.join(root, "backend.local.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

/** Which queue to talk to: env → config. Defaults to remote. */
export function resolveMode(config: MarketerConfig): "remote" | "local" {
  const env = process.env.MARKETER_MODE?.trim().toLowerCase();
  if (env === "local" || env === "remote") return env;
  return config.backend.mode === "local" ? "local" : "remote";
}

/**
 * Backend base URL: env → backend.local.json (gitignored) → marketer.config.json.
 * Returns null when nothing is configured — callers decide whether that is fatal
 * (it is in remote mode, irrelevant in local mode).
 */
export function resolveBaseUrl(root: string, config: MarketerConfig): string | null {
  if (process.env.MARKETER_BACKEND_BASEURL) return process.env.MARKETER_BACKEND_BASEURL;
  const local = readLocalBackendFile(root);
  if (local.baseUrl) return String(local.baseUrl);
  return config.backend.baseUrl ?? null;
}

/** Ingest key: env → backend.local.json (gitignored) → config. Same pattern as andy2_crawler. */
export function resolveIngestKey(root: string, config: MarketerConfig): string | null {
  if (process.env.MARKETER_INGEST_KEY) return process.env.MARKETER_INGEST_KEY;
  const local = readLocalBackendFile(root);
  if (local.ingestKey) return String(local.ingestKey);
  return config.backend.ingestKey ?? null;
}
