/**
 * `npm run local` — the queue you drive by hand, when there is no backend.
 *
 * This is the local-mode replacement for the dashboard and the MCP tools: draft an action,
 * approve it, watch the agent pick it up. Everything lives in data/local/queue.json.
 *
 *   npm run local -- list
 *   npm run local -- draft check_session
 *   npm run local -- draft like --platform twitter --params '{"url":"https://x.com/.../status/1"}'
 *   npm run local -- approve a1b2
 *   npm run local -- show a1b2
 *   npm run local -- cancel a1b2
 *   npm run local -- prune
 *
 * Reads (scrape / search / check_session) run as soon as the agent sees them. Anything that
 * touches the world waits for `approve` — the same rail the server enforces, with you as the
 * server. Action ids can be shortened to any unambiguous prefix.
 */
import fs from "node:fs";
import path from "node:path";
import { ACT_TYPES, isActType } from "../src/actTypes";
import {
  readQueue,
  writeQueue,
  draft,
  approve,
  cancel,
  get,
  isRunnable,
  queuePath,
  LocalAction,
} from "../src/backend/local";

const ROOT = path.resolve(__dirname, "..");

/* ── tiny arg parser (no dependencies) ─────────────────────────────────── */
type Args = { _: string[]; flags: Record<string, string> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else out.flags[a.slice(2)] = argv[++i] ?? "";
    } else {
      out._.push(a);
    }
  }
  return out;
}

/* ── the brand file the README teaches you to generate ─────────────────── */
type Brand = {
  slug?: string;
  channels?: Record<string, { handle?: string }>;
};

function loadBrand(): Brand | null {
  const p = path.join(ROOT, "private", "brand.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Brand;
  } catch (e) {
    fail("private/brand.json is not valid JSON: " + (e as Error).message);
  }
}

function fail(msg: string): never {
  console.error("error: " + msg);
  process.exit(1);
}

/* ── rendering ─────────────────────────────────────────────────────────── */
const SHORT = (id: string) => id.replace(/^act_/, "").slice(0, 8);

function stateOf(a: LocalAction): string {
  if (a.status === "queued") return isRunnable(a) ? "ready" : "needs approval";
  return a.status;
}

function renderList(actions: LocalAction[]): void {
  if (actions.length === 0) {
    console.log("Queue is empty. Add one:  npm run local -- draft check_session");
    return;
  }
  const rows = actions.map((a) => ({
    id: SHORT(a.actionId),
    state: stateOf(a),
    type: a.type + (a.platform ? " (" + a.platform + ")" : ""),
    brand: a.brandId ?? "—",
    when: a.createdAt.slice(0, 16).replace("T", " "),
  }));
  const w = (k: keyof (typeof rows)[0]) =>
    Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const widths = { id: w("id"), state: w("state"), type: w("type"), brand: w("brand"), when: w("when") };
  const line = (r: Record<string, string>) =>
    [
      r.id.padEnd(widths.id),
      r.state.padEnd(widths.state),
      r.type.padEnd(widths.type),
      r.brand.padEnd(widths.brand),
      r.when,
    ].join("  ");

  console.log(line({ id: "ID", state: "STATE", type: "TYPE", brand: "BRAND", when: "CREATED" }));
  console.log("-".repeat(widths.id + widths.state + widths.type + widths.brand + widths.when + 8));
  for (const r of rows) console.log(line(r as unknown as Record<string, string>));

  const waiting = actions.filter((a) => a.status === "queued" && !isRunnable(a));
  if (waiting.length) {
    console.log(
      "\n" +
        waiting.length +
        " waiting on you:  npm run local -- approve " +
        SHORT(waiting[0].actionId),
    );
  }
}

/* ── commands ──────────────────────────────────────────────────────────── */
function cmdList(): void {
  renderList(readQueue(ROOT).actions);
}

function cmdDraft(args: Args): void {
  const type = args._[1];
  if (!type) fail("draft needs an action type, e.g.  npm run local -- draft check_session");

  const platform = args.flags.platform ?? null;
  let params: Record<string, unknown> = {};
  if (args.flags.params) {
    try {
      params = JSON.parse(args.flags.params);
    } catch (e) {
      fail("--params must be valid JSON: " + (e as Error).message);
    }
  }

  const brand = loadBrand();
  const brandId = args.flags.brand ?? brand?.slug ?? null;

  // The identity guard refuses to act as the wrong account — but only when a handle was
  // declared. Stamp it from the brand file so local mode gets the same protection.
  let expectedHandle: string | null = args.flags.handle ?? null;
  if (!expectedHandle && platform && brand?.channels?.[platform]?.handle) {
    expectedHandle = brand.channels[platform].handle as string;
  }

  const a = draft(ROOT, { type, platform, params, brandId, expectedHandle });

  console.log("drafted " + SHORT(a.actionId) + "  " + a.type + (platform ? " (" + platform + ")" : ""));
  if (isActType(type)) {
    // The guard only bites on outward acts, so only promise it there.
    if (expectedHandle) console.log("  identity guard: must be signed in as @" + expectedHandle);
    console.log("  this acts on the world — approve it:  npm run local -- approve " + SHORT(a.actionId));
  } else {
    console.log("  read action — the agent will run it on its next poll (within 30s).");
  }
}

function cmdApprove(args: Args): void {
  const id = args._[1];
  if (!id) fail("approve needs an action id — see  npm run local -- list");
  try {
    const a = approve(ROOT, id);
    console.log("approved " + SHORT(a.actionId) + "  " + a.type + " — the agent will claim it within 30s.");
  } catch (e) {
    fail((e as Error).message);
  }
}

function cmdCancel(args: Args): void {
  const id = args._[1];
  if (!id) fail("cancel needs an action id");
  try {
    const a = cancel(ROOT, id);
    console.log("cancelled " + SHORT(a.actionId));
  } catch (e) {
    fail((e as Error).message);
  }
}

function cmdShow(args: Args): void {
  const id = args._[1];
  if (!id) fail("show needs an action id");
  try {
    console.log(JSON.stringify(get(ROOT, id), null, 2));
  } catch (e) {
    fail((e as Error).message);
  }
}

function cmdPrune(): void {
  const q = readQueue(ROOT);
  const before = q.actions.length;
  q.actions = q.actions.filter((a) => a.status === "queued" || a.status === "running");
  writeQueue(ROOT, q);
  console.log("removed " + (before - q.actions.length) + " finished action(s); " + q.actions.length + " left.");
}

function cmdHelp(): void {
  console.log(
    [
      "Local queue — " + path.relative(ROOT, queuePath(ROOT)),
      "",
      "  list                     show the queue (default)",
      "  draft <type> [opts]      add an action",
      "  approve <id>             stamp an outward action so the agent may run it",
      "  cancel <id>              drop a queued action",
      "  show <id>                full JSON, including the result",
      "  prune                    forget finished actions",
      "",
      "draft options:",
      "  --platform <p>           twitter | instagram | tiktok | facebook | youtube",
      '  --params \'{"k":"v"}\'     executor parameters, as JSON',
      "  --brand <slug>           defaults to slug from private/brand.json",
      "  --handle <h>             identity guard; defaults to the brand's channel handle",
      "",
      "Actions needing approval: " + ACT_TYPES.join(", "),
      "",
      "Run the agent alongside this with:  MARKETER_MODE=local npm run agent",
    ].join("\n"),
  );
}

/* ── entry ─────────────────────────────────────────────────────────────── */
const args = parseArgs(process.argv.slice(2));
switch (args._[0] ?? "list") {
  case "list":
    cmdList();
    break;
  case "draft":
    cmdDraft(args);
    break;
  case "approve":
    cmdApprove(args);
    break;
  case "cancel":
    cmdCancel(args);
    break;
  case "show":
    cmdShow(args);
    break;
  case "prune":
    cmdPrune();
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  default:
    console.error("unknown command: " + args._[0] + "\n");
    cmdHelp();
    process.exit(1);
}
