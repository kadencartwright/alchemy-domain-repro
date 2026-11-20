import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CampaignId, OpportunityId, ReservationId } from "./Types.ts";

export class NoEligibleCampaign extends Domain.Rejection(
  "NoEligibleCampaign",
  { opportunityId: OpportunityId },
  { httpApiStatus: 404 },
) {}

export class InsufficientQuota extends Domain.Rejection(
  "InsufficientQuota",
  { campaignId: CampaignId, opportunityId: OpportunityId },
  { httpApiStatus: 409 },
) {}

export class CampaignNotFound extends Domain.Rejection(
  "CampaignNotFound",
  { campaignId: CampaignId },
  { httpApiStatus: 404 },
) {}

export class UnknownReservation extends Domain.Rejection(
  "UnknownReservation",
  { reservationId: ReservationId },
  { httpApiStatus: 404 },
) {}

export class InvoiceNotReady extends Domain.Rejection(
  "InvoiceNotReady",
  {
    campaignId: CampaignId,
    remainingPrimary: Schema.Int,
    remainingCompanion: Schema.Int,
  },
  { httpApiStatus: 409 },
) {}
