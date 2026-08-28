# andy2_marketer

The **hands** of a marketing system whose brain is Claude. Claude decides what to say and to
whom; a backend decides whether it may go out, when, and records what happened; this repo
executes one approved action at a time — in a real logged-in Chrome, or straight against
the Google Ads API — and reports evidence. The agent itself decides nothing.

## How it works

```
  You ───▶ ┌──────────────────────────────────────────────────────────────┐
  intent   │ CLAUDE — the brain                                           │
     ▲     │ chat · Claude Code · scheduled session                       │
     │     └────────────────────────┬─────────────────────────────────────┘
     │                              │ marketer_* MCP tools
     │                              ▼
     │     ┌──────────────────────────────────────────────────────────────┐      ┌───────────┐
     │     │ backend · the RAILS (Express + MongoDB)                      │      │ dashboard │
     │     │  1 lint  →  2 approve  →  3 rate-govern  →  claim            │◀────▶│    the    │
     │     │  brands · campaigns · posts · links · inbox · media_assets   │      │  cockpit  │
     │     └────────┬─────────────────────────────────────────▲───────────┘      └───────────┘
     │              │ 30s poll: one action + approvedAt       │ 4 verify-after-act:
     │              ▼                                         │    evidence, or needs_review
     │     ┌────────┬─────────────────────────────────────────┴───────────┐
     │     │ andy2_marketer — the HANDS (this repo, on your PC)           │
     │     │ Playwright ──CDP──▶ real logged-in Chrome · Google Ads REST  │
     │     │ identity guard · dryRun on any act · no LLM key, no judgment │
     │     └──────┬───────────────────┬───────────────────┬───────────────┘
     │            ▼                   ▼                   ▼
     │      X  IG  TikTok       gpt-image-2         Google Ads REST
     │      YouTube  Facebook   static ads          create · budget · status
     │      act + read          → data/media/
     │            │
     └────────────┴── metrics · clicks · conversions · inbox ──▶ the loop closes
```

| | |
|---|---|
| **Reads** — run automatically | `check_session` · `scrape` · `search` · `ads_report` |
| **Acts** — refused without a server-side `approvedAt` stamp | `post` · `reply` / `comment` · `like` · `follow` · `dm` · `ads_mutate` |
| **Produces** | `generate_media` — gpt-image-2 static ads (chatgpt.com browser automation as fallback) → `data/media/<brand>/` + manifest |
| **Coverage** | like / follow / comment / search / structured scrape on X, Instagram, TikTok, YouTube, Facebook; DMs where a Message button exists. X is the only platform that can originate a post today |
| **Rails** | lint → approve → rate-govern → verify-after-act, plus an in-agent identity guard so a brand can never act from the wrong account. Every act type takes `dryRun: true` |

## Design decisions

- **CDP session reuse instead of login automation.** The agent attaches to your existing
  Chrome profile over the DevTools Protocol — it never sees or stores credentials, and 2FA,
  cookies, and session state stay exactly where they belong.
- **Every outward action is human-gated.** The executor refuses any act without a
  server-side approval stamp; approval lives in the backend, not in the agent. A compromised
  queue still cannot spend money or post: the money rail is checked three times
  (lint cap → approval → executor re-check).
- **The agent holds no judgment and no LLM key.** All authoring and deciding happens in
  Claude via MCP tools; this process just executes and reports evidence.
- **One adapter per platform.** Each platform implements the same executor interface
  (`src/executors/`); a new platform is one file and a registry line.
- **Verify after act.** Every action re-reads the surface it touched and reports evidence —
  or flags itself `needs_review`. The ledger records what actually happened, not what was
  attempted.

## Quickstart

```bash
npm install      # uses your installed Chrome — no playwright browser download
npm run login    # sign in to the platforms once, in the automation profile
npm run smoke    # proves Chrome control works
npm run agent    # the daemon: poll → claim → execute → report, every 30s
```

Point `backend.baseUrl` in `marketer.config.json` at a backend implementing the rails above,
and provide its ingest key via the `MARKETER_INGEST_KEY` env var or a gitignored
`backend.local.json`. Google Ads needs OAuth credentials in a gitignored
`googleads.local.json` (see `scripts/googleads-auth.ts`) plus a brand-declared `customerId`.
Media generation needs `OPENAI_API_KEY` in a gitignored `.env`; without it, image renders
fall back to chatgpt.com browser automation.

## What isn't in this repo

This is one repo, worked on directly — there is no private fork and no sanitising build step.
The split is by **file**, not by repository: the code is public, the business layer never
leaves the machine it runs on.

| Stays local (gitignored) | Why |
|---|---|
| `MASTERPLAN.md`, `docs/BRIEF.md`, `docs/STATUS.md` | Strategy, roadmap and where the build actually stands |
| `docs/INFLUENCERS.md` | Named outreach targets — other people's information, not mine to publish |
| `.claude/`, `.agents/`, `skills-lock.json` | The prompt IP: the skills that decide what an ad *says*. The hands are open source; the judgment is not |
| `.env`, `*.local.json` | API keys, OAuth credentials, backend ingest key |
| `data/`, `profiles/` | Real scraped material and a logged-in Chrome profile — live session cookies |
| `*.xlsx`, `*.csv` | Local deliverables containing customer data |

Two things enforce that, so it can't rot into a convention nobody follows:

- **`.gitignore`** lists each path above, plus `private/` and `*.private.md` as a home for
  anything new — so a future strategy doc is invisible to git by default rather than by memory.
- **`.githooks/pre-commit`** refuses any commit that stages one of those paths *even with
  `git add -f`*, and rejects staged diffs containing secret-shaped strings. Enable it after
  cloning with `git config core.hooksPath .githooks`.

The practical consequence: clone this and you get a complete, runnable agent. What you don't
get is my roadmap, my contact list, or the prompts that make it write good copy — and nothing
in the history has ever contained them.

## Where to read more

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Three processes, four rails, every collection |
| [docs/AGENT.md](docs/AGENT.md) | Operator manual: each action's params, the probe harnesses, browser gotchas |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | The schemas: brands, actions, campaigns, ads |
| [docs/decisions/](docs/decisions/) | ADRs behind the hard-to-reverse calls |

## Stack

TypeScript · Playwright + Chrome DevTools Protocol · gpt-image-2 · Google Ads API · Node/Express + MongoDB (backend) · Model Context Protocol
