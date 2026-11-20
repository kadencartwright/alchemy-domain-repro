import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Campaign } from "./Campaign/Campaign.aggregate.ts";
import {
  AllocationCell,
  DistributeGrants,
  DistributeGrantsLive,
  Treasury,
} from "./Escrow/Escrow.aggregate.ts";
import {
  Market,
  ScheduleLeaseExpiry,
  ScheduleLeaseExpiryLive,
} from "./Market/Market.aggregate.ts";

export class MarketQuotaModel extends Domain.Model("MarketQuotaModel", {
  aggregates: [Market],
  policies: [ScheduleLeaseExpiry],
}) {}

export const MarketQuotaHandlers = ScheduleLeaseExpiryLive;

export class MarketQuotaApi extends Domain.Api("MarketQuotaApi", {
  model: MarketQuotaModel,
  commands: ["UpsertCampaign", "AllocateOpportunity", "RecordExposure", "FinalizeInvoice"],
}) {}

export class CampaignQuotaModel extends Domain.Model("CampaignQuotaModel", {
  aggregates: [Campaign],
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
