# `@alchemy.run/domain` High-Throughput Modeling Reproduction

An abstract reproduction of two workloads that **outgrow single-aggregate / single-Durable-Object capacity** in **`@alchemy.run/domain`** on Cloudflare Durable Objects. It contains the problem only: the domain requirements, the straightforward ways to model them (including with `Domain.Decision`), deterministic workloads, an in-memory oracle that defines "correct", and benchmarks that show where each model breaks. It deliberately contains **no proposed solutions**. The open question is how these workloads *should* be modeled.

Per-entity models (like a task board partitioned per thread/board) map cleanly onto `@alchemy.run/domain`'s one-aggregate-per-DO model. The two cases here are real workloads where **shared capacity constraints or rich cross-entity invariant graphs** pull traffic or state back into a hot aggregate faster, or larger, than a single DO can absorb:

1. **Case 1: Dynamic Ad Network / Quota-Bounded Fulfillment (`packages/quota-domain`)**: weighted selection plus atomic paired quota reservations across active campaigns at **185–400 opportunities/s** bursts (**3.5M → 35M opportunities/month**), with short start leases, delayed/late/duplicate exposure reports, and immutable fixed-price invoices.
2. **Case 2: 25,000-Document Podcast Network CMS (`packages/cms-domain`)**: a multi-type editorial CMS (**25,000 documents across 8 types, 66,900 directed reference edges**) enforcing 8 cross-document invariants (scoped show slugs, per-show episode slugs and schedule dates, strong-ref and delete-in-use integrity, published playable audio-master readiness, multi-hop `clipOnlyMode` rules, and atomic multi-doc publish).

## Version

Everything here runs on **alchemy `main` @ `de0bdeda2`** (Effect `4.1.5`), because `Domain.Decision` (#3420) isn't in a published release yet. `main`'s `@alchemy.run/domain` needs `main`'s `alchemy` and `@alchemy.run/cloudflare`, so `pnpm-workspace.yaml` overrides all eight alchemy packages with tarballs in `vendor/`. `vendor/` isn't committed: `scripts/bootstrap-alchemy.sh` fetches alchemy at that commit from GitHub, builds it, and packs them (or builds from your own checkout with `ALCHEMY_DIR=...`).

*(History: first evaluated on `2.0.0-beta.84`; `2.0.0-beta.87` fixed the `@alchemy.run/domain/internal` packaging issue and added `Domain.Query` + `atLeast`, projection batching, and `schedule`/`unschedule`. Moving to `main` meant porting every model to commands that carry their target id plus `keyOf`, and to the new `send`/`schedule`/`Story.when` signatures. The pre-Decision topologies behave the same on `main` as on `beta.87`.)*

---

## Quick Start

Requires git, Node 24+ (`node:sqlite` + `--experimental-strip-types`) and `pnpm`. No Cloudflare credentials or cloud deployment required.

```sh
scripts/bootstrap-alchemy.sh   # once: build alchemy main @ de0bdeda2 into vendor/ (a few minutes)
pnpm install
pnpm typecheck
pnpm test            # Story tests + Decision model tests + 25k-doc oracle tests + local DO tests
pnpm bench:eval      # Falsifiable scorecard (oracle vs. each modeling attempt) on local workerd
BENCH_ONLY=cms pnpm bench:eval   # CMS models only (skips the slow ad network runs)
BENCH_ONLY=cms BENCH_STORAGE=disk pnpm bench:eval   # same, with local DO storage on disk
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
   - **CMS, 25,000-document corpus (`66,900` directed ref edges):** `350 shows` (`internal` / `partner`), `350 channelWelcomes`, `1,200 hosts`, `1,800 managedLinks`, `3,500 mediaAssets`, `4,500 segments`, `5,000 audioMasters` (timed chapter sections and loudness LUFS), and `8,300 episodes` (multi-show membership, exclusive closers, `clipOnlyMode`). Measures all **8 invariants**, live `workerd` single-field autosave latency, and **exact SQLite DO `"meta"` bytes at 25,000 documents** against Cloudflare's **2 MiB single-value cap**.
2. **In-memory reference oracles** ([mock-baselines.ts](apps/repro-worker/benchmarks/mock-baselines.ts), verified in [benchmarks.test.ts](apps/repro-worker/test/benchmarks.test.ts)):
   - `MockQuotaReference` and `MockCmsReference` (running the full 25,000-doc corpus in memory) execute the same tapes and **pass 100% of acceptance gates**. They define the target behavior; they are not a deployable design.

**About the latency numbers:** local `alchemy dev` runs every Durable Object in one `workerd` process on one machine, and stores each one as a SQLite file that syncs on every commit. Where those files live dominates the latencies, so the benchmark runs with an empty `.alchemy` each time and reports the CMS latencies two ways:

- **Memory** (`BENCH_STORAGE=memory`, the default): `.alchemy` on tmpfs, so a sync costs microseconds. This measures the models and the framework.
- **Disk** (`BENCH_STORAGE=disk`): `.alchemy` on the machine's disk, where a synchronous write took ~6 ms. Each commit pays it, so models that commit more often pay more.

Neither matches Cloudflare, where a commit waits for replication. Compare models within one storage mode. Storage, fill, accuracy and invariant results are exact and the same in both. *(Earlier versions of this README reported disk-backed numbers only, with storage left over from previous runs; the ad network numbers below are still from those runs.)*

---

## How `Domain.Decision` commits (as read from `main`)

`Domain.Decision` lets one command read several aggregate instances and record events on any of them, atomically. Three properties of its two-phase commit ([`TwoPhase.ts`](https://github.com/alchemy-run/alchemy/blob/main/packages/domain/src/TwoPhase.ts), [`Kernel.ts`](https://github.com/alchemy-run/alchemy/blob/main/packages/domain/src/Kernel.ts)) shape every result below:

1. **Every instance a decision reads is a participant, even if it records nothing there.** Each read becomes a write with (possibly) zero events, so the instance is prepared and holds an intent until the outcome is delivered. While it holds one, it takes no other command.
2. **Participants are prepared one after another.** Reads run concurrently, but `finish` prepares the other instances in a sequential loop, then commits the primary, then delivers. Commit latency grows with the number of instances read.
3. **Contention is resolved by abort and retry.** A decision that meets a held or changed instance aborts and retries with jittered backoff from 10 ms to 250 ms, up to 90 times (about 20 s), then dies. Plain commands wait for a held instance for about 13 s.

And one property of `keyOf`: **it sees only the command.** Instances that follow from an aggregate's *current* state (the unique values a document holds, the documents it references, the index it sits in) can't be derived by the decision. The caller has to read them first and name them in the command, and the decision has to check that it was given every instance it needs.

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
| **Topology B** | Per-`Campaign` DOs, try-next fallback ([Campaign.aggregate.ts](packages/quota-domain/src/Campaign/Campaign.aggregate.ts)) | Isolates unrelated sponsors. Without a decision, weighted selection across campaigns isn't atomic: the Worker tries candidates in order. |
| **Topology C** | `Treasury` + 8 sharded `AllocationCell` DOs ([Escrow.aggregate.ts](packages/quota-domain/src/Escrow/Escrow.aggregate.ts)) | Shards decision writes horizontally, but strands quota under routing skew and has no global ledger/invoice. |
| **Topology D** | Per-`Campaign` DOs + `CampaignSelection` decision ([CampaignSelection.decision.ts](packages/quota-domain/src/Campaign/CampaignSelection.decision.ts)) | Restores atomic weighted selection: one decision reads every candidate campaign, picks by weight among those with capacity, and records the reservation on the chosen one. |

### Scorecard (`pnpm bench:eval`, real local `workerd` DOs + SQLite storage probe)

*Disk-backed numbers, from a run before the benchmark cleared or relocated local DO storage. Not rerun since: latencies are probably inflated, storage figures are exact.*

**Acceptance gates:** Burst `p95 <= 100 ms` and `wall <= 4500 ms` | Skewed fill `>= 98%` | Exhaustion exactly `40/40` + `0` duplicate double-counts + finalized `$500` invoice | Storage `<= 600 B/opp` and `<= 4 putKeys/opp`

| Model | Burst Wall | Burst p95 | Skew Fill | Exhaustion (A cred/del/ex, inv) | PutKeys/opp | Stored B/opp (→10GB @3.5M/mo) | Verdict |
|---|---:|---:|---:|---|---:|---:|---|
| **Oracle** *(in-memory)* | 100 ms | 0.0 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 0.00 | 0 B (∞) | **PASS** |
| **Topology A: `Market` (+ Policy)** | 87,628 ms | 86,686.0 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 27.29 | 3,628 B (25d) | **FAIL** |
| **Topology B: Per-`Campaign` DOs** | 14,905 ms | 13,003.1 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 12.10 | 2,199 B (42d) | **FAIL** |
| **Topology C: 8 `AllocationCell` DOs** | 11,811 ms | 9,784.2 ms | **62.5% (90 str.)** | N/A (no global ledger) | 12.43 | 2,424 B (299d) | **FAIL** |
| **Topology D: Per-`Campaign` + `Decision`** | 153,671 ms | 144,541.4 ms | 100.0% (0 str.) | 40/40 (del 40, ex 0, dup 0, inv ok) | 25.16 | 2,292 B (40d) | **FAIL** |

### What This Shows

1. **The model that keeps every invariant correct (Topology A) can't keep up.** It is exact on accuracy, dedupe, and invoicing, but a per-reservation `schedule` policy plus one command per opportunity and per exposure queues the 3 s burst into a **~87 s p95**. It writes **~27 storage keys per opportunity**, which fills a 10 GB DO in **~25 days** at 3.5M opps/mo (~2.5 days at 10×).
2. **Splitting the aggregate trades correctness for throughput, and still isn't fast enough.** Per-campaign DOs (B) give up atomic cross-campaign selection. Sharded cells (C) strand **37.5%** of a tight budget under skew and lose the global ledger. Both remain multi-second at p95, at ~12 puts/opp.
3. **`Domain.Decision` gives back atomic selection (D), at the cost of making every campaign hot.** D is exactly as correct as A, and its stored bytes per opportunity are close to B's. But weighted selection must see every candidate, so every opportunity's decision reads, prepares and holds **all** candidate campaigns. Concurrent opportunities contend on the same set and abort and retry, and the burst p95 is **~145 s**, worse than the single `Market`. Two-phase commit also doubles writes per opportunity (**25 puts/opp** vs 12 for B). The hot spot moved from one aggregate to "every aggregate, all at once".
4. **Framework bookkeeping dominates storage even with pruned user state.** With user `"meta"` held under ~1 KiB, `event:*`, `receipt:*`, `seen:*`, `armed:*`, `scheduled:*`, `cb:*` (and, for decisions, two-phase-commit) keys still grow monotonically per command (see `pnpm bench:quota` for the per-prefix breakdown).

*(A separate test of raw SQLite DOs on real Cloudflare found that synchronous per-opportunity DO admission reached **4,096 ms p95** under peak bursts.)*

---

## Case 2: 25,000-Document Podcast Network CMS (`packages/cms-domain`)

### Requirements: 8 Cross-Document Invariants

A toy 3-type CMS hides where things break at scale, so the corpus models a realistic **25,000-document Podcast Network CMS** (`66,900` directed reference edges across 8 types; large transcripts and rich-text bodies are already externalized as `sha256` digests):

- **Document types:** `show` (`350`), `channelWelcome` (`350`, system-managed per-show welcome audio with permanent `retiredAt` tombstones), `host` (`1,200`), `managedLink` (`1,800`), `mediaAsset` (`3,500`), `segment` (`4,500`), `audioMaster` (`5,000`, timed chapter sections + LUFS loudness), and `episode` (`8,300`, multi-show membership, exclusive closers, `clipOnlyMode`).
- **Invariants:**
  1. Optimistic concurrency (`expectedRevision` → `409 RevisionConflict`)
  2. Scoped `show.slug` uniqueness per `ownershipType` (`internal` vs `partner` → `409 SlugConflict`)
  3. Multi-parent `episode.slug` and `releaseDate` uniqueness within *every* owning `show` (`409`)
  4. Dangling strong-reference rejection across all typed ref arrays (`409 StrongReferenceViolation`)
  5. Delete-in-use protection across drafts and published docs (`409 StrongReferenceViolation`)
  6. Published playable `audioMaster` readiness gate on episode publish (`409 PublishReadinessViolation`)
  7. Multi-hop `clipOnlyMode` rule: requires `show.ownershipType === "partner"` **and** the referenced `audioMaster` having **exactly 1 valid `"highlight"` chapter** inside `durationSeconds` (`409 ClipOnlyRuleViolation`)
  8. Atomic multi-doc publish (`[audioMaster, episode]`)

### Domain review: how editors actually work

The requirements above came from the existing CMS, and every model up to E was built against them. Reviewing them against how editors work changed four, and Topology F is built against the revised set. The older models stay scored against the original requirements, as the database-shaped attempts.

- **Autosave is debounced and live.** It fires after typing pauses, about once a second per active editor, and nobody waits on it: it only has to be durable within a few seconds. F's autosave gate is therefore **p95 ≤ 2 s**, not the 30 ms the older models are held to.
- **Co-editors merge field by field (revises invariant 1).** Two editors changing different fields of one episode both succeed. If an editor changes a field that someone else changed after they last saw it, that field is refused and the editor is shown the other value; the rest of the save still applies. There's no merging inside one field.
- **Publish names the revision that was reviewed (extends invariant 8).** Exactly that revision goes live, or nothing: if the draft has been saved since the review, publish is refused and the publisher re-reviews.
- **Requirement 9, full revision history.** Every autosave is a revision. Any revision can be listed and read back, and restored as a new revision. Autosaves are constant; reading history and restoring are rare.

### Modeling Attempts

| Model | Aggregate boundary | What happens at 25,000 docs |
|---|---|---|
| **Oracle** | In-memory indexed ([mock-baselines.ts](apps/repro-worker/benchmarks/mock-baselines.ts)) | Passes all 8 invariants at full corpus scale. |
| **Monolith `Workspace` DO** | 1 DO holds every `DocumentMeta` in KV `"meta"` ([Workspace.aggregate.ts](packages/cms-domain/src/Workspace/Workspace.aggregate.ts)) | Enforces 8/8 invariants atomically, but `"meta"` reaches **18.21 MiB at 25,000 docs (910% of Cloudflare's 2 MiB value cap)**. |
| **Naive split `ContentDocument` DO** | 1 DO per document, plain commands ([Document.aggregate.ts](packages/cms-domain/src/Document/Document.aggregate.ts)) | Small `"meta"` and fast edits, but can only enforce **1/8** invariants locally. |
| **Topology E: per-document aggregates + `Decision`** | `CmsDocument(docId)`, `UniqueClaim(value)`, `InboundRefs(docId)`, and one decision per command ([Decision/](packages/cms-domain/src/Decision/)) | **8/8 invariants** with **no instance above 0.8 KiB**, but every save is a distributed transaction. |
| **Topology F: the content domain** | `Show`, `ShowHandle`, `Episode`, `AudioMaster`, `LibraryItem`, with decisions only for naming a show, scheduling an episode and publishing ([Content/](packages/cms-domain/src/Content/)) | **8/8 on the revised requirements**, with **3 invariants restated** as content rules; autosaves are field patches, plain single-aggregate commands; full revision history; no instance above 1.6 KiB. |

#### Topology E: the CMS's model, made atomic

E keeps the CMS's own model (documents with typed strong references) and gives every invariant an aggregate keyed by what it protects, the pattern the `alchemy-domain` skill recommends for "a rule about several things at once":

- **Slugs and dates (2, 3):** one `UniqueClaim` per unique value (`show-slug:partner:daily`, `episode-slug:<showId>:<slug>`, `episode-date:<showId>:<date>`), so no index grows with the corpus.
- **References (4, 5):** a save reads the documents it newly references (do they exist?) and records on their `InboundRefs`; a delete is refused while its own `InboundRefs` is non-empty.
- **Publish (6, 7, 8):** one decision reads the whole batch and its dependencies (audio masters, shows) and publishes all or none.
- **Steelmanned:** a save reads only what it *changes* relative to what the caller last saw. A reference the document already holds can't have been deleted since (delete-in-use forbids it), and a claim it already holds is still its own. A single-field autosave of a document without `clipOnlyMode` reads only itself. The benchmark episode has `clipOnlyMode` on, so its autosave reads **3** instances: itself, plus the partner show and the audio master that rule re-checks.
- **The `keyOf` cost:** each command carries an `observed` block (the claims and references the caller last read). The decision refuses with `StaleRead` if it needed an instance the caller didn't name, and the caller re-reads and retries. The [DecisionCms client](packages/cms-domain/src/Decision/DecisionCms.client.ts) does that read-then-send.

Specified in [DecisionCms.test.ts](packages/cms-domain/test/DecisionCms.test.ts).

#### Topology F: the content domain itself

E, like every model before it, treats the podcast network the way a CMS does: as documents that reference each other. F models what the network is about instead, and puts each rule with what owns it:

- **`Show`** owns its schedule: the episode slugs and release dates taken within it.
- **`ShowHandle`** is a show's public slug, unique per ownership type.
- **`Episode`** owns its draft, with a revision per field. An editor's autosave (`SaveEpisodeFields`) carries only the fields that changed and the revision of each that the editor last saw; it's a plain command on one aggregate. Fields a co-editor changed since are skipped and listed in the event, so the history records them too.
- **`AudioMaster`** and **`LibraryItem`** (segments, hosts, links, media, channel welcomes) are content an episode uses.
- **Decisions** run only where a rule genuinely spans aggregates: `ShowNaming` (a show and its handle), `Scheduling` (an episode and the shows it joins or leaves) and `EpisodePublication` (an episode, its audio master, its shows and its library content).

Of the eight invariants, five are kept (two of them revised by the domain review) and three are restated as rules about content rather than about references. Those restatements are a change to the requirements, not only to the model:

| # | Invariant | In Topology F |
|---|---|---|
| 1 | Optimistic concurrency | **Revised:** per field on `Episode` (co-editors merge; a stale field is refused), `expectedRevision` on the other aggregates. |
| 2 | Show slug unique per ownership type | **Kept.** `ShowHandle`, taken and released by `ShowNaming`. |
| 3 | Episode slug and date unique within every owning show | **Kept.** The show's own schedule, updated by `Scheduling` on every show the episode joins or leaves. |
| 4 | No dangling strong references | **Restated:** a draft may reference anything; an episode can't *publish* against content that doesn't exist. |
| 5 | No deleting content in use | **Restated:** content is never hard-deleted. Retiring is always allowed, and an episode can't publish against retired content. Published episodes keep what they published. |
| 6 | Publish needs a published, playable audio master | **Kept.** Checked by `EpisodePublication`. |
| 7 | `clipOnlyMode` needs a partner show and one valid highlight | **Restated (timing):** checked when the episode publishes, not on every edit. |
| 8 | Atomic multi-document publish | **Kept and extended:** the reviewed revision of an episode publishes with its audio master in one step, or not at all if the draft has moved on (`DraftMovedOn`). |

One consequence of the restatements: show and audio master references (a show's hosts, an audio master's segments) aren't checked by any rule, because only episodes publish here. Specified in [Content.test.ts](packages/cms-domain/test/Content.test.ts); probed on `workerd` with the same 8 checks as the other models, with the restated ones checking the restated rule (for example, invariant 5 checks that retiring succeeds and that a later publish against the retired asset is refused; invariant 1 checks that two editors' saves to different fields merge and that a stale field is refused).

#### Revision history (requirement 9)

An aggregate's events already hold every revision, but alchemy clients can only `get` an aggregate's state. So the history is a projection, [`EpisodeHistory`](packages/cms-domain/src/Content/Content.history.ts), that appends each autosave's patch (editor, changed fields, skipped fields) to a `Domain.Stream` keyed by episode. The draft at any revision is those patches folded; restoring saves back the fields that differ, as a new revision, so a restore can be undone.

| | Memory | Disk |
|---|---:|---:|
| Autosaves one second apart (an editor's cadence), p50 / p95 | 8.9 / 10.2 ms | 74.9 / 91.5 ms |
| From autosave until its revision is readable, p50 / p95 | 9.5 / 10.9 ms | 78.7 / 84.9 ms |
| Episode with 1,000 revisions: newest 50 revisions | 4.0 ms | 4.2 ms |
| ...the content at revision 1 / 500 / 1,000 | 5.8 / 5.7 / 9.1 ms | 6.7 / 7.0 / 12.8 ms |
| Restore an old revision | 10.2 ms | 66.5 ms |

What history costs per autosave, measured on the instrumented SQLite platform over 200 autosaves: the episode stores the edit (1,111 B, 2 keys) and now makes **8 storage writes instead of 4**, because any projection on an aggregate stages a delivery and a 10-second backstop alarm with every commit; the projection keeps its own input log (766 B); the stream keeps the revision (435 B). Each revision is stored three times. In memory that costs F's autosave about 2 ms (4.0 → 6.2 ms p50); on disk, where each write syncs, it's most of the 73 ms.


### Scorecard (`pnpm bench:eval`, real local `workerd` DOs + 25,000-doc SQLite DO probes)

**Acceptance gates:** Invariants `8/8` | Autosave `p95 <= 30 ms` (Topology F: `<= 2 s`, from the domain review) | Edited instance `<= 4 KiB` | Largest single instance @ 25,000 docs `<= 1.50 MiB` *(Cloudflare SQLite DO limit: 2.00 MiB)*

| Model | Invariants | Autosave p50 / p95, **memory** | Autosave p50 / p95, disk | Edited instance | Largest instance @25,000 docs | % of 2 MiB cap | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| **Oracle** *(in-memory, 25k docs)* | 8/8 | 0.0 / 0.0 ms | — | 0.6 KiB | 0.6 KiB | 0.0% | **PASS** |
| **Monolith `Workspace` DO** | 8/8 | 11.2 / 14.2 ms | 121.5 / 126.0 ms | 371.5 KiB *(500-doc slice)* | **18.21 MiB** | **910.5%** | **FAIL** *(size)* |
| **Naive split `ContentDocument` DO** | **1/8** | 3.2 / 4.0 ms | 11.7 / 13.1 ms | 0.3 KiB | 0.3 KiB | 0.0% | **FAIL** *(invariants)* |
| **Topology E: Per-Doc + `Decision`** | **8/8** | 24.8 / **59.8 ms** | 1,528.8 / 3,174.8 ms | 0.8 KiB | **0.8 KiB** | **0.0%** | **FAIL** *(latency)* |
| **Topology F: Content domain** | **8/8** *(revised; 3 restated)* | 6.2 / 10.3 ms | 72.7 / 209.5 ms | 0.8 KiB | **1.6 KiB** | **0.1%** | **PASS** *(on the revised requirements)* |

*(Each column comes from one `BENCH_ONLY=cms pnpm bench:eval` run, with empty local storage, so the models in a column share the same machine. F's autosave includes its revision history.)*

On disk, E's autosave was 135 ms p50 in earlier runs and rose to ~1.5 s once F's revised model joined the same worker, even when E ran alone; with memory storage it stays at 25 ms. That points at local storage, not at E, but the mechanism isn't identified.

At 25,000 documents, E has `25,000` `CmsDocument`, `19,350` `UniqueClaim` and `15,623` `InboundRefs` instances; its heaviest is the edited episode's `CmsDocument` at **0.8 KiB**, and its heaviest `InboundRefs` (a `show` with 34 referrers) is 0.6 KiB. F has `350` `Show`, `8,300` `Episode`, `5,000` `AudioMaster` and `11,350` `LibraryItem` instances, plus a `ShowHandle` per show; its heaviest is the busiest show's schedule (33 episodes) at **1.6 KiB**.

**Contention.** K commands at once, 3 rounds per K, p95 (all 246 commands succeeded in every run). Columns (a) share no instances, so they measure local `workerd` under load; columns (b) add what holding the same instances costs: in E, a popular host's `CmsDocument` and `InboundRefs`, which every new episode referencing it records on; in F, the show that every scheduling decision records on.

| K | E (a) autosave: memory / disk | E (b) new episode references the host: memory / disk | F (a) autosave: memory / disk | F (b) schedule an episode into the show: memory / disk |
|---:|---:|---:|---:|---:|
| 1 | 7 / 105 ms | 11 / 169 ms | 16 / 302 ms | 12 / 340 ms |
| 8 | 19 / 425 ms | 82 / 1,700 ms | 29 / 628 ms | 155 / 2,105 ms |
| 32 | 64 / 1,404 ms | 325 / 6,891 ms | 91 / 2,750 ms | 622 / 19,390 ms |

### What This Shows

1. **`Domain.Decision` removes the monolith's state-size wall.** E holds all 8 invariants with every instance under 1 KiB, versus 18.21 MiB in one `"meta"` value. Atomic publish needs no saga.
2. **Applied to the CMS's model, every edit becomes a distributed transaction.** In memory, a decision that reads only its own document takes ~5 ms against ~3 ms as a plain command; E's benchmark autosave (3 instances) takes 25 ms p50 / 60 ms p95, over the 30 ms gate. Prepares run one after another and each is a commit, so on disk, where commits are expensive, E's autosave reaches seconds.
3. **Modeling the content domain moves Decision to where rules really span aggregates.** In F, editing is a plain command (6.2 / 10.3 ms in memory, 73 / 210 ms on disk, with revision history), and decisions run only when a show is named or an episode is scheduled or published. F passes on three restated invariants and the domain review's revised ones, which are product decisions as much as modeling ones.
4. **Most of the original requirements were shaped like a database.** Synchronous strong references, delete-in-use, a single document revision and a 30 ms autosave were the existing system's guarantees, not the editors'. Restated as what editors need (retire instead of delete, check at publish, merge co-editors by field, durable within seconds), the hardest costs disappear rather than getting faster.
5. **Contention follows the rule's owner.** In E, popular *referenced* documents (a host or show) are contended by every save that starts or stops referencing them. In F, a show is contended only by episodes being scheduled into it at the same moment: realistic for a bulk import (622 ms p95 in memory, 19.4 s on disk, at K = 32), rare for editors, and better modeled as one `ImportSchedule` command on the show.
6. **The caller has to know the aggregate's state.** Because `keyOf` sees only the command, E's renames, reference changes and deletes, and F's scheduling and publishing, read before they send and check that read is still current.
7. **Revision history is cheap to read and costs every write.** Reads stay in single-digit milliseconds at 1,000 revisions, but the history is a projection copying events the aggregate already stores, so every autosave doubles its storage writes and each revision is stored three times (question 6).

---

## Questions for Discussion

1. **Read-only participants:** a decision prepares and holds every instance it reads, including ones it only checks (does this referenced document exist? is this campaign eligible?). Is there, or could there be, a way to read an instance with only a version check at commit, without holding it, so that validation-only reads don't serialize unrelated writers?
2. **Participant fan-out:** prepares run sequentially. Is that a correctness requirement (deadlock avoidance through stream order), or could prepares to distinct instances run concurrently?
3. **`keyOf` from state:** is there an idiomatic way to involve instances that depend on an aggregate's current state (its claims, its outgoing references) without the caller naming them and the decision validating them (the `observed` + `StaleRead` pattern here)?
4. **High-throughput shared quota (Ads):** when every request must atomically choose among, and decrement, a small shared set of budgets at hundreds of requests per second, neither one aggregate (A), independent aggregates (B, C), nor a decision over all of them (D) keeps up. What is the recommended boundary?
5. **Domain model vs. CMS model:** Topology F passes by modeling shows, episodes and content directly, and by restating three CMS invariants as content rules (retire instead of delete, check references and `clipOnlyMode` at publish). Is that the shape you'd recommend for `@alchemy.run/domain`, and are those restatements the ones you'd expect a domain model to make?
6. **Reading an aggregate's own history:** an aggregate's event log already holds every revision, but clients can only `get` its state. Revision history therefore needs a projection that copies each edit into a `Domain.Stream`, and any reaction on an aggregate adds a cost to every commit (see [Revision history](#revision-history-requirement-9)). Could an aggregate expose `events` / `list` on its own stream, even as a slow read, for histories that are read rarely?
7. **Framework key retention and compaction:** even with pruned user state, `event:*`, `receipt:*`, `seen:*`, `armed:*`, `scheduled:*`, and `cb:*` keys grow monotonically (~27 puts/opp in Topology A with its policy; ~12 in Topology B without one; ~25 with a decision). Are snapshot compaction, `receipt:*` TTLs, or retention policies planned, so high-volume aggregates don't hit Cloudflare's 10 GB DO limit? And how would compaction interact with full revision history, and with a projection's `version` bump, which replays the whole log?
