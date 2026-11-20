import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { ContentDocument, SplitDocumentCms } from "@repro/cms-domain/Document/Document.aggregate";
import { SaveDocumentDraft } from "@repro/cms-domain/Document/Document.commands";
import { DocumentId, WorkspaceId } from "@repro/cms-domain/Ids";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import { Workspace } from "@repro/cms-domain/Workspace/Workspace.aggregate";
import { SaveDraft } from "@repro/cms-domain/Workspace/Workspace.commands";
import { WorkspaceCms, WorkspaceCmsHandlers } from "@repro/cms-domain/Workspace/Workspace.model";
import {
  Campaign,
  ConfigureCampaign,
  ReserveCampaignSlots,
} from "@repro/quota-domain/Campaign/Campaign.aggregate";
import {
  AllocateInCell,
  AllocationCell,
  PartitionCampaignGrants,
  Treasury,
} from "@repro/quota-domain/Escrow/Escrow.aggregate";
import { Market } from "@repro/quota-domain/Market/Market.aggregate";
import {
  AllocateOpportunity,
  RecordExposure,
  UpsertCampaign,
} from "@repro/quota-domain/Market/Market.commands";
import {
  CampaignQuotaModel,
  EscrowQuotaHandlers,
  EscrowQuotaModel,
  MarketQuotaHandlers,
  MarketQuotaModel,
} from "@repro/quota-domain/Quota.model";
import {
  CampaignId,
  CellId,
  ExposureId,
  MarketId,
  OpportunityId,
  ReservationId,
} from "@repro/quota-domain/Types";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

const PlatformLive = DomainCloudflare.layerDurableObjects();

const ModelsLive = Layer.mergeAll(
  MarketQuotaModel.layer(MarketQuotaHandlers, { legacyData: false }),
  CampaignQuotaModel.layer(Layer.empty, { legacyData: false }),
  EscrowQuotaModel.layer(EscrowQuotaHandlers, { legacyData: false }),
  WorkspaceCms.layer(WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)), {
    legacyData: false,
  }),
  SplitDocumentCms.layer(Layer.empty, { legacyData: false }),
).pipe(Layer.provide(PlatformLive));

/**
 * Real Cloudflare Worker hosting all reproduction models on
 * `@alchemy.run/domain/Cloudflare` (`2.0.0-beta.87`).
 *
 * Boots locally in `workerd` with `pnpm --filter @repro/worker dev`
 * (zero Cloudflare credentials required).
 */
export default class ReproWorker extends Cloudflare.Worker<ReproWorker>()(
  "ReproWorker",
  {
    main: import.meta.url,
    dev: { host: "127.0.0.1", port: 8799, strictPort: true },
  },
  Effect.gen(function* () {
    const market = yield* Market;
    const campaign = yield* Campaign;
    const treasury = yield* Treasury;
    const cell = yield* AllocationCell;
    const workspace = yield* Workspace;
    const doc = yield* ContentDocument;

    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://127.0.0.1:8799");

      if (url.pathname === "/healthz") {
        return yield* HttpServerResponse.json({ ok: true, domainVersion: "2.0.0-beta.87" });
      }
      if (request.method !== "POST") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      const body = (yield* request.json) as Record<string, any>;

      // --- Case 1: Dynamic Ad Network / Quota Topologies ---
      if (url.pathname === "/market/setup") {
        const receipt = yield* market.send(
          MarketId.make(body.marketId),
          new UpsertCampaign({
            campaignId: CampaignId.make(body.campaignId),
            name: body.name ?? "Sponsor",
            weight: body.weight ?? 10,
            audience: body.audience ?? "all",
            startAt: body.startAt ?? 0,
            endAt: body.endAt ?? Date.UTC(2028, 0, 1),
            bundlePriceCents: body.bundlePriceCents ?? 100_000,
            creativeVersion: 1,
            requireCompanion: body.requireCompanion ?? true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: body.targets ?? { primary: 100_000, companion: 100_000, secondary: 0 },
          }),
          { commandId: body.commandId },
        );
        return yield* HttpServerResponse.json({ ok: true, version: receipt.version });
      }

      if (url.pathname === "/market/allocate") {
        return yield* market
          .send(
            MarketId.make(body.marketId),
            new AllocateOpportunity({
              opportunityId: OpportunityId.make(body.opportunityId),
              audience: body.audience ?? "free",
              leaseTtlMs: body.leaseTtlMs ?? 120_000,
            }),
            { commandId: body.commandId ?? body.opportunityId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({ ok: true, reply: receipt.reply, version: receipt.version }),
            ),
            Effect.catchTag("NoEligibleCampaign", () =>
              HttpServerResponse.json({ ok: false, reason: "no_fill" }, { status: 200 }),
            ),
          );
      }

      if (url.pathname === "/market/expose") {
        return yield* market
          .send(
            MarketId.make(body.marketId),
            new RecordExposure({
              exposureId: ExposureId.make(body.exposureId),
              reservationId: ReservationId.make(body.reservationId),
              campaignId: CampaignId.make(body.campaignId),
              placement: body.placement,
            }),
            { commandId: body.exposureId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({ ok: true, reply: receipt.reply, version: receipt.version }),
            ),
            Effect.catchTag("CampaignNotFound", () =>
              HttpServerResponse.json({ ok: false, reason: "campaign_not_found" }, { status: 404 }),
            ),
          );
      }

      if (url.pathname === "/campaign/setup") {
        const receipt = yield* campaign.send(
          CampaignId.make(body.campaignId),
          new ConfigureCampaign({
            name: body.name ?? "Sponsor",
            weight: body.weight ?? 10,
            audience: body.audience ?? "all",
            startAt: body.startAt ?? 0,
            endAt: body.endAt ?? Date.UTC(2028, 0, 1),
            bundlePriceCents: body.bundlePriceCents ?? 100_000,
            creativeVersion: 1,
            requireCompanion: body.requireCompanion ?? true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            active: true,
            targets: body.targets ?? { primary: 100_000, companion: 100_000, secondary: 0 },
          }),
          { commandId: body.commandId },
        );
        return yield* HttpServerResponse.json({ ok: true, version: receipt.version });
      }

      if (url.pathname === "/campaign/allocate") {
        const candidates: ReadonlyArray<string> = body.campaignIds;
        const oppId = OpportunityId.make(body.opportunityId);
        let hops = 0;
        for (const cid of candidates) {
          hops += 1;
          const attempt = yield* campaign
            .send(
              CampaignId.make(cid),
              new ReserveCampaignSlots({
                opportunityId: oppId,
                audience: body.audience ?? "free",
                leaseTtlMs: body.leaseTtlMs ?? 120_000,
              }),
              { commandId: `${body.opportunityId}:${cid}` },
            )
            .pipe(
              Effect.map((receipt) => ({ ok: true as const, campaignId: cid, reply: receipt.reply })),
              Effect.catchTag("InsufficientQuota", () => Effect.succeed({ ok: false as const })),
            );
          if (attempt.ok) {
            return yield* HttpServerResponse.json({
              ok: true,
              campaignId: attempt.campaignId,
              hops,
              reply: attempt.reply,
            });
          }
        }
        return yield* HttpServerResponse.json({ ok: false, reason: "no_fill", hops });
      }

      if (url.pathname === "/escrow/setup") {
        const receipt = yield* treasury.send(
          CampaignId.make(body.campaignId),
          new PartitionCampaignGrants({
            name: body.name ?? "Sharded Sponsor",
            weight: 10,
            audience: "all",
            startAt: 0,
            endAt: Date.UTC(2028, 0, 1),
            bundlePriceCents: 100_000,
            creativeVersion: 1,
            requireCompanion: true,
            standalonePrimaryApproved: false,
            standaloneCompanionApproved: false,
            cellIds: (body.cellIds as ReadonlyArray<string>).map((c) => CellId.make(c)),
            targets: body.targets,
          }),
          { commandId: body.commandId },
        );
        return yield* HttpServerResponse.json({ ok: true, version: receipt.version });
      }

      if (url.pathname === "/escrow/allocate") {
        return yield* cell
          .send(
            CellId.make(body.cellId),
            new AllocateInCell({
              opportunityId: OpportunityId.make(body.opportunityId),
              audience: body.audience ?? "free",
              leaseTtlMs: body.leaseTtlMs ?? 120_000,
            }),
            { commandId: body.commandId ?? body.opportunityId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({ ok: true, reply: receipt.reply, version: receipt.version }),
            ),
            Effect.catchTag("NoEligibleCampaign", () =>
              HttpServerResponse.json({ ok: false, reason: "no_fill" }),
            ),
          );
      }

      // --- Case 2: CMS Workspace vs Per-Document ---
      if (url.pathname === "/cms/workspace/save") {
        return yield* workspace
          .send(
            WorkspaceId.make(body.workspaceId),
            new SaveDraft({
              documentId: DocumentId.make(body.documentId),
              expectedRevision: body.expectedRevision ?? null,
              title: body.title,
              kind: body.kind ?? "article",
              releaseDate: body.releaseDate ?? null,
              bodyHash: body.bodyHash ?? "sha256:0",
              strongRefs: (body.strongRefs ?? []).map((id: string) => DocumentId.make(id)),
              strengthenOnPublish: [],
            }),
            { commandId: body.commandId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({ ok: true, reply: receipt.reply, version: receipt.version }),
            ),
            Effect.catchTags({
              RevisionConflict: (e) => HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              ScheduleDateConflict: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              StrongReferenceViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
            }),
          );
      }

      if (url.pathname === "/cms/document/save") {
        return yield* doc
          .send(
            DocumentId.make(body.documentId),
            new SaveDocumentDraft({
              workspaceId: WorkspaceId.make(body.workspaceId),
              expectedRevision: body.expectedRevision ?? null,
              title: body.title,
              releaseDate: body.releaseDate ?? null,
              bodyHash: body.bodyHash ?? "sha256:0",
              strongRefs: (body.strongRefs ?? []).map((id: string) => DocumentId.make(id)),
            }),
            { commandId: body.commandId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({ ok: true, reply: receipt.reply, version: receipt.version }),
            ),
            Effect.catchTag("DocumentRevisionConflict", (e) =>
              HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
            ),
          );
      }

      return HttpServerResponse.text("Not Found", { status: 404 });
    }).pipe(
      Effect.catchCause((cause) =>
        HttpServerResponse.json({ ok: false, defect: String(cause) }, { status: 500 }),
      ),
    );

    return { fetch: handle };
  }).pipe(Effect.provide(ModelsLive)),
) {}
