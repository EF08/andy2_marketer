/**
 * Interactive adapter R&D harness — probe.ts's big sibling. Drives one Chrome session
 * through a list of steps (navigate, scroll, click, type, eval) and prints every eval
 * result as JSON. This is how selectors get worked out on pages that only render their
 * interesting parts after interaction (YouTube comments, IG search).
 *
 *   npx tsx scripts/explore.ts @steps.json
 *
 * steps.json is an array of step objects, executed in order:
 *   {"goto": "https://..."}            navigate (domcontentloaded + settle wait)
 *   {"scroll": 3}                      wheel down N times with human pauses
 *   {"click": "css=..."} or {"clickText": "Follow"}
 *   {"type": "text"}                   humanType into the focused element
 *   {"press": "Enter"}
 *   {"wait": 2000}
 *   {"eval": "expr or @file.js", "label": "what this dumps"}
 *   {"shot": "C:/path/out.png"}
 *
 * Run it only while the agent is idle — both drive the same Chrome profile.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/loader";
import { launchSession } from "../src/browser/session";
import { humanType, randomWait } from "../src/browser/humanize";

type Step = Partial<{
  goto: string; scroll: number; click: string; clickText: string;
  type: string; press: string; wait: number; eval: string; label: string; shot: string;
}>;

async function main() {
  const arg = process.argv[2];
  if (!arg?.startsWith("@")) { console.error("usage: npx tsx scripts/explore.ts @steps.json"); process.exit(1); }
  const steps: Step[] = JSON.parse(fs.readFileSync(arg.slice(1), "utf-8"));

  const root = path.resolve(__dirname, "..");
  const config = loadConfig(path.join(root, "marketer.config.json"));
  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    page.setDefaultTimeout(15_000);
    for (const [i, step] of steps.entries()) {
      try {
        if (step.goto) {
          await page.goto(step.goto, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
          await randomWait(3_000, 4_500);
          console.log(`\n### step ${i} goto ${step.goto} → ${page.url()}`);
        }
        if (step.scroll) {
          for (let s = 0; s < step.scroll; s++) { await page.mouse.wheel(0, 1_100); await randomWait(700, 1_300); }
        }
        if (step.click) { await page.locator(step.click).first().click(); await randomWait(800, 1_500); }
        if (step.clickText) { await page.getByText(step.clickText, { exact: false }).first().click(); await randomWait(800, 1_500); }
        if (step.type) await humanType(page, step.type);
        if (step.press) { await page.keyboard.press(step.press); await randomWait(500, 1_000); }
        if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
        if (step.eval) {
          const expr = step.eval.startsWith("@") ? fs.readFileSync(step.eval.slice(1), "utf-8") : step.eval;
          const out = await page.evaluate(expr);
          console.log(`\n### step ${i} eval${step.label ? ` (${step.label})` : ""}:\n${JSON.stringify(out, null, 2)}`);
        }
        if (step.shot) { await page.screenshot({ path: step.shot }); console.log(`\n### step ${i} shot → ${step.shot}`); }
      } catch (e) {
        console.log(`\n### step ${i} FAILED: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
