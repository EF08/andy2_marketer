# AGENT — operator reference

The full manual for running and extending the PC agent: setup, every action type and its
platform coverage, the probe harnesses, and the browser gotchas. [README.md](../README.md) is
the short version.

Social-media marketing agent — the "hands" of the system described in the README. Polls `a1a2-command-center` for approved actions and executes them in Andy's real logged-in Chrome (TikTok, Instagram, Twitter/X, Facebook, YouTube). Sibling of `andy2_crawler`: same CDP-attach + stealth + humanize browser core, cross-platform (Mac + Windows).

## Setup

```bash
npm install                 # uses your installed Google Chrome — no playwright browser download
npm run login               # opens the automation profile in real Chrome; sign in to the 5 platforms once
npm run smoke               # proves Chrome control works: opens x.com, prints title + login state
```

Backend key (any one of):
- `MARKETER_INGEST_KEY` env var
- `backend.local.json` in the repo root: `{ "ingestKey": "..." }`  (gitignored)
- `backend.ingestKey` in `marketer.config.json`

The key must match `MARKETER_INGEST_KEY` / `API_SHARED_SECRET` on the command center.

## Run

```bash
npm run agent               # always-on daemon: polls every 30s, claims approved actions, executes
```

Point at a non-production backend with `MARKETER_BACKEND_BASEURL=http://...`.

## What it can do

| Action | Params | Coverage |
|---|---|---|
| `check_session` | `{platforms?}` | all 5 platforms — login-health sweep |
| `scrape` | `{what: page\|thread\|comments\|profile\|feed, targetUrl\|handle, limit?, includeReplies?}` | `page` on all 5; structured shapes on all 5 (`feed` is X-only; YT also takes `video`/`channel`) |
| `search` | `{query, tab?, limit?}` | X (`latest\|top\|people`), TikTok (`top\|videos\|accounts`), YouTube (`videos\|channels`), FB (`posts\|people\|pages`), IG (no tabs — returns accounts + hashtags) |
| `post` | `{text}` | X (text only — no asset pipeline yet) |
| `reply` / `comment` | `{targetUrl, text}` | X, IG (post/reel URL), TikTok (video URL, ≤150 chars), YouTube (watch URL), FB (post/reel/video URL) — a comment on the target everywhere |
| `like` | `{targetUrl, undo?}` | X, IG, TikTok, YouTube, FB |
| `follow` | `{handle\|targetUrl, undo?}` | X, IG, TikTok, YouTube (= subscribe), FB (pages/profiles with a Follow button; friend requests are not automated) |
| `dm` | `{handle, text}` | X (needs X Chat unlocked — see below), IG, TikTok + FB (only where a Message button exists). YouTube has no DMs |

Every act type also takes `dryRun: true`: it drives the whole flow and stops just before sending. Use it to rehearse anything risky.

*Posting* beyond X needs the planned asset pipeline (YouTube uploads are planned via the official API; FB text posting waits on a solid composer-verification story).

**X Chat passcode:** if X has locked Messages behind a device-managed passcode, `/messages` redirects to a PIN-recovery screen and `dm` fails with a `login_required` telling you so. Fix it once by hand — `npm run login`, open Messages, "Send temporary passcode", enter the code from your phone.

## How it works

- `src/agent/agent.ts` — poll loop: heartbeat + claim + execute + complete. Single-instance lockfile in `data/agent.lock`; log in `data/agent.log`; `data/agent-status.json` for the widget.
- `src/browser/` — Chrome control: spawns real Chrome with `--remote-debugging-port=9223` (crawler uses 9222, so both agents coexist), attaches Playwright over CDP, strips automation args, injects stealth patches. Dedicated profile in `profiles/automation-profile` — never Andy's live Chrome profile.
- `src/platforms.ts` — per-platform home URLs + login-state detectors.
- `src/executors/` — one module per action type; each dispatches per platform. X's flows live inline (plus `xCommon.ts`, the shared X machinery); Instagram/TikTok/YouTube/Facebook live in one adapter file each (registered in `adapters.ts`), on top of `webCommon.ts` (shared session lifecycle, login gates, count parsing, failure taxonomy). A new platform = one adapter file + one registry line.

Two rails guard every outward action:

- **Approval stamp.** The backend ships `approvedAt` with each claimed action and the agent refuses any act type that arrives without one — so a bug or a prompt-injected tool call upstream still can't make it post.
- **Verify-after-act.** Nothing reports success on a click. `post`/`reply` take the permalink out of X's success toast (or find the post on `/with_replies`), `like`/`follow` confirm the button flipped state, and anything ambiguous comes back as ambiguous — never retried, because a "failed" post may well have gone out.

Failures carry a machine-readable `failureCode` (`login_required`, `rate_limited`, `ui_changed`, `not_found`, `bad_params`, `blocked`, `ambiguous`, `platform_error`) so the command center can route between retry and needs-review.

## Working on adapters

```bash
npx tsx scripts/probe.ts <url> [jsExpr | @file.js]   # open a page in the profile, run an expression, print JSON
npx tsx scripts/explore.ts @steps.json               # drive a page through steps (goto/scroll/click/type/eval) — for lazy-loading UIs
npx tsx scripts/runAction.ts '<action>' | @file.json # run actions through the real executors, no queue; act types only with dryRun:true
```

Platform DOMs change; the probes are how you check a selector against the live page before codifying it. Run them only while the agent is idle — everything drives the same Chrome profile.

Only server-side **approved** actions are ever handed to this agent — the approval queue, autonomy policy, and kill switch live in `a1a2-command-center/apps/marketer`. Claude drives everything remotely through the `marketer_*` MCP tools at `/api/marketer/mcp`; the cockpit is [andy2_marketer_dashboard](../../andy2_marketer_dashboard).
