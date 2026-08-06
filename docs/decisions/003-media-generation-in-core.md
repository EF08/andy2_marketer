# ADR 003 — Media generation runs in core, through chatgpt.com

**Date:** 2026-08-04 · **Status:** accepted

## Decision

Add one media action type, `generate_media`, to the core action pipeline. The agent drives
chatgpt.com in the same logged-in automation Chrome (the account is already there), saves
the render + a `manifest.json` under `data/media/<brand>/<date>_<slug>/` on the PC, and the
backend keeps a `media_assets` ledger: verbatim prompt, creative context, file inventory,
and an append-only list of paid-test results ($25/$50 Meta experiments) recorded via
`marketer_media_track`.

## What this reverses, deliberately

The BRIEF's plug-point model says **image production lives in the brand's own repo** ("core
never screenshots") and scoped the full media pipeline out of the v2 build. Both remain true
for *templated* cards (the `cards` plug point is untouched). What changed: Andy commissioned
the separate media build the BRIEF pointed at (MASTERPLAN §2.4's lean slice), and ad
creative is not brand code — it is a *prompt*, authored by Claude per decision #9, executed
by a generator that is the same for every brand. Core learns nothing about basketball; it
learns "submit text to ChatGPT, save the image." Genericity holds: roseacademy ads need
zero core changes.

## Shape (and what was rejected)

- **Rides the existing action pipeline** (decision #5): draft → queue → claim → execute →
  report → rollup. Rejected: a parallel "renders" queue — new plumbing, second approval
  surface, nothing gained.
- **Runs like a read** (auto, no approval): it publishes nothing and spends nothing but
  ChatGPT quota, which the governor paces (6/hr, 24/day, 2-min gaps). Rejected: approval
  gating — a tap that protects nothing teaches tap-blindness.
- **Files on the PC, record in Mongo.** The image is a working artifact (it gets uploaded
  to Meta when used); the *story* — prompt, context, crop, experiments — is the system of
  record and must survive with the PC off. Rejected: R2/cloud storage (MASTERPLAN §2.4
  scope, not needed to sell the first site) and base64 files in Mongo (16MB doc limit,
  and the ledger is not a CDN). A ~300px thumbnail on the doc is the one exception so the
  dashboard can show the asset.
- **ChatGPT web, not an image API.** Andy pays for the account already, the profile is
  logged in, and the same UI-automation muscle the agent lives on applies. Rejected: API
  keys in the backend (violates "no LLM key in core") or in the agent (a second billing
  surface). Cost: ChatGPT's UI can change → `ui_changed` failures; accepted, that is the
  agent's normal hazard and the selectors are dated in the executor header.
- **Perfect recall is a contract, not a habit:** `params.prompt` must be the full
  standalone prompt (model refuses a draft without it), `params.context` carries the
  creative reasoning, and the executor records the exact submitted text. Rejected:
  reconstructing prompts from chat history later — that is how provenance dies.
