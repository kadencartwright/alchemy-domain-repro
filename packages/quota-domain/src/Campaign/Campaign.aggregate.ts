import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { InsufficientQuota } from "../Rejections.ts";
import {
  applyExposureToCounters,
  Audience,
  CampaignId,
  CampaignRecord,
  canServePaired,
  emptyCounters,
  ExposureId,
  OpportunityId,
  Placement,
  PlacementTargets,
  ReservationId,
  ReservationRecord,
} from "../Types.ts";

export class CampaignConfigured extends Domain.Event("CampaignConfigured", {
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

export class CampaignSlotsReserved extends Domain.Event("CampaignSlotsReserved", {
  opportunityId: OpportunityId,
  creativeVersion: Schema.Int,
  reservations: Schema.Array(
    Schema.Struct({
      reservationId: ReservationId,
      placement: Placement,
      expiresAt: Schema.Number,
    }),
  ),
}) {}

export class CampaignExposureRecorded extends Domain.Event("CampaignExposureRecorded", {
  exposureId: ExposureId,
  reservationId: ReservationId,
  placement: Placement,
  late: Schema.Boolean,
}) {}

export class ConfigureCampaign extends Domain.Command("ConfigureCampaign", {
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
  events: [CampaignConfigured],
  rejects: [],
}) {}

export class ReserveCampaignSlots extends Domain.Command("ReserveCampaignSlots", {
  input: {
    campaignId: CampaignId,
    opportunityId: OpportunityId,
    audience: Schema.Literals(["free", "paid"]),
    leaseTtlMs: Schema.Int,
  },
  events: [CampaignSlotsReserved],
  rejects: [InsufficientQuota],
  reply: { reservationIds: Schema.Array(ReservationId) },
}) {}

export class RecordCampaignExposure extends Domain.Command("RecordCampaignExposure", {
  input: {
    campaignId: CampaignId,
    exposureId: ExposureId,
    reservationId: ReservationId,
    placement: Placement,
  },
  events: [CampaignExposureRecorded],
  rejects: [],
  reply: { late: Schema.Boolean },
}) {}

const CampaignAggregateState = Schema.Struct({
  config: Schema.NullOr(CampaignRecord),
  activeReservations: Schema.Record(Schema.String, ReservationRecord),
});

/**
 * Topology B — Per-Campaign Aggregate (pruned active-hold state).
 *
 * Isolates unrelated campaigns across separate DOs, but:
 * 1. Weighted selection across N active campaigns no longer has an atomic view;
 *    a Worker/coordinator must try candidate 1, catch `InsufficientQuota`, and
 *    fall back to candidate 2 (extra DO RPC hops on the critical decision path).
 * 2. A single popular/large campaign still serializes every decision and
 *    exposure report on one DO.
 */
export class Campaign extends Domain.Aggregate("Campaign", {
  id: CampaignId,
  state: CampaignAggregateState,
  initial: { config: null, activeReservations: {} },
  commands: [ConfigureCampaign, ReserveCampaignSlots, RecordCampaignExposure],
  keyOf: (cmd) => cmd.campaignId,
  decide: {
    ConfigureCampaign: (_state, cmd) => {
      const { _tag: _, ...fields } = cmd;
      return [new CampaignConfigured(fields)];
    },
    ReserveCampaignSlots: (state, cmd, ctx) => {
      const now = DateTime.toEpochMillis(ctx.now);
      if (!state.config) {
        return new InsufficientQuota({ campaignId: ctx.id, opportunityId: cmd.opportunityId });
      }
      const placements = canServePaired(state.config, cmd.audience, now);
      if (placements.length === 0) {
        return new InsufficientQuota({ campaignId: ctx.id, opportunityId: cmd.opportunityId });
      }
      const expiresAt = now + cmd.leaseTtlMs;
      return [
        new CampaignSlotsReserved({
          opportunityId: cmd.opportunityId,
          creativeVersion: state.config.creativeVersion,
          reservations: placements.map((placement) => ({
            reservationId: ReservationId.make(`${cmd.opportunityId}:${placement}`),
            placement,
            expiresAt,
          })),
        }),
      ];
    },
    RecordCampaignExposure: (state, cmd) => {
      if (!state.config) return [];
      const active = state.activeReservations[cmd.reservationId];
      return [
        new CampaignExposureRecorded({
          exposureId: cmd.exposureId,
          reservationId: cmd.reservationId,
          placement: cmd.placement,
          late: active === undefined,
        }),
      ];
    },
  },
  evolve: {
    CampaignConfigured: (state, e, envelope) => ({
      ...state,
      config: {
        id: envelope.id,
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
        active: e.active,
        counters: state.config?.counters ?? {
          primary: emptyCounters(e.targets.primary),
          companion: emptyCounters(e.targets.companion),
          secondary: emptyCounters(e.targets.secondary),
        },
      },
    }),
    CampaignSlotsReserved: (state, e) => {
      if (!state.config) return state;
      const nextCounters = { ...state.config.counters };
      const nextActive = { ...state.activeReservations };
      for (const r of e.reservations) {
        nextCounters[r.placement] = {
          ...nextCounters[r.placement],
          reserved: nextCounters[r.placement].reserved + 1,
        };
        nextActive[r.reservationId] = {
          id: r.reservationId,
          opportunityId: e.opportunityId,
          campaignId: state.config.id,
          placement: r.placement,
          creativeVersion: e.creativeVersion,
          expiresAt: r.expiresAt,
          status: "active",
        };
      }
      return {
        ...state,
        config: { ...state.config, counters: nextCounters },
        activeReservations: nextActive,
      };
    },
    CampaignExposureRecorded: (state, e) => {
      if (!state.config) return state;
      const wasActive = e.reservationId in state.activeReservations;
      const nextActive = { ...state.activeReservations };
      delete nextActive[e.reservationId];
      return {
        ...state,
        activeReservations: nextActive,
        config: {
          ...state.config,
          counters: {
            ...state.config.counters,
            [e.placement]: applyExposureToCounters(state.config.counters[e.placement], wasActive),
          },
        },
      };
    },
  },
  reply: {
    ReserveCampaignSlots: (_state, events) => {
      const reserved = events.find((e) => e._tag === "CampaignSlotsReserved");
      return { reservationIds: reserved ? reserved.reservations.map((r) => r.reservationId) : [] };
    },
    RecordCampaignExposure: (_state, events) => {
      const recorded = events.find((e) => e._tag === "CampaignExposureRecorded");
      return { late: recorded ? recorded.late : false };
    },
  },
}) {}
