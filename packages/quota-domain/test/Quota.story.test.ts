import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import {
  AllocateInCell,
  AllocationCell,
  CellGrantInstalled,
  CellOpportunityAllocated,
  GrantPartitioned,
  PartitionCampaignGrants,
  Treasury,
} from "../src/Escrow/Escrow.aggregate.ts";
import { Market } from "../src/Market/Market.aggregate.ts";
import {
  AllocateOpportunity,
  CampaignUpserted,
  ExposureAccounted,
  FinalizeInvoice,
  InvoiceFinalized,
  LeaseExpired,
  OpportunityAllocated,
  RecordExposure,
  UpsertCampaign,
} from "../src/Market/Market.commands.ts";
import {
  EscrowQuotaHandlers,
  EscrowQuotaModel,
  MarketQuotaHandlers,
  MarketQuotaModel,
} from "../src/Quota.model.ts";
import { NoEligibleCampaign } from "../src/Rejections.ts";
import {
  CampaignId,
  CellId,
  ExposureId,
  MarketId,
  OpportunityId,
  ReservationId,
} from "../src/Types.ts";

const marketStory = Story.make(MarketQuotaModel, { layer: MarketQuotaHandlers });
const escrowStory = Story.make(EscrowQuotaModel, { layer: EscrowQuotaHandlers });

const T0 = Date.parse("2026-11-20T12:00:00Z");
const T_END = Date.parse("2026-11-21T12:00:00Z");

it.effect("Market handles paired quotas, lease expiry, honest late reports, and immutable invoices", () => {
  const m = Market.ref(MarketId.make("main"));
  const cid = CampaignId.make("camp-1");
  const opp1 = OpportunityId.make("opp-1");
  const opp2 = OpportunityId.make("opp-2");
  const r1Primary = ReservationId.make("opp-1:primary");
  const r1Companion = ReservationId.make("opp-1:companion");
  const r2Primary = ReservationId.make("opp-2:primary");
  const r2Companion = ReservationId.make("opp-2:companion");

  return marketStory(
    Story.clock("2026-11-20T12:00:00Z"),
    Story.when(
      m,
      new UpsertCampaign({
        campaignId: cid,
        name: "Sponsor Bundle",
        weight: 10,
        audience: "all",
        startAt: T0,
        endAt: T_END,
        bundlePriceCents: 50_000,
        creativeVersion: 1,
        requireCompanion: false,
        standalonePrimaryApproved: false,
        standaloneCompanionApproved: true,
        active: true,
        targets: { primary: 1, companion: 1, secondary: 0 },
      }),
    ),
    Story.then(
      m,
      new CampaignUpserted({
        campaignId: cid,
        name: "Sponsor Bundle",
        weight: 10,
        audience: "all",
        startAt: T0,
        endAt: T_END,
        bundlePriceCents: 50_000,
        creativeVersion: 1,
        requireCompanion: false,
        standalonePrimaryApproved: false,
        standaloneCompanionApproved: true,
        active: true,
        targets: { primary: 1, companion: 1, secondary: 0 },
      }),
    ),

    // Opportunity 1 claims the sole paired [primary, companion] unit.
    Story.when(
      m,
      new AllocateOpportunity({ opportunityId: opp1, audience: "free", leaseTtlMs: 30_000 }),
    ),
    Story.then(
      m,
      new OpportunityAllocated({
        opportunityId: opp1,
        campaignId: cid,
        creativeVersion: 1,
        reservations: [
          { reservationId: r1Primary, placement: "primary", expiresAt: T0 + 30_000 },
          { reservationId: r1Companion, placement: "companion", expiresAt: T0 + 30_000 },
        ],
      }),
    ),

    // Advance past lease TTL: scheduled ExpireLease commands fire for both placements.
    Story.advance("31 seconds"),
    Story.then(
      m,
      Story.anyOrder(
        new LeaseExpired({ reservationId: r1Primary, campaignId: cid, placement: "primary" }),
        new LeaseExpired({ reservationId: r1Companion, campaignId: cid, placement: "companion" }),
      ),
    ),

    // Capacity returned -> Opportunity 2 allocates and qualifies both placements.
    Story.when(
      m,
      new AllocateOpportunity({ opportunityId: opp2, audience: "free", leaseTtlMs: 30_000 }),
    ),
    Story.then(
      m,
      new OpportunityAllocated({
        opportunityId: opp2,
        campaignId: cid,
        creativeVersion: 1,
        reservations: [
          { reservationId: r2Primary, placement: "primary", expiresAt: T0 + 61_000 },
          { reservationId: r2Companion, placement: "companion", expiresAt: T0 + 61_000 },
        ],
      }),
    ),
    Story.when(
      m,
      new RecordExposure({
        exposureId: ExposureId.make("exp-2p"),
        reservationId: r2Primary,
        campaignId: cid,
        placement: "primary",
      }),
    ),
    Story.then(
      m,
      new ExposureAccounted({
        exposureId: ExposureId.make("exp-2p"),
        reservationId: r2Primary,
        campaignId: cid,
        placement: "primary",
        late: false,
      }),
    ),
    Story.when(
      m,
      new RecordExposure({
        exposureId: ExposureId.make("exp-2c"),
        reservationId: r2Companion,
        campaignId: cid,
        placement: "companion",
      }),
    ),
    Story.then(
      m,
      new ExposureAccounted({
        exposureId: ExposureId.make("exp-2c"),
        reservationId: r2Companion,
        campaignId: cid,
        placement: "companion",
        late: false,
      }),
    ),

    // Late report for expired opp-1 primary still counts honestly as delivered + excess
    // even though LeaseExpired already pruned opp-1 from activeReservations.
    Story.when(
      m,
      new RecordExposure({
        exposureId: ExposureId.make("exp-1p-late"),
        reservationId: r1Primary,
        campaignId: cid,
        placement: "primary",
      }),
      { commandId: "exp-1p-late" },
    ),
    Story.then(
      m,
      new ExposureAccounted({
        exposureId: ExposureId.make("exp-1p-late"),
        reservationId: r1Primary,
        campaignId: cid,
        placement: "primary",
        late: true,
      }),
    ),
    Story.replied({ late: true }),

    // Duplicate retry with the same commandId is deduped by @alchemy.run/domain's receipt.
    Story.when(
      m,
      new RecordExposure({
        exposureId: ExposureId.make("exp-1p-late"),
        reservationId: r1Primary,
        campaignId: cid,
        placement: "primary",
      }),
      { commandId: "exp-1p-late" },
    ),
    Story.then(m),
    Story.replied({ late: true }),

    // Confirm activeReservations was fully pruned (zero retained reservation history in state).
    Story.state(m, (state) => Object.keys(state.activeReservations).length === 0),

    // Finalize invoice at fixed $500 bundle price; excess is recorded, never billed extra.
    Story.when(m, new FinalizeInvoice({ campaignId: cid })),
    Story.then(
      m,
      new InvoiceFinalized({
        snapshot: {
          campaignId: cid,
          bundlePriceCents: 50_000,
          finalizedAt: T0 + 31_000,
          totals: {
            primary: { target: 1, reserved: 0, credited: 1, delivered: 2, excess: 1 },
            companion: { target: 1, reserved: 0, credited: 1, delivered: 1, excess: 0 },
            secondary: { target: 0, reserved: 0, credited: 0, delivered: 0, excess: 0 },
          },
        },
      }),
    ),
  );
});

it.effect("Escrow cells shard writes, but skewed traffic strands quota on sibling cells", () => {
  const cid = CampaignId.make("camp-escrow");
  const treasury = Treasury.ref(cid);
  const cell0 = AllocationCell.ref(CellId.make("cell-0"));
  const cell1 = AllocationCell.ref(CellId.make("cell-1"));

  return escrowStory(
    Story.clock("2026-11-20T12:00:00Z"),
    Story.when(
      treasury,
      new PartitionCampaignGrants({
        name: "Sharded Campaign",
        weight: 10,
        audience: "all",
        startAt: T0,
        endAt: T_END,
        bundlePriceCents: 20_000,
        creativeVersion: 1,
        requireCompanion: true,
        standalonePrimaryApproved: false,
        standaloneCompanionApproved: false,
        cellIds: [CellId.make("cell-0"), CellId.make("cell-1")],
        targets: { primary: 2, companion: 2, secondary: 0 },
      }),
    ),
    Story.then(
      treasury,
      new GrantPartitioned({
        campaignId: cid,
        name: "Sharded Campaign",
        weight: 10,
        audience: "all",
        startAt: T0,
        endAt: T_END,
        bundlePriceCents: 20_000,
        creativeVersion: 1,
        requireCompanion: true,
        standalonePrimaryApproved: false,
        standaloneCompanionApproved: false,
        grants: [
          { cellId: CellId.make("cell-0"), targets: { primary: 1, companion: 1, secondary: 0 } },
          { cellId: CellId.make("cell-1"), targets: { primary: 1, companion: 1, secondary: 0 } },
        ],
      }),
    ),
    Story.then(
      cell0,
      new CellGrantInstalled({
        campaignId: cid,
        name: "Sharded Campaign",
        weight: 10,
        audience: "all",
        startAt: T0,
        endAt: T_END,
        bundlePriceCents: 20_000,
        creativeVersion: 1,
        requireCompanion: true,
        standalonePrimaryApproved: false,
        standaloneCompanionApproved: false,
        targets: { primary: 1, companion: 1, secondary: 0 },
      }),
    ),
    Story.then(
      cell1,
      new CellGrantInstalled({
        campaignId: cid,
        name: "Sharded Campaign",
        weight: 10,
        audience: "all",
        startAt: T0,
        endAt: T_END,
        bundlePriceCents: 20_000,
        creativeVersion: 1,
        requireCompanion: true,
        standalonePrimaryApproved: false,
        standaloneCompanionApproved: false,
        targets: { primary: 1, companion: 1, secondary: 0 },
      }),
    ),

    // First request hitting cell-0 succeeds.
    Story.when(
      cell0,
      new AllocateInCell({
        opportunityId: OpportunityId.make("skew-1"),
        audience: "free",
        leaseTtlMs: 30_000,
      }),
    ),
    Story.then(
      cell0,
      new CellOpportunityAllocated({
        opportunityId: OpportunityId.make("skew-1"),
        campaignId: cid,
        creativeVersion: 1,
        reservations: [
          { reservationId: ReservationId.make("skew-1:primary"), placement: "primary", expiresAt: T0 + 30_000 },
          { reservationId: ReservationId.make("skew-1:companion"), placement: "companion", expiresAt: T0 + 30_000 },
        ],
      }),
    ),

    // Second request hitting cell-0 gets NoEligibleCampaign even though cell-1
    // still holds unused quota (requires multi-cell fallback or rebalancing).
    Story.when(
      cell0,
      new AllocateInCell({
        opportunityId: OpportunityId.make("skew-2"),
        audience: "free",
        leaseTtlMs: 30_000,
      }),
    ),
    Story.rejected(new NoEligibleCampaign({ opportunityId: OpportunityId.make("skew-2") })),
  );
});
