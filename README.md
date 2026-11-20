# `@alchemy.run/domain` High-Throughput Modeling Reproduction

Follow-up reproduction exploring how to model workloads that **overload single-aggregate / single-Durable-Object capacity** in **`@alchemy.run/domain`** (`2.0.0-beta.87`, Effect `4.1.5`) on Cloudflare Durable Objects.

Per-entity models (like a task board partitioned per thread/board) map cleanly onto `@alchemy.run/domain`'s one-aggregate-per-DO model. The two cases here are real workloads where **shared capacity constraints or cross-entity invariants** pull traffic back into a hot aggregate faster than a single DO can serialize it:

1. **Primary Case — Dynamic Ad Network / Quota-Bounded Fulfillment (`packages/quota-domain`)**: weighted selection + atomic paired quota reservations across active campaigns at **185–400 opportunities/s** bursts (**3.5M → 35M opportunities/month**), with short start leases, delayed/late/duplicate exposure reports, and immutable fixed-price invoices.
2. **Bonus Case — Multi-Tenant Document CMS (`packages/cms-domain`)**: a second place we hit the single-aggregate wall—thousands of documents sharing unique schedule slots, strong reference integrity, and atomic multi-document publish.

*(We originally evaluated `@alchemy.run/domain` on `2.0.0-beta.84`. Moving this repro to `2.0.0-beta.87` already resolved the earlier `@alchemy.run/domain/internal` packaging issue and added `Domain.Query` + `atLeast`, projection batching, and `schedule`/`unschedule`. Everything below reflects current `2.0.0-beta.87` behavior.)*

---

## Quick Start

Requires Node 24+ (`node:sqlite` + `--experimental-strip-types`) and `pnpm`. No Cloudflare credentials or cloud deployment required.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm bench:workerd   # Real local workerd DOs via `alchemy dev --stage local`
pnpm bench:quota     # Steelmanned DO storage / key-amplification inspector (Ads)
pnpm bench:cms       # DO storage / meta-size inspector (CMS)
```

---

## Primary Case: Dynamic Ad Network (`packages/quota-domain`)

### Use-Case & Scale Targets

When a listener hits play, an ad decision has to return quickly (**< 100 ms decision path**) while enforcing commercial guarantees:
- **Traffic shape:** ~18.5 opportunities/s observed peak today; designing for **185–400 opportunities/s** bursts (10× peak headroom) and **3.5M → 35M opportunities/month**.
- **Weighted selection + paired quotas:** Each opportunity selects 1 eligible campaign by weight (active date window, free/paid audience, remaining quota) and atomically reserves **paired placements** (`primary` + `companion`) that each have independent purchased targets and standalone-continuation rules.
- **Short start leases + honest late reporting:** Reservations hold capacity for a short start window (seconds to ~2 min). Non-qualifying holds expire so capacity returns. Valid exposure reports can arrive **late** (after lease expiry) or be retried; duplicates must count once, late exposures must still be counted honestly (tracking excess separately), and finalized bundle invoices stay fixed-price and immutable.

### How We Modeled It (3 Attempts)

To avoid a strawman, **`MarketState` is aggressively pruned** ([Market.aggregate.ts](packages/quota-domain/src/Market/Market.aggregate.ts)):
- Only currently *active* (unexpired, unqualified) holds live in `activeReservations`; qualified and expired reservations are deleted immediately in `evolve`.
- Retry deduplication uses `@alchemy.run/domain`'s built-in `receipt:<commandId>` (passing `commandId: exposureId`), and client receipts carry signed `(campaignId, placement)` so late exposures account cleanly without retaining historical reservations in state.

We tested three standard DDD aggregate boundaries side-by-side:

| Topology | Aggregate Boundary | What Works | Where It Bottlenecks |
|---|---|---|---|
| **A. `Market` + `ScheduleLeaseExpiry`** | One aggregate per market ([Market.aggregate.ts](packages/quota-domain/src/Market/Market.aggregate.ts)) | Atomic weighted selection, atomic paired reservation, exact global quotas, zero stranding | Every decision, exposure, and expiry serializes through **one DO** (`blockConcurrencyWhile`). Scheduling per-reservation expiry callbacks (`ScheduleLeaseExpiry` policy) feeds 2 extra `schedule` RPCs/opp right back into the same hot DO. |
| **B. Per-`Campaign` DOs** | One aggregate per campaign ([Campaign.aggregate.ts](packages/quota-domain/src/Campaign/Campaign.aggregate.ts)) | Isolates unrelated sponsors | Selection loses an atomic view across campaigns → multi-hop try/fallback RPCs when a candidate exhausts; **a single hot campaign still serializes on one DO**. |
| **C. `Treasury` + 8 `AllocationCell` DOs** | Conserved quota grants partitioned across N serving DOs ([Escrow.aggregate.ts](packages/quota-domain/src/Escrow/Escrow.aggregate.ts)) | Horizontally shards decision writes in 1 DO hop | Skewed traffic exhausts hot cells while quiet cells hold **stranded quota**; paired `[primary, companion]` capacity fragments near campaign end; invoice finalization becomes a non-transactional multi-actor gather. |

### Where the Bottlenecks Occurred

#### 1. Real Local `workerd` DO Load (`pnpm bench:workerd`)

Running `apps/repro-worker/src/ReproWorker.ts` on **`DomainCloudflare.layerDurableObjects()`** via `alchemy dev --stage local`, driving an **open-loop 185 opps/s × 3s (555 opps)** burst (no synthetic delays):

| Topology | Wall | p50 | p95 | p99 | max | Filled | Stranded no-fills | 5xx |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **A. Single `Market` DO** *(with `ScheduleLeaseExpiry`)* | 43,290 ms | 19,575.8 ms | 40,391.7 ms | 40,505.3 ms | 40,530.5 ms | 555 | 0 | 0 |
| **B. `Campaign` DOs** *(2 candidates, 417 fallback hops)* | 10,754 ms | 3,985.7 ms | 7,865.0 ms | 7,925.8 ms | 7,952.0 ms | 555 | 0 | 0 |
| **C. 8 `AllocationCell` DOs** *(50% skew to cells 0–1)* | 5,175 ms | 2,294.0 ms | 2,800.8 ms | 3,107.5 ms | 3,134.3 ms | 347 | **208** | 0 |

Two things stand out immediately:
- **Single-DO serialization + policy self-contention:** Even in local `workerd` with zero WAN RTT, Topology A queues to **40 s p95** because `AllocateOpportunity` and `ScheduleLeaseExpiry`'s `market.schedule(...)` callbacks fight for the same `Market` DO lock. Even without the expiry policy (Topology B), a single funded campaign DO still queues to **7.8 s p95** at 185/s.
- **Sharding trades latency for stranding:** Spreading across 8 `AllocationCell` DOs cuts wall time ~8× vs Topology A, but mild routing skew immediately leaves **208 of 555** opportunities unfilled while sibling cells still hold unused quota.

*(In our separate real Cloudflare cloud hop benchmark of raw SQLite DOs, synchronous DO admission hit **4,096 ms p95** under peak bursts and projected ~$184/mo at 1× / ~$2,000/mo at 10× driven by DO row writes.)*

#### 2. Irreducible Framework Storage & Write Amplification (`pnpm bench:quota`)

Running `@alchemy.run/domain/DurableObjects`'s real `makePlatform` over instrumented per-DO SQLite on **250 paired opportunities** (65% primary / 89% companion qualification, remainder expired):

- **Aggregate `"meta"` stays tiny:** `17.7 KiB` while holds are active → **`0.6 KiB` once leases expire** (confirming state pruning works).
- **Yet framework-managed keys cannot be pruned by user code** — after just 250 opportunities, `Market` DO retains **`3,008` keys (`849.9 KiB`, `~3,481 B/opp`)**:
  - `event:*`: 751 keys (`320.6 KiB`)
  - `receipt:*`: 751 keys (`241.5 KiB`) — needed indefinitely if relying on `commandId` for exposure dedupe
  - `cb:*`: 501 keys (`233.5 KiB`) — individual durable expiry callback jobs
  - `armed:*` / `scheduled:*`: 500 + 500 keys (`53.7 KiB`)
  - `meta`: 1 key (**`0.6 KiB`**)
  - Plus `ScheduleLeaseExpiry` Policy DO: `seen:*` = 250 keys (`1.0 KiB`)
- **Write amplification & 10 GB DO runway:**
  - **`26.3` `storage.put` keys/opp** across Aggregate + Policy → **`91.9M` put keys/mo** at 3.5M opps/mo (1×) and **`919.1M`/mo** at 35M opps/mo (10×).
  - Uncompacted single-DO storage hits Cloudflare's **10 GB per-DO SQLite limit** in **~26.4 days (1×) / ~2.64 days (10×)**.

### What We Ended Up Doing Outside `@alchemy.run/domain`

To meet sub-100 ms decision latency and low cost in real Cloudflare testing, we split the system into:
1. **Control plane:** Campaign setup, targets, pricing, immutable invoice snapshots (low-volume, strongly consistent — a great fit for `@alchemy.run/domain`).
2. **Data / serving plane:** Stateless Workers reading short-TTL serving plans from R2 + leasing small **permit batches** from a DO (~32 ms p50 / ~256 ms p95 on real Cloudflare cloud; ~$50/mo at 1×).
3. **Accounting / feedback plane:** Batched SQLite ingestion + debounced outbox replication to Postgres + a 1 Hz pacing controller adjusting issuance probabilities/permits.

---

## Bonus Case: Multi-Tenant Document CMS (`packages/cms-domain`)

We hit a closely related aggregate-capacity wall when prototyping a CMS replacement (~25,000 documents across workspaces) in `@alchemy.run/domain`:

- **Workspace-as-Aggregate ([Workspace.aggregate.ts](packages/cms-domain/src/Workspace/Workspace.aggregate.ts)):** Cleanly enforces cross-document invariants atomically (unique `releaseDate` per workspace, strong reference integrity across drafts and published docs, atomic multi-document publish/discard) and gives `SearchCatalog` a single `receipt` for `atLeast` read-your-writes.
  - **The wall:** Even with large editorial bodies externalized as `sha256` hashes, `"meta"` holds coordination metadata for every document in the workspace and is **rewritten whole on every single-field edit** (`DurableObjects.ts` `aggregateObject`).
- **Split `ContentDocument` + `ScheduleSlot` ([Document.aggregate.ts](packages/cms-domain/src/Document/Document.aggregate.ts)):** Keeps `"meta"` flat at `0.3 KiB` and cuts single-edit latency **~10×** on local `workerd` (`11.0 ms` vs `101–135 ms` p50), but loses atomic cross-document strong-reference checks and atomic multi-document publish, and a single `atLeast: receipt` only gates one document's stream.

### Measured Output (`pnpm bench:cms` & `pnpm bench:workerd`)

| Docs in `Workspace` | `meta` size | % of 2 MiB SQLite DO cap | Put bytes/edit | Total Agg keys (uncompacted) | Local `workerd` edit p50 |
|---:|---:|---:|---:|---:|---:|
| 10 | 4.4 KiB | 0.2% | 6.2 KiB | 77 | 134.7 ms |
| 100 | 43.7 KiB | 2.1% | 45.5 KiB | 257 | — |
| 200 | ~87 KiB | ~4.3% | ~89 KiB | ~457 | 101.3 ms |
| 500 | 218.7 KiB | 10.7% | 220.5 KiB | 1,057 | 114.3 ms |
| 750 | 328.1 KiB | 16.0% | 329.9 KiB | 1,557 | — |
| *(Split `ContentDocument`)* | *0.3 KiB* | *< 0.1%* | *1.2 KiB* | *O(edits/doc)* | *11.0 ms* |

At **~448 bytes/doc** of metadata, a single `Workspace` aggregate approaches Cloudflare SQLite DO's **2 MiB per-value limit** around **~4,700 documents** (and rewrites hundreds of KiB–MiB per single-field autosave along the way).

---

## Questions for Discussion

1. **Modeling high-fan-in shared quotas (Ads):** How would you model 185–400 req/s weighted selection + paired quota reservations in `@alchemy.run/domain` without either single-DO serialization (`Market` / hot `Campaign`) or escrow stranding (`AllocationCell`)?
2. **Control plane vs. data plane & ephemeral state (Ads):** Even with pruned aggregate state (`0.6 KiB` `"meta"`), high-frequency commands + per-lease `schedule` policies accumulate unbounded `event:*`, `receipt:*`, `seen:*`, `armed:*`, `scheduled:*`, and `cb:*` keys (~26 puts/opp, ~26 days to 10 GB at 1×). Should `@alchemy.run/domain` strictly own the slow **control plane** while edge-cached permits / batched ingestion / sweep timers sit outside it—or is there an idiomatic/planned way to model ephemeral state, periodic sweeps, and event/receipt compaction inside `@alchemy.run/domain`?
3. **Bounded collections with cross-entity invariants (CMS):** When thousands of documents share cross-document strong-reference and atomic-publish invariants, how would you avoid both O(N) whole-`"meta"` rewrites on a single `Workspace` aggregate and fractured invariants / multi-stream `atLeast` gaps on per-`Document` aggregates?
