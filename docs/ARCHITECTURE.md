# ARCHITECTURE

Three processes, one queue, and a hard rule about who is allowed to think.

```
┌──────────────────┐   MCP (Streamable HTTP)   ┌───────────────────────────────┐
│ Claude (chat,     │ ────────────────────────▶ │ a1a2-command-center            │
│ Code, scheduled)  │   33 marketer_* tools     │ apps/marketer/                 │
│ THE BRAIN         │ ◀──────────────────────── │ queue · ledger · rails         │
└──────────────────┘                            └──────────┬────────────────────┘
┌──────────────────┐        JSON API                       │ 30s poll
│ dashboard (Vercel)│ ◀─────────────────────────────────────┤ (x-marketer-key)
│ THE COCKPIT       │                                       ▼
└──────────────────┘                            ┌───────────────────────────────┐
                            Gmail alerts ◀────── │ andy2_marketer agent (this PC) │
                                                 │ Playwright + CDP → real Chrome │
                                                 │ THE HANDS — never thinks       │
                                                 └───────────────────────────────┘
```

**The brain is not in the backend.** No LLM key lives here. Claude decides what to say; the
backend decides whether it may go out, when, and records what happened. The agent decides
nothing at all — it executes one claimed action and reports evidence. That separation is why
every action is loggable, approvable, rate-limitable, and replayable, and why a future brain
(a scheduled Claude Code session, a different model) plugs into the same queue.

## Core vs. per-brand

Core code never learns any brand's subject matter. Everything brand-specific arrives as data
on a **brand profile** (`brands` collection) or through one of three plug points:

| Plug point | Contract | Who implements it |
|---|---|---|
| **Substrate** | one whole-document `GET` returning `{version, records:[{id,kind,title,url,updatedAt,facts{}}]}` | the brand's own site (a prerendered endpoint) |
| **Creative templates** | `{baseUrl}/{template}?params` returning an image | the brand's own repo (core never screenshots) |
| **Conversion reporter** | brand site `POST`s `/api/marketer/conversions` with its public token | the brand's own site (one line, or client-side JS) |

A brand is to this system what a repo plus its CLAUDE.md is to Claude Code. Brands are
isolated: separate queues, policies, rate lanes, dedupe scopes, active hours, and channel
identities.

## The four rails (in the order an action meets them)

1. **Linter** (`lint.js`) — deterministic, at draft time. Blocking findings mean nobody can
   approve it, including a campaign envelope. There is no `git revert` for a published post,
   so verification happens *before* the send.
2. **Approval** — per action (`pending_approval`) or per campaign envelope, which raises the
   altitude without removing a rail.
3. **Rate governor** (`governor.js`) — at claim time, server-side: lane cooldowns, brand active
   hours, jittered minimum gaps, hourly/daily caps. A held action stays approved and carries
   `heldUntil` + `holdReason`, so the queue explains its own wait.
4. **Verify-after-act** — the agent must find its own evidence. Anything ambiguous becomes
   `needs_review`, never `failed`, because "failed" reads as safe-to-retry and a retry is how
   you double-post.

Plus one guard that sits inside the agent: **identity** (`identity.ts`). One Chrome profile is
one logged-in identity per platform, so an outward act whose brand declares a different handle
is refused (`wrong_identity`) rather than published from the wrong account.

## Collections (Mongo, DB `marketer`)

| Collection | What it holds |
|---|---|
| `actions` | The unified queue **and** ledger. Drafts and executed actions are the same doc. |
| `brands` | Brand profiles: voice, rules, channels, active hours, rate overrides, plug points. |
| `settings` | Singletons: global policy, `policy:<brand>`, lane cooldowns, migration flags. |
| `schedules` | Sweeps and paced releases, evaluated lazily on the agent's poll. |
| `posts` | One doc per published thing + append-only metric snapshots + click/conversion counters. |
| `links` / `clicks` / `conversions` | Attribution chain: minted code → click (bots flagged) → outcome. |
| `inbox` | Mentions and replies with a triage lifecycle and per-author history. |
| `campaigns` / `playbooks` | Approval envelopes with atomic budget burn; versioned playbooks as data. |
| `substrate` | Cached per-brand substrate snapshot, so claim-tracing never needs a live fetch. |
| `ingested` | Raw scraped payloads. **Working data, never the system of record.** |
| `agents` / `alert_log` | Heartbeat + session health; alert throttle. |

## Data flow of one post, end to end

1. Claude reads the brand profile, `marketer_performance`, and the substrate; mints a link
   (`marketer_mint_link`) and puts the shortUrl in the copy.
2. `marketer_draft_action` → linter runs → campaign envelope or policy decides the status.
3. Agent polls, backend's `claimNextAction` consults the governor, hands over the action plus
   `approvedAt` and `expectedHandle`.
4. Agent verifies identity, acts in real Chrome, verifies the artifact, reports evidence.
5. `completeAction` picks a terminal state honestly, seeds/heals the `posts` row, and routes
   read results into metric snapshots or inbox items.
6. Clicks hit `/api/marketer/r/:code`, which records and 302s with `?cs=`; the brand site
   reports the outcome later; both land on the post row.
7. Next session Claude reads what earned and adjusts — the loop closes.

## Why no cron

Render's free tier spins down, so a clock inside this process would silently stop being a
clock. Schedule evaluation is lazy and server-side, inside `/agent/poll` (the `failStaleRunning`
precedent). While the PC is on, schedules run; while it is off, nothing could have executed
anyway. The agent stays schedule-blind — this is deliberately *not* the crawler's client-side
scheduler.
