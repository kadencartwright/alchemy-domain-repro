import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { ContentDocument, SplitDocumentCms } from "@repro/cms-domain/Document/Document.aggregate";
import { SaveDocumentDraft } from "@repro/cms-domain/Document/Document.commands";
import { RetireLibraryItem, SaveLibraryItem } from "@repro/cms-domain/Content/Content.aggregates";
import { ContentClient, ContentSeeder } from "@repro/cms-domain/Content/Content.client";
import { ContentDomain } from "@repro/cms-domain/Content/Content.model";
import {
  DecisionCmsClient,
  type Draft,
  DecisionCmsSeeder,
} from "@repro/cms-domain/Decision/DecisionCms.client";
import { DecisionCms } from "@repro/cms-domain/Decision/DecisionCms.model";
import { DocumentId, WorkspaceId } from "@repro/cms-domain/Ids";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import { Workspace } from "@repro/cms-domain/Workspace/Workspace.aggregate";
import {
  BulkImportDocuments,
  DeleteDocument,
  PublishWorkspace,
  SaveDraft,
} from "@repro/cms-domain/Workspace/Workspace.commands";
import { WorkspaceCms, WorkspaceCmsHandlers } from "@repro/cms-domain/Workspace/Workspace.model";
import type { DocumentMeta } from "@repro/cms-domain/Workspace/WorkspaceState";
import {
  Campaign,
  ConfigureCampaign,
  RecordCampaignExposure,
  ReserveCampaignSlots,
} from "@repro/quota-domain/Campaign/Campaign.aggregate";
import {
  AllocateAcrossCampaigns,
  CampaignSelection,
} from "@repro/quota-domain/Campaign/CampaignSelection.decision";
import {
  AllocateInCell,
  AllocationCell,
  PartitionCampaignGrants,
  RecordCellExposure,
  Treasury,
} from "@repro/quota-domain/Escrow/Escrow.aggregate";
import { Market } from "@repro/quota-domain/Market/Market.aggregate";
import {
  AllocateOpportunity,
  FinalizeInvoice,
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
  hashString,
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
  DecisionCms.layer(Layer.empty, { legacyData: false }),
  ContentDomain.layer(Layer.empty, { legacyData: false }),
).pipe(Layer.provide(PlatformLive));

/**
 * Real Cloudflare Worker hosting the reproduction models
 * on `@alchemy.run/domain/Cloudflare` (`2.0.0-beta.87`).
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
    const selection = yield* CampaignSelection;
    const treasury = yield* Treasury;
    const cell = yield* AllocationCell;
    const workspace = yield* Workspace;
    const doc = yield* ContentDocument;
    const decisionCms = yield* DecisionCmsClient;
    const seedDecisionCms = yield* DecisionCmsSeeder;
    const content = yield* ContentClient;
    const seedContent = yield* ContentSeeder;

    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://127.0.0.1:8799");

      if (url.pathname === "/healthz") {
        return yield* HttpServerResponse.json({ ok: true, domainVersion: "main@de0bdeda2" });
      }
      if (request.method !== "POST") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      const body = (yield* request.json) as Record<string, any>;

      // --- Topology A: Single Market DO + ScheduleLeaseExpiry ---
      if (url.pathname === "/market/setup") {
        const receipt = yield* market.send(
          new UpsertCampaign({
            marketId: MarketId.make(body.marketId),
            campaignId: CampaignId.make(body.campaignId),
            name: body.name ?? "Sponsor",
            weight: body.weight ?? 10,
            audience: body.audience ?? "all",
            startAt: body.startAt ?? 0,
            endAt: body.endAt ?? Date.UTC(2028, 0, 1),
            bundlePriceCents: body.bundlePriceCents ?? 50_000,
            creativeVersion: 1,
            requireCompanion: body.requireCompanion ?? true,
            standalonePrimaryApproved: body.standalonePrimaryApproved ?? false,
            standaloneCompanionApproved: body.standaloneCompanionApproved ?? false,
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
            new AllocateOpportunity({
              marketId: MarketId.make(body.marketId),
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
      if (url.pathname === "/market/expose") {
        return yield* market
          .send(
            new RecordExposure({
              marketId: MarketId.make(body.marketId),
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
      if (url.pathname === "/market/state") {
        const state = yield* market.get(MarketId.make(body.marketId));
        return yield* HttpServerResponse.json({ ok: true, state });
      }
      if (url.pathname === "/market/invoice") {
        return yield* market
          .send(
            new FinalizeInvoice({
              marketId: MarketId.make(body.marketId),
              campaignId: CampaignId.make(body.campaignId),
            }),
            { commandId: body.commandId ?? `inv:${body.marketId}:${body.campaignId}` },
          )
          .pipe(
            Effect.flatMap((r) =>
              HttpServerResponse.json({ ok: true, snapshot: r.reply.snapshot }),
            ),
            Effect.catchTags({
              CampaignNotFound: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 404 }),
              InvoiceNotReady: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
            }),
          );
      }

      // --- Topology B: Per-Campaign DOs ---
      if (url.pathname === "/campaign/setup") {
        const receipt = yield* campaign.send(
          new ConfigureCampaign({
            campaignId: CampaignId.make(body.campaignId),
            name: body.name ?? "Sponsor",
            weight: body.weight ?? 10,
            audience: body.audience ?? "all",
            startAt: body.startAt ?? 0,
            endAt: body.endAt ?? Date.UTC(2028, 0, 1),
            bundlePriceCents: body.bundlePriceCents ?? 50_000,
            creativeVersion: 1,
            requireCompanion: body.requireCompanion ?? true,
            standalonePrimaryApproved: body.standalonePrimaryApproved ?? false,
            standaloneCompanionApproved: body.standaloneCompanionApproved ?? false,
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
              new ReserveCampaignSlots({
                campaignId: CampaignId.make(cid),
                opportunityId: oppId,
                audience: body.audience ?? "free",
                leaseTtlMs: body.leaseTtlMs ?? 120_000,
              }),
              { commandId: `${body.opportunityId}:${cid}` },
            )
            .pipe(
              Effect.map((receipt) => ({
                ok: true as const,
                campaignId: cid,
                reply: receipt.reply,
              })),
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
      if (url.pathname === "/campaign/expose") {
        const receipt = yield* campaign.send(
          new RecordCampaignExposure({
            campaignId: CampaignId.make(body.campaignId),
            exposureId: ExposureId.make(body.exposureId),
            reservationId: ReservationId.make(body.reservationId),
            placement: body.placement,
          }),
          { commandId: body.exposureId },
        );
        return yield* HttpServerResponse.json({ ok: true, reply: receipt.reply });
      }
      if (url.pathname === "/campaign/state") {
        const state = yield* campaign.get(CampaignId.make(body.campaignId));
        return yield* HttpServerResponse.json({ ok: true, state });
      }

      // --- Topology D: Per-Campaign DOs + Domain.Decision across every candidate ---
      if (url.pathname === "/campaign/allocate-decision") {
        return yield* selection
          .send(
            new AllocateAcrossCampaigns({
              campaignIds: (body.campaignIds as ReadonlyArray<string>).map((c) =>
                CampaignId.make(c),
              ),
              opportunityId: OpportunityId.make(body.opportunityId),
              audience: body.audience ?? "free",
              leaseTtlMs: body.leaseTtlMs ?? 120_000,
            }),
            { commandId: body.opportunityId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({
                ok: true,
                campaignId: receipt.reply.campaignId,
                reply: receipt.reply,
              }),
            ),
            Effect.catchTag("NoEligibleCampaign", () =>
              HttpServerResponse.json({ ok: false, reason: "no_fill" }),
            ),
          );
      }

      // --- Topology C: 8 Sharded Escrow Cell DOs ---
      if (url.pathname === "/escrow/setup") {
        const receipt = yield* treasury.send(
          new PartitionCampaignGrants({
            campaignId: CampaignId.make(body.campaignId),
            name: body.name ?? "Sharded Sponsor",
            weight: body.weight ?? 10,
            audience: body.audience ?? "all",
            startAt: body.startAt ?? 0,
            endAt: body.endAt ?? Date.UTC(2028, 0, 1),
            bundlePriceCents: body.bundlePriceCents ?? 50_000,
            creativeVersion: 1,
            requireCompanion: body.requireCompanion ?? true,
            standalonePrimaryApproved: body.standalonePrimaryApproved ?? false,
            standaloneCompanionApproved: body.standaloneCompanionApproved ?? false,
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
            new AllocateInCell({
              cellId: CellId.make(body.cellId),
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
      if (url.pathname === "/escrow/expose") {
        const receipt = yield* cell.send(
          new RecordCellExposure({
            cellId: CellId.make(body.cellId),
            exposureId: ExposureId.make(body.exposureId),
            reservationId: ReservationId.make(body.reservationId),
            campaignId: CampaignId.make(body.campaignId),
            placement: body.placement,
          }),
          { commandId: body.exposureId },
        );
        return yield* HttpServerResponse.json({ ok: true, reply: receipt.reply });
      }

      // --- Case 2: Podcast Network CMS (Monolith Workspace vs Naive Split ContentDocument) ---
      if (url.pathname === "/cms/workspace/save") {
        const toIds = (arr: unknown): Array<DocumentId> =>
          Array.isArray(arr) ? arr.map((id) => DocumentId.make(String(id))) : [];
        return yield* workspace
          .send(
            new SaveDraft({
              workspaceId: WorkspaceId.make(body.workspaceId),
              documentId: DocumentId.make(body.documentId),
              expectedRevision: body.expectedRevision ?? null,
              title: body.title,
              kind: body.kind ?? "episode",
              slug: body.slug ?? null,
              ownershipType: body.ownershipType ?? null,
              showIds: toIds(body.showIds),
              releaseDate: body.releaseDate ?? null,
              audioMasterId: body.audioMasterId ? DocumentId.make(body.audioMasterId) : null,
              clipOnlyMode: body.clipOnlyMode ?? false,
              closerKind: body.closerKind ?? "none",
              playableAudio: body.playableAudio ?? false,
              durationSeconds: body.durationSeconds ?? null,
              chapters: body.chapters ?? [],
              segmentIds: toIds(body.segmentIds),
              hostIds: toIds(body.hostIds),
              managedLinkIds: toIds(body.managedLinkIds),
              mediaAssetIds: toIds(body.mediaAssetIds),
              bodyHash: body.bodyHash ?? "sha256:0",
              strongRefs: toIds(body.strongRefs),
              strengthenOnPublish: toIds(body.strengthenOnPublish),
              retiredAt: body.retiredAt ?? null,
            }),
            { commandId: body.commandId },
          )
          .pipe(
            Effect.flatMap((receipt) =>
              HttpServerResponse.json({ ok: true, reply: receipt.reply, version: receipt.version }),
            ),
            Effect.catchTags({
              RevisionConflict: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              ScheduleDateConflict: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              SlugConflict: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              StrongReferenceViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              ClipOnlyRuleViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
            }),
          );
      }
      if (url.pathname === "/cms/workspace/bulk-import") {
        const receipt = yield* workspace.send(
          new BulkImportDocuments({
            workspaceId: WorkspaceId.make(body.workspaceId),
            documents: body.documents,
          }),
          { commandId: body.commandId },
        );
        return yield* HttpServerResponse.json({ ok: true, reply: receipt.reply });
      }
      if (url.pathname === "/cms/workspace/delete") {
        return yield* workspace
          .send(
            new DeleteDocument({
              workspaceId: WorkspaceId.make(body.workspaceId),
              documentId: DocumentId.make(body.documentId),
              expectedRevision: body.expectedRevision,
            }),
            { commandId: body.commandId },
          )
          .pipe(
            Effect.flatMap((r) => HttpServerResponse.json({ ok: true, reply: r.reply })),
            Effect.catchTags({
              DocumentNotFound: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 404 }),
              RevisionConflict: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              StrongReferenceViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
            }),
          );
      }
      if (url.pathname === "/cms/workspace/publish") {
        return yield* workspace
          .send(
            new PublishWorkspace({
              workspaceId: WorkspaceId.make(body.workspaceId),
              documentIds: (body.documentIds as ReadonlyArray<string>).map((id) =>
                DocumentId.make(id),
              ),
            }),
            { commandId: body.commandId },
          )
          .pipe(
            Effect.flatMap((r) => HttpServerResponse.json({ ok: true, reply: r.reply })),
            Effect.catchTags({
              DocumentNotFound: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 404 }),
              StrongReferenceViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              PublishReadinessViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
              ClipOnlyRuleViolation: (e) =>
                HttpServerResponse.json({ ok: false, error: e }, { status: 409 }),
            }),
          );
      }

      if (url.pathname === "/cms/document/save") {
        return yield* doc
          .send(
            new SaveDocumentDraft({
              documentId: DocumentId.make(body.documentId),
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

      // --- Topology E: Per-document aggregates + Domain.Decision (alchemy main) ---
      if (url.pathname.startsWith("/cms/decision/")) {
        const toIds = (arr: unknown): Array<DocumentId> =>
          Array.isArray(arr) ? arr.map((id) => DocumentId.make(String(id))) : [];
        const options = body.commandId ? { commandId: String(body.commandId) } : undefined;
        const respond = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.flatMap((receipt) => HttpServerResponse.json({ ok: true, receipt })),
            Effect.catch((e) =>
              HttpServerResponse.json(
                { ok: false, error: e },
                { status: e._tag === "DocumentNotFound" ? 404 : 409 },
              ),
            ),
          );
        if (url.pathname === "/cms/decision/import") {
          const counts = yield* seedDecisionCms(body.documents as ReadonlyArray<DocumentMeta>, {
            concurrency: body.concurrency ?? 16,
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true, counts });
        }
        if (url.pathname === "/cms/decision/save") {
          const d: Draft = {
            documentId: DocumentId.make(body.documentId),
            expectedRevision: body.expectedRevision ?? null,
            title: body.title,
            kind: body.kind ?? "episode",
            slug: body.slug ?? null,
            ownershipType: body.ownershipType ?? null,
            showIds: toIds(body.showIds),
            releaseDate: body.releaseDate ?? null,
            audioMasterId: body.audioMasterId ? DocumentId.make(body.audioMasterId) : null,
            clipOnlyMode: body.clipOnlyMode ?? false,
            closerKind: body.closerKind ?? "none",
            playableAudio: body.playableAudio ?? false,
            durationSeconds: body.durationSeconds ?? null,
            chapters: body.chapters ?? [],
            segmentIds: toIds(body.segmentIds),
            hostIds: toIds(body.hostIds),
            managedLinkIds: toIds(body.managedLinkIds),
            mediaAssetIds: toIds(body.mediaAssetIds),
            bodyHash: body.bodyHash ?? "sha256:0",
            strongRefs: toIds(body.strongRefs),
            strengthenOnPublish: toIds(body.strengthenOnPublish),
            retiredAt: body.retiredAt ?? null,
          };
          // `known`: the document as the caller last saw it (an autosave), so no read first.
          return yield* respond(
            body.known === undefined
              ? decisionCms.save(d, options)
              : decisionCms.saveKnown(d, body.known, options),
          );
        }
        if (url.pathname === "/cms/decision/delete") {
          return yield* respond(
            decisionCms.remove(DocumentId.make(body.documentId), body.expectedRevision, options),
          );
        }
        if (url.pathname === "/cms/decision/publish") {
          return yield* respond(decisionCms.publish(toIds(body.documentIds), options));
        }
        if (url.pathname === "/cms/decision/get") {
          const doc = yield* decisionCms.get(DocumentId.make(body.documentId));
          return yield* HttpServerResponse.json({ ok: true, doc });
        }
      }

      // --- Topology F: the content domain (alchemy main) ---
      if (url.pathname.startsWith("/cms/content/")) {
        const toIds = (arr: unknown): Array<DocumentId> =>
          Array.isArray(arr) ? arr.map((id) => DocumentId.make(String(id))) : [];
        const options = body.commandId ? { commandId: String(body.commandId) } : undefined;
        const respond = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.flatMap((receipt) => HttpServerResponse.json({ ok: true, receipt })),
            Effect.catch((e) =>
              HttpServerResponse.json(
                { ok: false, error: e },
                { status: e._tag === "DocumentNotFound" ? 404 : 409 },
              ),
            ),
          );
        if (url.pathname === "/cms/content/import") {
          const counts = yield* seedContent(body.documents as ReadonlyArray<DocumentMeta>, {
            concurrency: body.concurrency ?? 16,
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true, counts });
        }
        if (url.pathname === "/cms/content/edit") {
          return yield* respond(
            content.edit(
              {
                episodeId: DocumentId.make(body.episodeId),
                expectedRevision: body.expectedRevision ?? null,
                title: body.title,
                bodyHash: body.bodyHash ?? "sha256:0",
                closerKind: body.closerKind ?? "none",
                clipOnlyMode: body.clipOnlyMode ?? false,
                audioMasterId: body.audioMasterId ? DocumentId.make(body.audioMasterId) : null,
                segmentIds: toIds(body.segmentIds),
                hostIds: toIds(body.hostIds),
                managedLinkIds: toIds(body.managedLinkIds),
                mediaAssetIds: toIds(body.mediaAssetIds),
              },
              options,
            ),
          );
        }
        if (url.pathname === "/cms/content/save-show") {
          return yield* respond(
            content.saveShow(
              {
                showId: DocumentId.make(body.showId),
                expectedRevision: body.expectedRevision ?? null,
                title: body.title,
                slug: body.slug,
                ownershipType: body.ownershipType,
              },
              options,
            ),
          );
        }
        if (url.pathname === "/cms/content/schedule") {
          return yield* respond(
            content.schedule(
              DocumentId.make(body.episodeId),
              toIds(body.showIds),
              body.slug ?? null,
              body.releaseDate ?? null,
              options,
            ),
          );
        }
        if (url.pathname === "/cms/content/publish") {
          return yield* respond(
            content.publish(
              DocumentId.make(body.episodeId),
              body.publishAudioMaster ?? false,
              options,
            ),
          );
        }
        if (url.pathname === "/cms/content/save-item") {
          return yield* respond(
            content.library.send(
              new SaveLibraryItem({
                itemId: DocumentId.make(body.itemId),
                expectedRevision: body.expectedRevision ?? null,
                kind: body.kind,
                title: body.title,
              }),
              options,
            ),
          );
        }
        if (url.pathname === "/cms/content/retire-item") {
          return yield* respond(
            content.library.send(
              new RetireLibraryItem({ itemId: DocumentId.make(body.itemId) }),
              options,
            ),
          );
        }
        if (url.pathname === "/cms/content/get-episode") {
          const episode = yield* content.episodes.get(DocumentId.make(body.episodeId));
          return yield* HttpServerResponse.json({ ok: true, episode });
        }
        if (url.pathname === "/cms/content/get-item") {
          const item = yield* content.library.get(DocumentId.make(body.itemId));
          return yield* HttpServerResponse.json({ ok: true, item });
        }
      }

      return HttpServerResponse.text("Not Found", { status: 404 });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          HttpServerResponse.text(JSON.stringify({ ok: false, defect: String(cause) }), {
            status: 500,
            contentType: "application/json",
          }),
        ),
      ),
    );

    return { fetch: handle };
  }).pipe(Effect.provide(ModelsLive)),
) {}
