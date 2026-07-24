/**
 * Adapter R&D harness: open a page in the automation profile and dump whatever you need
 * to see, without going through the queue. This is how you work out selectors before
 * codifying them into an executor.
 *
 *   npx tsx scripts/probe.ts <url> [jsExpression]
 *
 * The expression runs in the page and its result is printed as JSON. With no expression
 * it prints the title plus a summary of the tweet cells it can see.
 *
 * Run it only while the agent is idle — both drive the same Chrome profile.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/loader";
import { launchSession } from "../src/browser/session";
import { randomWait } from "../src/browser/humanize";

const DEFAULT_EXPR = `(() => {
  const out = [];
  for (const a of Array.from(document.querySelectorAll('article[data-testid="tweet"]')).slice(0, 3)) {
    const g = a.querySelector('[role="group"][aria-label]');
    out.push({
      text: (a.querySelector('[data-testid="tweetText"]')?.innerText ?? '').slice(0, 60),
      groupAriaLabel: g ? g.getAttribute('aria-label') : null,
      testids: Array.from(a.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')),
    });
  }
  return { title: document.title, url: location.href, cells: out };
})()`;

async function main() {
  const url = process.argv[2];
  if (!url) { console.error("usage: npx tsx scripts/probe.ts <url> [jsExpression]"); process.exit(1); }
  // @file.js keeps multi-line expressions out of the shell's quoting rules.
  const arg = process.argv[3];
  const expr = !arg ? DEFAULT_EXPR : arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf-8") : arg;

  const root = path.resolve(__dirname, "..");
  const config = loadConfig(path.join(root, "marketer.config.json"));
  const session = await launchSession(config);
  try {
    const page = await session.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.behavior.navigationTimeoutMs });
    await randomWait(3_000, 4_500);
    console.log(JSON.stringify(await page.evaluate(expr), null, 2));
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
