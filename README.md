# `@alchemy.run/domain` High-Throughput Modeling Reproduction

An abstract reproduction of two workloads that **outgrow single-aggregate / single-Durable-Object capacity** in **`@alchemy.run/domain`** (`2.0.0-beta.87`, Effect `4.1.5`) on Cloudflare Durable Objects. It contains the problem only: the domain requirements, the straightforward ways we modeled them, deterministic workloads, an in-memory oracle that defines "correct", and benchmarks that show where each model breaks. It deliberately contains **no proposed solutions**. The open question is how these workloads *should* be modeled.

Per-entity models (like a task board partitioned per thread/board) map cleanly onto `@alchemy.run/domain`'s one-aggregate-per-DO model. The two cases here are real workloads where **shared capacity constraints or rich cross-entity invariant graphs** pull traffic or state back into a hot aggregate faster, or larger, than a single DO can absorb:

1. **Case 1: Dynamic Ad Network / Quota-Bounded Fulfillment (`packages/quota-domain`)**: weighted selection plus atomic paired quota reservations across active campaigns at **185–400 opportunities/s** bursts (**3.5M → 35M opportunities/month**), with short start leases, delayed/late/duplicate exposure reports, and immutable fixed-price invoices.
2. **Case 2: 25,000-Document Podcast Network CMS (`packages/cms-domain`)**: a multi-type editorial CMS (**25,000 documents across 9 types, 85,585 directed reference edges**) enforcing 8 cross-document invariants (scoped show slugs, per-show episode slugs and schedule dates, strong-ref and delete-in-use integrity, published playable audio-master readiness, multi-hop `clipOnlyMode` rules, atomic multi-doc publish, and cascading primary-segment tag sync).

*(We first evaluated `@alchemy.run/domain` on `2.0.0-beta.84`. Moving to `2.0.0-beta.87` already fixed the earlier `@alchemy.run/domain/internal` packaging issue and added `Domain.Query` + `atLeast`, projection batching, and `schedule`/`unschedule`. Everything below reflects `2.0.0-beta.87`.)*

---

## Quick Start

Requires Node 24+ (`node:sqlite` + `--experimental-strip-types`) and `pnpm`. No Cloudflare credentials or cloud deployment required.

```sh
pnpm install
pnpm typecheck
pnpm test            # Story tests + 25k-doc oracle tests + local DO tests
pnpm bench:eval      # Falsifiable scorecard (oracle vs. each modeling attempt) on local workerd
pnpm bench:workerd   # Focused real local workerd DO load probe
pnpm bench:quota     # DO key-prefix & storage breakdown (Ads)
pnpm bench:cms       # DO "meta" size scaling from 100 -> 25,000 CMS docs
```

---

## How the Benchmarks Stay Falsifiable

`apps/repro-worker/benchmarks/` defines:

1. **Deterministic seeded synthetic tapes** ([synthetic-tapes.ts](apps/repro-worker/benchmarks/synthetic-tapes.ts), seed `20261120`):
   - **Ad Network, `burst-185rps-3s` (555 opps):** open-loop 185 opps/s across 3 weighted campaigns (`50/30/20`, audience `all`/`free`/`paid`), deterministic qualification, 5% duplicate exposure retries.
   - **Ad Network, `exhaustion-handoff-120`:** fixed-price Sponsor A (`target: 40/40`, `$500` bundle) plus funded replacement Sponsor B (`target: 500/500`), including lease expiries, late exposure reports, ~10% duplicate retries, and immutable invoice finalization.
   - **Ad Network, `skewed-tight-240`:** exact total budget (`240`) under 50% regional skew (50% of traffic hits cells 0–1 on sharded topologies).
   - **Ad Network, storage probe (`250` opps):** runs `@alchemy.run/domain/DurableObjects`'s real `makePlatform` over instrumented per-DO SQLite (`node:sqlite`), counting exact `put` keys, stored bytes, and days to Cloudflare's 10 GB DO cap at 3.5M opps/mo.
   - **CMS, 25,000-document corpus (`85,585` directed ref edges):** `350 shows` (`internal` / `partner`), `350 channelWelcomes`, `1,200 hosts`, `800 taxonomyTags`, `1,800 managedLinks`, `3,500 mediaAssets`, `4,500 segments`, `5,000 audioMasters` (timed chapter sections and loudness LUFS), and `7,500 episodes` (multi-show membership, exclusive closers, `clipOnlyMode`, primary-segment tag sync). Measures all **8 invariants**, live `workerd` single-field autosave latency, and **exact SQLite DO `"meta"` bytes at 25,000 documents** against Cloudflare's **2 MiB single-value cap**.
2. **In-memory reference oracles** ([mock-baselines.ts](apps/repro-worker/benchmarks/mock-baselines.ts), verified in [benchmarks.test.ts](apps/repro-worker/test/benchmarks.test.ts)):
   - `MockQuotaReference` and `MockCmsReference` (running the full 25,000-doc corpus in memory) execute the same tapes and **pass 100% of acceptance gates**. They define the target behavior; they are not a deployable design.

---

## Case 1: Dynamic Ad Network (`packages/quota-domain`)

### Requirements

- Each opportunity picks one eligible campaign by weight and **atomically reserves paired quota** (primary + companion placement) under a short start lease.
- Exposure reports arrive **late, out of order, and duplicated**; each must be counted exactly once, and expired leases must return quota.
- A fixed-price campaign must deliver **exactly** its target (no over-delivery), then hand off to a replacement sponsor, then produce an **immutable invoice**.
- Sustained 185 opps/s with bursts to ~400 opps/s, at 3.5M–35M opportunities/month.

### Modeling Attempts

| Model | Aggregate boundary | Notes |
|---|---|---|
| **Oracle** | In-memory ([mock-baselines.ts](apps/repro-worker/benchmarks/mock-baselines.ts)) | Defines correct behavior; passes all gates. |
| **Topology A** | Single `Market` DO + `ScheduleLeaseExpiry` policy ([Market.aggregate.ts](packages/quota-domain/src/Market/Market.aggregate.ts)) | The natural model: every invariant lives in one aggregate. Steelmanned with pruned `activeReservations` and built-in `receipt:<commandId>` dedupe. |
| **Topology B** | Per-`Campaign` DOs ([Campaign.aggregate.ts](packages/quota-domain/src/Campaign/Campaign.aggregate.ts)) | Isolates unrelated sponsors, but loses atomic multi-campaign weighted selection and still serializes hot campaigns. |
| **Topology C** | `Treasury` + 8 sharded `AllocationCell` DOs ([Escrow.aggregate.ts](packages/quota-domain/src/Escrow/Escrow.aggregate.ts)) | Shards decision writes horizontally, but strands quota under routing skew and has no global ledger/invoice. |

### Scorecard (`pnpm bench:eval`, real local `workerd` DOs + SQLite storage probe)

**Acceptance gates:** Burst `p95 <= 100 ms` and `wall <= 4500 ms` | Skewed fill `>= 98%` | Exhaustion exactly `40/40` + `0` duplicate double-counts + finalized `$500` invoice | Storage `<= 600 B/opp` and `<= 4 putKeys/opp`

| Model | Burst Wall | Burst p95 | Skew Fill | Exhaustion (A cred/del/ex, inv) | PutKeys/opp | Stored B/opp (→10GB @3.5M/mo) | Verdict |
|---|---:|---:|---:|---|---:|---:|---|
| **Oracle** *(in-memory)* | 17 ms | 0.0 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 0.00 | 0 B (∞) | **PASS** |
| **Topology A: `Market` (+ Policy)** | 84,143 ms | 82,068.7 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 26.36 | 3,572 B (26d) | **FAIL** |
| **Topology B: Per-`Campaign` DOs** | 5,016 ms | 2,954.4 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 12.00 | 2,199 B (42d) | **FAIL** |
| **Topology C: 8 `AllocationCell` DOs** | 4,387 ms | 2,550.1 ms | **62.5% (90 str.)** | N/A (no global ledger) | 12.00 | 2,424 B (299d) | **FAIL** |

*Latency varies with machine load: a later run on the same code measured 77 s / 12.2 s / 22.6 s burst p95 for A / B / C. Storage, fill, and accuracy results were identical.*

### What This Shows

1. **The model that keeps every invariant correct (Topology A) can't keep up.** It is exact on accuracy, dedupe, and invoicing, but a per-reservation `schedule` policy plus one command per opportunity and per exposure queues the 3 s burst into an **82 s p95**. It writes **~26 storage keys per opportunity**, which fills a 10 GB DO in **~26 days** at 3.5M opps/mo (~2.6 days at 10×).
2. **Splitting the aggregate trades correctness for throughput, and still isn't fast enough.** Per-campaign DOs (B) give up atomic cross-campaign selection. Sharded cells (C) strand **37.5%** of a tight budget under skew and lose the global ledger. Both remain at **~2.5–3 s p95** and ~12 puts/opp.
3. **Framework bookkeeping dominates storage even with pruned user state.** With user `"meta"` held under ~1 KiB, `event:*`, `receipt:*`, `seen:*`, `armed:*`, `scheduled:*`, and `cb:*` keys still grow monotonically per command (see `pnpm bench:quota` for the per-prefix breakdown).

*(A separate test of raw SQLite DOs on real Cloudflare found that synchronous per-opportunity DO admission reached **4,096 ms p95** under peak bursts.)*

---

## Case 2: 25,000-Document Podcast Network CMS (`packages/cms-domain`)

### Requirements: 8 Cross-Document Invariants

A toy 3-type CMS hides where things break at scale, so the corpus models a realistic **25,000-document Podcast Network CMS** (`85,585` directed reference edges across 9 types; large transcripts and rich-text bodies are already externalized as `sha256` digests):

- **Document types:** `show` (`350`), `channelWelcome` (`350`, system-managed per-show welcome audio with permanent `retiredAt` tombstones), `host` (`1,200`), `taxonomyTag` (`800`), `managedLink` (`1,800`), `mediaAsset` (`3,500`), `segment` (`4,500`), `audioMaster` (`5,000`, timed chapter sections + LUFS loudness), and `episode` (`7,500`, multi-show membership, exclusive closers, `clipOnlyMode`, primary-segment tag sync).
- **Invariants:**
  1. Optimistic concurrency (`expectedRevision` → `409 RevisionConflict`)
  2. Scoped `show.slug` uniqueness per `ownershipType` (`internal` vs `partner` → `409 SlugConflict`)
  3. Multi-parent `episode.slug` and `releaseDate` uniqueness within *every* owning `show` (`409`)
  4. Dangling strong-reference rejection across all typed ref arrays (`409 StrongReferenceViolation`)
  5. Delete-in-use protection across drafts and published docs (`409 StrongReferenceViolation`)
  6. Published playable `audioMaster` readiness gate on episode publish (`409 PublishReadinessViolation`)
  7. Multi-hop `clipOnlyMode` rule: requires `show.ownershipType === "partner"` **and** the referenced `audioMaster` having **exactly 1 valid `"highlight"` chapter** inside `durationSeconds` (`409 ClipOnlyRuleViolation`)
  8. Atomic multi-doc publish (`[audioMaster, episode]`) **and** cascading `segment` taxonomy tag sync to every published episode whose `segmentIds[0] === segmentId`

### Modeling Attempts

| Model | Aggregate boundary | What happens at 25,000 docs |
|---|---|---|
| **Oracle** | In-memory indexed ([mock-baselines.ts](apps/repro-worker/benchmarks/mock-baselines.ts)) | Passes all 8 invariants at full corpus scale. |
| **Monolith `Workspace` DO** | 1 DO holds every `DocumentMeta` in KV `"meta"` ([Workspace.aggregate.ts](packages/cms-domain/src/Workspace/Workspace.aggregate.ts)) | Enforces 8/8 invariants atomically, but `"meta"` reaches **1.82 MiB at just 2,500 docs** and **18.84 MiB at 25,000 docs (942% of Cloudflare's 2 MiB value cap)**. |
| **Naive split `ContentDocument` DO** | 1 DO per document ([Document.aggregate.ts](packages/cms-domain/src/Document/Document.aggregate.ts)) | Flat `0.3 KiB` `"meta"` and ~12 ms edits, but can only enforce **1/8** invariants locally. |

### Scorecard (`pnpm bench:eval`, real local `workerd` DOs + 25,000-doc SQLite DO probes)

**Acceptance gates:** Invariants `8/8` | Edit `p95 <= 30 ms` | Edit `"meta"` `<= 4 KiB` | Max single-DO `"meta"` @ 25,000 docs `<= 1.50 MiB` *(Cloudflare SQLite DO limit: 2.00 MiB)*

| Model | Invariants | Edit p50 | Edit p95 | Edit `meta` | Max DO `meta` @25,000 docs | % of 2 MiB DO cap | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| **Oracle** *(in-memory, 25k docs)* | 8/8 | 0.0 ms | 0.1 ms | 0.6 KiB | 0.6 KiB | 0.0% | **PASS** |
| **Monolith `Workspace` DO** | 8/8 | 121.7 ms | 137.1 ms | 384.4 KiB *(500-doc slice)* | **18.84 MiB** | **942.2%** | **FAIL** |
| **Naive split `ContentDocument` DO** | **1/8** | 11.0 ms | 12.1 ms | 0.3 KiB | 0.3 KiB | 0.0% | **FAIL** |

### What This Shows

The invariants are inherently cross-document: slugs are unique per scope, episodes are unique per *each* owning show, references must resolve, deletes must check inbound refs, and publish/cascade must be atomic across documents. Keeping them in one aggregate means rewriting the whole state blob on every autosave, which overflows the 2 MiB single-value cap roughly 10× over at realistic size and makes each edit ~120 ms. Splitting per document keeps edits fast and small, but leaves 7 of 8 invariants with no aggregate that can enforce them.

---

## Questions for Discussion

1. **Large, invariant-heavy aggregates (CMS):** What is the idiomatic `@alchemy.run/domain` model for a ~25,000-entity workspace whose invariants span many entities (uniqueness indexes, reverse-reference checks, atomic multi-entity publish, cascades)? The aggregate state alone is several MiB even when compacted, well past the 2 MiB single-value limit.
2. **High-throughput shared quota (Ads):** What is the recommended boundary when every request must atomically decrement a shared, weighted budget at hundreds of requests/second? One command per opportunity on one aggregate serializes into multi-second queues, and splitting the aggregate loses either atomic selection or global accounting.
3. **Framework key retention and compaction:** Even with pruned user state, `event:*`, `receipt:*`, `seen:*`, `armed:*`, `scheduled:*`, and `cb:*` keys grow monotonically (~26 puts/opp in Topology A with its policy; ~12 in Topology B without one). Are snapshot compaction, `receipt:*` TTLs, or retention policies planned, so high-volume aggregates don't hit Cloudflare's 10 GB DO limit?
