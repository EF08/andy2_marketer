/**
 * Direct-executor R&D harness — run actions locally without the queue, to test
 * adapters end-to-end. Takes one action object or an array of them:
 *
 *   npx tsx scripts/runAction.ts '{"type":"search","platform":"tiktok","params":{"query":"x"}}'
 *   npx tsx scripts/runAction.ts @actions.json
 *
 * SAFETY: outward types (post/reply/comment/like/follow/dm) are refused here unless
 * params.dryRun is true — real sends must go through the queue + approval flow.
 * Run it only while the agent is idle — both drive the same Chrome profile.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/loader";
import { executeAction, ACT_TYPES, Action } from "../src/executors/index";

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: npx tsx scripts/runAction.ts '<action json>' | @file.json"); process.exit(1); }
  const raw = arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf-8") : arg;
  const parsed = JSON.parse(raw);
  const actions: Partial<Action>[] = Array.isArray(parsed) ? parsed : [parsed];

  const root = path.resolve(__dirname, "..");
  const config = loadConfig(path.join(root, "marketer.config.json"));

  for (const [i, a] of actions.entries()) {
    const action: Action = {
      actionId: `local-${Date.now()}-${i}`,
      type: String(a.type ?? ""),
      platform: a.platform ?? null,
      params: a.params ?? {},
      brandId: a.brandId ?? null, // generate_media files under data/media/<brandId>/
      // The local stamp only exists so dryRun flows can pass the dispatch gate.
      approvedAt: new Date().toISOString(),
    };
    if (ACT_TYPES.includes(action.type) && action.params.dryRun !== true) {
      console.error(`\n=== [${i}] ${action.type}/${action.platform} REFUSED: act types need params.dryRun:true in this harness ===`);
      continue;
    }
    console.log(`\n=== [${i}] ${action.type}/${action.platform} ${JSON.stringify(action.params).slice(0, 120)} ===`);
    const started = Date.now();
    try {
      const res = await executeAction(action, config);
      console.log(`--- ok=${res.ok} (${Math.round((Date.now() - started) / 1000)}s)`);
      console.log(JSON.stringify(res, null, 2).slice(0, 6_000));
    } catch (e) {
      console.error(`--- threw: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
