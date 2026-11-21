import * as Domain from "@alchemy.run/domain";
import { Campaign } from "./Campaign/Campaign.aggregate.ts";
import { CampaignSelection } from "./Campaign/CampaignSelection.decision.ts";
import {
  AllocationCell,
  DistributeGrants,
  DistributeGrantsLive,
  Treasury,
} from "./Escrow/Escrow.aggregate.ts";
import { Market, ScheduleLeaseExpiry, ScheduleLeaseExpiryLive } from "./Market/Market.aggregate.ts";

export class MarketQuotaModel extends Domain.Model("MarketQuotaModel", {
  aggregates: [Market],
  policies: [ScheduleLeaseExpiry],
}) {}

export const MarketQuotaHandlers = ScheduleLeaseExpiryLive;

export class MarketQuotaApi extends Domain.Api("MarketQuotaApi", {
  model: MarketQuotaModel,
  commands: ["UpsertCampaign", "AllocateOpportunity", "RecordExposure", "FinalizeInvoice"],
}) {}

/**
 * Topology B (per-campaign commands, try-next fallback) and Topology D (the same
 * aggregates, allocated atomically across campaigns by `CampaignSelection`).
 */
export class CampaignQuotaModel extends Domain.Model("CampaignQuotaModel", {
  aggregates: [Campaign],
  decisions: [CampaignSelection],
}) {}

export class EscrowQuotaModel extends Domain.Model("EscrowQuotaModel", {
  aggregates: [Treasury, AllocationCell],
  policies: [DistributeGrants],
}) {}

export const EscrowQuotaHandlers = DistributeGrantsLive;

export class EscrowQuotaApi extends Domain.Api("EscrowQuotaApi", {
  model: EscrowQuotaModel,
  commands: ["PartitionCampaignGrants", "AllocateInCell", "RecordCellExposure"],
}) {}
