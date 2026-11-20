import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CampaignNotFound,
  InvoiceNotReady,
  NoEligibleCampaign,
  UnknownReservation,
} from "../Rejections.ts";
import {
  applyExposureToCounters,
  CampaignRecord,
  canServePaired,
  emptyCounters,
  InvoiceSnapshot,
  MarketId,
  pickWeightedCampaign,
  ReservationId,
  ReservationRecord,
} from "../Types.ts";
import {
  AllocateOpportunity,
  CampaignUpserted,
  ExpireLease,
  ExposureAccounted,
  FinalizeInvoice,
  InvoiceFinalized,
  LeaseExpired,
  OpportunityAllocated,
  RecordExposure,
  UpsertCampaign,
} from "./Market.commands.ts";

export const MarketState = Schema.Struct({
  campaigns: Schema.Record(Schema.String, CampaignRecord),
  reservations: Schema.Record(Schema.String, ReservationRecord),
  opportunityDecisions: Schema.Record(Schema.String, Schema.Array(ReservationId)),
  seenExposures: Schema.Record(Schema.String, Schema.Boolean),
  invoices: Schema.Record(Schema.String, InvoiceSnapshot),
});
export type MarketState = typeof MarketState.Type;

export const initialMarketState: MarketState = {
  campaigns: {},
  reservations: {},
  opportunityDecisions: {},
  seenExposures: {},
  invoices: {},
};

/**
 * Topology A — Single Market Aggregate.
 *
 * Semantically ideal: atomic weighted selection across all eligible campaigns,
 * atomic paired [primary, companion] reservation, idempotent late-safe exposure
 * accounting, and immutable invoice snapshots.
 *
 * Runtime friction under @alchemy.run/domain/Cloudflare:
 * 1. Every decision, exposure report, and lease expiry across the whole market
 *    serializes through ONE DO (`blockConcurrencyWhile`).
 * 2. `reservations`, `opportunityDecisions`, and `seenExposures` live inside
 *    `"meta"`, so every command rewrites an ever-growing JSON blob AND appends
 *    unbounded `event:*` + `receipt:*` keys.
 * 3. Expiring leases via `schedule` creates one durable callback job per
 *    reservation instead of a single indexed expiry sweep.
 */
export class Market extends Domain.Aggregate("Market", {
  id: MarketId,
  state: MarketState,
  initial: initialMarketState,
  commands: [UpsertCampaign, AllocateOpportunity, RecordExposure, ExpireLease, FinalizeInvoice],
  decide: {
    UpsertCampaign: (_state, cmd) => {
      const { _tag: _, ...fields } = cmd;
      return [new CampaignUpserted(fields)];
    },
    AllocateOpportunity: (state, cmd, ctx) => {
      const now = DateTime.toEpochMillis(ctx.now);
      // Idempotent by opportunityId across retries.
      const existing = state.opportunityDecisions[cmd.opportunityId];
      if (existing && existing.length > 0) return [];

      const eligible: Array<{ campaign: CampaignRecord; placements: ReadonlyArray<"primary" | "companion" | "secondary"> }> = [];
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
        new OpportunityAllocated({
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
    RecordExposure: (state, cmd) => {
      if (state.seenExposures[cmd.exposureId]) return [];
      const res = state.reservations[cmd.reservationId];
      if (!res) return new UnknownReservation({ reservationId: cmd.reservationId });
      if (res.status === "qualified") return [];
      return [
        new ExposureAccounted({
          exposureId: cmd.exposureId,
          reservationId: res.id,
          campaignId: res.campaignId,
          placement: res.placement,
          late: res.status === "expired" || res.status === "released",
        }),
      ];
    },
    ExpireLease: (state, cmd) => {
      const res = state.reservations[cmd.reservationId];
      if (!res || res.status !== "active") return [];
      return [
        new LeaseExpired({
          reservationId: res.id,
          campaignId: res.campaignId,
          placement: res.placement,
        }),
      ];
    },
    FinalizeInvoice: (state, cmd, ctx) => {
      if (state.invoices[cmd.campaignId]) return [];
      const campaign = state.campaigns[cmd.campaignId];
      if (!campaign) return new CampaignNotFound({ campaignId: cmd.campaignId });
      const remPrimary = Math.max(0, campaign.counters.primary.target - campaign.counters.primary.credited);
      const remCompanion = Math.max(
        0,
        campaign.counters.companion.target - campaign.counters.companion.credited,
      );
      if (remPrimary > 0 || remCompanion > 0) {
        return new InvoiceNotReady({
          campaignId: cmd.campaignId,
          remainingPrimary: remPrimary,
          remainingCompanion: remCompanion,
        });
      }
      return [
        new InvoiceFinalized({
          snapshot: {
            campaignId: campaign.id,
            bundlePriceCents: campaign.bundlePriceCents,
            finalizedAt: DateTime.toEpochMillis(ctx.now),
            totals: campaign.counters,
          },
        }),
      ];
    },
  },
  evolve: {
    CampaignUpserted: (state, e) => {
      const prev = state.campaigns[e.campaignId];
      const next: CampaignRecord = {
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
        active: e.active,
        counters: prev
          ? {
              primary: { ...prev.counters.primary, target: e.targets.primary },
              companion: { ...prev.counters.companion, target: e.targets.companion },
              secondary: { ...prev.counters.secondary, target: e.targets.secondary },
            }
          : {
              primary: emptyCounters(e.targets.primary),
              companion: emptyCounters(e.targets.companion),
              secondary: emptyCounters(e.targets.secondary),
            },
      };
      return { ...state, campaigns: { ...state.campaigns, [e.campaignId]: next } };
    },
    OpportunityAllocated: (state, e) => {
      const campaign = state.campaigns[e.campaignId];
      if (!campaign) return state;
      const nextCounters = { ...campaign.counters };
      const nextReservations = { ...state.reservations };
      const resIds: Array<ReservationId> = [];
      for (const item of e.reservations) {
        resIds.push(item.reservationId);
        nextCounters[item.placement] = {
          ...nextCounters[item.placement],
          reserved: nextCounters[item.placement].reserved + 1,
        };
        nextReservations[item.reservationId] = {
          id: item.reservationId,
          opportunityId: e.opportunityId,
          campaignId: e.campaignId,
          placement: item.placement,
          creativeVersion: e.creativeVersion,
          expiresAt: item.expiresAt,
          status: "active",
        };
      }
      return {
        ...state,
        campaigns: {
          ...state.campaigns,
          [e.campaignId]: { ...campaign, counters: nextCounters },
        },
        reservations: nextReservations,
        opportunityDecisions: {
          ...state.opportunityDecisions,
          [e.opportunityId]: resIds,
        },
      };
    },
    ExposureAccounted: (state, e) => {
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
    LeaseExpired: (state, e) => {
      const res = state.reservations[e.reservationId];
      const campaign = state.campaigns[e.campaignId];
      if (!res || !campaign || res.status !== "active") return state;
      const c = campaign.counters[e.placement];
      return {
        ...state,
        reservations: {
          ...state.reservations,
          [e.reservationId]: { ...res, status: "expired" as const },
        },
        campaigns: {
          ...state.campaigns,
          [e.campaignId]: {
            ...campaign,
            counters: {
              ...campaign.counters,
              [e.placement]: { ...c, reserved: Math.max(0, c.reserved - 1) },
            },
          },
        },
      };
    },
    InvoiceFinalized: (state, e) => ({
      ...state,
      invoices: { ...state.invoices, [e.snapshot.campaignId]: e.snapshot },
    }),
  },
  reply: {
    AllocateOpportunity: (_state, events) => {
      const allocated = events.find((e) => e._tag === "OpportunityAllocated");
      return {
        campaignId: allocated ? allocated.campaignId : ("" as never),
        creativeVersion: allocated ? allocated.creativeVersion : 0,
        reservationIds: allocated ? allocated.reservations.map((r) => r.reservationId) : [],
      };
    },
    RecordExposure: (_state, events) => {
      const accounted = events.find((e) => e._tag === "ExposureAccounted");
      return {
        duplicate: accounted === undefined,
        late: accounted ? accounted.late : false,
      };
    },
    FinalizeInvoice: (state, events) => {
      const finalized = events.find((e) => e._tag === "InvoiceFinalized");
      const snap = finalized?.snapshot ?? Object.values(state.invoices)[0]!;
      return { snapshot: snap };
    },
  },
}) {}

/**
 * Idiomatic @alchemy.run/domain deadline policy: schedules one `ExpireLease`
 * command per issued reservation.
 *
 * Clean in stories, but at 200-400 opportunities/s × 2-3 placements, this
 * stages 400-1,200 outbox rows/s, invokes a Policy DO 400-1,200 times/s,
 * and arms 400-1,200 individual durable callback timers/s back on `Market`.
 */
export class ScheduleLeaseExpiry extends Domain.Policy("ScheduleLeaseExpiry", {
  from: Market,
  on: [OpportunityAllocated],
}) {}

export const ScheduleLeaseExpiryLive = ScheduleLeaseExpiry.toLayer(
  Effect.gen(function* () {
    const market = yield* Market;
    return Effect.fn(function* ({ source, event }) {
      for (const res of event.reservations) {
        yield* market.schedule(source.id, new ExpireLease({ reservationId: res.reservationId }), {
          at: DateTime.makeUnsafe(res.expiresAt),
          commandId: `expire:${res.reservationId}`,
        });
      }
    });
  }),
);
