# CONTRACTS

Every schema a second implementer would need. **If a contract changes, it changes here in the
same commit.**

## 1. Brand profile (`brands` collection, `_id` = slug)

```jsonc
{
  "slug": "circuitstats",              // _id; 3-40 chars, [a-z0-9-], no leading/trailing hyphen
  "name": "Circuit Stats",
  "status": "active",                  // active | paused  (paused refuses new drafts)

  "voice":    { "tone": "plain, factual, no hype", "styleRules": ["never use exclamation marks"] },
  "audience": "Grassroots basketball players, parents, coaches following EYBL/UAA/3SSB.",
  "goals":    ["Grow awareness of free searchable circuit stats"],

  "bannedClaims":  ["guaranteed scholarship"],   // literal substrings that BLOCK a draft
  "doNotMention":  ["competitor name"],          // ditto
  "aiDisclosure":  null,                         // required substring in outward copy, or null

  "channels": { "twitter": { "handle": "circuitstats" } },   // the identity guard
  "activeHours": { "start": 8, "end": 24, "tz": "America/Toronto" },  // outward acts only

  "rateOverrides": {                   // most specific wins: "twitter:like" > "like" > default
    "like": { "perHour": 25, "perDay": 150, "minGapSeconds": 45 }
  },

  "substrate": { "url": "https://circuitstats.org/substrate.json" },  // or null
  "cards":     { "baseUrl": "https://circuitstats.org/api", "templates": { "player": { "w": 1200, "h": 675 } } },
  "links":     { "domain": "circuitstats.org" },   // serve short links first-party, or null
  "conversionToken": "…",              // public write token; shown once on create/rotate
  "createdAt": "…", "updatedAt": "…"
}
```

Patch semantics: only fields you pass change. `channels.<platform>: null` removes that channel.
`substrate`/`cards`/`activeHours`: `null` clears.

## 2. Plug point — substrate provider

One whole-document `GET`. **No query params, no conditional requests** (static-site friendly).
Core caches a snapshot per brand, so claim-tracing never depends on a live fetch.

```jsonc
{
  "version": "2026-07-30",             // anything; may honestly be build time
  "records": [
    {
      "id": "player-1234",
      "kind": "player",
      "title": "Ezekiel Ifejeh",
      "url": "https://circuitstats.org/player/1234",
      "updatedAt": "2026-07-29T00:00:00Z",
      "facts": { "ppg": 14.5, "rpg": 6.5, "games": 11 }   // any shape; every number is extracted
    }
  ]
}
```

What the linter does with it: collects **every number anywhere** in `records` into a set. A
numeric claim in copy that isn't in that set is a blocking `claim_untraceable` finding. No
substrate declared → numeric claims produce a *warning* instead (untraceable, not wrong).

Implementation note: for an Astro site this is ~30 lines as a prerendered file endpoint
(precedent: `circuitstats-astro/src/pages/sitemap.xml.ts`).

## 3. Plug point — creative templates

Brand declares `cards: { baseUrl, templates: { name: {w,h} } }`. Core **never screenshots**; it
consumes `{baseUrl}/{template}?params` as an image URL through the image bridge.

The renderer lives in the brand's repo (precedent: `circuitstats-astro/api/og-shot.js`) and must
return an image content-type, ≤12MB, over https.

## 4. Plug point — conversion reporter

Mint → click → outcome:

1. `marketer_mint_link` → `{ code, shortUrl }`. Put `shortUrl` in the copy **before** drafting.
2. `GET /api/marketer/r/:code` records the click (bots flagged via the visitor tracker's UA
   regex, never counted) and `302`s to the destination with `?cs=<code>` appended.
3. The brand site persists `cs` (localStorage) and later reports the outcome:

```http
POST /api/marketer/conversions
Content-Type: application/json

{
  "brandId": "circuitstats",
  "token": "<the brand's conversionToken>",
  "cs": "aB3xY7q",              // the code from the URL; optional but that's what attributes it
  "clickId": "…",               // optional, more precise
  "kind": "signup",
  "value": 49,                  // optional number
  "currency": "USD",            // optional
  "dedupeKey": "order-1234",    // optional; replay-safe
  "meta": { }                   // optional
}
```

Responses: `{ok:true, attributed:true, postId}` · `{ok:true, duplicate:true}` · `401` on a bad
token. CORS is open on this route (`POST`, `OPTIONS`) because brand sites call it from the
browser.

For a fully static brand this is client-side JS only. For a brand with a backend app it is one
added line where the lead is recorded.

## 5. Playbook (`playbooks` collection, versioned per brand+name)

Data, not code. Claude executes it; the backend only stores and versions it.

```jsonc
{
  "brandId": "circuitstats", "name": "weekly-standouts", "version": 3,
  "steps": [
    { "step": 1, "kind": "harvest",  "description": "top performers this week", "substrateQuery": "kind=player sort=ppg limit=5" },
    { "step": 2, "kind": "select",   "description": "skip anyone posted in the last 14 days" },
    { "step": 3, "kind": "render",   "template": "player" },
    { "step": 4, "kind": "draft",    "description": "one post per player, stat + link" },
    { "step": 5, "kind": "schedule", "slot": "morning-post" }
  ],
  "notes": "…"
}
```

`kind` is free text by convention: `harvest | select | render | draft | schedule | note`.

## 6. Action document (the queue and the ledger)

Serialized by `fmtAction` — **a whitelist**. A field missing there is invisible to routes, MCP,
and the dashboard, so every new field must be added to it.

```jsonc
{
  "actionId": "…", "brandId": "circuitstats",
  "type": "post",                  // scrape|search|check_session | post|reply|comment|like|follow|dm
  "platform": "twitter",
  "params": { },                   // per-type; see the marketer_draft_action description
  "status": "approved",            // draft|pending_approval|approved|running|done|needs_review|failed|rejected
  "requestedBy": "claude", "requestedAt": "…", "approvedAt": "…",
  "startedAt": "…", "finishedAt": "…",
  "result": { }, "error": null, "agent": "Andy", "autonomy": "approve",
  "dedupeKey": "…",                // unique per (brandId, dedupeKey) — partial index, see ADR 002
  "campaignId": "…", "scheduledFor": "…",
  "heldUntil": "…", "holdReason": "hourly cap reached (3/3 post on twitter)",
  "lint": { "blocking": [], "warnings": [], "claims": [], "shingles": [], "substrate": { } },
  "postId": "…", "inboxItemId": "…"
}
```

`needs_review` means **it may have gone out**. Never blind-retry one.

## 7. Media assets (`media_assets` collection) + the `generate_media` action

The one action type that produces a file instead of touching a platform. Runs like a read
(auto, no approval — nothing publishes), `platform: null`, executed by `generateMedia.ts`
driving chatgpt.com in the logged-in profile.

`params`:

```jsonc
{
  "title": "Prep School Offers Hero",
  "prompt": "…",                 // REQUIRED. The full, standalone image prompt, verbatim —
                                 // everything the generator needs with no other context.
  "aspectRatio": "4:5",          // 1:1 | 4:5 | 2:3 | 3:2 | 9:16 | 16:9 (default 4:5).
                                 // Non-native ratios are center-cropped from the nearest
                                 // native render; the crop box is recorded.
  "slug": "prep-school-offers",  // optional; names the folder (derived from title otherwise)
  "referenceImages": [           // optional, ≤4 — attached to the ChatGPT prompt via the
    {                            // composer's real file input; the prompt text must say what
      "url": "https://…",        // each attachment is for. url = https (image-bridge checks:
      "path": "C:\\…\\ad.png",   // content-type + 12MB cap) OR path = file already on the
      "note": "the real site"    // agent PC (a prior winning ad, a saved screenshot).
    }
  ],
  "context": {                   // optional, free-form provenance — the "why it looks like this"
    "concept": "…", "angle": "…", "offer": "…", "referenceUrls": ["…"],
    "decision": "inherit|iterate|fresh — and why (see the media-drafting playbook)", "notes": "…"
  },
  "dryRun": true                 // optional: open ChatGPT, verify the composer, submit nothing
}
```

Files land on the agent's PC under `data/media/<brandId>/<YYYY-MM-DD>_<slug>/` —
`ad-<ratio>.png` (cropped final), `source.png` (uncropped native render), `manifest.json`
(the complete generation story). The completion rollup upserts one `media_assets` doc per
action (keyed on `actionId`, retry-safe) and stamps `mediaAssetId` back onto the action:

```jsonc
{
  "brandId": "playersites", "actionId": "…",
  "title": "…", "slug": "…",
  "status": "draft",             // draft | selected | testing | winner | retired
  "generator": "chatgpt",
  "prompt": "…",                 // the VERBATIM submitted prompt (incl. the executor's
                                 // orientation suffix) — the recall anchor
  "context": { },                // params.context, verbatim
  "referenceImages": [           // what the generator was shown (recall): source + sha256
    { "source": "https://… or C:\\…", "note": "…", "bytes": 1234, "sha256": "…" }
  ],
  "aspectRatio": "4:5",
  "files": [{ "path", "role", "width", "height", "ratio", "bytes", "sha256" }],
  "savedDir": "…", "manifestPath": "…", "conversationUrl": "https://chatgpt.com/c/…",
  "thumbnailDataUrl": "data:image/jpeg;…",   // ~300px, for the dashboard grid
  "experiments": [               // append-only, capped at 40 (the metric-snapshot pattern)
    {
      "at": "…", "platform": "meta", "label": "$25 traffic test, parents-GTA",
      "budgetUsd": 25, "spendUsd": 24.6,
      "campaignId": "…", "adsetId": "…", "adId": "…",      // Meta ids
      "metrics": { "impressions": 4100, "clicks": 87, "ctr": 2.1, "leads": 2, "cpl": 12.3 },
      "verdict": "winner",       // winner | loser | inconclusive | short free text
      "notes": "…"
    }
  ],
  "createdAt": "…", "updatedAt": "…"
}
```

Experiment numbers are read from Meta ads by Claude-in-session and recorded via
`marketer_media_track` — the backend stores them verbatim and never computes or invents a
metric. `marketer_media_list` returns lean rows (no prompt/context/experiments);
`marketer_media_get` is the full "how was this ad made, top to bottom" answer.

## 8. Agent poll contract

`POST /api/marketer/agent/poll` (header `x-marketer-key`)

```jsonc
// request
{ "status": "idle", "hostname": "Andy", "platform": "win32", "currentActionId": null, "wantAction": true, "sessions": { } }

// response — deliberately minimal
{
  "action": {
    "actionId": "…", "type": "post", "platform": "twitter", "params": { },
    "approvedAt": "…",            // the agent refuses any outward act without this
    "status": "running",
    "brandId": "circuitstats",
    "expectedHandle": "circuitstats"   // present only when the brand declared one
  },
  "now": "…"
}
```

## 9. Failure taxonomy (agent → backend)

`result.failureCode` is what the backend routes on: `bad_params`, `login_required`, `not_found`,
`ui_changed`, `rate_limited`, `blocked`, `ambiguous`, `platform_error`, `not_approved`.

- `ambiguous` → the action becomes `needs_review`.
- `rate_limited` → the governor cools that brand+platform lane (exponential per strike).
- `wrong_identity` is reported as `bad_params` with a message naming both handles.
