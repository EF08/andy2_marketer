/**
 * Always-on marketer agent (cross-platform: Mac now, Windows PC later).
 *
 * Lets the backend — and therefore Claude, from any device via the Marketer MCP
 * connector — run social-media actions in Andy's real logged-in Chrome:
 *
 *   every 30s   → POST /api/marketer/agent/poll   (heartbeat + claim an approved action)
 *   claimed     → execute via the matching executor (check_session, scrape; act types in Phase 2)
 *   done/failed → POST /api/marketer/agent/actions/:id/complete { ok, result, error }
 *
 * Only server-side APPROVED actions are ever handed out (the approval queue lives in the
 * backend), and executors re-validate everything they touch (host whitelists, param clamps).
 * Session-check results ride every heartbeat so the dashboard always shows login health.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveIngestKey } from "../config/loader";
import { executeAction, Action } from "../executors";
import type { SessionCheckResult } from "../executors/checkSession";

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);

const POLL_MS = 30_000;
const ACTION_TIMEOUT_MS = 15 * 60_000;
const LOG_PATH = path.join(ROOT, "data", "agent.log");
const LOCK_PATH = path.join(ROOT, "data", "agent.lock");
const LOCAL_STATUS_PATH = path.join(ROOT, "data", "agent-status.json");

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch { /* logging must never kill the agent */ }
}

/* ── single-instance lock ── */
function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 0); // throws if the process is gone
          log(`Another agent is already running (pid=${pid}) — exiting.`);
          return false;
        } catch { /* stale lock */ }
      }
    }
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch (e) {
    log(`Lockfile error: ${(e as Error).message} — continuing anyway.`);
    return true;
  }
}

/* ── backend connection ── */
const config = loadConfig(path.join(ROOT, "marketer.config.json"));
const BASE_URL = process.env.MARKETER_BACKEND_BASEURL || config.backend.baseUrl;
const KEY = resolveIngestKey(ROOT, config);
const HOSTNAME = os.hostname();

async function api(pathname: string, body: unknown): Promise<any> {
  const res = await fetch(new URL(pathname, BASE_URL).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-marketer-key": KEY as string },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathname}`);
  return res.json();
}

/* ── agent state ── */
let currentAction: Action | null = null;
let lastSessions: SessionCheckResult | null = null;
let failStreak = 0;

/** ~300-byte local status file — a widget/menu-bar app can read this every second. */
function writeLocalStatus(): void {
  try {
    fs.writeFileSync(LOCAL_STATUS_PATH, JSON.stringify({
      status: currentAction ? "working" : "idle",
      currentActionId: currentAction?.actionId ?? null,
      currentActionType: currentAction?.type ?? null,
      sessions: lastSessions,
      updatedAt: new Date().toISOString(),
    }));
  } catch { /* the status file must never kill the agent */ }
}

async function runAction(action: Action): Promise<void> {
  currentAction = action;
  writeLocalStatus();
  log(`Action ${action.actionId} claimed: ${action.type}${action.platform ? ` (${action.platform})` : ""}`);

  let ok = false, result: any = null, error: string | undefined;
  try {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`action timed out after ${ACTION_TIMEOUT_MS / 60000} min`)), ACTION_TIMEOUT_MS),
    );
    const r = await Promise.race([executeAction(action, config), timeout]);
    ok = r.ok; result = r.result ?? null; error = r.error;
    if (r.sessions) lastSessions = r.sessions;
  } catch (e) {
    error = (e as Error).message;
  }

  try {
    await api(`/api/marketer/agent/actions/${action.actionId}/complete`, { ok, result, error: error ?? null });
    log(`Action ${action.actionId} ${ok ? "done" : `FAILED: ${error}`}`);
  } catch (e) {
    log(`Could not report completion for ${action.actionId}: ${(e as Error).message}`);
  }
  currentAction = null;
  writeLocalStatus();
}

async function tick(): Promise<void> {
  try {
    const resp = await api("/api/marketer/agent/poll", {
      status: currentAction ? "working" : "idle",
      hostname: HOSTNAME,
      platform: process.platform,
      currentActionId: currentAction?.actionId ?? null,
      wantAction: currentAction === null,
      sessions: lastSessions,
    });
    failStreak = 0;
    if (!currentAction && resp.action) {
      // run without awaiting — the poll loop keeps heartbeating while the action executes
      runAction(resp.action as Action).catch((e) => log(`runAction crashed: ${(e as Error).message}`));
    }
  } catch (e) {
    failStreak++;
    // Render free tier cold-starts — log the first few failures, then only every 20th
    if (failStreak <= 3 || failStreak % 20 === 0) {
      log(`Poll failed (streak ${failStreak}): ${(e as Error).message}`);
    }
  }
  writeLocalStatus();
}

async function main(): Promise<void> {
  if (!acquireLock()) return;
  if (!KEY) {
    log("No ingest key — set MARKETER_INGEST_KEY, backend.local.json {ingestKey}, or backend.ingestKey in marketer.config.json.");
    return;
  }
  log(`Marketer agent started (pid=${process.pid}, host=${HOSTNAME}, os=${process.platform}, backend=${BASE_URL})`);
  writeLocalStatus();
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => log(`Fatal: ${(e as Error).message}`));
