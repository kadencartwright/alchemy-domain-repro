import { performance } from "node:perf_hooks";
import { Market } from "@repro/quota-domain/Market/Market.aggregate";
import {
  AllocateOpportunity,
  ExpireLease,
  RecordExposure,
  UpsertCampaign,
} from "@repro/quota-domain/Market/Market.commands";
import { MarketQuotaHandlers, MarketQuotaModel } from "@repro/quota-domain/Quota.model";
import {
  CampaignId,
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

/**
 * Storage & write-amplification inspector over `@alchemy.run/domain/DurableObjects`'s
 * real `makePlatform` (`2.0.0-beta.87`).
 *
 * Uses the steelmanned `Market` aggregate:
 * - Completed and expired reservations are pruned immediately from `activeReservations`.
 * - Exposure dedupe uses `@alchemy.run/domain`'s built-in `receipt:<commandId>`.
 * - After all active leases clear, `"meta"` shrinks back to ~0.5 KiB — isolating
 *   the irreducible framework-managed key growth (`event:*`, `receipt:*`, Policy
 *   `seen:*`, and `schedule` `armed:*`/`scheduled:*`/`cb:*`).
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
      const unqualified: Array<ReservationId> = [];

      for (let i = 0; i < opportunities; i++) {
        const oppId = OpportunityId.make(`opp-${String(i).padStart(6, "0")}`);
        yield* market.send(
          mId,
          new AllocateOpportunity({ opportunityId: oppId, audience: "free", leaseTtlMs: 120_000 }),
          { commandId: `alloc-${i}` },
        );

        const rPrimary = ReservationId.make(`${oppId}:primary`);
        const rCompanion = ReservationId.make(`${oppId}:companion`);

        // ~65% primary qualification, ~89% companion qualification; unqualified holds expire.
        if (i % 100 < 65) {
          const expId = ExposureId.make(`exp-${i}-p`);
          yield* market.send(
            mId,
            new RecordExposure({
              exposureId: expId,
              reservationId: rPrimary,
              campaignId: cId,
              placement: "primary",
            }),
            { commandId: expId },
          );
        } else {
          unqualified.push(rPrimary);
        }

        if (i % 100 < 89) {
          const expId = ExposureId.make(`exp-${i}-c`);
          yield* market.send(
            mId,
            new RecordExposure({
              exposureId: expId,
              reservationId: rCompanion,
              campaignId: cId,
              placement: "companion",
            }),
            { commandId: expId },
          );
        } else {
          unqualified.push(rCompanion);
        }
      }

      yield* host.drainBackground;
      const inFlightMetaBytes = host
        .inspectAll()
        .find((m) => m.className.includes("MarketAggregate"))!.metaBytes;

      // Expire the remaining unqualified holds so `activeReservations` is completely empty.
      for (const resId of unqualified) {
        yield* market.send(mId, new ExpireLease({ reservationId: resId }), {
          commandId: `expire-run:${resId}`,
        });
      }
      const elapsedMs = performance.now() - t0;
      yield* host.drainBackground;

      const all = host.inspectAll();
      const marketMetric = all.find((m) => m.className.includes("MarketAggregate"))!;
      const policyMetric = all.find((m) => m.className.includes("ScheduleLeaseExpiryPolicy"));

      const totalPutKeys = all.reduce((s, m) => s + m.putKeys, 0);
      const bytesPerOpp = marketMetric.totalStoredBytes / opportunities;
      const monthlyOpps1x = 3_500_000;
      const monthlyOpps10x = 35_000_000;
      const doLimitBytes = 10 * 1024 * 1024 * 1024; // 10 GB per DO SQLite limit

      return {
        opportunities,
        elapsedMs,
        inFlightMetaBytes,
        quiescentMetaBytes: marketMetric.metaBytes,
        marketStoredBytes: marketMetric.totalStoredBytes,
        marketStoredKeys: marketMetric.totalStoredKeys,
        marketPrefixes: marketMetric.keysByPrefix,
        policyStoredKeys: policyMetric?.totalStoredKeys ?? 0,
        policyStoredBytes: policyMetric?.totalStoredBytes ?? 0,
        policyPrefixes: policyMetric?.keysByPrefix ?? {},
        putKeysPerOpp: +(totalPutKeys / opportunities).toFixed(1),
        putBytesPerOpp: Math.round(marketMetric.totalPutBytes / opportunities),
        bytesPerOpp: Math.round(bytesPerOpp),
        daysTo10GbAt1x: +((doLimitBytes / (bytesPerOpp * (monthlyOpps1x / 30)))).toFixed(1),
        daysTo10GbAt10x: +((doLimitBytes / (bytesPerOpp * (monthlyOpps10x / 30)))).toFixed(2),
        monthlyPutKeys1xM: +(((totalPutKeys / opportunities) * monthlyOpps1x) / 1e6).toFixed(1),
        monthlyPutKeys10xM: +(((totalPutKeys / opportunities) * monthlyOpps10x) / 1e6).toFixed(1),
      };
    }).pipe(Effect.provide(modelLayer));

    yield* host.close;
    return result;
  });

const main = Effect.gen(function* () {
  console.log(
    "=== Case 1 (Storage Inspector): Steelmanned Market + ScheduleLeaseExpiry (@alchemy.run/domain 2.0.0-beta.87) ===\n",
  );
  const p = yield* runMarketStorageProbe(250);
  console.log(
    `Ran ${p.opportunities} paired opportunities (65% primary / 89% companion qualified, remainder expired) in ${p.elapsedMs.toFixed(0)} ms`,
  );
  console.log(
    `Market DO \`meta\` size: ${formatKB(p.inFlightMetaBytes)} during active holds → ${formatKB(p.quiescentMetaBytes)} after leases expire (state is pruned)`,
  );
  console.log(
    `Market DO total retained storage: ${p.marketStoredKeys} keys (${formatKB(p.marketStoredBytes)}, ~${p.bytesPerOpp} B/opp)`,
  );
  console.log(
    `Policy DO total retained storage: ${p.policyStoredKeys} keys (${formatKB(p.policyStoredBytes)})`,
  );
  console.log(
    `Total DO storage.put keys/opp (Agg + Policy): ${p.putKeysPerOpp} keys/opp (~${formatKB(p.putBytesPerOpp)}/opp written)`,
  );
  console.log(
    `Projected DO storage.put keys/mo: ${p.monthlyPutKeys1xM}M at 3.5M opps/mo (1x), ${p.monthlyPutKeys10xM}M at 35M opps/mo (10x)`,
  );
  console.log(
    `Projected days to 10 GB single-DO cap (uncompacted): ~${p.daysTo10GbAt1x} days (1x), ~${p.daysTo10GbAt10x} days (10x)`,
  );
  console.log("\nMarket DO retained key breakdown:");
  for (const [prefix, stats] of Object.entries(p.marketPrefixes).sort()) {
    console.log(
      `  - ${prefix.padEnd(14)} ${String(stats.count).padStart(5)} keys  (${formatKB(stats.bytes)})`,
    );
  }
  console.log("\nScheduleLeaseExpiry Policy DO retained key breakdown:");
  for (const [prefix, stats] of Object.entries(p.policyPrefixes).sort()) {
    console.log(
      `  - ${prefix.padEnd(14)} ${String(stats.count).padStart(5)} keys  (${formatKB(stats.bytes)})`,
    );
  }
});

Effect.runPromise(main.pipe(Effect.provide(SecureRandom.layerWebCrypto))).catch((err) => {
  console.error(err);
  process.exit(1);
});
