# andy2_marketer

The **hands** of a marketing system whose brain is Claude. Claude decides what to say and to
whom; a backend decides whether it may go out, when, and records what happened; this repo
executes one approved action at a time — in Andy's real logged-in Chrome, or straight against
the Google Ads API — and reports evidence. The agent itself decides nothing.

## How it works today

```
  Andy ──▶ ┌──────────────────────────────────────────────────────────────┐
  intent   │ CLAUDE — the brain                                           │
     ▲     │ chat · Claude Code · scheduled session                       │
     │     │ skills: /ad-ideas   /ad-read   /content-ideas                │
     │     └────────────────────────┬─────────────────────────────────────┘
     │                              │ marketer_* MCP tools
     │                              ▼
     │     ┌──────────────────────────────────────────────────────────────┐      ┌───────────┐
     │     │ a1a2-command-center · apps/marketer — the RAILS  Render+Mongo│      │ dashboard │
     │     │  1 lint  →  2 approve  →  3 rate-govern  →  claim            │◀────▶│    the    │
     │     │  brands · campaigns · posts · links · inbox · media_assets   │      │  cockpit  │
     │     └────────┬─────────────────────────────────────────▲───────────┘      └───────────┘
     │              │ 30s poll: one action + approvedAt       │ 4 verify-after-act:
     │              ▼                                         │    evidence, or needs_review
     │     ┌────────┬─────────────────────────────────────────┴───────────┐
     │     │ andy2_marketer — the HANDS (this repo, on Andy's PC)         │
     │     │ Playwright ──CDP──▶ real logged-in Chrome · Google Ads REST  │
     │     │ identity guard · dryRun on any act · no LLM key, no judgment │
     │     └──────┬───────────────────┬───────────────────┬───────────────┘
     │            ▼                   ▼                   ▼
     │      X  IG  TikTok       gpt-image-2         Google Ads REST
     │      YouTube  Facebook   static ads          built + selftested,
     │      act + read          → data/media/       no live account yet
     │            │
     └────────────┴── metrics · clicks · conversions · inbox ──▶ the loop closes
```

| | |
|---|---|
| **Reads** — run automatically | `check_session` · `scrape` · `search` · `ads_report` |
| **Acts** — refused without a server-side `approvedAt` stamp | `post` · `reply` / `comment` · `like` · `follow` · `dm` · `ads_mutate` |
| **Produces** | `generate_media` — gpt-image-2 static ads (chatgpt.com as fallback) → `data/media/<brand>/` + manifest + a browse copy on the Desktop |
| **Coverage** | like / follow / comment / search / structured scrape on all five platforms; DMs on X, IG, TikTok, FB. **X is the only one that can originate a post** — nothing else has an asset pipeline yet |
| **Rails** | lint → approve → rate-govern → verify-after-act, plus an in-agent identity guard so a brand can never act from the wrong account. Every act type takes `dryRun: true` |

## Planned, or implied by what's already here

```
  hands ╌╌┬╌╌▶ asset pipeline (R2 / watched folder, video, caption fan-out per platform)
          │      → posting beyond X, and YouTube upload as an executor:"api" action
          ├╌╌▶ a second Chrome profile = a second identity — the guard already assumes it
          ├╌╌▶ new adapters: LinkedIn / Threads / Reddit — one file + one registry line
          └╌╌▶ owned channels (email / newsletter) — deliberately no surface today

  brain ╌╌┬╌╌▶ influencer CRM: discover → qualify → enrich → outreach → track
          │      docs/INFLUENCERS.md is the hand-run v0 of exactly that pipeline
          ├╌╌▶ Meta ads onto these rails — today they run from chat through the Meta Ads
          │      MCP, outside the lint/approve/govern chain that Google Ads rides
          └╌╌▶ scheduled Claude sessions as a standing brain — the queue is brain-agnostic
```

Two things are built but unproven, and should be treated that way: **Google Ads has never
touched a live account** (needs `googleads.local.json` plus a brand-declared `customerId`), and
the **image bridge has never sent a real post**. [docs/STATUS.md](docs/STATUS.md) keeps that
list honest — it is the file to trust over any other.

## Quickstart

```bash
npm install      # uses your installed Chrome — no playwright browser download
npm run login    # sign in to the five platforms once, in the automation profile
npm run smoke    # proves Chrome control works
npm run agent    # the daemon: poll → claim → execute → report, every 30s
```

Needs a backend key (`MARKETER_INGEST_KEY` env var, or `backend.local.json`) matching the
command center. Point elsewhere with `MARKETER_BACKEND_BASEURL`.

## Where to read more

| | |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | **What actually works**, verified against code, with the caveats |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Three processes, four rails, every collection |
| [docs/AGENT.md](docs/AGENT.md) | Operator manual: each action's params, the probe harnesses, browser gotchas |
| [docs/BRIEF.md](docs/BRIEF.md) | Plan of record for this build — locked decisions and phases |
| [docs/CONTRACTS.md](docs/CONTRACTS.md), [docs/decisions/](docs/decisions/) | Schemas, and the ADRs behind the hard-to-reverse calls |
| [MASTERPLAN.md](MASTERPLAN.md) | The vision, including the builds still out of scope |
