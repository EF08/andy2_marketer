/**
 * Local queue — the whole backend, as one JSON file.
 *
 * No server, no database, no network. `data/local/queue.json` holds every action; the agent
 * claims from it and writes results back. Deliberately a flat file: the queue is a handful of
 * rows on one machine, so a real database would be ceremony without a payoff. If you outgrow
 * it, that is the signal to run the remote backend instead.
 *
 * The rails do not change in local mode. An outward action still refuses to run without an
 * `approvedAt` stamp — the difference is only that YOU stamp it, with `npm run local approve`,
 * instead of a server doing it. Reads (scrape/search/check_session) run unattended, exactly
 * as they do remotely.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Action } from "../executors";
import { isActType } from "../actTypes";
import type { Transport, Heartbeat, PollResponse, Completion } from "./types";

export type LocalStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type LocalAction = {
  actionId: string;
  type: string;
  platform: string | null;
  params: Record<string, unknown>;
  brandId: string | null;
  expectedHandle: string | null;
  status: LocalStatus;
  approvedAt: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  ok: boolean | null;
  result: unknown;
  error: string | null;
};

export type Queue = { version: 1; actions: LocalAction[] };

export const queuePath = (root: string): string => path.join(root, "data", "local", "queue.json");

export function readQueue(root: string): Queue {
  const p = queuePath(root);
  if (!fs.existsSync(p)) return { version: 1, actions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<Queue>;
    return { version: 1, actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
  } catch {
    // A corrupt queue must not silently drop work — keep the bad file for inspection.
    const backup = p + ".corrupt-" + Date.now();
    try {
      fs.renameSync(p, backup);
    } catch {
      /* best effort */
    }
    return { version: 1, actions: [] };
  }
}

/** Write via temp file + rename, so a crash mid-write can never truncate the queue. */
export function writeQueue(root: string, q: Queue): void {
  const p = queuePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function mutate<T>(root: string, fn: (q: Queue) => T): T {
  const q = readQueue(root);
  const out = fn(q);
  writeQueue(root, q);
  return out;
}

const newId = (): string =>
  "act_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

function find(q: Queue, actionId: string): LocalAction {
  // Accept an unambiguous prefix, with or without the `act_` prefix. The list prints ids
  // without it, and a printed id has to be one you can paste straight back in.
  const needle = actionId.startsWith("act_") ? actionId : "act_" + actionId;
  const exact = q.actions.find((a) => a.actionId === actionId || a.actionId === needle);
  if (exact) return exact;
  const hits = q.actions.filter((a) => a.actionId.startsWith(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error("No action matching " + actionId + ".");
  throw new Error(actionId + " matches " + hits.length + " actions — use more characters.");
}

/** An action is runnable when it is queued and — if it acts on the world — approved. */
export function isRunnable(a: LocalAction): boolean {
  if (a.status !== "queued") return false;
  return isActType(a.type) ? Boolean(a.approvedAt) : true;
}

/* ── operations the CLI drives ─────────────────────────────────────────── */

export function draft(
  root: string,
  spec: {
    type: string;
    platform?: string | null;
    params?: Record<string, unknown>;
    brandId?: string | null;
    expectedHandle?: string | null;
  },
): LocalAction {
  const action: LocalAction = {
    actionId: newId(),
    type: spec.type,
    platform: spec.platform ?? null,
    params: spec.params ?? {},
    brandId: spec.brandId ?? null,
    expectedHandle: spec.expectedHandle ?? null,
    status: "queued",
    approvedAt: null,
    createdAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null,
    ok: null,
    result: null,
    error: null,
  };
  mutate(root, (q) => q.actions.push(action));
  return action;
}

export function approve(root: string, actionId: string): LocalAction {
  return mutate(root, (q) => {
    const a = find(q, actionId);
    if (a.status !== "queued") {
      throw new Error(a.actionId + " is '" + a.status + "', not queued — nothing to approve.");
    }
    if (!isActType(a.type)) {
      throw new Error("'" + a.type + "' is a read action; it runs without approval.");
    }
    a.approvedAt = new Date().toISOString();
    return a;
  });
}

export function cancel(root: string, actionId: string): LocalAction {
  return mutate(root, (q) => {
    const a = find(q, actionId);
    if (a.status === "done" || a.status === "failed") {
      throw new Error(a.actionId + " already finished.");
    }
    a.status = "cancelled";
    return a;
  });
}

export const get = (root: string, actionId: string): LocalAction => find(readQueue(root), actionId);

/* ── the transport the agent sees ──────────────────────────────────────── */

export function createLocalTransport(root: string): Transport {
  // The single-instance lock guarantees no other agent holds a claim, so anything left
  // 'running' is debris from a crash. Return it to the queue rather than stranding it.
  const recovered = mutate(root, (q) => {
    let n = 0;
    for (const a of q.actions) {
      if (a.status === "running") {
        a.status = "queued";
        a.claimedAt = null;
        n++;
      }
    }
    return n;
  });

  const suffix = recovered
    ? " (recovered " + recovered + " stale claim" + (recovered === 1 ? "" : "s") + ")"
    : "";

  return {
    describe: "local queue " + path.relative(root, queuePath(root)) + suffix,

    async poll(hb: Heartbeat): Promise<PollResponse> {
      if (!hb.wantAction) return { action: null };
      return mutate(root, (q) => {
        const next = q.actions.find(isRunnable);
        if (!next) return { action: null };
        next.status = "running";
        next.claimedAt = new Date().toISOString();
        const action: Action = {
          actionId: next.actionId,
          type: next.type,
          platform: next.platform,
          params: next.params as Record<string, any>,
          approvedAt: next.approvedAt,
          status: next.status,
          brandId: next.brandId,
          expectedHandle: next.expectedHandle,
        };
        return { action };
      });
    },

    async complete(actionId: string, c: Completion): Promise<void> {
      mutate(root, (q) => {
        const a = q.actions.find((x) => x.actionId === actionId);
        if (!a) return;
        a.status = c.ok ? "done" : "failed";
        a.ok = c.ok;
        a.result = c.result ?? null;
        a.error = c.error ?? null;
        a.completedAt = new Date().toISOString();
      });
    },
  };
}
