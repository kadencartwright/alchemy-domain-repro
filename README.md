# `@alchemy.run/domain` Modeling & Runtime Reproduction

Standalone, domain-agnostic reproduction of two real-world systems we tried modeling with **`@alchemy.run/domain`** (`2.0.0-beta.87`, Effect `4.1.5`) on Cloudflare Durable Objects:

1. **Case 1 — Multi-Tenant Document CMS** (`packages/cms-domain`): a publishing workspace with cross-document invariants (unique schedule dates, strong reference integrity across drafts and published docs, atomic multi-document publish/discard) and ad-hoc filtered/paginated catalog search.
2. **Case 2 — High-Throughput Quota-Bounded Fulfillment Network** (`packages/quota-domain`): a sponsored-slot delivery system with weighted campaign selection, atomic paired placement quotas (`primary` + `companion`), short-lived start leases, honest late/duplicate consumption reports, and immutable fixed-price settlement invoices at 50–400 requests/s.

The goal is to get feedback on whether there is a better idiomatic way to model these problems in `@alchemy.run/domain`, or where the boundary should sit between `@alchemy.run/domain` and lower-level storage/serving primitives.

---

## Quick Start

Requires Node 24+ (for built-in `node:sqlite` and `--experimental-strip-types`) and `pnpm`. No Cloudflare credentials or cloud deployment required.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm bench:all
```

What each command runs:
- `pnpm typecheck` — verifies both domain packages and the Cloudflare Worker (`apps/repro-worker/src/ReproWorker.ts` + `alchemy.run.ts`) against `@alchemy.run/domain/Cloudflare` (`2.0.0-beta.87`).
- `pnpm test` — runs `Story` tests (`Domain.InMemory`) for both models plus integration tests over `@alchemy.run/domain/DurableObjects`'s real `makePlatform`.
- `pnpm bench:cms` / `pnpm bench:quota` — executes `@alchemy.run/domain/DurableObjects`'s real `aggregateObject`, `policyObject`, `projectionObject`, `queue`, and `alarmCallbacks` over an instrumented per-DO SQLite `ObjectStorage` (`apps/repro-worker/scripts/instrumented-do-platform.ts`), measuring exact `storage.put` counts, serialized `"meta"` byte sizes, key-prefix growth, and concurrent burst serialization.

---

## Note on `2.0.0-beta.87` Improvements

We originally evaluated `@alchemy.run/domain` on `2.0.0-beta.84`. Moving this reproduction to `2.0.0-beta.87` already resolved several earlier friction points:
- `@alchemy.run/domain/Cloudflare` now lives inside `@alchemy.run/domain` (no longer hits the `beta.84` `./internal` package-export issue).
- `Domain.Query` with `waitsFor` + `{ atLeast: receipt }` provides a clean first-class read-your-writes catch-up pattern over a `Domain.Projection`.
- `Domain.Projection` supports `{ batch: { size, wait } }`, and `schedule` / `unschedule` are first-class.

The remaining questions below are the modeling and runtime walls that still show up on `2.0.0-beta.87`.

---

## Case 1: Multi-Tenant Document CMS (`packages/cms-domain`)

### The Modeling Dilemma
A publishing workspace holds hundreds to thousands of documents with **cross-document invariants**:
- Unique `releaseDate` across active scheduled articles in the workspace.
- Strong reference integrity (cannot save a dangling strong ref; cannot delete a target referenced by any active draft or published doc; publish strengthens `strengthenOnPublish` refs atomically).
- Atomic multi-document publish and per-document draft discard back to the pinned published revision.
- Ad-hoc filtered/paginated catalog search with read-your-writes after save.

We implemented both obvious aggregate boundaries side-by-side:
- **Approach A (`Workspace` aggregate — `packages/cms-domain/src/Workspace/Workspace.aggregate.ts`):** All cross-document invariants hold atomically in `decide`, and a single `receipt` gates `SearchCatalog({ atLeast: receipt })`. Even after externalizing large document bodies as `bodyHash` digests, every single-field edit serializes under `exclusive` (`blockConcurrencyWhile`) and rewrites the **entire** `"meta"` state blob (`DurableObjects.ts` `aggregateObject`).
- **Approach B (`ContentDocument` + `ScheduleSlot` aggregates — `packages/cms-domain/src/Document/Document.aggregate.ts`):** Edit payload drops to a flat ~0.3 KiB, and 1:1 date uniqueness moves to an invariant-shaped `ScheduleSlot` aggregate. However, strong-reference graphs across arbitrary documents and atomic multi-document publish lose their transactional boundary, and a single `atLeast: receipt` only gates one document's stream rather than a multi-document batch.

### Measured Output (`pnpm bench:cms`)

Single-field title edit cost on `Workspace` as document count grows (bodies already externalized as `sha256` hashes):

| Docs | `meta` size | >128 KiB KV? | Put bytes/edit | Put keys/edit (Agg) | ms/edit (local SQLite) | Total Agg keys |
|---:|---:|:---:|---:|---:|---:|---:|
| 10 | 4.4 KiB | no | 6.2 KiB | 8 | 0.84 ms | 77 |
| 100 | 43.7 KiB | no | 45.5 KiB | 8 | 1.93 ms | 257 |
| 350 | 153.1 KiB | **YES** | 154.9 KiB | 8 | 4.58 ms | 757 |
| 500 | 218.7 KiB | **YES** | 220.5 KiB | 8 | 8.12 ms | 1,057 |
| 750 | 328.1 KiB | **YES** | 329.9 KiB | 8 | 13.11 ms | 1,557 |

- At **~300 documents**, `"meta"` alone crosses **128 KiB** (Cloudflare DO KV value limit) even without storing document bodies.
- Compare with Approach B (`ContentDocument`): flat **`0.3 KiB`** `meta`, **`1.2 KiB`** written/edit, **`0.20 ms/edit`**, at the cost of losing cross-document strong-reference and atomic-publish invariants.
- Unbounded key accumulation in the 750-doc `Workspace` DO (no built-in retention/compaction):
  - `event:*`: 775 keys (`442.5 KiB`)
  - `receipt:*`: 775 keys (`354.2 KiB`)
  - `meta`: 1 key (`328.1 KiB`)
- Read-your-writes (`SaveDraft` → `SearchCatalog({ atLeast: receipt })` with 5 ms commit + 5 ms DO RPC + 25 ms projection batch wait): `SaveDraft=88.4 ms`, `SearchCatalog(atLeast)=80.5 ms`.

---

## Case 2: Quota-Bounded Fulfillment Network (`packages/quota-domain`)

### The Modeling Dilemma
An incoming opportunity (50–400/s peak bursts; ~3.5M/month current, ~35M/month at 10×) must:
1. Pick one eligible campaign by weight (active window, audience targeting, remaining capacity).
2. Atomically reserve paired placements (`primary` + `companion`) respecting independent purchased targets and standalone approval rules, with a short-lived start lease.
3. Account for delayed, duplicated, or **late** (post-expiry) consumption reports honestly—crediting up to target, tracking excess separately, and never changing a finalized fixed-price bundle invoice.

We modeled three topologies side-by-side (`packages/quota-domain/src/`):
- **Topology A (`Market` aggregate + `ScheduleLeaseExpiry` policy):** Semantically clean, but every decision, exposure report, and lease expiry serializes through one DO, rewrites an ever-growing `"meta"` blob (holding active reservations + dedupe sets), and schedules one durable callback per reservation.
- **Topology B (`Campaign` aggregate):** Isolates unrelated campaigns, but weighted selection requires multi-hop try/fallback across candidate DOs—and a single hot campaign still serializes on one DO.
- **Topology C (`Treasury` + 8 sharded `AllocationCell` aggregates):** Scales decision writes across N DOs in 1 hop, but skewed traffic strands quota on quiet cells, fragments paired capacity near campaign end, and turns invoice finalization into a non-transactional multi-actor gather.

### Measured Output (`pnpm bench:quota`)

**1) Storage & key amplification on `Market` + `ScheduleLeaseExpiry` over just 250 opportunities** (paired `primary` + `companion`, 65%/89% qualification):
- `Market` DO `"meta"` size after 250 opps: **`116.6 KiB`** (approaching 128 KiB after only 250 requests!).
- `Market` DO stored keys: **`2,824` keys (`920.3 KiB`, `~3,769 B/opp`)**:
  - `event:*`: 659 keys (`286.0 KiB`)
  - `receipt:*`: 659 keys (`230.6 KiB`)
  - `cb:*`: 501 keys (`233.4 KiB`) — individual durable expiry callback jobs
  - `armed:*`: 500 keys (`35.1 KiB`)
  - `scheduled:*`: 500 keys (`18.6 KiB`)
  - `meta`: 1 key (`116.6 KiB`)
- `ScheduleLeaseExpiry` Policy DO stored keys: `seen:*` = 250 keys (`1.0 KiB`).
- Total DO `storage.put` keys/opp (Aggregate + Policy): **`24.8 keys/opp`** (`~157.1 KiB/opp` written).
- Uncompacted projection:
  - **`86.8M` DO `put` keys/mo** at 3.5M opps/mo (1×) and **`867.6M`/mo** at 35M opps/mo (10×).
  - Hits Cloudflare's **10 GB single-DO SQLite cap** in **~24.4 days** (1×) / **~2.44 days** (10×).

**2) 80-request concurrent burst (5 ms DO commit + 5 ms DO RPC):**

| Topology | Wall time | p50 | p95 | max | Stranded no-fills |
|---|---:|---:|---:|---:|---:|
| Topology A: Single Market DO | 496.2 ms | 240.2 ms | 467.2 ms | 493.5 ms | 0 |
| Topology B: Campaign DOs (60 fallback hops) | 495.1 ms | 250.5 ms | 468.1 ms | 492.3 ms | 0 |
| Topology C: 8 Sharded Escrow Cells (mild skew) | 66.6 ms | 60.6 ms | 63.1 ms | 63.3 ms | **40** |

*(In our separate Cloudflare cloud benchmark of raw SQLite DOs, synchronous DO claims hit ~4,096 ms p95 under peak bursts and ~$184/mo at 1× / ~$2,000/mo at 10× due to DO row-writes—whereas splitting out stateless edge-cached serving plans + leased permit batches + async batched DO SQLite outbox cut decision latency to ~32 ms p50 / ~256 ms p95 and projected cost to ~$50/mo at 1×.)*

---

## Questions for the Maintainer

1. **Bounded collections with cross-entity invariants (CMS):**
   Is there an idiomatic `@alchemy.run/domain` pattern for a workspace of 500–5,000 documents that needs strong reference checks, unique schedule slots, and atomic multi-doc publish *without* serializing an O(N) `"meta"` blob on every single-field edit? Or is this a sign that aggregate state needs SQLite-table / incremental-field storage rather than a single KV `"meta"` value?

2. **Multi-aggregate read-your-writes & catalog search (CMS):**
   `Domain.Query` + `waitsFor` + `atLeast: receipt` works nicely for a single `Workspace` aggregate. If we split into per-`Document` aggregates, how should a bulk edit or multi-doc publish gate a `Query` across N streams?

3. **Storage lifecycle, compaction, and TTL (Both):**
   In `DurableObjects.ts`, `event:*`, `receipt:*`, `seen:*` (policies), `in:*` (views/projections), and `armed:*` / `scheduled:*` accumulate indefinitely. For long-lived or high-volume aggregates, what is the intended story for compacting/pruning receipts, events, and view/projection logs so a DO doesn't hit Cloudflare's 10 GB cap or rack up unbounded storage?

4. **High-fan-in weighted quota allocation (Ads/Quota):**
   When every incoming request needs weighted selection across active campaigns + atomic paired quota reservation at 200–400 req/s:
   - Single aggregate (`Market`) serializes on `blockConcurrencyWhile`.
   - Per-campaign aggregates (`Campaign`) multiply cross-DO hops and still hotspot on a single popular campaign.
   - Sharded escrow cells (`AllocationCell`) strand quota under skew and fragment paired placements.
   How would you model this in `@alchemy.run/domain`?

5. **Ephemeral leases & expiry sweeps vs. per-item `schedule` (Ads/Quota):**
   Using `Policy` + `schedule` for short-lived leases creates `armed:*`, `scheduled:*`, and `cb:*` rows per reservation (1,500+ keys per 250 paired opportunities). Is there a recommended pattern for high-frequency ephemeral leases / periodic sweep timers inside `@alchemy.run/domain`, or should ephemeral serving state intentionally live outside the event-sourced domain model?

6. **Control plane vs. data plane boundary (Ads/Quota):**
   Our best-performing production-shaped architecture used:
   - Strongly consistent **control plane** (campaign setup, budgets, finalized invoices),
   - Stateless Worker **data plane** reading cached R2 plans + short-lived leased permit batches,
   - Micro-batched **accounting/feedback plane** (batched SQLite ingest + debounced outbox replication + 1 Hz pacing controller).
   Would you recommend keeping `@alchemy.run/domain` strictly as the **control plane** (and letting the high-throughput serving/telemetry planes sit outside it), or do you see `@alchemy.run/domain` evolving to support SQL-backed incremental aggregate state, micro-batched command commits, and batched outbox drains?
