import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { NoEligibleCampaign } from "../Rejections.ts";
import { CampaignId, canServePaired, hashString, OpportunityId, ReservationId } from "../Types.ts";
import { Campaign, CampaignSlotsReserved } from "./Campaign.aggregate.ts";

/**
 * Allocate one opportunity across every campaign that might serve it, in one
 * atomic step. The caller names the candidate campaigns (the market's active
 * set); `Domain.Decision` reads all of them, picks one by weight among those
 * with paired capacity left, and records the reservation on that one.
 */
export class AllocateAcrossCampaigns extends Domain.Command("AllocateAcrossCampaigns", {
  input: {
    campaignIds: Schema.Array(CampaignId),
    opportunityId: OpportunityId,
    audience: Schema.Literals(["free", "paid"]),
    leaseTtlMs: Schema.Int,
  },
  events: [CampaignSlotsReserved],
  rejects: [NoEligibleCampaign],
  reply: {
    campaignId: CampaignId,
    creativeVersion: Schema.Int,
    reservationIds: Schema.Array(ReservationId),
  },
}) {}

/**
 * Topology D — Per-`Campaign` aggregates + `Domain.Decision` (alchemy main).
 *
 * Restores what Topology B gave up: weighted selection over every candidate
 * campaign is atomic again, with no try-next fallback loop. The cost is that
 * every opportunity's decision reads (and so prepares and holds) every
 * candidate campaign, not only the one it reserves on.
 */
export class CampaignSelection extends Domain.Decision(AllocateAcrossCampaigns, {
  reads: { campaigns: Campaign },
  keyOf: (cmd) => ({ campaigns: cmd.campaignIds }),
  decide: ({ campaigns }, cmd, ctx) => {
    const now = DateTime.toEpochMillis(ctx.now);
    const eligible = campaigns.flatMap((c) => {
      const config = c.state.config;
      if (!config) return [];
      const placements = canServePaired(config, cmd.audience, now);
      return placements.length === 0 ? [] : [{ read: c, config, placements }];
    });
    if (eligible.length === 0) {
      return new NoEligibleCampaign({ opportunityId: cmd.opportunityId });
    }
    const totalWeight = eligible.reduce((sum, e) => sum + Math.max(1, e.config.weight), 0);
    let ticket = hashString(cmd.opportunityId) % totalWeight;
    let chosen = eligible[0]!;
    for (const e of eligible) {
      const w = Math.max(1, e.config.weight);
      if (ticket < w) {
        chosen = e;
        break;
      }
      ticket -= w;
    }
    const expiresAt = now + cmd.leaseTtlMs;
    return [
      chosen.read.record(
        new CampaignSlotsReserved({
          opportunityId: cmd.opportunityId,
          creativeVersion: chosen.config.creativeVersion,
          reservations: chosen.placements.map((placement) => ({
            reservationId: ReservationId.make(`${cmd.opportunityId}:${placement}`),
            placement,
            expiresAt,
          })),
        }),
      ),
    ];
  },
  reply: (states, events) => {
    const reserved = events[0];
    const chosen = states.campaigns.find(
      (s) =>
        reserved !== undefined && reserved.reservations[0]!.reservationId in s.activeReservations,
    );
    return {
      campaignId: chosen?.config?.id ?? CampaignId.make(""),
      creativeVersion: reserved?.creativeVersion ?? 0,
      reservationIds: reserved ? reserved.reservations.map((r) => r.reservationId) : [],
    };
  },
}) {}
