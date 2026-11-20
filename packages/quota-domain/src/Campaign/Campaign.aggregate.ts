import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { InsufficientQuota, UnknownReservation } from "../Rejections.ts";
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
    active: Schema.Boolean,
    targets: PlacementTargets,
  },
  events: [CampaignConfigured],
  rejects: [],
}) {}

export class ReserveCampaignSlots extends Domain.Command("ReserveCampaignSlots", {
  target: CampaignId,
  input: {
    opportunityId: OpportunityId,
    audience: Schema.Literals(["free", "paid"]),
    leaseTtlMs: Schema.Int,
  },
  events: [CampaignSlotsReserved],
  rejects: [InsufficientQuota],
  reply: { reservationIds: Schema.Array(ReservationId) },
}) {}

export class RecordCampaignExposure extends Domain.Command("RecordCampaignExposure", {
  target: CampaignId,
  input: {
    exposureId: ExposureId,
    reservationId: ReservationId,
  },
  events: [CampaignExposureRecorded],
  rejects: [UnknownReservation],
  reply: { duplicate: Schema.Boolean },
}) {}

const CampaignAggregateState = Schema.Struct({
  config: Schema.NullOr(CampaignRecord),
  reservations: Schema.Record(Schema.String, ReservationRecord),
  seenExposures: Schema.Record(Schema.String, Schema.Boolean),
});

/**
 * Topology B — Per-Campaign Aggregate.
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
  initial: { config: null, reservations: {}, seenExposures: {} },
  commands: [ConfigureCampaign, ReserveCampaignSlots, RecordCampaignExposure],
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
      if (state.seenExposures[cmd.exposureId]) return [];
      const res = state.reservations[cmd.reservationId];
      if (!res) return new UnknownReservation({ reservationId: cmd.reservationId });
      if (res.status === "qualified") return [];
      return [
        new CampaignExposureRecorded({
          exposureId: cmd.exposureId,
          reservationId: res.id,
          placement: res.placement,
          late: res.status === "expired",
        }),
      ];
    },
  },
  evolve: {
    CampaignConfigured: (state, e) => ({
      ...state,
      config: {
        id: state.config?.id ?? CampaignId.make(e.name),
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
      const nextRes = { ...state.reservations };
      for (const r of e.reservations) {
        nextCounters[r.placement] = {
          ...nextCounters[r.placement],
          reserved: nextCounters[r.placement].reserved + 1,
        };
        nextRes[r.reservationId] = {
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
        reservations: nextRes,
      };
    },
    CampaignExposureRecorded: (state, e) => {
      const res = state.reservations[e.reservationId];
      if (!state.config || !res) return state;
      const wasActive = res.status === "active";
      return {
        ...state,
        seenExposures: { ...state.seenExposures, [e.exposureId]: true },
        reservations: {
          ...state.reservations,
          [e.reservationId]: { ...res, status: "qualified" as const },
        },
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
    RecordCampaignExposure: (_state, events) => ({
      duplicate: !events.some((e) => e._tag === "CampaignExposureRecorded"),
    }),
  },
}) {}
