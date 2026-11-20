import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NoEligibleCampaign, UnknownReservation } from "../Rejections.ts";
import {
  applyExposureToCounters,
  Audience,
  CampaignId,
  CampaignRecord,
  canServePaired,
  CellId,
  emptyCounters,
  ExposureId,
  OpportunityId,
  pickWeightedCampaign,
  Placement,
  PlacementTargets,
  ReservationId,
  ReservationRecord,
} from "../Types.ts";

export class GrantPartitioned extends Domain.Event("GrantPartitioned", {
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
  grants: Schema.Array(
    Schema.Struct({
      cellId: CellId,
      targets: PlacementTargets,
    }),
  ),
}) {}

export class PartitionCampaignGrants extends Domain.Command("PartitionCampaignGrants", {
  target: CampaignId,
  input: {
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
    cellIds: Schema.Array(CellId),
    targets: PlacementTargets,
  },
  events: [GrantPartitioned],
  rejects: [],
}) {}

const TreasuryState = Schema.Struct({
  totalTargets: Schema.NullOr(PlacementTargets),
  grantsByCell: Schema.Record(Schema.String, PlacementTargets),
});

/**
 * Topology C (part 1) — Treasury Aggregate.
 *
 * Splits conserved quota vectors across N `AllocationCell` aggregates so hot
 * serving traffic scales across N DOs.
 */
export class Treasury extends Domain.Aggregate("Treasury", {
  id: CampaignId,
  state: TreasuryState,
  initial: { totalTargets: null, grantsByCell: {} },
  commands: [PartitionCampaignGrants],
  decide: {
    PartitionCampaignGrants: (_state, cmd, ctx) => {
      const n = Math.max(1, cmd.cellIds.length);
      const split = (total: number, index: number) =>
        Math.floor(total / n) + (index < total % n ? 1 : 0);
      const grants = cmd.cellIds.map((cellId, index) => ({
        cellId,
        targets: {
          primary: split(cmd.targets.primary, index),
          companion: split(cmd.targets.companion, index),
          secondary: split(cmd.targets.secondary, index),
        },
      }));
      return [
        new GrantPartitioned({
          campaignId: ctx.id,
          name: cmd.name,
          weight: cmd.weight,
          audience: cmd.audience,
          startAt: cmd.startAt,
          endAt: cmd.endAt,
          bundlePriceCents: cmd.bundlePriceCents,
          creativeVersion: cmd.creativeVersion,
          requireCompanion: cmd.requireCompanion,
          standalonePrimaryApproved: cmd.standalonePrimaryApproved,
          standaloneCompanionApproved: cmd.standaloneCompanionApproved,
          grants,
        }),
      ];
    },
  },
  evolve: {
    GrantPartitioned: (_state, e) => {
      const grantsByCell: Record<string, PlacementTargets> = {};
      let primary = 0;
      let companion = 0;
      let secondary = 0;
      for (const g of e.grants) {
        grantsByCell[g.cellId] = g.targets;
        primary += g.targets.primary;
        companion += g.targets.companion;
        secondary += g.targets.secondary;
      }
      return { totalTargets: { primary, companion, secondary }, grantsByCell };
    },
  },
}) {}

export class CellGrantInstalled extends Domain.Event("CellGrantInstalled", {
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
  targets: PlacementTargets,
}) {}

export class CellOpportunityAllocated extends Domain.Event("CellOpportunityAllocated", {
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

export class CellExposureAccounted extends Domain.Event("CellExposureAccounted", {
  exposureId: ExposureId,
  reservationId: ReservationId,
  campaignId: CampaignId,
  placement: Placement,
}) {}

export class InstallCellGrant extends Domain.Command("InstallCellGrant", {
  target: CellId,
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
    targets: PlacementTargets,
  },
  events: [CellGrantInstalled],
  rejects: [],
}) {}

export class AllocateInCell extends Domain.Command("AllocateInCell", {
  target: CellId,
  input: {
    opportunityId: OpportunityId,
    audience: Schema.Literals(["free", "paid"]),
    leaseTtlMs: Schema.Int,
  },
  events: [CellOpportunityAllocated],
  rejects: [NoEligibleCampaign],
  reply: {
    campaignId: CampaignId,
    reservationIds: Schema.Array(ReservationId),
  },
}) {}

export class RecordCellExposure extends Domain.Command("RecordCellExposure", {
  target: CellId,
  input: {
    exposureId: ExposureId,
    reservationId: ReservationId,
  },
  events: [CellExposureAccounted],
  rejects: [UnknownReservation],
  reply: { duplicate: Schema.Boolean },
}) {}

const CellState = Schema.Struct({
  campaigns: Schema.Record(Schema.String, CampaignRecord),
  reservations: Schema.Record(Schema.String, ReservationRecord),
  seenExposures: Schema.Record(Schema.String, Schema.Boolean),
});

/**
 * Topology C (part 2) — Sharded AllocationCell Aggregate.
 *
 * Horizontally shards write throughput across N DOs in 1 hop per decision,
 * but exposes classic escrow tradeoffs:
 * - Skewed traffic exhausts one cell while sibling cells hold stranded quota.
 * - Paired [primary, companion] capacity fragments across cells near exhaustion.
 * - Reconciling global invoices requires non-transactional reads across all cells.
 */
export class AllocationCell extends Domain.Aggregate("AllocationCell", {
  id: CellId,
  state: CellState,
  initial: { campaigns: {}, reservations: {}, seenExposures: {} },
  commands: [InstallCellGrant, AllocateInCell, RecordCellExposure],
  decide: {
    InstallCellGrant: (_state, cmd) => {
      const { _tag: _, ...fields } = cmd;
      return [new CellGrantInstalled(fields)];
    },
    AllocateInCell: (state, cmd, ctx) => {
      const now = DateTime.toEpochMillis(ctx.now);
      const eligible: Array<{
        campaign: CampaignRecord;
        placements: ReadonlyArray<Placement>;
      }> = [];
      for (const campaign of Object.values(state.campaigns)) {
        const placements = canServePaired(campaign, cmd.audience, now);
        if (placements.length > 0) eligible.push({ campaign, placements });
      }
      const picked = pickWeightedCampaign(
        eligible.map((e) => e.campaign),
        cmd.opportunityId,
      );
      if (!picked) return new NoEligibleCampaign({ opportunityId: cmd.opportunityId });
      const chosen = eligible.find((e) => e.campaign.id === picked.id)!;
      const expiresAt = now + cmd.leaseTtlMs;
      return [
        new CellOpportunityAllocated({
          opportunityId: cmd.opportunityId,
          campaignId: picked.id,
          creativeVersion: picked.creativeVersion,
          reservations: chosen.placements.map((placement) => ({
            reservationId: ReservationId.make(`${cmd.opportunityId}:${placement}`),
            placement,
            expiresAt,
          })),
        }),
      ];
    },
    RecordCellExposure: (state, cmd) => {
      if (state.seenExposures[cmd.exposureId]) return [];
      const res = state.reservations[cmd.reservationId];
      if (!res) return new UnknownReservation({ reservationId: cmd.reservationId });
      if (res.status === "qualified") return [];
      return [
        new CellExposureAccounted({
          exposureId: cmd.exposureId,
          reservationId: res.id,
          campaignId: res.campaignId,
          placement: res.placement,
        }),
      ];
    },
  },
  evolve: {
    CellGrantInstalled: (state, e) => ({
      ...state,
      campaigns: {
        ...state.campaigns,
        [e.campaignId]: {
          id: e.campaignId,
          name: e.name,
          weight: e.weight,
          audience: e.audience,
          startAt: e.startAt,
          endAt: e.endAt,
          bundlePriceCents: e.bundlePriceCents,
          creativeVersion: e.creativeVersion,
          requireCompanion: e.requireCompanion,
          standalonePrimaryApproved: e.standalonePrimaryApproved,
          standaloneCompanionApproved: e.standaloneCompanionApproved,
          active: true,
          counters: {
            primary: emptyCounters(e.targets.primary),
            companion: emptyCounters(e.targets.companion),
            secondary: emptyCounters(e.targets.secondary),
          },
        },
      },
    }),
    CellOpportunityAllocated: (state, e) => {
      const campaign = state.campaigns[e.campaignId];
      if (!campaign) return state;
      const nextCounters = { ...campaign.counters };
      const nextRes = { ...state.reservations };
      for (const r of e.reservations) {
        nextCounters[r.placement] = {
          ...nextCounters[r.placement],
          reserved: nextCounters[r.placement].reserved + 1,
        };
        nextRes[r.reservationId] = {
          id: r.reservationId,
          opportunityId: e.opportunityId,
          campaignId: e.campaignId,
          placement: r.placement,
          creativeVersion: e.creativeVersion,
          expiresAt: r.expiresAt,
          status: "active",
        };
      }
      return {
        ...state,
        campaigns: { ...state.campaigns, [e.campaignId]: { ...campaign, counters: nextCounters } },
        reservations: nextRes,
      };
    },
    CellExposureAccounted: (state, e) => {
      const res = state.reservations[e.reservationId];
      const campaign = state.campaigns[e.campaignId];
      if (!res || !campaign) return state;
      const wasActive = res.status === "active";
      return {
        ...state,
        seenExposures: { ...state.seenExposures, [e.exposureId]: true },
        reservations: {
          ...state.reservations,
          [e.reservationId]: { ...res, status: "qualified" as const },
        },
        campaigns: {
          ...state.campaigns,
          [e.campaignId]: {
            ...campaign,
            counters: {
              ...campaign.counters,
              [e.placement]: applyExposureToCounters(campaign.counters[e.placement], wasActive),
            },
          },
        },
      };
    },
  },
  reply: {
    AllocateInCell: (_state, events) => {
      const allocated = events.find((e) => e._tag === "CellOpportunityAllocated");
      return {
        campaignId: allocated ? allocated.campaignId : ("" as never),
        reservationIds: allocated ? allocated.reservations.map((r) => r.reservationId) : [],
      };
    },
    RecordCellExposure: (_state, events) => ({
      duplicate: !events.some((e) => e._tag === "CellExposureAccounted"),
    }),
  },
}) {}

export class DistributeGrants extends Domain.Policy("DistributeGrants", {
  from: Treasury,
  on: [GrantPartitioned],
}) {}

export const DistributeGrantsLive = DistributeGrants.toLayer(
  Effect.gen(function* () {
    const cells = yield* AllocationCell;
    return Effect.fn(function* ({ event }) {
      for (const grant of event.grants) {
        yield* cells.send(
          grant.cellId,
          new InstallCellGrant({
            campaignId: event.campaignId,
            name: event.name,
            weight: event.weight,
            audience: event.audience,
            startAt: event.startAt,
            endAt: event.endAt,
            bundlePriceCents: event.bundlePriceCents,
            creativeVersion: event.creativeVersion,
            requireCompanion: event.requireCompanion,
            standalonePrimaryApproved: event.standalonePrimaryApproved,
            standaloneCompanionApproved: event.standaloneCompanionApproved,
            targets: grant.targets,
          }),
          { commandId: `grant:${event.campaignId}:${grant.cellId}` },
        );
      }
    });
  }),
);
