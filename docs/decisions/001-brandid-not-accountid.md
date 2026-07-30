# ADR 001 — `brandId`, not `accountId`

**Date:** 2026-07-30 · **Status:** accepted · **Supersedes:** MASTERPLAN.md §8's `accountId`

## Context

MASTERPLAN.md §8 proposed putting `accountId` on every row "from day one (default `main`)" so a
second brand would be config rather than surgery. It was never implemented — every existing
action predates it. Implementing multi-tenancy now forced the name to be settled.

## Decision

The unit of isolation is the **brand**, and the field is `brandId`, defaulting to `circuitstats`
(not `main`).

## Why

- **`accountId` names the wrong thing.** One brand legitimately owns several platform accounts
  (`channels: {twitter:{handle}, instagram:{handle}}`), and one Chrome profile can only be signed
  into one account per platform anyway. Keying isolation on "account" would have made the common
  case — one brand, five channels — into five rows of policy.
- **The brand is what carries the rules.** Voice, banned claims, active hours, substrate,
  conversion token: all of these are properties of a brand, not of a login. Naming the field
  after the thing that owns the rules keeps `brands.js` the single place a rule can live.
- **`circuitstats` beats `main`.** A default named `main` is a lie the moment a second brand
  exists — every historical row really was Circuit Stats, and saying so makes the backfill
  auditable.

## Consequences

- `brandId` is on `actions`, `posts`, `inbox`, `campaigns`, `schedules`, `links`, `clicks`,
  `conversions`, and policy documents (`policy:<brandId>`).
- Policy is per-brand over a global default, and `paused` is an OR — a brand can never
  un-pause the whole system.
- A second Chrome profile (a second identity per platform) is still out of scope. What makes
  single-profile multi-brand safe is the identity guard, which refuses to act when the
  signed-in handle isn't the acting brand's declared one.

## Rejected

- **`accountId`** — see above.
- **Separate databases per brand.** Isolation would be stronger, but every cross-brand rollup
  (and the single agent's single queue) would need fan-out, for a system with two brands.
