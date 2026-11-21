# `@alchemy.run/domain` High-Throughput Modeling Reproduction

An abstract reproduction of two workloads that **outgrow single-aggregate / single-Durable-Object capacity** in **`@alchemy.run/domain`** on Cloudflare Durable Objects. It contains the problem only: the domain requirements, the straightforward ways to model them (including with `Domain.Decision`), deterministic workloads, an in-memory oracle that defines "correct", and benchmarks that show where each model breaks. It deliberately contains **no proposed solutions**. The open question is how these workloads *should* be modeled.

Per-entity models (like a task board partitioned per thread/board) map cleanly onto `@alchemy.run/domain`'s one-aggregate-per-DO model. The two cases here are real workloads where **shared capacity constraints or rich cross-entity invariant graphs** pull traffic or state back into a hot aggregate faster, or larger, than a single DO can absorb:

1. **Case 1: Dynamic Ad Network / Quota-Bounded Fulfillment (`packages/quota-domain`)**: weighted selection plus atomic paired quota reservations across active campaigns at **185–400 opportunities/s** bursts (**3.5M → 35M opportunities/month**), with short start leases, delayed/late/duplicate exposure reports, and immutable fixed-price invoices.
2. **Case 2: 25,000-Document Podcast Network CMS (`packages/cms-domain`)**: a multi-type editorial CMS (**25,000 documents across 9 types, 85,585 directed reference edges**) enforcing 8 cross-document invariants (scoped show slugs, per-show episode slugs and schedule dates, strong-ref and delete-in-use integrity, published playable audio-master readiness, multi-hop `clipOnlyMode` rules, atomic multi-doc publish, and cascading primary-segment tag sync).

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

**About the latency numbers:** local `alchemy dev` runs every Durable Object in one `workerd` process on one machine, so absolute latencies, and especially latencies under concurrency, are higher and noisier than on Cloudflare. Compare models within one run. Storage, fill, accuracy and invariant results are exact and repeat run to run.

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
| **Naive split `ContentDocument` DO** | 1 DO per document, plain commands ([Document.aggregate.ts](packages/cms-domain/src/Document/Document.aggregate.ts)) | Small `"meta"` and fast edits, but can only enforce **1/8** invariants locally. |
| **Topology E: per-document aggregates + `Decision`** | `CmsDocument(docId)`, `UniqueClaim(value)`, `InboundRefs(docId)`, `SegmentEpisodes(segmentId)`, and one decision per command ([Decision/](packages/cms-domain/src/Decision/)) | **8/8 invariants** with **no instance above 1.1 KiB**, but every save is a distributed transaction. |
| **Topology F: the content domain** | `Show`, `ShowHandle`, `Episode`, `AudioMaster`, `LibraryItem`, with decisions only for naming a show, scheduling an episode and publishing ([Content/](packages/cms-domain/src/Content/)) | **8/8**, with **4 invariants restated** as content rules; autosaves are plain single-aggregate commands; no instance above 1.5 KiB. |

#### Topology E: the CMS's model, made atomic

E keeps the CMS's own model (documents with typed strong references) and gives every invariant an aggregate keyed by what it protects, the pattern the `alchemy-domain` skill recommends for "a rule about several things at once":

- **Slugs and dates (2, 3):** one `UniqueClaim` per unique value (`show-slug:partner:daily`, `episode-slug:<showId>:<slug>`, `episode-date:<showId>:<date>`), so no index grows with the corpus.
- **References (4, 5):** a save reads the documents it newly references (do they exist?) and records on their `InboundRefs`; a delete is refused while its own `InboundRefs` is non-empty.
- **Publish (6, 7, 8a):** one decision reads the whole batch and its dependencies (audio masters, shows) and publishes all or none.
- **Tag cascade (8b):** the decision reads the segment's `SegmentEpisodes` index and every episode on it, checks the caller named exactly that set, and updates them all.
- **Steelmanned:** a save reads only what it *changes* relative to what the caller last saw. A reference the document already holds can't have been deleted since (delete-in-use forbids it), and a claim it already holds is still its own. A single-field autosave of a document without `clipOnlyMode` reads only itself. The benchmark episode has `clipOnlyMode` on, so its autosave reads **5** instances, including the partner show and the audio master that rule re-checks.
- **The `keyOf` cost:** each command carries an `observed` block (the claims, references and segment index the caller last read). The decision refuses with `StaleRead` if it needed an instance the caller didn't name, and the caller re-reads and retries. The [DecisionCms client](packages/cms-domain/src/Decision/DecisionCms.client.ts) does that read-then-send.

Specified in [DecisionCms.test.ts](packages/cms-domain/test/DecisionCms.test.ts).

#### Topology F: the content domain itself

E, like every model before it, treats the podcast network the way a CMS does: as documents that reference each other. F models what the network is about instead, and puts each rule with what owns it:

- **`Show`** owns its schedule: the episode slugs and release dates taken within it.
- **`ShowHandle`** is a show's public slug, unique per ownership type.
- **`Episode`** owns its draft. An editor's autosave (`EditEpisodeDraft`) is a plain command on one aggregate.
- **`AudioMaster`** and **`LibraryItem`** (segments, hosts, tags, links, media, channel welcomes) are content an episode uses.
- **Decisions** run only where a rule genuinely spans aggregates: `ShowNaming` (a show and its handle), `Scheduling` (an episode and the shows it joins or leaves) and `EpisodePublication` (an episode, its audio master, its shows and its library content).

Four of the eight invariants are kept exactly. The other four are restated as rules about content rather than about references, which is a change to the requirements, not only to the model:

| # | Invariant | In Topology F |
|---|---|---|
| 1 | Optimistic concurrency | **Kept.** `expectedRevision` on every aggregate. |
| 2 | Show slug unique per ownership type | **Kept.** `ShowHandle`, taken and released by `ShowNaming`. |
| 3 | Episode slug and date unique within every owning show | **Kept.** The show's own schedule, updated by `Scheduling` on every show the episode joins or leaves. |
| 4 | No dangling strong references | **Restated:** a draft may reference anything; an episode can't *publish* against content that doesn't exist. |
| 5 | No deleting content in use | **Restated:** content is never hard-deleted. Retiring is always allowed, and an episode can't publish against retired content. Published episodes keep what they published. |
| 6 | Publish needs a published, playable audio master | **Kept.** Checked by `EpisodePublication`. |
| 7 | `clipOnlyMode` needs a partner show and one valid highlight | **Restated (timing):** checked when the episode publishes, not on every edit. |
| 8 | Atomic multi-document publish; tags cascade from a segment | **8a kept:** an episode publishes with its audio master in one step. **8b restated:** an episode's tags come from its primary segment when it's read, so a segment edit is one write instead of a cascade. |

Two consequences of the restatements: show and audio master references (a show's hosts, an audio master's segments) aren't checked by any rule, because only episodes publish here; and an episode's stored `tagIds` are only used when it has no primary segment. Specified in [Content.test.ts](packages/cms-domain/test/Content.test.ts); probed on `workerd` with the same 8 checks as the other models, with the restated ones checking the restated rule (for example, invariant 5 checks that retiring succeeds and that a later publish against the retired asset is refused).

### Scorecard (`pnpm bench:eval`, real local `workerd` DOs + 25,000-doc SQLite DO probes)

**Acceptance gates:** Invariants `8/8` | Edit `p95 <= 30 ms` | Edit `"meta"` `<= 4 KiB` | Max single-DO `"meta"` @ 25,000 docs `<= 1.50 MiB` *(Cloudflare SQLite DO limit: 2.00 MiB)*

| Model | Invariants | Edit p50 | Edit p95 | Edit `meta` | Max DO `meta` @25,000 docs | % of 2 MiB DO cap | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| **Oracle** *(in-memory, 25k docs)* | 8/8 | 0.0 ms | 0.0 ms | 0.6 KiB | 0.6 KiB | 0.0% | **PASS** |
| **Monolith `Workspace` DO** | 8/8 | 142.4 ms | 173.6 ms | 384.4 KiB *(500-doc slice)* | **18.84 MiB** | **942.2%** | **FAIL** |
| **Naive split `ContentDocument` DO** | **1/8** | 10.7 ms | 14.0 ms | 0.3 KiB | 0.3 KiB | 0.0% | **FAIL** |
| **Topology E: Per-Doc + `Decision`** | **8/8** | 215.0 ms | 227.8 ms | 0.9 KiB | **1.1 KiB** | **0.1%** | **FAIL** *(latency)* |
| **Topology F: Content domain** | **8/8** *(4 restated)* | 11.4 ms | 12.0 ms | 0.4 KiB | **1.5 KiB** | **0.1%** | **PASS** *(on restated rules)* |

*(The CMS numbers come from one `BENCH_ONLY=cms pnpm bench:eval` run, so every CMS model shares the same machine load; the ad network numbers come from the preceding full run of the same code.)*

At 25,000 documents, E has `25,000` `CmsDocument`, `17,520` `UniqueClaim`, `16,423` `InboundRefs` and `4,500` `SegmentEpisodes` instances; its heaviest is an `InboundRefs` (a `taxonomyTag` with 69 referrers) at **1.1 KiB**. F has `350` `Show`, `7,500` `Episode`, `5,000` `AudioMaster` and `12,150` `LibraryItem` instances, plus a `ShowHandle` per show; its heaviest is the busiest show's schedule (30 episodes) at **1.5 KiB**.

**Contention, Topology E.** K documents saved at once, all involving the same `host` (3 rounds per K):

| K | (a) Autosave; refs unchanged, host not read: p50 / p95 / max | failed | (b) New episode adds a ref to the host: p50 / p95 / max | failed |
|---:|---:|---:|---:|---:|
| 1 | 91 / 97 / 97 ms | 0/3 | 167 / 169 / 169 ms | 0/3 |
| 8 | 408 / 439 / 439 ms | 0/24 | 941 / 1,645 / 1,779 ms | 0/24 |
| 32 | 1,394 / 1,408 / 1,408 ms | 0/96 | 3,997 / 7,251 / 7,470 ms | 0/96 |

**Contention, Topology F.** K commands at once around the same show (3 rounds per K):

| K | (a) Autosave, a plain command on each episode: p50 / p95 / max | failed | (b) Schedule a new episode into the show: p50 / p95 / max | failed |
|---:|---:|---:|---:|---:|
| 1 | 12 / 61 / 61 ms | 0/3 | 147 / 185 / 185 ms | 0/3 |
| 8 | 64 / 6,466 / 6,466 ms | 0/24 | 1,283 / 1,845 / 1,913 ms | 0/24 |
| 32 | 432 / 467 / 467 ms | 0/96 | 14,773 / 18,631 / 18,931 ms | 0/96 |

Columns (a) share no instances, so they measure local `workerd` under load. F's (a) at K = 8 has a 6.5 s outlier against a 64 ms median, which this run doesn't explain. Columns (b) add what holding the same instances costs: in E, the host's `CmsDocument` and `InboundRefs`; in F, the show itself, which every scheduling decision records on.

### What This Shows

1. **`Domain.Decision` removes the monolith's state-size wall.** E holds all 8 invariants with every instance at about 1 KiB, versus 18.84 MiB in one `"meta"` value. Atomic publish and cascades need no sagas.
2. **Applied to the CMS's model, every edit becomes a distributed transaction.** Even a decision that reads only its own document takes ~90–170 ms locally, against ~11 ms for the same edit as a plain command; E's benchmark autosave (5 instances) takes 215 ms p50 / 228 ms p95. Prepares run one after another, so latency scales with the instances read.
3. **Modeling the content domain moves Decision to where rules really span aggregates.** In F, editing is a plain command (11.4 ms p50 / 12.0 ms p95, under the 30 ms gate), and decisions run only when a show is named, an episode is scheduled or published. F passes every gate, but on four restated invariants, which are a product decision as much as a modeling one.
4. **Contention follows the rule's owner.** In E, popular *referenced* documents (a host, tag or show) are contended by every save that starts or stops referencing them. In F, a show is contended only by episodes being scheduled into it at the same moment: realistic for a bulk import (18.6 s p95 at K = 32), rare for editors.
5. **The caller has to know the aggregate's state.** Because `keyOf` sees only the command, E's renames, reference changes, deletes and cascades, and F's scheduling and publishing, read before they send and check that read is still current.

---

## Questions for Discussion

1. **Read-only participants:** a decision prepares and holds every instance it reads, including ones it only checks (does this referenced document exist? is this campaign eligible?). Is there, or could there be, a way to read an instance with only a version check at commit, without holding it, so that validation-only reads don't serialize unrelated writers?
2. **Participant fan-out:** prepares run sequentially. Is that a correctness requirement (deadlock avoidance through stream order), or could prepares to distinct instances run concurrently?
3. **`keyOf` from state:** is there an idiomatic way to involve instances that depend on an aggregate's current state (its claims, its outgoing references) without the caller naming them and the decision validating them (the `observed` + `StaleRead` pattern here)?
4. **High-throughput shared quota (Ads):** when every request must atomically choose among, and decrement, a small shared set of budgets at hundreds of requests per second, neither one aggregate (A), independent aggregates (B, C), nor a decision over all of them (D) keeps up. What is the recommended boundary?
5. **Domain model vs. CMS model:** Topology F passes by modeling shows, episodes and content directly, and by restating four CMS invariants as content rules (retire instead of delete, check references and `clipOnlyMode` at publish, derive tags when read). Is that the shape you'd recommend for `@alchemy.run/domain`, and are those restatements the ones you'd expect a domain model to make?
6. **Framework key retention and compaction:** even with pruned user state, `event:*`, `receipt:*`, `seen:*`, `armed:*`, `scheduled:*`, and `cb:*` keys grow monotonically (~27 puts/opp in Topology A with its policy; ~12 in Topology B without one; ~25 with a decision). Are snapshot compaction, `receipt:*` TTLs, or retention policies planned, so high-volume aggregates don't hit Cloudflare's 10 GB DO limit?
