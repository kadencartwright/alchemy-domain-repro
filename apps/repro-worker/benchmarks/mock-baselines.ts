import { performance } from "node:perf_hooks";
import { hasValidHighlightChapter } from "@repro/cms-domain/Ids";
import {
  applyExposureToCounters,
  CampaignId,
  type CampaignRecord,
  canServePaired,
  emptyCounters,
  type InvoiceSnapshot,
  pickWeightedCampaign,
} from "@repro/quota-domain/Types";
import {
  CMS_GATES,
  type CmsTape,
  QUOTA_GATES,
  type QuotaBurstTape,
  type QuotaExhaustionTape,
  type QuotaSkewedTape,
  type SyntheticCampaignSpec,
  type SyntheticPodcastDoc,
} from "./synthetic-tapes.ts";

// ---------------------------------------------------------------------------
// 1. Mocked Reference Baseline — Dynamic Ad Network
// ---------------------------------------------------------------------------

export interface QuotaBurstResult {
  readonly wallMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly filled: number;
  readonly total: number;
  readonly fillRate: number;
  readonly errors: number;
}

export interface QuotaExhaustionResult {
  readonly sponsorACredited: number;
  readonly sponsorADelivered: number;
  readonly sponsorAExcess: number;
  readonly sponsorATarget: number;
  readonly duplicateDoubleCounted: number;
  readonly sponsorBFilled: number;
  readonly totalFilled: number;
  readonly totalOpportunities: number;
  readonly invoicePriceCents: number | null;
  readonly invoiceFinalized: boolean;
}

export interface QuotaSkewedResult {
  readonly filled: number;
  readonly stranded: number;
  readonly total: number;
  readonly fillRate: number;
}

export interface QuotaStorageResult {
  readonly opportunities: number;
  readonly putKeysPerOpp: number;
  readonly storedBytesPerOpp: number;
  readonly metaBytes: number;
  readonly daysTo10GbAt3_5MPerMonth: number;
}

export interface QuotaGateEvaluation {
  readonly burstLatencyPass: boolean;
  readonly burstFillPass: boolean;
  readonly exhaustionAccuracyPass: boolean;
  readonly skewedFillPass: boolean;
  readonly storagePass: boolean;
  readonly allPassed: boolean;
}

export const evaluateQuotaGates = (args: {
  readonly burst: QuotaBurstResult;
  readonly exhaustion: QuotaExhaustionResult;
  readonly skewed: QuotaSkewedResult;
  readonly storage: QuotaStorageResult;
}): QuotaGateEvaluation => {
  const burstLatencyPass =
    args.burst.p95Ms <= QUOTA_GATES.burstP95MaxMs &&
    args.burst.wallMs <= QUOTA_GATES.burstMaxWallMs &&
    args.burst.errors === 0;
  const burstFillPass = args.burst.fillRate >= QUOTA_GATES.minFillRate;
  const exhaustionAccuracyPass =
    args.exhaustion.sponsorACredited === args.exhaustion.sponsorATarget &&
    args.exhaustion.sponsorAExcess <=
      Math.ceil(args.exhaustion.sponsorATarget * QUOTA_GATES.maxExcessRatio) &&
    args.exhaustion.duplicateDoubleCounted === 0 &&
    args.exhaustion.totalFilled === args.exhaustion.totalOpportunities &&
    args.exhaustion.invoiceFinalized &&
    args.exhaustion.invoicePriceCents === 50_000;
  const skewedFillPass = args.skewed.fillRate >= QUOTA_GATES.minFillRate;
  const storagePass =
    args.storage.storedBytesPerOpp <= QUOTA_GATES.maxStoredBytesPerOpp &&
    args.storage.putKeysPerOpp <= QUOTA_GATES.maxPutKeysPerOpp;
  return {
    burstLatencyPass,
    burstFillPass,
    exhaustionAccuracyPass,
    skewedFillPass,
    storagePass,
    allPassed:
      burstLatencyPass &&
      burstFillPass &&
      exhaustionAccuracyPass &&
      skewedFillPass &&
      storagePass,
  };
};

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
};

export class MockQuotaReference {
  private readonly campaigns = new Map<string, CampaignRecord>();
  private readonly activeReservations = new Map<
    string,
    { campaignId: string; placement: "primary" | "companion"; expiresAt: number }
  >();
  private readonly seenExposures = new Set<string>();
  private readonly invoices = new Map<string, InvoiceSnapshot>();

  upsertCampaign(spec: SyntheticCampaignSpec): void {
    this.campaigns.set(spec.campaignId, {
      id: CampaignId.make(spec.campaignId),
      name: spec.name,
      weight: spec.weight,
      audience: spec.audience,
      startAt: 0,
      endAt: Date.UTC(2030, 0, 1),
      bundlePriceCents: spec.bundlePriceCents,
      creativeVersion: 1,
      requireCompanion: spec.requireCompanion,
      standalonePrimaryApproved: false,
      standaloneCompanionApproved: false,
      active: true,
      counters: {
        primary: emptyCounters(spec.targets.primary),
        companion: emptyCounters(spec.targets.companion),
        secondary: emptyCounters(spec.targets.secondary),
      },
    });
  }

  private sweepExpired(now: number): void {
    for (const [resId, res] of this.activeReservations) {
      if (res.expiresAt <= now) {
        this.activeReservations.delete(resId);
        const camp = this.campaigns.get(res.campaignId);
        if (camp) {
          const c = camp.counters[res.placement];
          this.campaigns.set(res.campaignId, {
            ...camp,
            counters: {
              ...camp.counters,
              [res.placement]: { ...c, reserved: Math.max(0, c.reserved - 1) },
            },
          });
        }
      }
    }
  }

  allocate(
    opportunityId: string,
    audience: "free" | "paid",
    leaseTtlMs: number,
    now: number,
  ): { campaignId: string; reservationIds: ReadonlyArray<string> } | null {
    this.sweepExpired(now);
    const eligible: Array<{ campaign: CampaignRecord; placements: ReadonlyArray<"primary" | "companion"> }> =
      [];
    for (const camp of this.campaigns.values()) {
      const placements = canServePaired(camp, audience, now).filter(
        (p): p is "primary" | "companion" => p === "primary" || p === "companion",
      );
      if (placements.length > 0) eligible.push({ campaign: camp, placements });
    }
    const picked = pickWeightedCampaign(
      eligible.map((e) => e.campaign),
      opportunityId,
    );
    if (!picked) return null;
    const chosen = eligible.find((e) => e.campaign.id === picked.id)!;
    const nextCounters = { ...picked.counters };
    const reservationIds: Array<string> = [];
    for (const placement of chosen.placements) {
      nextCounters[placement] = {
        ...nextCounters[placement],
        reserved: nextCounters[placement].reserved + 1,
      };
      const rid = `${opportunityId}:${placement}`;
      this.activeReservations.set(rid, {
        campaignId: picked.id,
        placement,
        expiresAt: now + leaseTtlMs,
      });
      reservationIds.push(rid);
    }
    this.campaigns.set(picked.id, { ...picked, counters: nextCounters });
    return { campaignId: picked.id, reservationIds };
  }

  recordExposure(
    exposureId: string,
    reservationId: string,
    campaignId: string,
    placement: "primary" | "companion",
    now: number,
  ): { duplicate: boolean; late: boolean } {
    if (this.seenExposures.has(exposureId)) return { duplicate: true, late: false };
    this.seenExposures.add(exposureId);
    this.sweepExpired(now);
    const wasActive = this.activeReservations.delete(reservationId);
    const camp = this.campaigns.get(campaignId);
    if (camp) {
      this.campaigns.set(campaignId, {
        ...camp,
        counters: {
          ...camp.counters,
          [placement]: applyExposureToCounters(camp.counters[placement], wasActive),
        },
      });
    }
    return { duplicate: false, late: !wasActive };
  }

  finalizeInvoice(campaignId: string, now: number): InvoiceSnapshot | null {
    const existing = this.invoices.get(campaignId);
    if (existing) return existing;
    const camp = this.campaigns.get(campaignId);
    if (!camp) return null;
    if (
      camp.counters.primary.credited < camp.counters.primary.target ||
      camp.counters.companion.credited < camp.counters.companion.target
    ) {
      return null;
    }
    const snap: InvoiceSnapshot = {
      campaignId: camp.id,
      bundlePriceCents: camp.bundlePriceCents,
      finalizedAt: now,
      totals: camp.counters,
    };
    this.invoices.set(campaignId, snap);
    return snap;
  }

  getCampaign(campaignId: string): CampaignRecord | undefined {
    return this.campaigns.get(campaignId);
  }
}

export const runMockQuotaBenchmarks = (
  burstTape: QuotaBurstTape,
  exhaustionTape: QuotaExhaustionTape,
  skewedTape: QuotaSkewedTape,
): {
  readonly burst: QuotaBurstResult;
  readonly exhaustion: QuotaExhaustionResult;
  readonly skewed: QuotaSkewedResult;
  readonly storage: QuotaStorageResult;
  readonly gates: QuotaGateEvaluation;
} => {
  const burstRef = new MockQuotaReference();
  for (const c of burstTape.campaigns) burstRef.upsertCampaign(c);
  const t0 = performance.now();
  const lats: Array<number> = [];
  let filled = 0;
  const baseNow = Date.UTC(2026, 10, 20, 12, 0, 0);
  for (const opp of burstTape.opportunities) {
    const s = performance.now();
    const res = burstRef.allocate(opp.opportunityId, opp.audience, 120_000, baseNow + opp.index * 5);
    lats.push(performance.now() - s);
    if (res) {
      filled += 1;
      if (opp.primaryQualifies) {
        burstRef.recordExposure(
          `exp:${opp.opportunityId}:p`,
          `${opp.opportunityId}:primary`,
          res.campaignId,
          "primary",
          baseNow + opp.index * 5 + 100,
        );
        if (opp.duplicatePrimaryRetry) {
          burstRef.recordExposure(
            `exp:${opp.opportunityId}:p`,
            `${opp.opportunityId}:primary`,
            res.campaignId,
            "primary",
            baseNow + opp.index * 5 + 150,
          );
        }
      }
      if (opp.companionQualifies) {
        burstRef.recordExposure(
          `exp:${opp.opportunityId}:c`,
          `${opp.opportunityId}:companion`,
          res.campaignId,
          "companion",
          baseNow + opp.index * 5 + 100,
        );
      }
    }
  }
  const wallMs = performance.now() - t0;
  lats.sort((a, b) => a - b);
  const burst: QuotaBurstResult = {
    wallMs,
    p50Ms: percentile(lats, 50),
    p95Ms: percentile(lats, 95),
    p99Ms: percentile(lats, 99),
    filled,
    total: burstTape.opportunities.length,
    fillRate: filled / burstTape.opportunities.length,
    errors: 0,
  };

  const exRef = new MockQuotaReference();
  exRef.upsertCampaign(exhaustionTape.sponsorA);
  exRef.upsertCampaign(exhaustionTape.sponsorB);
  let totalFilled = 0;
  let sponsorBFilled = 0;
  let expectedADelivered = 0;
  const lateQueue: Array<{ expId: string; resId: string; cid: string }> = [];

  for (const opp of exhaustionTape.opportunities) {
    const now = baseNow + opp.index * 20;
    const res = exRef.allocate(opp.opportunityId, opp.audience, 300, now);
    if (!res) continue;
    totalFilled += 1;
    if (res.campaignId === exhaustionTape.sponsorB.campaignId) sponsorBFilled += 1;
    if (opp.latePrimaryReport) {
      lateQueue.push({
        expId: `exp:${opp.opportunityId}:p`,
        resId: `${opp.opportunityId}:primary`,
        cid: res.campaignId,
      });
      if (res.campaignId === exhaustionTape.sponsorA.campaignId) expectedADelivered += 1;
    } else if (opp.primaryQualifies) {
      exRef.recordExposure(
        `exp:${opp.opportunityId}:p`,
        `${opp.opportunityId}:primary`,
        res.campaignId,
        "primary",
        now + 10,
      );
      if (res.campaignId === exhaustionTape.sponsorA.campaignId) expectedADelivered += 1;
      if (opp.duplicatePrimaryRetry) {
        exRef.recordExposure(
          `exp:${opp.opportunityId}:p`,
          `${opp.opportunityId}:primary`,
          res.campaignId,
          "primary",
          now + 15,
        );
      }
    }
    if (opp.companionQualifies) {
      exRef.recordExposure(
        `exp:${opp.opportunityId}:c`,
        `${opp.opportunityId}:companion`,
        res.campaignId,
        "companion",
        now + 10,
      );
    }
  }
  const lateNow = baseNow + 10_000;
  for (const item of lateQueue) {
    exRef.recordExposure(item.expId, item.resId, item.cid, "primary", lateNow);
    exRef.recordExposure(item.expId, item.resId, item.cid, "primary", lateNow + 5);
  }
  const campA = exRef.getCampaign(exhaustionTape.sponsorA.campaignId)!;
  const inv = exRef.finalizeInvoice(exhaustionTape.sponsorA.campaignId, lateNow + 10);
  const exhaustion: QuotaExhaustionResult = {
    sponsorACredited: campA.counters.primary.credited,
    sponsorADelivered: campA.counters.primary.delivered,
    sponsorAExcess: campA.counters.primary.excess,
    sponsorATarget: exhaustionTape.sponsorA.targets.primary,
    duplicateDoubleCounted: Math.max(0, campA.counters.primary.delivered - expectedADelivered),
    sponsorBFilled,
    totalFilled,
    totalOpportunities: exhaustionTape.opportunities.length,
    invoicePriceCents: inv?.bundlePriceCents ?? null,
    invoiceFinalized: inv !== null,
  };

  const skewRef = new MockQuotaReference();
  skewRef.upsertCampaign(skewedTape.campaign);
  let skewFilled = 0;
  for (const opp of skewedTape.opportunities) {
    const res = skewRef.allocate(opp.opportunityId, opp.audience, 120_000, baseNow + opp.index * 5);
    if (res) skewFilled += 1;
  }
  const skewed: QuotaSkewedResult = {
    filled: skewFilled,
    stranded: skewedTape.opportunities.length - skewFilled,
    total: skewedTape.opportunities.length,
    fillRate: skewFilled / skewedTape.opportunities.length,
  };

  const metaBytes = Buffer.byteLength(JSON.stringify([...burstRef["campaigns"].values()]), "utf8");
  const storage: QuotaStorageResult = {
    opportunities: 250,
    putKeysPerOpp: 0,
    storedBytesPerOpp: 0,
    metaBytes,
    daysTo10GbAt3_5MPerMonth: Number.POSITIVE_INFINITY,
  };

  return {
    burst,
    exhaustion,
    skewed,
    storage,
    gates: evaluateQuotaGates({ burst, exhaustion, skewed, storage }),
  };
};

// ---------------------------------------------------------------------------
// 2. Mocked Reference Baseline — 25,000-Document Podcast Network CMS
// ---------------------------------------------------------------------------

export interface CmsInvariantResults {
  readonly staleRevisionRejected: boolean;
  readonly scopedShowSlugRejected: boolean;
  readonly perShowEpisodeSlugRejected: boolean;
  readonly danglingRefRejected: boolean;
  readonly deleteInUseRejected: boolean;
  readonly unpublishedAudioMasterRejected: boolean;
  readonly clipOnlyRuleRejected: boolean;
  readonly atomicPublishSucceeded: boolean;
  readonly passedCount: number;
}

export interface CmsBenchmarkResult {
  readonly invariants: CmsInvariantResults;
  readonly editP50Ms: number;
  readonly editP95Ms: number;
  readonly editMetaBytes: number;
  readonly maxSingleDoMetaAt25kBytes: number;
  readonly gates: {
    readonly invariantsPass: boolean;
    readonly editLatencyPass: boolean;
    readonly editMetaPass: boolean;
    readonly scale25kCapPass: boolean;
    readonly allPassed: boolean;
  };
}

export const evaluateCmsGates = (args: {
  readonly invariants: CmsInvariantResults;
  readonly editP95Ms: number;
  readonly editMetaBytes: number;
  readonly maxSingleDoMetaAt25kBytes: number;
  /** Overrides the autosave gate (Topology F uses the domain review's). */
  readonly editP95MaxMs?: number;
}) => {
  const invariantsPass = args.invariants.passedCount === CMS_GATES.requiredInvariantsPassed;
  const editLatencyPass = args.editP95Ms <= (args.editP95MaxMs ?? CMS_GATES.editP95MaxMs);
  const editMetaPass = args.editMetaBytes <= CMS_GATES.maxEditMetaBytes;
  const scale25kCapPass = args.maxSingleDoMetaAt25kBytes <= CMS_GATES.maxSingleDoMetaAt25kBytes;
  return {
    invariantsPass,
    editLatencyPass,
    editMetaPass,
    scale25kCapPass,
    allPassed: invariantsPass && editLatencyPass && editMetaPass && scale25kCapPass,
  };
};

interface MockPodcastRecord extends SyntheticPodcastDoc {
  revision: number;
}

const allRefsOfSynthetic = (doc: SyntheticPodcastDoc): Array<string> => {
  const set = new Set<string>();
  for (const id of doc.showIds) set.add(id);
  if (doc.audioMasterId) set.add(doc.audioMasterId);
  for (const id of doc.segmentIds) set.add(id);
  for (const id of doc.hostIds) set.add(id);
  for (const id of doc.managedLinkIds) set.add(id);
  for (const id of doc.mediaAssetIds) set.add(id);
  for (const id of doc.strongRefs) set.add(id);
  return [...set];
};

/**
 * In-memory indexed reference implementation for the 25,000-document Podcast
 * Network CMS. Proves all 8 invariants + O(1) edits + 25k-doc corpus scale
 * are achievable (falsifiable starting point).
 */
export class MockCmsReference {
  private readonly docs = new Map<string, MockPodcastRecord>();
  private readonly showSlugIndex = new Map<string, string>();
  private readonly episodeSlugIndex = new Map<string, string>();
  private readonly showDateIndex = new Map<string, string>();
  private readonly reverseRefs = new Map<string, Set<string>>();

  private indexDoc(doc: MockPodcastRecord): void {
    if (doc.kind === "show" && doc.slug && doc.ownershipType) {
      this.showSlugIndex.set(`${doc.ownershipType}:${doc.slug}`, doc.documentId);
    }
    if (doc.kind === "episode") {
      for (const sh of doc.showIds) {
        if (doc.slug) this.episodeSlugIndex.set(`${sh}:${doc.slug}`, doc.documentId);
        if (doc.releaseDate) this.showDateIndex.set(`${sh}:${doc.releaseDate}`, doc.documentId);
      }
    }
    for (const target of allRefsOfSynthetic(doc)) {
      let set = this.reverseRefs.get(target);
      if (!set) {
        set = new Set();
        this.reverseRefs.set(target, set);
      }
      set.add(doc.documentId);
    }
  }

  private unindexDoc(doc: MockPodcastRecord): void {
    if (doc.kind === "show" && doc.slug && doc.ownershipType) {
      const k = `${doc.ownershipType}:${doc.slug}`;
      if (this.showSlugIndex.get(k) === doc.documentId) this.showSlugIndex.delete(k);
    }
    if (doc.kind === "episode") {
      for (const sh of doc.showIds) {
        if (doc.slug && this.episodeSlugIndex.get(`${sh}:${doc.slug}`) === doc.documentId) {
          this.episodeSlugIndex.delete(`${sh}:${doc.slug}`);
        }
        if (doc.releaseDate && this.showDateIndex.get(`${sh}:${doc.releaseDate}`) === doc.documentId) {
          this.showDateIndex.delete(`${sh}:${doc.releaseDate}`);
        }
      }
    }
    for (const target of allRefsOfSynthetic(doc)) {
      this.reverseRefs.get(target)?.delete(doc.documentId);
    }
  }

  seedCorpus(docs: ReadonlyArray<SyntheticPodcastDoc>): void {
    for (const d of docs) {
      const rec: MockPodcastRecord = { ...d, revision: 1 };
      this.docs.set(d.documentId, rec);
      this.indexDoc(rec);
    }
  }

  saveDraft(
    doc: SyntheticPodcastDoc,
    expectedRevision: number | null,
  ): { ok: true; revision: number } | { ok: false; code: string } {
    const existing = this.docs.get(doc.documentId);
    const actualRev = existing?.revision ?? null;
    if (actualRev !== expectedRevision) return { ok: false, code: "RevisionConflict" };

    if (doc.kind === "show" && doc.slug && doc.ownershipType) {
      const owner = this.showSlugIndex.get(`${doc.ownershipType}:${doc.slug}`);
      if (owner && owner !== doc.documentId) return { ok: false, code: "SlugConflict" };
    }
    if (doc.kind === "episode") {
      for (const sh of doc.showIds) {
        if (doc.slug) {
          const owner = this.episodeSlugIndex.get(`${sh}:${doc.slug}`);
          if (owner && owner !== doc.documentId) return { ok: false, code: "SlugConflict" };
        }
        if (doc.releaseDate) {
          const owner = this.showDateIndex.get(`${sh}:${doc.releaseDate}`);
          if (owner && owner !== doc.documentId) return { ok: false, code: "ScheduleDateConflict" };
        }
      }
    }
    for (const ref of allRefsOfSynthetic(doc)) {
      if (!this.docs.has(ref)) return { ok: false, code: "StrongReferenceViolation" };
    }
    if (doc.kind === "episode" && doc.clipOnlyMode) {
      const show = doc.showIds[0] ? this.docs.get(doc.showIds[0]) : undefined;
      const master = doc.audioMasterId ? this.docs.get(doc.audioMasterId) : undefined;
      if (!show || !master) return { ok: false, code: "ClipOnlyRuleViolation" };
      if (show.ownershipType !== "partner") return { ok: false, code: "ClipOnlyRuleViolation" };
      if (!hasValidHighlightChapter(master.durationSeconds, master.chapters)) {
        return { ok: false, code: "ClipOnlyRuleViolation" };
      }
    }

    if (existing) this.unindexDoc(existing);
    const nextRev = (actualRev ?? 0) + 1;
    const rec: MockPodcastRecord = { ...doc, revision: nextRev };
    this.docs.set(doc.documentId, rec);
    this.indexDoc(rec);
    return { ok: true, revision: nextRev };
  }

  deleteDoc(documentId: string): { ok: true } | { ok: false; code: string } {
    const existing = this.docs.get(documentId);
    if (!existing) return { ok: false, code: "DocumentNotFound" };
    const refs = this.reverseRefs.get(documentId);
    if (refs && refs.size > 0) return { ok: false, code: "StrongReferenceViolation" };
    this.unindexDoc(existing);
    this.docs.delete(documentId);
    return { ok: true };
  }

  publishBatch(documentIds: ReadonlyArray<string>): { ok: true } | { ok: false; code: string } {
    const batch = new Set(documentIds);
    for (const id of documentIds) {
      const doc = this.docs.get(id);
      if (!doc) return { ok: false, code: "DocumentNotFound" };
      if (doc.kind === "episode" && doc.audioMasterId) {
        const master = this.docs.get(doc.audioMasterId);
        if (!master) return { ok: false, code: "StrongReferenceViolation" };
        if (!master.published && !batch.has(doc.audioMasterId)) {
          return { ok: false, code: "PublishReadinessViolation" };
        }
        if (!master.playableAudio) return { ok: false, code: "PublishReadinessViolation" };
      }
    }
    for (const id of documentIds) {
      const doc = this.docs.get(id)!;
      this.docs.set(id, { ...doc, published: true });
    }
    return { ok: true };
  }

  getDoc(documentId: string): MockPodcastRecord | undefined {
    return this.docs.get(documentId);
  }
}

export const runMockCmsBenchmarks = (tape: CmsTape): CmsBenchmarkResult => {
  const cms = new MockCmsReference();
  cms.seedCorpus(tape.seedDocs);
  const f = tape.fixtures;
  const editDoc = cms.getDoc(f.editEpisodeId)!;

  // 1. Stale revision
  const r1 = cms.saveDraft({ ...editDoc, title: "Stale" }, 999);
  // 2. Scoped show slug conflict
  const r2 = cms.saveDraft(
    {
      ...editDoc,
      documentId: "show-dup-slug",
      kind: "show",
      slug: f.internalShowSlug,
      ownershipType: "internal",
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      segmentIds: [],
      hostIds: [],
      managedLinkIds: [],
      mediaAssetIds: [],
      strongRefs: [],
    },
    null,
  );
  // 3. Per-show episode slug conflict
  const r3 = cms.saveDraft(
    {
      ...editDoc,
      documentId: "ep-dup-slug",
      slug: f.editEpisodeSlug,
      releaseDate: "2029-12-30",
      clipOnlyMode: false,
    },
    null,
  );
  // 4. Dangling strong reference
  const r4 = cms.saveDraft(
    {
      ...editDoc,
      documentId: "ep-dangling",
      slug: "ep-dangling",
      releaseDate: "2029-12-29",
      mediaAssetIds: [f.missingRefId],
      clipOnlyMode: false,
    },
    null,
  );
  // 5. Delete in use
  const r5 = cms.deleteDoc(f.referencedAssetId);
  // 6. Unpublished audio master on publish
  const epWithDraftMaster = cms.saveDraft(
    {
      ...editDoc,
      documentId: "ep-unpublished-master",
      slug: "ep-unpublished-master",
      releaseDate: "2029-12-28",
      audioMasterId: f.draftOnlyMasterId,
      clipOnlyMode: false,
      published: false,
    },
    null,
  );
  const r6 = epWithDraftMaster.ok ? cms.publishBatch(["ep-unpublished-master"]) : epWithDraftMaster;
  // 7. Multi-hop clipOnlyMode violation (internal show OR audioMaster missing highlight chapter)
  const r7a = cms.saveDraft(
    {
      ...editDoc,
      documentId: "ep-clip-internal",
      slug: "ep-clip-internal",
      showIds: [f.internalShowId],
      releaseDate: "2029-12-27",
      audioMasterId: f.publishedValidMasterId,
      clipOnlyMode: true,
    },
    null,
  );
  const r7b = cms.saveDraft(
    {
      ...editDoc,
      documentId: "ep-clip-no-highlight",
      slug: "ep-clip-no-highlight",
      showIds: [f.partnerShowId],
      releaseDate: "2029-12-26",
      audioMasterId: f.noHighlightMasterId,
      clipOnlyMode: true,
    },
    null,
  );
  // 8. Atomic multi-doc publish
  const r8Ok = cms.publishBatch([f.draftOnlyMasterId, "ep-unpublished-master"]).ok;

  const checks = [
    !r1.ok && r1.code === "RevisionConflict",
    !r2.ok && r2.code === "SlugConflict",
    !r3.ok && r3.code === "SlugConflict",
    !r4.ok && r4.code === "StrongReferenceViolation",
    !r5.ok && r5.code === "StrongReferenceViolation",
    !r6.ok && r6.code === "PublishReadinessViolation",
    !r7a.ok && r7a.code === "ClipOnlyRuleViolation" && !r7b.ok && r7b.code === "ClipOnlyRuleViolation",
    r8Ok,
  ];
  const invariants: CmsInvariantResults = {
    staleRevisionRejected: checks[0]!,
    scopedShowSlugRejected: checks[1]!,
    perShowEpisodeSlugRejected: checks[2]!,
    danglingRefRejected: checks[3]!,
    deleteInUseRejected: checks[4]!,
    unpublishedAudioMasterRejected: checks[5]!,
    clipOnlyRuleRejected: checks[6]!,
    atomicPublishSucceeded: checks[7]!,
    passedCount: checks.filter(Boolean).length,
  };

  // 20 single-field editorial autosaves against the 25,000-doc corpus
  const lats: Array<number> = [];
  for (let e = 0; e < tape.editCount; e++) {
    const cur = cms.getDoc(f.editEpisodeId)!;
    const s = performance.now();
    const res = cms.saveDraft(
      {
        ...cur,
        title: `Podcast Episode #0 (autosave ${e + 1})`,
        bodyHash: `sha256:edit${String(e).padStart(59, "0")}`,
      },
      cur.revision,
    );
    lats.push(performance.now() - s);
    if (!res.ok) throw new Error(`Mock edit ${e} failed: ${res.code}`);
  }
  lats.sort((a, b) => a - b);

  const singleDocBytes = Buffer.byteLength(JSON.stringify(cms.getDoc(f.editEpisodeId)), "utf8");
  const editP50Ms = percentile(lats, 50);
  const editP95Ms = percentile(lats, 95);

  return {
    invariants,
    editP50Ms,
    editP95Ms,
    editMetaBytes: singleDocBytes,
    maxSingleDoMetaAt25kBytes: singleDocBytes,
    gates: evaluateCmsGates({
      invariants,
      editP95Ms,
      editMetaBytes: singleDocBytes,
      maxSingleDoMetaAt25kBytes: singleDocBytes,
    }),
  };
};
