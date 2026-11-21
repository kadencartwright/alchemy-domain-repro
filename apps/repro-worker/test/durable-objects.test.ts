import { it } from "@effect/vitest";
import { DocumentId, WorkspaceId } from "@repro/cms-domain/Ids";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import { Workspace } from "@repro/cms-domain/Workspace/Workspace.aggregate";
import { SaveDraft } from "@repro/cms-domain/Workspace/Workspace.commands";
import {
  WorkspaceCms,
  WorkspaceCmsApi,
  WorkspaceCmsHandlers,
} from "@repro/cms-domain/Workspace/Workspace.model";
import { Market } from "@repro/quota-domain/Market/Market.aggregate";
import { AllocateOpportunity, UpsertCampaign } from "@repro/quota-domain/Market/Market.commands";
import { MarketQuotaHandlers, MarketQuotaModel } from "@repro/quota-domain/Quota.model";
import { CampaignId, MarketId, OpportunityId } from "@repro/quota-domain/Types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vitest";
import { createInstrumentedDoPlatform } from "../scripts/instrumented-do-platform.ts";

const podcastDraft = (overrides: {
  workspaceId?: WorkspaceId;
  documentId: DocumentId;
  expectedRevision: number | null;
  title: string;
  kind: "show" | "episode" | "mediaAsset";
  slug?: string | null;
  ownershipType?: "internal" | "partner" | null;
  showIds?: ReadonlyArray<DocumentId>;
  releaseDate?: string | null;
  bodyHash: string;
}) => ({
  workspaceId: overrides.workspaceId ?? WorkspaceId.make("ws-default"),
  documentId: overrides.documentId,
  expectedRevision: overrides.expectedRevision,
  title: overrides.title,
  kind: overrides.kind,
  slug: overrides.slug ?? null,
  ownershipType: overrides.ownershipType ?? null,
  showIds: overrides.showIds ?? [],
  releaseDate: overrides.releaseDate ?? null,
  audioMasterId: null,
  clipOnlyMode: false,
  closerKind: "none" as const,
  playableAudio: false,
  durationSeconds: null,
  chapters: [],
  segmentIds: [],
  hostIds: [],
  tagIds: [],
  managedLinkIds: [],
  mediaAssetIds: [],
  bodyHash: overrides.bodyHash,
  strongRefs: [],
  strengthenOnPublish: [],
  retiredAt: null,
});

it.live("CMS Workspace DO rewrites full meta blob on each single-field edit", () =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform();
    const layer = WorkspaceCms.layer(WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)), {
      legacyData: false,
    }).pipe(Layer.provide(host.layer));

    yield* Effect.gen(function* () {
      const workspace = yield* Workspace;
      const wsId = WorkspaceId.make("test-ws");
      const showId = DocumentId.make("show-0");
      yield* workspace.send(
        new SaveDraft({
          ...podcastDraft({
            documentId: showId,
            expectedRevision: null,
            title: "Main Show",
            kind: "show",
            slug: "main-show",
            ownershipType: "internal",
            bodyHash: "sha256:show-0",
          }),
          workspaceId: wsId,
        }),
        { commandId: "seed-show" },
      );
      for (let i = 0; i < 40; i++) {
        yield* workspace.send(
          new SaveDraft({
            ...podcastDraft({
              documentId: DocumentId.make(`ep-${i}`),
              expectedRevision: null,
              title: `Episode ${i}`,
              kind: "episode",
              slug: `ep-${i}`,
              showIds: [showId],
              releaseDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
              bodyHash: `sha256:${String(i).padStart(64, "0")}`,
            }),
            workspaceId: wsId,
          }),
          { commandId: `seed-${i}` },
        );
      }
      yield* host.drainBackground;
      host.resetCounters();

      yield* workspace.send(
        new SaveDraft({
          ...podcastDraft({
            documentId: DocumentId.make("ep-0"),
            expectedRevision: 1,
            title: "Episode 0 Edited",
            kind: "episode",
            slug: "ep-0",
            showIds: [showId],
            releaseDate: "2026-01-01",
            bodyHash: `sha256:${"0".padStart(64, "0")}`,
          }),
          workspaceId: wsId,
        }),
        { commandId: "edit-0" },
      );
      yield* host.drainBackground;

      const wsMetric = host.inspectAll().find((m) => m.instanceName === "test-ws")!;
      expect(wsMetric.metaBytes).toBeGreaterThan(15_000);
      expect(wsMetric.totalPutBytes).toBeGreaterThan(wsMetric.metaBytes);
    }).pipe(Effect.provide(layer));

    yield* host.close;
  }),
);

it.live("Quota Market DO + ScheduleLeaseExpiry accumulates per-reservation callback keys", () =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform();
    const layer = MarketQuotaModel.layer(MarketQuotaHandlers, { legacyData: false }).pipe(
      Layer.provide(host.layer),
    );

    yield* Effect.gen(function* () {
      const market = yield* Market;
      const mId = MarketId.make("test-market");
      yield* market.send(
        new UpsertCampaign({
          marketId: mId,
          campaignId: CampaignId.make("camp-1"),
          name: "Test Sponsor",
          weight: 10,
          audience: "all",
          startAt: 0,
          endAt: Date.UTC(2028, 0, 1),
          bundlePriceCents: 10_000,
          creativeVersion: 1,
          requireCompanion: true,
          standalonePrimaryApproved: false,
          standaloneCompanionApproved: false,
          active: true,
          targets: { primary: 100, companion: 100, secondary: 0 },
        }),
        { commandId: "camp-setup" },
      );

      for (let i = 0; i < 10; i++) {
        yield* market.send(
          new AllocateOpportunity({
            marketId: mId,
            opportunityId: OpportunityId.make(`opp-${i}`),
            audience: "free",
            leaseTtlMs: 60_000,
          }),
          { commandId: `alloc-${i}` },
        );
      }
      yield* host.drainBackground;

      const marketMetric = host.inspectAll().find((m) => m.className.includes("MarketAggregate"))!;
      expect(marketMetric.keysByPrefix["armed:*"]?.count).toBe(20);
      expect(marketMetric.keysByPrefix["scheduled:*"]?.count).toBe(20);
      expect(marketMetric.keysByPrefix["cb:*"]?.count).toBeGreaterThanOrEqual(20);
    }).pipe(Effect.provide(layer));

    yield* host.close;
  }),
);

it.live("WorkspaceCmsApi supports read-your-writes Query via atLeast", () =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform();
    const layer = WorkspaceCms.layer(WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)), {
      legacyData: false,
    }).pipe(Layer.provide(host.layer));

    yield* Effect.gen(function* () {
      const api = yield* WorkspaceCmsApi.clientInProcess;
      const wsId = WorkspaceId.make("ws-api");
      const receipt = yield* api.SaveDraft(
        podcastDraft({
          workspaceId: wsId,
          documentId: DocumentId.make("ep-ryw"),
          expectedRevision: null,
          title: "Indexed Podcast Episode",
          kind: "episode",
          slug: "indexed-podcast-episode",
          releaseDate: "2026-11-24",
          bodyHash: "sha256:a",
        }),
        { commandId: "api-1" },
      );
      const page = yield* api.SearchCatalog(
        { workspaceId: wsId, query: "Indexed" },
        { atLeast: receipt },
      );
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.title).toBe("Indexed Podcast Episode");
    }).pipe(Effect.scoped, Effect.provide(layer));

    yield* host.close;
  }),
);
