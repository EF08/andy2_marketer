# ADR 002 — dedupe keys are scoped per brand (and the index must be *partial*, not sparse)

**Date:** 2026-07-30 · **Status:** accepted · **Hard to reverse:** yes

## Context

`dedupeKey` is the idempotency guarantee that makes a retried draft safe: same key → return the
existing action instead of double-posting. It was enforced by a globally unique sparse index
(`dedupeKey_1`).

With multiple brands, a global scope is wrong: two brands may legitimately want the same natural
key (`post:twitter:weekly-standouts`), and one brand's key would silently suppress the other's
action — the worst kind of bug, because nothing errors and a post simply never happens.

## Decision

Uniqueness is scoped to `(brandId, dedupeKey)`.

The index is **partial**, not sparse:

```js
actions.createIndex(
  { brandId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
)
```

## Why partial matters (this bit its own author)

A **compound sparse** index only omits a document when *every* indexed field is missing.
`brandId` is always present, so `{brandId: 1, dedupeKey: 1}` with `sparse: true` indexes
keyless actions as `dedupeKey: null` — and the *second* action without a dedupeKey in the same
brand fails with a duplicate-key error.

This was caught by `scripts/marketer-selftest.js` on its first run: eleven assertions failed with
`E11000 … dup key: { brandId: "circuitstats", dedupeKey: null }`. Shipped, it would have broken
every draft that didn't pass a key — which is most drafts. `partialFilterExpression` indexes only
documents where `dedupeKey` is a string, which is the actual intent.

## Migration (order matters, and is not reversible)

1. Ensure the default brand exists.
2. Stamp `brandId: 'circuitstats'` on every action lacking one.
3. Only then drop the legacy `dedupeKey_1` index and create the partial compound one.

Running (2) before (3) is required: a compound index built while rows have no `brandId` would key
them on `null` and collide across brands. The migration also detects and rebuilds an earlier
*sparse* version of the compound index, so a database that ran the first draft of this code
heals itself on the next boot.

Recorded in `settings._id = 'migrations'` (`perBrandDedupe`), but each step is written to be
safe if it runs again.

## Consequences

- Two brands may hold the same `dedupeKey`. That is the point.
- The dashboard's `POST /actions` now sends an automatic hour-bucketed key
  (`dash:<brand>:<type>:<platform>:<hash>:<YYYY-MM-DDTHH>`), so a double-tap can't double-post
  while an intentional repeat tomorrow still can. Genuine repetition is the linter's job
  (`duplicate_idea`), not the index's.
