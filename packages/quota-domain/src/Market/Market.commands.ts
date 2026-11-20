import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  CampaignNotFound,
  InvoiceNotReady,
  NoEligibleCampaign,
  UnknownReservation,
} from "../Rejections.ts";
import {
  Audience,
  CampaignId,
  ExposureId,
  InvoiceSnapshot,
  MarketId,
  OpportunityId,
  Placement,
  PlacementTargets,
  ReservationId,
} from "../Types.ts";

export class CampaignUpserted extends Domain.Event("CampaignUpserted", {
  campaignId: CampaignId,
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
  targets: PlacementTargets,
}) {}

export class OpportunityAllocated extends Domain.Event("OpportunityAllocated", {
  opportunityId: OpportunityId,
  campaignId: CampaignId,
  creativeVersion: Schema.Int,
  reservations: Schema.Array(
    Schema.Struct({
      reservationId: ReservationId,
      placement: Placement,
      expiresAt: Schema.Number,
    }),
  ),
}) {}

export class ExposureAccounted extends Domain.Event("ExposureAccounted", {
  exposureId: ExposureId,
  reservationId: ReservationId,
  campaignId: CampaignId,
  placement: Placement,
  late: Schema.Boolean,
}) {}

export class LeaseExpired extends Domain.Event("LeaseExpired", {
  reservationId: ReservationId,
  campaignId: CampaignId,
  placement: Placement,
}) {}

export class InvoiceFinalized extends Domain.Event("InvoiceFinalized", {
  snapshot: InvoiceSnapshot,
}) {}

export class UpsertCampaign extends Domain.Command("UpsertCampaign", {
  target: MarketId,
  input: {
    campaignId: CampaignId,
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
    targets: PlacementTargets,
  },
  events: [CampaignUpserted],
  rejects: [],
}) {}

export class AllocateOpportunity extends Domain.Command("AllocateOpportunity", {
  target: MarketId,
  input: {
    opportunityId: OpportunityId,
    audience: Schema.Literals(["free", "paid"]),
    leaseTtlMs: Schema.Int,
  },
  events: [OpportunityAllocated],
  rejects: [NoEligibleCampaign],
  reply: {
    campaignId: CampaignId,
    creativeVersion: Schema.Int,
    reservationIds: Schema.Array(ReservationId),
  },
}) {}

export class RecordExposure extends Domain.Command("RecordExposure", {
  target: MarketId,
  input: {
    exposureId: ExposureId,
    reservationId: ReservationId,
  },
  events: [ExposureAccounted],
  rejects: [UnknownReservation],
  reply: { duplicate: Schema.Boolean, late: Schema.Boolean },
}) {}

/** Scheduled by LeaseExpiry policy; cannot reject so it can be scheduled. */
export class ExpireLease extends Domain.Command("ExpireLease", {
  target: MarketId,
  input: {
    reservationId: ReservationId,
  },
  events: [LeaseExpired],
  rejects: [],
}) {}

export class FinalizeInvoice extends Domain.Command("FinalizeInvoice", {
  target: MarketId,
  input: {
    campaignId: CampaignId,
  },
  events: [InvoiceFinalized],
  rejects: [CampaignNotFound, InvoiceNotReady],
  reply: { snapshot: InvoiceSnapshot },
}) {}
