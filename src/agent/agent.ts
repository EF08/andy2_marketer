/**
 * Always-on marketer agent (cross-platform: macOS and Windows).
 *
 * Runs social-media actions in a real logged-in Chrome, one at a time:
 *
 *   every 30s   → poll     (heartbeat + claim an approved action)
 *   claimed     → execute via the matching executor
 *   done/failed → complete { ok, result, error }
 *
 * Those two calls are the agent's entire dependency on "the queue", and they are served by
 * either transport (see ../backend): a remote HTTP backend, or a local JSON file with no
 * server at all. The agent cannot tell the difference, and the rails are the same in both —
 * only APPROVED actions are ever handed out, and executors re-validate everything they touch
 * (host whitelists, param clamps). Session-check results ride every heartbeat, so login
 * health is always visible.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/loader";
import { createTransport, Transport } from "../backend";
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

/* ── the queue: a remote backend, or a local JSON file ── */
const config = loadConfig(path.join(ROOT, "marketer.config.json"));
const HOSTNAME = os.hostname();
let transport: Transport;

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
    await transport.complete(action.actionId, { ok, result, error: error ?? null });
    log(`Action ${action.actionId} ${ok ? "done" : `FAILED: ${error}`}`);
  } catch (e) {
    log(`Could not report completion for ${action.actionId}: ${(e as Error).message}`);
  }
  currentAction = null;
  writeLocalStatus();
}

async function tick(): Promise<void> {
  try {
    const resp = await transport.poll({
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
    // A sleeping host cold-starts — log the first few failures, then only every 20th
    if (failStreak <= 3 || failStreak % 20 === 0) {
      log(`Poll failed (streak ${failStreak}): ${(e as Error).message}`);
    }
  }
  writeLocalStatus();
}

async function main(): Promise<void> {
  if (!acquireLock()) return;
  try {
    transport = createTransport(ROOT, config);
  } catch (e) {
    log((e as Error).message);
    return;
  }
  log(`Marketer agent started (pid=${process.pid}, host=${HOSTNAME}, os=${process.platform}, queue=${transport.describe})`);
  writeLocalStatus();
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => log(`Fatal: ${(e as Error).message}`));
