import { performance } from "node:perf_hooks";
import {
  Campaign,
  ConfigureCampaign,
  ReserveCampaignSlots,
} from "@repro/quota-domain/Campaign/Campaign.aggregate";
import {
  AllocateInCell,
  AllocationCell,
  PartitionCampaignGrants,
  Treasury,
} from "@repro/quota-domain/Escrow/Escrow.aggregate";
import { Market } from "@repro/quota-domain/Market/Market.aggregate";
import {
  AllocateOpportunity,
  RecordExposure,
  UpsertCampaign,
} from "@repro/quota-domain/Market/Market.commands";
import {
  CampaignQuotaModel,
  EscrowQuotaHandlers,
  EscrowQuotaModel,
  MarketQuotaHandlers,
  MarketQuotaModel,
} from "@repro/quota-domain/Quota.model";
import {
  CampaignId,
  CellId,
  ExposureId,
  MarketId,
  OpportunityId,
  ReservationId,
} from "@repro/quota-domain/Types";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createInstrumentedDoPlatform } from "./instrumented-do-platform.ts";

const T0 = Date.parse("2026-11-20T00:00:00Z");
const T_END = Date.parse("2026-12-20T00:00:00Z");
const formatKB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
};

/**
 * Probe 1: Storage key, byte, and row-write amplification on Topology A (Market
 * aggregate + ScheduleLeaseExpiry policy) over N opportunities.
 */
const runMarketStorageProbe = (opportunities: number) =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform();
    const modelLayer = MarketQuotaModel.layer(MarketQuotaHandlers, { legacyData: false }).pipe(
      Layer.provide(host.layer),
    );

    const result = yield* Effect.gen(function* () {
      const market = yield* Market;
      const mId = MarketId.make("main");
      const cId = CampaignId.make("camp-main");

      yield* market.send(
        mId,
        new UpsertCampaign({
          campaignId: cId,
          name: "Primary Sponsor Campaign",
          weight: 10,
          audience: "all",
          startAt: T0,
          endAt: T_END,
          bundlePriceCents: 100_000,
          creativeVersion: 1,
          requireCompanion: false,
          standalonePrimaryApproved: true,
          standaloneCompanionApproved: true,
          active: true,
          targets: { primary: opportunities * 2, companion: opportunities * 2, secondary: 0 },
        }),
        { commandId: "setup-camp" },
      );
      yield* host.drainBackground;
      host.resetCounters();

      const t0 = performance.now();
      for (let i = 0; i < opportunities; i++) {
        const oppId = OpportunityId.make(`opp-${String(i).padStart(6, "0")}`);
        yield* market.send(
          mId,
          new AllocateOpportunity({ opportunityId: oppId, audience: "free", leaseTtlMs: 120_000 }),
          { commandId: `alloc-${i}` },
        );
        // Simulate ~65% primary qualification and ~89% companion qualification.
        if (i % 100 < 65) {
          yield* market.send(
            mId,
            new RecordExposure({
              exposureId: ExposureId.make(`exp-${i}-p`),
              reservationId: ReservationId.make(`${oppId}:primary`),
            }),
            { commandId: `exp-${i}-p` },
          );
        }
        if (i % 100 < 89) {
          yield* market.send(
            mId,
            new RecordExposure({
              exposureId: ExposureId.make(`exp-${i}-c`),
              reservationId: ReservationId.make(`${oppId}:companion`),
            }),
            { commandId: `exp-${i}-c` },
          );
        }
      }
      const elapsedMs = performance.now() - t0;
      yield* host.drainBackground;

      const all = host.inspectAll();
      const marketMetric = all.find((m) => m.className.includes("MarketAggregate"))!;
      const policyMetric = all.find((m) => m.className.includes("ScheduleLeaseExpiryPolicy"));

      const totalPutKeys = all.reduce((s, m) => s + m.putKeys, 0);
      const totalStoredBytes = all.reduce((s, m) => s + m.totalStoredBytes, 0);
      const bytesPerOpp = marketMetric.totalStoredBytes / opportunities;
      const monthlyOpps1x = 3_500_000;
      const monthlyOpps10x = 35_000_000;
      const doLimitBytes = 10 * 1024 * 1024 * 1024; // 10 GB per DO SQLite limit

      return {
        opportunities,
        elapsedMs,
        marketMetaBytes: marketMetric.metaBytes,
        marketStoredBytes: marketMetric.totalStoredBytes,
        marketStoredKeys: marketMetric.totalStoredKeys,
        marketPrefixes: marketMetric.keysByPrefix,
        policyStoredKeys: policyMetric?.totalStoredKeys ?? 0,
        policyStoredBytes: policyMetric?.totalStoredBytes ?? 0,
        policyPrefixes: policyMetric?.keysByPrefix ?? {},
        putKeysPerOpp: +(totalPutKeys / opportunities).toFixed(1),
        putBytesPerOpp: Math.round(marketMetric.totalPutBytes / opportunities),
        alarmsScheduled: marketMetric.alarmsScheduled,
        bytesPerOpp: Math.round(bytesPerOpp),
        daysTo10GbAt1x: +((doLimitBytes / (bytesPerOpp * (monthlyOpps1x / 30)))).toFixed(1),
        daysTo10GbAt10x: +((doLimitBytes / (bytesPerOpp * (monthlyOpps10x / 30)))).toFixed(2),
        monthlyPutKeys1xM: +(((totalPutKeys / opportunities) * monthlyOpps1x) / 1e6).toFixed(1),
        monthlyPutKeys10xM: +(((totalPutKeys / opportunities) * monthlyOpps10x) / 1e6).toFixed(1),
        totalStoredBytes,
      };
    }).pipe(Effect.provide(modelLayer));

    yield* host.close;
    return result;
  });

/**
 * Probe 2: Concurrent burst latency comparison across Topologies A, B, and C
 * under realistic 5 ms DO storage commit + 5 ms DO RPC hop.
 */
const runBurstComparison = (burstSize: number) =>
  Effect.gen(function* () {
    const commitDelayMs = 5;
    const rpcDelayMs = 5;

    // Topology A: Single Market DO
    const topoA = yield* Effect.gen(function* () {
      const host = createInstrumentedDoPlatform({ commitDelayMs, rpcDelayMs });
      const layer = MarketQuotaModel.layer(MarketQuotaHandlers, { legacyData: false }).pipe(
        Layer.provide(host.layer),
      );
      const res = yield* Effect.gen(function* () {
        const market = yield* Market;
        const mId = MarketId.make("burst");
        yield* market.send(
          mId,
          new UpsertCampaign({
            campaignId: CampaignId.make("c-1"),
            name: "Hot Sponsor",
            weight: 10,
            audience: "all",
            startAt: T0,
            endAt: T_END,
            bundlePriceCents: 100_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: { primary: 10_000, companion: 10_000, secondary: 0 },
          }),
          { commandId: "a-setup" },
        );
        const t0 = performance.now();
        const latencies = yield* Effect.forEach(
          Array.from({ length: burstSize }, (_, i) => i),
          (i) =>
            Effect.gen(function* () {
              const s = performance.now();
              yield* market.send(
                mId,
                new AllocateOpportunity({
                  opportunityId: OpportunityId.make(`a-opp-${i}`),
                  audience: "free",
                  leaseTtlMs: 120_000,
                }),
                { commandId: `a-cmd-${i}` },
              );
              return performance.now() - s;
            }),
          { concurrency: "unbounded" },
        );
        const wallMs = performance.now() - t0;
        const sorted = [...latencies].sort((a, b) => a - b);
        return {
          name: "Topology A: Single Market DO",
          wallMs: +wallMs.toFixed(1),
          p50Ms: +percentile(sorted, 50).toFixed(1),
          p95Ms: +percentile(sorted, 95).toFixed(1),
          maxMs: +percentile(sorted, 100).toFixed(1),
          noFills: 0,
        };
      }).pipe(Effect.provide(layer));
      yield* host.close;
      return res;
    });

    // Topology B: Per-Campaign DO with 2 candidates where candidate 1 runs out mid-burst
    const topoB = yield* Effect.gen(function* () {
      const host = createInstrumentedDoPlatform({ commitDelayMs, rpcDelayMs });
      const layer = CampaignQuotaModel.layer(Layer.empty, { legacyData: false }).pipe(
        Layer.provide(host.layer),
      );
      const res = yield* Effect.gen(function* () {
        const campaigns = yield* Campaign;
        const c1 = CampaignId.make("c-small");
        const c2 = CampaignId.make("c-fallback");
        yield* campaigns.send(
          c1,
          new ConfigureCampaign({
            name: "Small Sponsor",
            weight: 10,
            audience: "all",
            startAt: T0,
            endAt: T_END,
            bundlePriceCents: 10_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: { primary: Math.floor(burstSize / 4), companion: Math.floor(burstSize / 4), secondary: 0 },
          }),
          { commandId: "b-setup-1" },
        );
        yield* campaigns.send(
          c2,
          new ConfigureCampaign({
            name: "Funded Fallback Sponsor",
            weight: 10,
            audience: "all",
            startAt: T0,
            endAt: T_END,
            bundlePriceCents: 100_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: { primary: 10_000, companion: 10_000, secondary: 0 },
          }),
          { commandId: "b-setup-2" },
        );

        let fallbackHops = 0;
        const t0 = performance.now();
        const latencies = yield* Effect.forEach(
          Array.from({ length: burstSize }, (_, i) => i),
          (i) =>
            Effect.gen(function* () {
              const s = performance.now();
              const oppId = OpportunityId.make(`b-opp-${i}`);
              yield* campaigns
                .send(
                  c1,
                  new ReserveCampaignSlots({
                    opportunityId: oppId,
                    audience: "free",
                    leaseTtlMs: 120_000,
                  }),
                  { commandId: `b-c1-${i}` },
                )
                .pipe(
                  Effect.catchTag("InsufficientQuota", () => {
                    fallbackHops += 1;
                    return campaigns.send(
                      c2,
                      new ReserveCampaignSlots({
                        opportunityId: oppId,
                        audience: "free",
                        leaseTtlMs: 120_000,
                      }),
                      { commandId: `b-c2-${i}` },
                    );
                  }),
                );
              return performance.now() - s;
            }),
          { concurrency: "unbounded" },
        );
        const wallMs = performance.now() - t0;
        const sorted = [...latencies].sort((a, b) => a - b);
        return {
          name: `Topology B: Campaign DOs (${fallbackHops} fallback hops)`,
          wallMs: +wallMs.toFixed(1),
          p50Ms: +percentile(sorted, 50).toFixed(1),
          p95Ms: +percentile(sorted, 95).toFixed(1),
          maxMs: +percentile(sorted, 100).toFixed(1),
          noFills: 0,
        };
      }).pipe(Effect.provide(layer));
      yield* host.close;
      return res;
    });

    // Topology C: 8 Sharded AllocationCell DOs
    const topoC = yield* Effect.gen(function* () {
      const host = createInstrumentedDoPlatform({ commitDelayMs, rpcDelayMs });
      const layer = EscrowQuotaModel.layer(EscrowQuotaHandlers, { legacyData: false }).pipe(
        Layer.provide(host.layer),
      );
      const res = yield* Effect.gen(function* () {
        const treasury = yield* Treasury;
        const cells = yield* AllocationCell;
        const cellIds = Array.from({ length: 8 }, (_, idx) => CellId.make(`cell-${idx}`));
        yield* treasury.send(
          CampaignId.make("c-escrow"),
          new PartitionCampaignGrants({
            name: "Sharded Sponsor",
            weight: 10,
            audience: "all",
            startAt: T0,
            endAt: T_END,
            bundlePriceCents: 100_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            cellIds,
            // Exact total quota == burstSize, partitioned evenly across 8 cells.
            targets: { primary: burstSize, companion: burstSize, secondary: 0 },
          }),
          { commandId: "c-setup" },
        );
        yield* host.drainBackground;

        let noFills = 0;
        const t0 = performance.now();
        const latencies = yield* Effect.forEach(
          Array.from({ length: burstSize }, (_, i) => i),
          (i) =>
            Effect.gen(function* () {
              const s = performance.now();
              // Mild traffic skew (50% to cells 0-1, 50% across cells 2-7) shows stranding.
              const cellIdx = i % 2 === 0 ? i % 2 : 2 + (i % 6);
              const cellId = cellIds[cellIdx]!;
              yield* cells
                .send(
                  cellId,
                  new AllocateInCell({
                    opportunityId: OpportunityId.make(`c-opp-${i}`),
                    audience: "free",
                    leaseTtlMs: 120_000,
                  }),
                  { commandId: `c-cmd-${i}` },
                )
                .pipe(
                  Effect.catchTag("NoEligibleCampaign", () =>
                    Effect.sync(() => {
                      noFills += 1;
                    }),
                  ),
                );
              return performance.now() - s;
            }),
          { concurrency: "unbounded" },
        );
        const wallMs = performance.now() - t0;
        const sorted = [...latencies].sort((a, b) => a - b);
        return {
          name: "Topology C: 8 Sharded Escrow Cells (mild skew)",
          wallMs: +wallMs.toFixed(1),
          p50Ms: +percentile(sorted, 50).toFixed(1),
          p95Ms: +percentile(sorted, 95).toFixed(1),
          maxMs: +percentile(sorted, 100).toFixed(1),
          noFills,
        };
      }).pipe(Effect.provide(layer));
      yield* host.close;
      return res;
    });

    return [topoA, topoB, topoC];
  });

const main = Effect.gen(function* () {
  console.log("=== Case 2: Quota / Ad-Delivery Probes (@alchemy.run/domain 2.0.0-beta.87 DurableObjects) ===\n");

  console.log("1) Storage key, byte, and row-write amplification on Market + ScheduleLeaseExpiry:");
  const p = yield* runMarketStorageProbe(250);
  console.log(`   Ran ${p.opportunities} opportunities (paired primary+companion + 65%/89% exposures) in ${p.elapsedMs.toFixed(0)} ms`);
  console.log(`   Market DO \`meta\` size after ${p.opportunities} opps: ${formatKB(p.marketMetaBytes)} (Cloudflare KV value cap is 128 KiB)`);
  console.log(`   Market DO total stored: ${p.marketStoredKeys} keys (${formatKB(p.marketStoredBytes)}, ~${p.bytesPerOpp} B/opp)`);
  console.log(`   Policy DO total stored: ${p.policyStoredKeys} keys (${formatKB(p.policyStoredBytes)})`);
  console.log(`   Total DO storage.put keys/opp (Agg + Policy): ${p.putKeysPerOpp} keys/opp (~${formatKB(p.putBytesPerOpp)}/opp written)`);
  console.log(`   Projected DO storage.put keys/mo: ${p.monthlyPutKeys1xM}M at 3.5M opps/mo (1x), ${p.monthlyPutKeys10xM}M at 35M opps/mo (10x)`);
  console.log(`   Projected days to 10 GB single-DO cap (uncompacted): ~${p.daysTo10GbAt1x} days (1x), ~${p.daysTo10GbAt10x} days (10x)`);
  console.log("\n   Market DO key breakdown:");
  for (const [prefix, stats] of Object.entries(p.marketPrefixes).sort()) {
    console.log(`   - ${prefix.padEnd(14)} ${String(stats.count).padStart(5)} keys  (${formatKB(stats.bytes)})`);
  }
  console.log("\n   ScheduleLeaseExpiry Policy DO key breakdown:");
  for (const [prefix, stats] of Object.entries(p.policyPrefixes).sort()) {
    console.log(`   - ${prefix.padEnd(14)} ${String(stats.count).padStart(5)} keys  (${formatKB(stats.bytes)})`);
  }

  console.log("\n2) 80-request concurrent burst (5 ms DO commit + 5 ms DO RPC):");
  const rows = yield* runBurstComparison(80);
  console.log("| Topology | Wall time | p50 | p95 | max | Stranded no-fills |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${row.wallMs} ms | ${row.p50Ms} ms | ${row.p95Ms} ms | ${row.maxMs} ms | ${row.noFills} |`,
    );
  }
});

Effect.runPromise(main.pipe(Effect.provide(SecureRandom.layerWebCrypto))).catch((err) => {
  console.error(err);
  process.exit(1);
});
