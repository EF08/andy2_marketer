# andy2_marketer

Social-media marketing agent — the "hands" of the system described in [MASTERPLAN.md](MASTERPLAN.md). Polls `a1a2-command-center` for approved actions and executes them in Andy's real logged-in Chrome (TikTok, Instagram, Twitter/X, Facebook, YouTube). Sibling of `andy2_crawler`: same CDP-attach + stealth + humanize browser core, cross-platform (Mac + Windows).

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

## How it works

- `src/agent/agent.ts` — poll loop: heartbeat + claim + execute + complete. Single-instance lockfile in `data/agent.lock`; log in `data/agent.log`; `data/agent-status.json` for a future widget.
- `src/browser/` — Chrome control: spawns real Chrome with `--remote-debugging-port=9223` (crawler uses 9222, so both agents coexist), attaches Playwright over CDP, strips automation args, injects stealth patches. Dedicated profile in `profiles/automation-profile` — never Andy's live Chrome profile.
- `src/platforms.ts` — per-platform home URLs + login-state detectors.
- `src/executors/` — one module per action type. Today: `check_session` (login-health sweep across platforms), `scrape` (generic page read, host-whitelisted). Phase 2 adds the act types (post/reply/comment/like/follow/dm) as per-platform adapters with verify-after-act.

Only server-side **approved** actions are ever handed to this agent — the approval queue, autonomy policy, and kill switch live in `a1a2-command-center/apps/marketer`. Claude drives everything remotely through the `marketer_*` MCP tools at `/api/marketer/mcp`.
