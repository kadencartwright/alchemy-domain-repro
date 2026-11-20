import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CampaignNotFound, InvoiceNotReady, NoEligibleCampaign } from "../Rejections.ts";
import {
  applyExposureToCounters,
  CampaignRecord,
  canServePaired,
  emptyCounters,
  InvoiceSnapshot,
  MarketId,
  pickWeightedCampaign,
  Placement,
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

/**
 * Steelmanned `MarketState` — aggressively pruned to stay small:
 * - Only currently *active* (unexpired, unqualified) holds live in `activeReservations`.
 *   Qualified and expired reservations are deleted immediately on evolve.
 * - Opportunity & exposure retry deduplication is delegated to `@alchemy.run/domain`'s
 *   built-in `commandId` receipt (`receipt:<commandId>`), NOT duplicated in state.
 * - Client receipts carry signed `(campaignId, placement)` so late exposures still
 *   account honestly after `LeaseExpired` prunes the active hold.
 *
 * Even with `"meta"` kept small (~1–5 KiB), the real bottlenecks remain:
 * 1. Single-DO serialization (`blockConcurrencyWhile`) caps burst throughput / tail latency.
 * 2. Framework-managed `event:*`, `receipt:*`, Policy `seen:*`, and per-lease
 *    `armed:*`/`scheduled:*`/`cb:*` keys still grow unboundedly with zero compaction.
 */
export const MarketState = Schema.Struct({
  campaigns: Schema.Record(Schema.String, CampaignRecord),
  activeReservations: Schema.Record(Schema.String, ReservationRecord),
  invoices: Schema.Record(Schema.String, InvoiceSnapshot),
});
export type MarketState = typeof MarketState.Type;

export const initialMarketState: MarketState = {
  campaigns: {},
  activeReservations: {},
  invoices: {},
};

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
      const campaign = state.campaigns[cmd.campaignId];
      if (!campaign) return new CampaignNotFound({ campaignId: cmd.campaignId });
      const active = state.activeReservations[cmd.reservationId];
      return [
        new ExposureAccounted({
          exposureId: cmd.exposureId,
          reservationId: cmd.reservationId,
          campaignId: cmd.campaignId,
          placement: cmd.placement,
          late: active === undefined,
        }),
      ];
    },
    ExpireLease: (state, cmd) => {
      const active = state.activeReservations[cmd.reservationId];
      if (!active) return [];
      return [
        new LeaseExpired({
          reservationId: active.id,
          campaignId: active.campaignId,
          placement: active.placement,
        }),
      ];
    },
    FinalizeInvoice: (state, cmd, ctx) => {
      if (state.invoices[cmd.campaignId]) return [];
      const campaign = state.campaigns[cmd.campaignId];
      if (!campaign) return new CampaignNotFound({ campaignId: cmd.campaignId });
      const remPrimary = Math.max(
        0,
        campaign.counters.primary.target - campaign.counters.primary.credited,
      );
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
      const nextActive = { ...state.activeReservations };
      for (const item of e.reservations) {
        nextCounters[item.placement] = {
          ...nextCounters[item.placement],
          reserved: nextCounters[item.placement].reserved + 1,
        };
        nextActive[item.reservationId] = {
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
        activeReservations: nextActive,
      };
    },
    ExposureAccounted: (state, e) => {
      const campaign = state.campaigns[e.campaignId];
      if (!campaign) return state;
      const wasActive = e.reservationId in state.activeReservations;
      const nextActive = { ...state.activeReservations };
      delete nextActive[e.reservationId];
      return {
        ...state,
        activeReservations: nextActive,
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
      const active = state.activeReservations[e.reservationId];
      const campaign = state.campaigns[e.campaignId];
      if (!active || !campaign) return state;
      const nextActive = { ...state.activeReservations };
      delete nextActive[e.reservationId];
      const c = campaign.counters[e.placement];
      return {
        ...state,
        activeReservations: nextActive,
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
      return { late: accounted ? accounted.late : false };
    },
    FinalizeInvoice: (state, events) => {
      const finalized = events.find((e) => e._tag === "InvoiceFinalized");
      const snap = finalized?.snapshot ?? Object.values(state.invoices)[0]!;
      return { snapshot: snap };
    },
  },
}) {}

/**
 * Idiomatic `@alchemy.run/domain` deadline policy: schedules one `ExpireLease`
 * command per issued reservation.
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
