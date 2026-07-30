import { Page } from "playwright";
import { MarketerConfig } from "../config/types";
import { randomWait } from "../browser/humanize";
import { adapterExec, platformsSupporting } from "./adapters";
import type { Action, ActionResult } from "./index";
import {
  ActionError, extractTweets, gotoX, scrollForTweets, toFailure, waitForTweets, withX,
} from "./xCommon";

const MAX_RESULTS = 50;

type Tab = "latest" | "top" | "people";
const TAB_PARAM: Record<Tab, string> = { latest: "&f=live", top: "", people: "&f=user" };

/**
 * Run X's own search and bring back structured results.
 *
 * This is the "find the conversations worth replying to" primitive: search a niche,
 * get posts with permalinks + engagement numbers, then feed the good ones straight
 * back in as reply actions.
 */
export async function runSearch(action: Action, config: MarketerConfig): Promise<ActionResult> {
  try {
    const impl = adapterExec(action.platform, "search");
    if (impl) return await impl(action, config);
    if (action.platform !== "twitter") {
      throw new ActionError("bad_params", `search isn't implemented for '${action.platform ?? "none"}' (supported: ${platformsSupporting("search").join(", ")})`);
    }
    const query = String(action.params.query ?? "").trim();
    if (!query) throw new ActionError("bad_params", "params.query is required");
    if (query.length > 300) throw new ActionError("bad_params", "params.query is too long (max 300 chars)");

    const rawTab = String(action.params.tab ?? action.params.what ?? "latest").toLowerCase();
    if (!["latest", "top", "people"].includes(rawTab)) {
      throw new ActionError("bad_params", `params.tab must be latest|top|people (got '${rawTab}')`);
    }
    const tab = rawTab as Tab;
    const limit = Math.min(Math.max(parseInt(String(action.params.limit ?? 20), 10) || 20, 1), MAX_RESULTS);

    const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${TAB_PARAM[tab]}`;

    return await withX(config, async (page) => {
      await gotoX(page, url, config);

      if (tab === "people") {
        const users = await searchPeople(page, limit);
        return {
          ok: true,
          result: {
            platform: "twitter", query, tab, count: users.length, users, searchUrl: url,
            note: "X's people results carry no bio or follower count — scrape a profile (what:'profile') for those.",
          },
        };
      }

      const rendered = await waitForTweets(page, 25_000);
      if (!rendered) {
        return { ok: true, result: { platform: "twitter", query, tab, count: 0, results: [], searchUrl: url, note: "X returned no results for this query." } };
      }
      await scrollForTweets(page, limit);
      const all = await extractTweets(page, limit + 10);
      const results = all.filter((t) => !t.isPromoted).slice(0, limit);

      console.log(`[search] twitter: "${query}" (${tab}) → ${results.length} results`);
      return {
        ok: true,
        result: {
          platform: "twitter", query, tab, count: results.length, results, searchUrl: url,
          promotedFiltered: all.length - all.filter((t) => !t.isPromoted).length,
        },
      };
    });
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * The People tab renders UserCells, not tweets. Those cells are just name/handle/Follow —
 * X puts no bio in them — so `bio` is null here by design, not by a failed selector.
 */
async function searchPeople(page: Page, limit: number) {
  const cell = page.locator('[data-testid="UserCell"]').first();
  await cell.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  for (let i = 0; i < 8 && (await page.locator('[data-testid="UserCell"]').count()) < limit; i++) {
    await page.mouse.wheel(0, 1_200);
    await randomWait(800, 1_600);
  }
  return page.evaluate((max: number) => {
    const out: any[] = [];
    for (const c of Array.from(document.querySelectorAll('[data-testid="UserCell"]'))) {
      if (out.length >= max) break;
      const lines = ((c as HTMLElement).innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      const handle = lines.find((l) => l.startsWith("@"))?.slice(1) ?? null;
      if (!handle) continue;
      const name = lines[0] !== "@" + handle ? lines[0] : null;
      const bio = lines.slice(lines.findIndex((l) => l === "@" + handle) + 1).filter((l) => l !== "Follow" && l !== "Following").join(" ");
      out.push({ handle, name, bio: bio.slice(0, 300) || null, profileUrl: "https://x.com/" + handle });
    }
    return out;
  }, limit);
}
