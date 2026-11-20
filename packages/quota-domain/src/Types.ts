import * as Schema from "effect/Schema";

export const MarketId = Schema.String.pipe(Schema.brand("MarketId"));
export type MarketId = typeof MarketId.Type;

export const CampaignId = Schema.String.pipe(Schema.brand("CampaignId"));
export type CampaignId = typeof CampaignId.Type;

export const CellId = Schema.String.pipe(Schema.brand("CellId"));
export type CellId = typeof CellId.Type;

export const OpportunityId = Schema.String.pipe(Schema.brand("OpportunityId"));
export type OpportunityId = typeof OpportunityId.Type;

export const ReservationId = Schema.String.pipe(Schema.brand("ReservationId"));
export type ReservationId = typeof ReservationId.Type;

export const ExposureId = Schema.String.pipe(Schema.brand("ExposureId"));
export type ExposureId = typeof ExposureId.Type;

export const Placement = Schema.Literals(["primary", "companion", "secondary"]);
export type Placement = typeof Placement.Type;

export const Audience = Schema.Literals(["free", "paid", "all"]);
export type Audience = typeof Audience.Type;

export const PlacementCounters = Schema.Struct({
  target: Schema.Int,
  reserved: Schema.Int,
  credited: Schema.Int,
  delivered: Schema.Int,
  excess: Schema.Int,
});
export type PlacementCounters = typeof PlacementCounters.Type;

export const PlacementTargets = Schema.Struct({
  primary: Schema.Int,
  companion: Schema.Int,
  secondary: Schema.Int,
});
export type PlacementTargets = typeof PlacementTargets.Type;

export const CampaignRecord = Schema.Struct({
  id: CampaignId,
  name: Schema.String,
  weight: Schema.Int,
  audience: Audience,
  startAt: Schema.Number,
  endAt: Schema.Number,
  bundlePriceCents: Schema.Int,
  creativeVersion: Schema.Int,
  requireCompanion: Schema.Boolean,
  standalonePrimaryApproved: Schema.Boolean,
  standaloneCompanionApproved: Schema.Boolean,
  active: Schema.Boolean,
  counters: Schema.Struct({
    primary: PlacementCounters,
    companion: PlacementCounters,
    secondary: PlacementCounters,
  }),
});
export type CampaignRecord = typeof CampaignRecord.Type;

export const ReservationRecord = Schema.Struct({
  id: ReservationId,
  opportunityId: OpportunityId,
  campaignId: CampaignId,
  placement: Placement,
  creativeVersion: Schema.Int,
  expiresAt: Schema.Number,
  status: Schema.Literals(["active", "qualified", "expired", "released"]),
});
export type ReservationRecord = typeof ReservationRecord.Type;

export const InvoiceSnapshot = Schema.Struct({
  campaignId: CampaignId,
  bundlePriceCents: Schema.Int,
  finalizedAt: Schema.Number,
  totals: Schema.Struct({
    primary: PlacementCounters,
    companion: PlacementCounters,
    secondary: PlacementCounters,
  }),
});
export type InvoiceSnapshot = typeof InvoiceSnapshot.Type;

export const emptyCounters = (target: number): PlacementCounters => ({
  target,
  reserved: 0,
  credited: 0,
  delivered: 0,
  excess: 0,
});

export const remainingCapacity = (c: PlacementCounters): number =>
  Math.max(0, c.target - c.credited - c.reserved);

export const canServePaired = (
  campaign: CampaignRecord,
  audience: "free" | "paid",
  now: number,
): ReadonlyArray<Placement> => {
  if (!campaign.active || now < campaign.startAt || now >= campaign.endAt) return [];
  if (campaign.audience !== "all" && campaign.audience !== audience) return [];
  const hasPrimary = remainingCapacity(campaign.counters.primary) > 0;
  const hasCompanion = remainingCapacity(campaign.counters.companion) > 0;
  if (hasPrimary && hasCompanion) return ["primary", "companion"];
  if (campaign.requireCompanion) return [];
  if (hasPrimary && campaign.standalonePrimaryApproved) return ["primary"];
  if (hasCompanion && campaign.standaloneCompanionApproved) return ["companion"];
  return [];
};

/** Deterministic FNV-1a hash so weighted selection inside `decide` stays pure. */
export const hashString = (input: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const pickWeightedCampaign = (
  candidates: ReadonlyArray<CampaignRecord>,
  seed: string,
): CampaignRecord | null => {
  if (candidates.length === 0) return null;
  const totalWeight = candidates.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
  let ticket = hashString(seed) % totalWeight;
  for (const c of candidates) {
    const w = Math.max(1, c.weight);
    if (ticket < w) return c;
    ticket -= w;
  }
  return candidates[0] ?? null;
};

export const applyExposureToCounters = (
  c: PlacementCounters,
  wasActive: boolean,
): PlacementCounters => {
  const nextReserved = wasActive ? Math.max(0, c.reserved - 1) : c.reserved;
  const nextDelivered = c.delivered + 1;
  if (c.credited < c.target) {
    return {
      ...c,
      reserved: nextReserved,
      credited: c.credited + 1,
      delivered: nextDelivered,
    };
  }
  return {
    ...c,
    reserved: nextReserved,
    delivered: nextDelivered,
    excess: c.excess + 1,
  };
};
