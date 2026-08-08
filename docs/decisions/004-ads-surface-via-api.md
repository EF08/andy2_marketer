# ADR 004 — The paid surface: Google Ads through the API, on the same queue

**Date:** 2026-08-08 · **Status:** accepted

## Decision

Add the first paid-ads surface as two platform-agnostic action types on the existing
pipeline — `ads_report` (read, auto) and `ads_mutate` (act, approval always) — running on a
new ads platform value `google`. The agent executes them over the Google Ads REST API
(v25, version pinned in config) from the PC; no browser is involved. Credentials
(`googleads.local.json`: OAuth client + refresh token + developer token) live only on the
agent PC, bootstrapped by `scripts/googleads-auth.ts`. The brand profile grows one field,
`googleAds: { customerId, maxDailyBudget }` — the paid surface's identity guard and money
rail in one place.

## Why the agent and not the backend

The backend could call Google directly — it is just HTTPS — but that would put a
money-spending capability and its credentials on Render, and make the backend an actor for
the first time. The whole architecture rests on "the backend decides whether/when, the
agent acts, Claude thinks" (BRIEF decision #3/#5). Keeping execution in the agent preserves
that: approval, governor lanes, `needs_review` semantics, dedupe, and the ledger all apply
to money exactly as they apply to posts, with zero new plumbing. Cost: ads actions only run
while the PC is on — already true of everything else this system does.

## The money rail (new, because money is a new failure mode)

There is no `git revert` for spend, so the same before-the-send posture applies, three
layers deep:

1. **Linter at draft** — `ads_budget_cap` blocks any budget above the brand's declared
   `maxDailyBudget`, and blocks *all* spend when no cap is declared. Money is
   default-closed, like identity. RSA shape, banned claims, claim tracing, and finalUrl
   reachability are checked in the same pass — ad copy is copy.
2. **Approval, always** — `ads_mutate` defaults to `approve` in policy, and campaigns are
   created `PAUSED` unless `activate: true` is explicit: "may exist" and "may spend" are
   separate decisions (the Meta-test precedent).
3. **Executor re-check** — the backend stamps `{customerId, maxDailyBudget}` onto the
   claimed action (the `expectedHandle` pattern); the executor refuses any other account,
   refuses budgets above the stamped cap, and honours an optional local
   `allowedCustomerIds` allowlist so even a compromised queue cannot point spend at an
   arbitrary account.

## Shape (and what was rejected)

- **Two types, not one `google_ads` with mixed ops.** Autonomy policy is per type; a type
  that is sometimes-auto-sometimes-approved would fork the policy model. Read/act is the
  system's native split — and `platform: 'meta'` can reuse both types later without new
  vocabulary.
- **Ads platforms are not browser platforms.** `google` lives in `ADS_PLATFORMS`, kept out
  of `PLATFORMS`, so session sweeps, channel handles, and browser executors never see it.
- **`validateOnly` is dryRun.** Google validates the full mutation server-side and creates
  nothing — a better rehearsal than any browser dryRun we have.
- **Verify-after-act is a re-read.** Every mutation is followed by a GAQL read of what it
  claims to have changed; a mismatch reports `ambiguous` → `needs_review`, because a lost
  mutation MAY have landed and money is never blind-retried.
- **Rejected: the official client library** (`google-ads-api` / gRPC). The agent needs four
  endpoints (token refresh, search, mutate, listAccessibleCustomers); a hand-rolled REST
  client is ~100 lines with no dependency surface, and the API version is a config string.
