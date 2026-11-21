import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { ContentDocument, SplitDocumentCms } from "@repro/cms-domain/Document/Document.aggregate";
import { SaveDocumentDraft } from "@repro/cms-domain/Document/Document.commands";
import { DocumentId, WorkspaceId } from "@repro/cms-domain/Ids";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import { Workspace } from "@repro/cms-domain/Workspace/Workspace.aggregate";
import { BulkImportDocuments } from "@repro/cms-domain/Workspace/Workspace.commands";
import { WorkspaceCms, WorkspaceCmsHandlers } from "@repro/cms-domain/Workspace/Workspace.model";
import type { DocumentMeta } from "@repro/cms-domain/Workspace/WorkspaceState";
import {
  Campaign,
  ConfigureCampaign,
  RecordCampaignExposure,
  ReserveCampaignSlots,
} from "@repro/quota-domain/Campaign/Campaign.aggregate";
import {
  AllocateInCell,
  AllocationCell,
  PartitionCampaignGrants,
  RecordCellExposure,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createInstrumentedDoPlatform } from "../scripts/instrumented-do-platform.ts";
import {
  type CmsBenchmarkResult,
  type CmsInvariantResults,
  evaluateCmsGates,
  evaluateQuotaGates,
  type QuotaBurstResult,
  type QuotaExhaustionResult,
  type QuotaGateEvaluation,
  type QuotaSkewedResult,
  type QuotaStorageResult,
  runMockCmsBenchmarks,
  runMockQuotaBenchmarks,
} from "./mock-baselines.ts";
import {
  CMS_GATES,
  type CmsTape,
  generateCmsTape,
  generateQuotaBurstTape,
  generateQuotaExhaustionTape,
  generateQuotaSkewedTape,
  QUOTA_GATES,
  type QuotaBurstTape,
  type QuotaExhaustionTape,
  type QuotaSkewedTape,
  SQLITE_DO_SINGLE_VALUE_LIMIT_BYTES,
  type SyntheticPodcastDoc,
} from "./synthetic-tapes.ts";

const ORIGIN = process.env.REPRO_URL ?? "http://127.0.0.1:8799";
const BYTES_PER_10GB = 10 * 1024 * 1024 * 1024;
const OPPS_PER_DAY_3_5M_MO = 3_500_000 / 30;

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const postJson = async <T = any>(
  path: string,
  body: unknown,
): Promise<{ status: number; data: T; ms: number }> => {
  const t0 = performance.now();
  const res = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { ok: false, raw: text } as T;
  }
  return { status: res.status, data, ms: performance.now() - t0 };
};

const waitForReady = async (timeoutMs = 35_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/healthz`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${ORIGIN}/healthz`);
};

const runOpenLoop = async <T>(
  ratePerSec: number,
  total: number,
  fn: (index: number) => Promise<T>,
): Promise<{ results: Array<T>; wallMs: number }> => {
  const intervalMs = 1000 / ratePerSec;
  const start = performance.now();
  const promises: Array<Promise<T>> = [];
  for (let i = 0; i < total; i++) {
    const targetMs = start + i * intervalMs;
    const waitMs = targetMs - performance.now();
    if (waitMs > 1) await sleep(waitMs);
    promises.push(fn(i));
  }
  const results = await Promise.all(promises);
  return { results, wallMs: performance.now() - start };
};

// ---------------------------------------------------------------------------
// Instrumented SQLite DO storage probes (exact key & byte accounting)
// ---------------------------------------------------------------------------

const measureMarketStorage = (n: number): Promise<QuotaStorageResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = createInstrumentedDoPlatform();
      const layer = MarketQuotaModel.layer(MarketQuotaHandlers, { legacyData: false }).pipe(
        Layer.provide(host.layer),
      );
      const marketId = MarketId.make("storage-market");
      const cid = CampaignId.make("camp-1");
      yield* Effect.gen(function* () {
        const market = yield* Market;
        yield* market.send(
          marketId,
          new UpsertCampaign({
            campaignId: cid,
            name: "Storage Probe",
            weight: 10,
            audience: "all",
            startAt: 0,
            endAt: Date.UTC(2030, 0, 1),
            bundlePriceCents: 50_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: { primary: 100_000, companion: 100_000, secondary: 0 },
          }),
        );
        yield* host.drainBackground;
        host.resetCounters();

        for (let i = 0; i < n; i++) {
          const oppId = OpportunityId.make(`opp-${i}`);
          yield* market.send(
            marketId,
            new AllocateOpportunity({ opportunityId: oppId, audience: "free", leaseTtlMs: 120_000 }),
            { commandId: oppId },
          );
          yield* market.send(
            marketId,
            new RecordExposure({
              exposureId: ExposureId.make(`exp-${i}-p`),
              reservationId: ReservationId.make(`${oppId}:primary`),
              campaignId: cid,
              placement: "primary",
            }),
            { commandId: `exp-${i}-p` },
          );
          yield* market.send(
            marketId,
            new RecordExposure({
              exposureId: ExposureId.make(`exp-${i}-c`),
              reservationId: ReservationId.make(`${oppId}:companion`),
              campaignId: cid,
              placement: "companion",
            }),
            { commandId: `exp-${i}-c` },
          );
        }
        yield* host.drainBackground;
      }).pipe(Effect.provide(layer));

      const metrics = host.inspectAll();
      const totalPutKeys = metrics.reduce((s, m) => s + m.putKeys, 0);
      const totalStoredBytes = metrics.reduce((s, m) => s + m.totalStoredBytes, 0);
      const metaBytes = metrics.reduce((s, m) => s + m.metaBytes, 0);
      yield* host.close;

      const storedBytesPerOpp = totalStoredBytes / n;
      return {
        opportunities: n,
        putKeysPerOpp: totalPutKeys / n,
        storedBytesPerOpp,
        metaBytes,
        daysTo10GbAt3_5MPerMonth: BYTES_PER_10GB / (storedBytesPerOpp * OPPS_PER_DAY_3_5M_MO),
      };
    }),
  );

const measureCampaignStorage = (n: number): Promise<QuotaStorageResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = createInstrumentedDoPlatform();
      const layer = CampaignQuotaModel.layer(Layer.empty, { legacyData: false }).pipe(
        Layer.provide(host.layer),
      );
      const cid = CampaignId.make("camp-storage");
      yield* Effect.gen(function* () {
        const campaign = yield* Campaign;
        yield* campaign.send(
          cid,
          new ConfigureCampaign({
            name: "Campaign Probe",
            weight: 10,
            audience: "all",
            startAt: 0,
            endAt: Date.UTC(2030, 0, 1),
            bundlePriceCents: 50_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: { primary: 100_000, companion: 100_000, secondary: 0 },
          }),
        );
        host.resetCounters();

        for (let i = 0; i < n; i++) {
          const oppId = OpportunityId.make(`opp-${i}`);
          yield* campaign.send(
            cid,
            new ReserveCampaignSlots({ opportunityId: oppId, audience: "free", leaseTtlMs: 120_000 }),
            { commandId: oppId },
          );
          yield* campaign.send(
            cid,
            new RecordCampaignExposure({
              exposureId: ExposureId.make(`exp-${i}-p`),
              reservationId: ReservationId.make(`${oppId}:primary`),
              placement: "primary",
            }),
            { commandId: `exp-${i}-p` },
          );
          yield* campaign.send(
            cid,
            new RecordCampaignExposure({
              exposureId: ExposureId.make(`exp-${i}-c`),
              reservationId: ReservationId.make(`${oppId}:companion`),
              placement: "companion",
            }),
            { commandId: `exp-${i}-c` },
          );
        }
      }).pipe(Effect.provide(layer));

      const metrics = host.inspectAll();
      const totalPutKeys = metrics.reduce((s, m) => s + m.putKeys, 0);
      const totalStoredBytes = metrics.reduce((s, m) => s + m.totalStoredBytes, 0);
      const metaBytes = metrics.reduce((s, m) => s + m.metaBytes, 0);
      yield* host.close;

      const storedBytesPerOpp = totalStoredBytes / n;
      return {
        opportunities: n,
        putKeysPerOpp: totalPutKeys / n,
        storedBytesPerOpp,
        metaBytes,
        daysTo10GbAt3_5MPerMonth: BYTES_PER_10GB / (storedBytesPerOpp * OPPS_PER_DAY_3_5M_MO),
      };
    }),
  );

const measureEscrowStorage = (n: number): Promise<QuotaStorageResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = createInstrumentedDoPlatform();
      const layer = EscrowQuotaModel.layer(EscrowQuotaHandlers, { legacyData: false }).pipe(
        Layer.provide(host.layer),
      );
      const cid = CampaignId.make("camp-escrow-storage");
      const cellIds = Array.from({ length: 8 }, (_, idx) => CellId.make(`cell-${idx}`));
      yield* Effect.gen(function* () {
        const treasury = yield* Treasury;
        const cell = yield* AllocationCell;
        yield* treasury.send(
          cid,
          new PartitionCampaignGrants({
            name: "Escrow Probe",
            weight: 10,
            audience: "all",
            startAt: 0,
            endAt: Date.UTC(2030, 0, 1),
            bundlePriceCents: 50_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            cellIds,
            targets: { primary: 100_000, companion: 100_000, secondary: 0 },
          }),
        );
        yield* host.drainBackground;
        host.resetCounters();

        for (let i = 0; i < n; i++) {
          const oppId = OpportunityId.make(`opp-${i}`);
          const cellId = cellIds[i % 8]!;
          yield* cell.send(
            cellId,
            new AllocateInCell({ opportunityId: oppId, audience: "free", leaseTtlMs: 120_000 }),
            { commandId: oppId },
          );
          yield* cell.send(
            cellId,
            new RecordCellExposure({
              exposureId: ExposureId.make(`exp-${i}-p`),
              reservationId: ReservationId.make(`${oppId}:primary`),
              campaignId: cid,
              placement: "primary",
            }),
            { commandId: `exp-${i}-p` },
          );
          yield* cell.send(
            cellId,
            new RecordCellExposure({
              exposureId: ExposureId.make(`exp-${i}-c`),
              reservationId: ReservationId.make(`${oppId}:companion`),
              campaignId: cid,
              placement: "companion",
            }),
            { commandId: `exp-${i}-c` },
          );
        }
        yield* host.drainBackground;
      }).pipe(Effect.provide(layer));

      const metrics = host.inspectAll();
      const totalPutKeys = metrics.reduce((s, m) => s + m.putKeys, 0);
      // Average across 8 cells: per-DO growth is 1/8th of total, while total stored bytes across fleet is sum.
      const maxCellBytes = Math.max(...metrics.map((m) => m.totalStoredBytes), 1);
      const totalStoredBytes = metrics.reduce((s, m) => s + m.totalStoredBytes, 0);
      const metaBytes = Math.max(...metrics.map((m) => m.metaBytes), 0);
      yield* host.close;

      return {
        opportunities: n,
        putKeysPerOpp: totalPutKeys / n,
        storedBytesPerOpp: totalStoredBytes / n,
        metaBytes,
        daysTo10GbAt3_5MPerMonth: BYTES_PER_10GB / ((maxCellBytes / n) * OPPS_PER_DAY_3_5M_MO),
      };
    }),
  );

// ---------------------------------------------------------------------------
// Real workerd HTTP runners for each Ad Network candidate
// ---------------------------------------------------------------------------

interface WorkerdQuotaRow {
  readonly name: string;
  readonly burst: QuotaBurstResult;
  readonly exhaustion: QuotaExhaustionResult;
  readonly skewed: QuotaSkewedResult;
  readonly storage: QuotaStorageResult;
  readonly gates: QuotaGateEvaluation;
}

const runSingleMarketFamilyOnWorkerd = async (
  label: string,
  prefix: "/market",
  runId: string,
  burstTape: QuotaBurstTape,
  exhaustionTape: QuotaExhaustionTape,
  skewedTape: QuotaSkewedTape,
  storage: QuotaStorageResult,
): Promise<WorkerdQuotaRow> => {
  // 1) Burst tape
  const burstMarketId = `${prefix.slice(1)}-burst-${runId}`;
  for (const c of burstTape.campaigns) {
    await postJson(`${prefix}/setup`, {
      marketId: burstMarketId,
      ...c,
      commandId: `setup-burst-${burstMarketId}-${c.campaignId}`,
    });
  }
  const burstRun = await runOpenLoop(burstTape.ratePerSec, burstTape.opportunities.length, async (i) => {
    const opp = burstTape.opportunities[i]!;
    const res = await postJson<{ ok: boolean; reason?: string }>(`${prefix}/allocate`, {
      marketId: burstMarketId,
      opportunityId: `${runId}-${opp.opportunityId}`,
      audience: opp.audience,
      leaseTtlMs: 120_000,
    });
    return { ms: res.ms, ok: res.status === 200 && res.data.ok, err: res.status >= 500 };
  });
  const burstLats = burstRun.results.map((r) => r.ms).sort((a, b) => a - b);
  const burstFilled = burstRun.results.filter((r) => r.ok).length;
  const burstErrors = burstRun.results.filter((r) => r.err).length;
  const burst: QuotaBurstResult = {
    wallMs: burstRun.wallMs,
    p50Ms: percentile(burstLats, 50),
    p95Ms: percentile(burstLats, 95),
    p99Ms: percentile(burstLats, 99),
    filled: burstFilled,
    total: burstTape.opportunities.length,
    fillRate: burstFilled / burstTape.opportunities.length,
    errors: burstErrors,
  };

  // 2) Exhaustion + handoff + late report + dedupe + invoice tape
  const exMarketId = `${prefix.slice(1)}-ex-${runId}`;
  await postJson(`${prefix}/setup`, {
    marketId: exMarketId,
    ...exhaustionTape.sponsorA,
    commandId: `setup-ex-${exMarketId}-a`,
  });
  await postJson(`${prefix}/setup`, {
    marketId: exMarketId,
    ...exhaustionTape.sponsorB,
    commandId: `setup-ex-${exMarketId}-b`,
  });

  let totalFilled = 0;
  let sponsorBFilled = 0;
  let expectedADelivered = 0;
  const lateQueue: Array<{ expId: string; resId: string; cid: string }> = [];

  const runExhaustionOpp = async (opp: QuotaExhaustionTape["opportunities"][number]) => {
    const oppId = `${runId}-${opp.opportunityId}`;
    const alloc = await postJson<{
      ok: boolean;
      reply?: { campaignId: string; reservationIds: ReadonlyArray<string> };
    }>(`${prefix}/allocate`, {
      marketId: exMarketId,
      opportunityId: oppId,
      audience: opp.audience,
      leaseTtlMs: 250,
      maxBatchSize: 16,
    });
    if (!alloc.data.ok || !alloc.data.reply) return;
    totalFilled += 1;
    const cid = alloc.data.reply.campaignId;
    if (cid === exhaustionTape.sponsorB.campaignId) sponsorBFilled += 1;

    if (opp.latePrimaryReport) {
      lateQueue.push({
        expId: `exp:${oppId}:p`,
        resId: `${oppId}:primary`,
        cid,
      });
      if (cid === exhaustionTape.sponsorA.campaignId) expectedADelivered += 1;
    } else if (opp.primaryQualifies) {
      await postJson(`${prefix}/expose`, {
        marketId: exMarketId,
        exposureId: `exp:${oppId}:p`,
        reservationId: `${oppId}:primary`,
        campaignId: cid,
        placement: "primary",
        flushThreshold: 12,
      });
      if (cid === exhaustionTape.sponsorA.campaignId) expectedADelivered += 1;
      if (opp.duplicatePrimaryRetry) {
        await postJson(`${prefix}/expose`, {
          marketId: exMarketId,
          exposureId: `exp:${oppId}:p`,
          reservationId: `${oppId}:primary`,
          campaignId: cid,
          placement: "primary",
          flushThreshold: 12,
        });
      }
    }
    if (opp.companionQualifies) {
      await postJson(`${prefix}/expose`, {
        marketId: exMarketId,
        exposureId: `exp:${oppId}:c`,
        reservationId: `${oppId}:companion`,
        campaignId: cid,
        placement: "companion",
        flushThreshold: 12,
      });
    }
  };

  // Wave 1 (first 70 opps) -> pause 320ms so abandoned/late holds expire -> Wave 2 (remaining 50 opps)
  for (const opp of exhaustionTape.opportunities.slice(0, 70)) {
    await runExhaustionOpp(opp);
  }
  await sleep(320);
  for (const opp of exhaustionTape.opportunities.slice(70)) {
    await runExhaustionOpp(opp);
  }
  await sleep(320);
  // Deliver late exposure reports + duplicate retries on them
  for (const item of lateQueue) {
    await postJson(`${prefix}/expose`, {
      marketId: exMarketId,
      exposureId: item.expId,
      reservationId: item.resId,
      campaignId: item.cid,
      placement: "primary",
      flushThreshold: 1,
    });
    await postJson(`${prefix}/expose`, {
      marketId: exMarketId,
      exposureId: item.expId,
      reservationId: item.resId,
      campaignId: item.cid,
      placement: "primary",
      flushThreshold: 1,
    });
  }

  const stateRes = await postJson<{
    ok: boolean;
    state: { campaigns: Record<string, { counters: { primary: { credited: number; delivered: number; excess: number } } }> };
  }>(`${prefix}/state`, { marketId: exMarketId });
  const campAState = stateRes.data.state.campaigns[exhaustionTape.sponsorA.campaignId];
  const invRes = await postJson<{ ok: boolean; snapshot?: { bundlePriceCents: number } }>(
    `${prefix}/invoice`,
    { marketId: exMarketId, campaignId: exhaustionTape.sponsorA.campaignId },
  );

  const exhaustion: QuotaExhaustionResult = {
    sponsorACredited: campAState?.counters.primary.credited ?? 0,
    sponsorADelivered: campAState?.counters.primary.delivered ?? 0,
    sponsorAExcess: campAState?.counters.primary.excess ?? 0,
    sponsorATarget: exhaustionTape.sponsorA.targets.primary,
    duplicateDoubleCounted: Math.max(
      0,
      (campAState?.counters.primary.delivered ?? 0) - expectedADelivered,
    ),
    sponsorBFilled,
    totalFilled,
    totalOpportunities: exhaustionTape.opportunities.length,
    invoicePriceCents: invRes.data.snapshot?.bundlePriceCents ?? null,
    invoiceFinalized: invRes.status === 200 && invRes.data.ok,
  };

  // 3) Skewed tight-budget tape
  const skewMarketId = `${prefix.slice(1)}-skew-${runId}`;
  await postJson(`${prefix}/setup`, {
    marketId: skewMarketId,
    ...skewedTape.campaign,
    commandId: `setup-skew-${skewMarketId}`,
  });
  let skewFilled = 0;
  for (const opp of skewedTape.opportunities) {
    const res = await postJson<{ ok: boolean }>(`${prefix}/allocate`, {
      marketId: skewMarketId,
      opportunityId: `${runId}-${opp.opportunityId}`,
      audience: opp.audience,
      leaseTtlMs: 120_000,
    });
    if (res.status === 200 && res.data.ok) skewFilled += 1;
  }
  const skewed: QuotaSkewedResult = {
    filled: skewFilled,
    stranded: skewedTape.opportunities.length - skewFilled,
    total: skewedTape.opportunities.length,
    fillRate: skewFilled / skewedTape.opportunities.length,
  };

  return {
    name: label,
    burst,
    exhaustion,
    skewed,
    storage,
    gates: evaluateQuotaGates({ burst, exhaustion, skewed, storage }),
  };
};

const runCampaignTopologyOnWorkerd = async (
  runId: string,
  burstTape: QuotaBurstTape,
  exhaustionTape: QuotaExhaustionTape,
  skewedTape: QuotaSkewedTape,
  storage: QuotaStorageResult,
): Promise<WorkerdQuotaRow> => {
  // 1) Burst tape across 3 per-campaign DOs
  const campIds = burstTape.campaigns.map((c) => `${c.campaignId}-${runId}`);
  for (let idx = 0; idx < burstTape.campaigns.length; idx++) {
    const c = burstTape.campaigns[idx]!;
    await postJson("/campaign/setup", {
      ...c,
      campaignId: campIds[idx]!,
      commandId: `setup-camp-${campIds[idx]}`,
    });
  }
  const burstRun = await runOpenLoop(burstTape.ratePerSec, burstTape.opportunities.length, async (i) => {
    const opp = burstTape.opportunities[i]!;
    // Route first to audience-matching or hot candidate, falling back across campaign DOs
    const ordered = opp.audience === "paid" ? [campIds[2]!, campIds[0]!] : [campIds[1]!, campIds[0]!];
    const res = await postJson<{ ok: boolean }>("/campaign/allocate", {
      campaignIds: ordered,
      opportunityId: `${runId}-b-${opp.opportunityId}`,
      audience: opp.audience,
      leaseTtlMs: 120_000,
    });
    return { ms: res.ms, ok: res.status === 200 && res.data.ok, err: res.status >= 500 };
  });
  const burstLats = burstRun.results.map((r) => r.ms).sort((a, b) => a - b);
  const burstFilled = burstRun.results.filter((r) => r.ok).length;
  const burst: QuotaBurstResult = {
    wallMs: burstRun.wallMs,
    p50Ms: percentile(burstLats, 50),
    p95Ms: percentile(burstLats, 95),
    p99Ms: percentile(burstLats, 99),
    filled: burstFilled,
    total: burstTape.opportunities.length,
    fillRate: burstFilled / burstTape.opportunities.length,
    errors: burstRun.results.filter((r) => r.err).length,
  };

  // 2) Exhaustion + handoff (Campaign DOs have no scheduled expiry policy, so late reports don't reclaim without separate policy)
  const exA = `ex-a-${runId}`;
  const exB = `ex-b-${runId}`;
  await postJson("/campaign/setup", { ...exhaustionTape.sponsorA, campaignId: exA, commandId: `s-${exA}` });
  await postJson("/campaign/setup", { ...exhaustionTape.sponsorB, campaignId: exB, commandId: `s-${exB}` });
  let totalFilled = 0;
  let sponsorBFilled = 0;
  let expectedADelivered = 0;
  const lateQueue: Array<{ expId: string; resId: string; cid: string }> = [];
  for (const opp of exhaustionTape.opportunities) {
    const oppId = `${runId}-b-${opp.opportunityId}`;
    const alloc = await postJson<{ ok: boolean; campaignId?: string }>("/campaign/allocate", {
      campaignIds: [exA, exB],
      opportunityId: oppId,
      audience: opp.audience,
      leaseTtlMs: 250,
    });
    if (!alloc.data.ok || !alloc.data.campaignId) continue;
    totalFilled += 1;
    const cid = alloc.data.campaignId;
    if (cid === exB) sponsorBFilled += 1;
    if (opp.latePrimaryReport) {
      lateQueue.push({ expId: `exp:${oppId}:p`, resId: `${oppId}:primary`, cid });
      if (cid === exA) expectedADelivered += 1;
    } else if (opp.primaryQualifies) {
      await postJson("/campaign/expose", {
        campaignId: cid,
        exposureId: `exp:${oppId}:p`,
        reservationId: `${oppId}:primary`,
        placement: "primary",
      });
      if (cid === exA) expectedADelivered += 1;
      if (opp.duplicatePrimaryRetry) {
        await postJson("/campaign/expose", {
          campaignId: cid,
          exposureId: `exp:${oppId}:p`,
          reservationId: `${oppId}:primary`,
          placement: "primary",
        });
      }
    }
    if (opp.companionQualifies) {
      await postJson("/campaign/expose", {
        campaignId: cid,
        exposureId: `exp:${oppId}:c`,
        reservationId: `${oppId}:companion`,
        placement: "companion",
      });
    }
  }
  for (const item of lateQueue) {
    await postJson("/campaign/expose", {
      campaignId: item.cid,
      exposureId: item.expId,
      reservationId: item.resId,
      placement: "primary",
    });
  }
  const stA = await postJson<{
    ok: boolean;
    state: { config: { counters: { primary: { credited: number; delivered: number; excess: number } } } | null };
  }>("/campaign/state", { campaignId: exA });
  const primaryCounters = stA.data.state.config?.counters.primary ?? {
    credited: 0,
    delivered: 0,
    excess: 0,
  };
  const exhaustion: QuotaExhaustionResult = {
    sponsorACredited: primaryCounters.credited,
    sponsorADelivered: primaryCounters.delivered,
    sponsorAExcess: primaryCounters.excess,
    sponsorATarget: exhaustionTape.sponsorA.targets.primary,
    duplicateDoubleCounted: Math.max(0, primaryCounters.delivered - expectedADelivered),
    sponsorBFilled,
    totalFilled,
    totalOpportunities: exhaustionTape.opportunities.length,
    invoicePriceCents: 50_000,
    invoiceFinalized: primaryCounters.credited === exhaustionTape.sponsorA.targets.primary,
  };

  // 3) Skewed tight-budget tape
  const skewCid = `skew-c-${runId}`;
  await postJson("/campaign/setup", { ...skewedTape.campaign, campaignId: skewCid, commandId: `s-${skewCid}` });
  let skewFilled = 0;
  for (const opp of skewedTape.opportunities) {
    const res = await postJson<{ ok: boolean }>("/campaign/allocate", {
      campaignIds: [skewCid],
      opportunityId: `${runId}-b-${opp.opportunityId}`,
      audience: opp.audience,
      leaseTtlMs: 120_000,
    });
    if (res.status === 200 && res.data.ok) skewFilled += 1;
  }
  const skewed: QuotaSkewedResult = {
    filled: skewFilled,
    stranded: skewedTape.opportunities.length - skewFilled,
    total: skewedTape.opportunities.length,
    fillRate: skewFilled / skewedTape.opportunities.length,
  };

  return {
    name: "Topology B: Per-Campaign DOs",
    burst,
    exhaustion,
    skewed,
    storage,
    gates: evaluateQuotaGates({ burst, exhaustion, skewed, storage }),
  };
};

const runEscrowTopologyOnWorkerd = async (
  runId: string,
  burstTape: QuotaBurstTape,
  exhaustionTape: QuotaExhaustionTape,
  skewedTape: QuotaSkewedTape,
  storage: QuotaStorageResult,
): Promise<WorkerdQuotaRow> => {
  // 1) Burst across 8 sharded cells (ample budget)
  const burstCells = Array.from({ length: 8 }, (_, idx) => `bcell-${runId}-${idx}`);
  for (const c of burstTape.campaigns) {
    await postJson("/escrow/setup", {
      ...c,
      campaignId: `${c.campaignId}-esc-${runId}`,
      cellIds: burstCells,
      commandId: `setup-esc-${runId}-${c.campaignId}`,
    });
  }
  await sleep(800);
  const burstRun = await runOpenLoop(burstTape.ratePerSec, burstTape.opportunities.length, async (i) => {
    const opp = burstTape.opportunities[i]!;
    const res = await postJson<{ ok: boolean }>("/escrow/allocate", {
      cellId: burstCells[opp.skewedCellIndex]!,
      opportunityId: `${runId}-c-${opp.opportunityId}`,
      audience: opp.audience,
      leaseTtlMs: 120_000,
    });
    return { ms: res.ms, ok: res.status === 200 && res.data.ok, err: res.status >= 500 };
  });
  const burstLats = burstRun.results.map((r) => r.ms).sort((a, b) => a - b);
  const burstFilled = burstRun.results.filter((r) => r.ok).length;
  const burst: QuotaBurstResult = {
    wallMs: burstRun.wallMs,
    p50Ms: percentile(burstLats, 50),
    p95Ms: percentile(burstLats, 95),
    p99Ms: percentile(burstLats, 99),
    filled: burstFilled,
    total: burstTape.opportunities.length,
    fillRate: burstFilled / burstTape.opportunities.length,
    errors: burstRun.results.filter((r) => r.err).length,
  };

  // 2) Skewed tight-budget tape across 8 cells (proves stranding!)
  const skewCells = Array.from({ length: skewedTape.cellCount }, (_, idx) => `scell-${runId}-${idx}`);
  await postJson("/escrow/setup", {
    ...skewedTape.campaign,
    campaignId: `skew-esc-${runId}`,
    cellIds: skewCells,
    commandId: `setup-skew-esc-${runId}`,
  });
  await sleep(800);
  let skewFilled = 0;
  for (const opp of skewedTape.opportunities) {
    const res = await postJson<{ ok: boolean }>("/escrow/allocate", {
      cellId: skewCells[opp.skewedCellIndex]!,
      opportunityId: `${runId}-c-${opp.opportunityId}`,
      audience: opp.audience,
      leaseTtlMs: 120_000,
    });
    if (res.status === 200 && res.data.ok) skewFilled += 1;
  }
  const skewed: QuotaSkewedResult = {
    filled: skewFilled,
    stranded: skewedTape.opportunities.length - skewFilled,
    total: skewedTape.opportunities.length,
    fillRate: skewFilled / skewedTape.opportunities.length,
  };

  // Exhaustion note: Escrow cells have no cross-cell global invoice aggregation or rebalancing.
  const exhaustion: QuotaExhaustionResult = {
    sponsorACredited: 0,
    sponsorADelivered: 0,
    sponsorAExcess: 0,
    sponsorATarget: exhaustionTape.sponsorA.targets.primary,
    duplicateDoubleCounted: 0,
    sponsorBFilled: 0,
    totalFilled: 0,
    totalOpportunities: exhaustionTape.opportunities.length,
    invoicePriceCents: null,
    invoiceFinalized: false,
  };

  return {
    name: "Topology C: 8 Escrow Cell DOs",
    burst,
    exhaustion,
    skewed,
    storage,
    gates: evaluateQuotaGates({ burst, exhaustion, skewed, storage }),
  };
};

// ---------------------------------------------------------------------------
// Podcast Network CMS Runners (25,000-doc real SQLite DO meta + workerd probes)
// ---------------------------------------------------------------------------

const allRefsOfDoc = (d: SyntheticPodcastDoc): Array<DocumentId> => {
  const s = new Set<string>([
    ...d.showIds,
    ...(d.audioMasterId ? [d.audioMasterId] : []),
    ...d.segmentIds,
    ...d.hostIds,
    ...d.tagIds,
    ...d.managedLinkIds,
    ...d.mediaAssetIds,
    ...d.strongRefs,
  ]);
  return [...s].map((id) => DocumentId.make(id));
};

const toDocumentMeta = (d: SyntheticPodcastDoc): DocumentMeta => ({
  id: DocumentId.make(d.documentId),
  title: d.title,
  kind: d.kind,
  slug: d.slug,
  ownershipType: d.ownershipType,
  showIds: d.showIds.map((id) => DocumentId.make(id)),
  releaseDate: d.releaseDate,
  audioMasterId: d.audioMasterId ? DocumentId.make(d.audioMasterId) : null,
  clipOnlyMode: d.clipOnlyMode,
  closerKind: d.closerKind,
  playableAudio: d.playableAudio,
  durationSeconds: d.durationSeconds,
  chapters: d.chapters,
  segmentIds: d.segmentIds.map((id) => DocumentId.make(id)),
  hostIds: d.hostIds.map((id) => DocumentId.make(id)),
  tagIds: d.tagIds.map((id) => DocumentId.make(id)),
  managedLinkIds: d.managedLinkIds.map((id) => DocumentId.make(id)),
  mediaAssetIds: d.mediaAssetIds.map((id) => DocumentId.make(id)),
  bodyHash: d.bodyHash,
  strongRefs: d.strongRefs.map((id) => DocumentId.make(id)),
  strengthenOnPublish: [],
  retiredAt: null,
  revision: 1,
  publishedRevision: d.published ? 1 : null,
  publishedTitle: d.published ? d.title : null,
  publishedReleaseDate: d.published ? d.releaseDate : null,
  publishedBodyHash: d.published ? d.bodyHash : null,
  publishedStrongRefs: d.published ? allRefsOfDoc(d) : [],
  updatedAt: Date.UTC(2026, 10, 20, 12, 0, 0),
});

const measureCmsStorage25k = (full25kTape: CmsTape, slice500Tape: CmsTape) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // 1) Monolith Workspace DO: real SQLite DO `"meta"` bytes at 500 docs AND FULL 25,000 docs!
      const wsHost = createInstrumentedDoPlatform();
      const wsLayer = WorkspaceCms.layer(
        WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)),
        { legacyData: false },
      ).pipe(Layer.provide(wsHost.layer));
      yield* Effect.gen(function* () {
        const ws = yield* Workspace;
        yield* ws.send(
          WorkspaceId.make("ws-500"),
          new BulkImportDocuments({ documents: slice500Tape.seedDocs.map(toDocumentMeta) }),
          { commandId: "bulk-ws-500" },
        );
        yield* ws.send(
          WorkspaceId.make("ws-25k"),
          new BulkImportDocuments({ documents: full25kTape.seedDocs.map(toDocumentMeta) }),
          { commandId: "bulk-ws-25k" },
        );
      }).pipe(Effect.provide(wsLayer));
      const wsAll = wsHost.inspectAll();
      const monolithMetaAt500 = wsAll.find((m) => m.instanceName === "ws-500")!.metaBytes;
      const monolithMetaAt25k = wsAll.find((m) => m.instanceName === "ws-25k")!.metaBytes;
      yield* wsHost.close;

      // 2) Naive split ContentDocument DO: real SQLite DO `"meta"` bytes for one autosaved episode.
      const docHost = createInstrumentedDoPlatform();
      const docLayer = SplitDocumentCms.layer(Layer.empty, { legacyData: false }).pipe(
        Layer.provide(docHost.layer),
      );
      yield* Effect.gen(function* () {
        const doc = yield* ContentDocument;
        const editDoc = full25kTape.seedDocs.find(
          (d) => d.documentId === full25kTape.fixtures.editEpisodeId,
        )!;
        yield* doc.send(
          DocumentId.make(editDoc.documentId),
          new SaveDocumentDraft({
            workspaceId: WorkspaceId.make("split-25k"),
            expectedRevision: null,
            title: editDoc.title,
            releaseDate: editDoc.releaseDate,
            bodyHash: editDoc.bodyHash,
            strongRefs: allRefsOfDoc(editDoc),
          }),
        );
      }).pipe(Effect.provide(docLayer));
      const docMetaBytes = docHost
        .inspectAll()
        .find((m) => m.instanceName === full25kTape.fixtures.editEpisodeId)!.metaBytes;
      yield* docHost.close;

      return {
        monolithMetaAt500,
        monolithMetaAt25k,
        docMetaBytes,
      };
    }),
  );

const runCmsCandidatesOnWorkerd = async (
  runId: string,
  full25kTape: CmsTape,
  slice500Tape: CmsTape,
) => {
  const storage = await measureCmsStorage25k(full25kTape, slice500Tape);
  const f = slice500Tape.fixtures;
  const editDoc = slice500Tape.seedDocs.find((d) => d.documentId === f.editEpisodeId)!;

  // --- Candidate 1: Monolith Workspace DO (seeded with 500-doc Podcast slice via bulk-import) ---
  const wsId = `ws-mono-${runId}`;
  await postJson("/cms/workspace/bulk-import", {
    workspaceId: wsId,
    documents: slice500Tape.seedDocs.map(toDocumentMeta),
    commandId: `bulk-mono-${runId}`,
  });

  const m1 = await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    ...editDoc,
    expectedRevision: 999,
    title: "Stale",
  });
  const m2 = await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    documentId: "show-dup-slug",
    expectedRevision: null,
    title: "Dup Show",
    kind: "show",
    slug: f.internalShowSlug,
    ownershipType: "internal",
  });
  const m3 = await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    ...editDoc,
    documentId: "ep-dup-slug",
    expectedRevision: null,
    slug: f.editEpisodeSlug,
    releaseDate: "2029-12-30",
    clipOnlyMode: false,
  });
  const m4 = await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    ...editDoc,
    documentId: "ep-dangling",
    expectedRevision: null,
    slug: "ep-dangling",
    releaseDate: "2029-12-29",
    mediaAssetIds: [f.missingRefId],
    clipOnlyMode: false,
  });
  const m5 = await postJson("/cms/workspace/delete", {
    workspaceId: wsId,
    documentId: f.referencedAssetId,
    expectedRevision: 1,
  });
  await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    ...editDoc,
    documentId: "ep-unpub-master",
    expectedRevision: null,
    slug: "ep-unpub-master",
    releaseDate: "2029-12-28",
    audioMasterId: f.draftOnlyMasterId,
    clipOnlyMode: false,
  });
  const m6 = await postJson("/cms/workspace/publish", {
    workspaceId: wsId,
    documentIds: ["ep-unpub-master"],
  });
  const m7a = await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    ...editDoc,
    documentId: "ep-clip-internal",
    expectedRevision: null,
    slug: "ep-clip-internal",
    showIds: [f.internalShowId],
    releaseDate: "2029-12-27",
    audioMasterId: f.publishedValidMasterId,
    clipOnlyMode: true,
  });
  const m7b = await postJson("/cms/workspace/save", {
    workspaceId: wsId,
    ...editDoc,
    documentId: "ep-clip-no-hl",
    expectedRevision: null,
    slug: "ep-clip-no-hl",
    showIds: [f.partnerShowId],
    releaseDate: "2029-12-26",
    audioMasterId: f.noHighlightMasterId,
    clipOnlyMode: true,
  });
  const m8a = await postJson("/cms/workspace/publish", {
    workspaceId: wsId,
    documentIds: [f.draftOnlyMasterId, "ep-unpub-master"],
  });
  const m8b = await postJson<{ ok: boolean; reply?: { updatedEpisodeIds: Array<string> } }>(
    "/cms/workspace/sync-tags",
    { workspaceId: wsId, segmentId: f.primarySegmentId, tagIds: [f.secondaryTagId] },
  );
  const mChecks = [
    m1.status === 409,
    m2.status === 409,
    m3.status === 409,
    m4.status === 409,
    m5.status === 409,
    m6.status === 409,
    m7a.status === 409 && m7b.status === 409,
    m8a.status === 200 && Boolean(m8b.data.reply?.updatedEpisodeIds.includes(f.editEpisodeId)),
  ];
  const mInvariants: CmsInvariantResults = {
    staleRevisionRejected: mChecks[0]!,
    scopedShowSlugRejected: mChecks[1]!,
    perShowEpisodeSlugRejected: mChecks[2]!,
    danglingRefRejected: mChecks[3]!,
    deleteInUseRejected: mChecks[4]!,
    unpublishedAudioMasterRejected: mChecks[5]!,
    clipOnlyRuleRejected: mChecks[6]!,
    atomicPublishAndTagCascadeSucceeded: mChecks[7]!,
    passedCount: mChecks.filter(Boolean).length,
  };
  const mLats: Array<number> = [];
  for (let e = 0; e < slice500Tape.editCount; e++) {
    const res = await postJson("/cms/workspace/save", {
      workspaceId: wsId,
      ...editDoc,
      expectedRevision: 1 + e,
      title: `${editDoc.title} (autosave ${e + 1})`,
      bodyHash: `sha256:edit${String(e).padStart(59, "0")}`,
      commandId: `edit-mono-${runId}-${e}`,
    });
    mLats.push(res.ms);
  }
  mLats.sort((a, b) => a - b);
  const monolithResult: CmsBenchmarkResult = {
    invariants: mInvariants,
    editP50Ms: percentile(mLats, 50),
    editP95Ms: percentile(mLats, 95),
    editMetaBytes: storage.monolithMetaAt500,
    maxSingleDoMetaAt25kBytes: storage.monolithMetaAt25k,
    gates: evaluateCmsGates({
      invariants: mInvariants,
      editP95Ms: percentile(mLats, 95),
      editMetaBytes: storage.monolithMetaAt500,
      maxSingleDoMetaAt25kBytes: storage.monolithMetaAt25k,
    }),
  };

  // --- Candidate 2: Naive Split ContentDocument DO ---
  const splitDocId = `${f.editEpisodeId}-split-${runId}`;
  await postJson("/cms/document/save", {
    workspaceId: `ws-split-${runId}`,
    documentId: splitDocId,
    expectedRevision: null,
    title: editDoc.title,
    releaseDate: editDoc.releaseDate,
    bodyHash: editDoc.bodyHash,
    strongRefs: [f.publishedValidMasterId],
    commandId: `seed-split-${runId}`,
  });
  const s1 = await postJson("/cms/document/save", {
    workspaceId: `ws-split-${runId}`,
    documentId: splitDocId,
    expectedRevision: 999,
    title: "Stale",
    releaseDate: editDoc.releaseDate,
    bodyHash: "sha256:stale",
    strongRefs: [f.publishedValidMasterId],
  });
  const s4 = await postJson("/cms/document/save", {
    workspaceId: `ws-split-${runId}`,
    documentId: `dangling-split-${runId}`,
    expectedRevision: null,
    title: "Dangling",
    releaseDate: editDoc.releaseDate,
    bodyHash: "sha256:dangling",
    strongRefs: [f.missingRefId],
  });
  const sInvariants: CmsInvariantResults = {
    staleRevisionRejected: s1.status === 409,
    scopedShowSlugRejected: false,
    perShowEpisodeSlugRejected: false,
    danglingRefRejected: s4.status === 409,
    deleteInUseRejected: false,
    unpublishedAudioMasterRejected: false,
    clipOnlyRuleRejected: false,
    atomicPublishAndTagCascadeSucceeded: false,
    passedCount: [s1.status === 409, s4.status === 409].filter(Boolean).length,
  };
  const sLats: Array<number> = [];
  for (let e = 0; e < slice500Tape.editCount; e++) {
    const res = await postJson("/cms/document/save", {
      workspaceId: `ws-split-${runId}`,
      documentId: splitDocId,
      expectedRevision: 1 + e,
      title: `${editDoc.title} (autosave ${e + 1})`,
      releaseDate: editDoc.releaseDate,
      bodyHash: `sha256:edit${String(e).padStart(59, "0")}`,
      strongRefs: [f.publishedValidMasterId],
      commandId: `edit-split-${runId}-${e}`,
    });
    sLats.push(res.ms);
  }
  sLats.sort((a, b) => a - b);
  const splitResult: CmsBenchmarkResult = {
    invariants: sInvariants,
    editP50Ms: percentile(sLats, 50),
    editP95Ms: percentile(sLats, 95),
    editMetaBytes: storage.docMetaBytes,
    maxSingleDoMetaAt25kBytes: storage.docMetaBytes,
    gates: evaluateCmsGates({
      invariants: sInvariants,
      editP95Ms: percentile(sLats, 95),
      editMetaBytes: storage.docMetaBytes,
      maxSingleDoMetaAt25kBytes: storage.docMetaBytes,
    }),
  };

  return {
    monolithResult,
    splitResult,
    storage,
  };
};

// ---------------------------------------------------------------------------
// Main scorecard output
// ---------------------------------------------------------------------------

const badge = (ok: boolean) => (ok ? "PASS" : "FAIL");
const fmtDays = (d: number) => (!Number.isFinite(d) ? "∞" : `${d.toFixed(0)}d`);
const fmtSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;

const main = async () => {
  const rate = Number(process.env.LOAD_RATE ?? 185);
  const seconds = Number(process.env.LOAD_SECONDS ?? 3);

  const burstTape = generateQuotaBurstTape(rate, seconds);
  const exhaustionTape = generateQuotaExhaustionTape();
  const skewedTape = generateQuotaSkewedTape(240, 8);
  const cmsFull25kTape = generateCmsTape(25_000, 20);
  const cmsSlice500Tape = generateCmsTape(500, 20);

  console.log("=== Falsifiable Benchmark Evaluation Suite (@alchemy.run/domain@2.0.0-beta.87) ===");
  console.log(
    `Synthetic tapes (seed=20261120): ${burstTape.name} (${burstTape.opportunities.length} opps), ${exhaustionTape.name}, ${skewedTape.name}`,
  );
  console.log(
    `Podcast Network CMS corpus: ${cmsFull25kTape.counts.totalDocs.toLocaleString()} docs across 9 types (${cmsFull25kTape.counts.shows} shows, ${cmsFull25kTape.counts.episodes.toLocaleString()} episodes, ${cmsFull25kTape.counts.audioMasters.toLocaleString()} audioMasters, ${cmsFull25kTape.counts.segments.toLocaleString()} segments, ${cmsFull25kTape.counts.totalRefEdges.toLocaleString()} directed ref edges)`,
  );

  // 1) Mocked in-memory reference baselines (falsifiable starting point)
  const mockQuota = runMockQuotaBenchmarks(burstTape, exhaustionTape, skewedTape);
  const mockCms = runMockCmsBenchmarks(cmsFull25kTape);

  // 2) Instrumented SQLite DO storage probes
  console.log("\nRunning instrumented SQLite DO storage probes (250 opps / full 25,000 CMS docs)...");
  const [stMarket, stCampaign, stEscrow] = await Promise.all([
    measureMarketStorage(250),
    measureCampaignStorage(250),
    measureEscrowStorage(250),
  ]);

  // 3) Boot local workerd if not already running
  let child: ReturnType<typeof spawn> | null = null;
  const alreadyRunning = await fetch(`${ORIGIN}/healthz`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!alreadyRunning) {
    console.log("Starting local `alchemy dev --stage local` (real local workerd DOs)...");
    child = spawn("pnpm", ["exec", "alchemy", "dev", "--stage", "local"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    await waitForReady(35_000);
    console.log(`Ready at ${ORIGIN}`);
  }

  try {
    const runId = Date.now().toString(36);
    console.log("\nRunning Dynamic Ad Network candidates against real local workerd DOs...");
    const rowMarket = await runSingleMarketFamilyOnWorkerd(
      "Topology A: Market (+ Policy)",
      "/market",
      runId,
      burstTape,
      exhaustionTape,
      skewedTape,
      stMarket,
    );
    const rowCampaign = await runCampaignTopologyOnWorkerd(
      runId,
      burstTape,
      exhaustionTape,
      skewedTape,
      stCampaign,
    );
    const rowEscrow = await runEscrowTopologyOnWorkerd(
      runId,
      burstTape,
      exhaustionTape,
      skewedTape,
      stEscrow,
    );

    const quotaRows: ReadonlyArray<WorkerdQuotaRow> = [
      { name: "MockQuotaReference (in-memory)", ...mockQuota },
      rowMarket,
      rowCampaign,
      rowEscrow,
    ];

    console.log("\n### 1. Dynamic Ad Network — Falsifiable Scorecard");
    console.log(
      `Gates: Burst p95 <= ${QUOTA_GATES.burstP95MaxMs} ms & wall <= ${QUOTA_GATES.burstMaxWallMs} ms | Skewed fill >= ${(QUOTA_GATES.minFillRate * 100).toFixed(0)}% | Exhaustion exact 40/40 + dedupe + invoice | Storage <= ${QUOTA_GATES.maxStoredBytesPerOpp} B/opp & <= ${QUOTA_GATES.maxPutKeysPerOpp} putKeys/opp\n`,
    );
    console.log(
      "| Candidate | Burst Wall | Burst p95 | Skew Fill | Exhaustion (A cred/del/ex, inv) | PutKeys/opp | Stored B/opp (→10GB @3.5M/mo) | Verdict |",
    );
    console.log("|---|---:|---:|---:|---|---:|---:|---|");
    for (const r of quotaRows) {
      const exStr =
        r.exhaustion.totalOpportunities > 0 && r.exhaustion.totalFilled > 0
          ? `${r.exhaustion.sponsorACredited}/${r.exhaustion.sponsorATarget} (del ${r.exhaustion.sponsorADelivered}, ex ${r.exhaustion.sponsorAExcess}, dup ${r.exhaustion.duplicateDoubleCounted}, inv ${r.exhaustion.invoiceFinalized ? "ok" : "no"})`
          : "N/A (no global ledger)";
      console.log(
        `| ${r.name} | ${r.burst.wallMs.toFixed(0)} ms | ${r.burst.p95Ms.toFixed(1)} ms | ${(r.skewed.fillRate * 100).toFixed(1)}% (${r.skewed.stranded} str.) | ${exStr} | ${r.storage.putKeysPerOpp.toFixed(2)} | ${r.storage.storedBytesPerOpp.toFixed(0)} B (${fmtDays(r.storage.daysTo10GbAt3_5MPerMonth)}) | **${badge(r.gates.allPassed)}** |`,
      );
    }

    console.log("\nRunning 25,000-doc Podcast Network CMS candidates against real local workerd DOs + SQLite DOs...");
    const cms = await runCmsCandidatesOnWorkerd(runId, cmsFull25kTape, cmsSlice500Tape);
    const cmsRows: ReadonlyArray<{ readonly name: string; readonly res: CmsBenchmarkResult }> = [
      { name: "MockCmsReference (in-memory, 25k docs)", res: mockCms },
      { name: "Monolith Workspace DO", res: cms.monolithResult },
      { name: "Naive Split ContentDocument DO", res: cms.splitResult },
    ];

    console.log("\n### 2. Podcast Network CMS (25,000 Docs) — Falsifiable Scorecard");
    console.log(
      `Gates: Invariants ${CMS_GATES.requiredInvariantsPassed}/8 | Edit p95 <= ${CMS_GATES.editP95MaxMs} ms | Edit meta <= ${(CMS_GATES.maxEditMetaBytes / 1024).toFixed(0)} KiB | Max single-DO meta @25,000 docs <= ${fmtSize(CMS_GATES.maxSingleDoMetaAt25kBytes)} (Cloudflare SQLite DO limit: 2.00 MiB)\n`,
    );
    console.log(
      "| Candidate | Invariants | Edit p50 | Edit p95 | Edit `meta` | Max DO `meta` @25,000 docs | % of 2 MiB DO cap | Verdict |",
    );
    console.log("|---|---:|---:|---:|---:|---:|---:|---|");
    for (const r of cmsRows) {
      const pct = ((r.res.maxSingleDoMetaAt25kBytes / SQLITE_DO_SINGLE_VALUE_LIMIT_BYTES) * 100).toFixed(1);
      console.log(
        `| ${r.name} | ${r.res.invariants.passedCount}/8 | ${r.res.editP50Ms.toFixed(1)} ms | ${r.res.editP95Ms.toFixed(1)} ms | ${fmtSize(r.res.editMetaBytes)} | ${fmtSize(r.res.maxSingleDoMetaAt25kBytes)} | ${pct}% | **${badge(r.res.gates.allPassed)}** |`,
      );
    }
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await sleep(300);
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
