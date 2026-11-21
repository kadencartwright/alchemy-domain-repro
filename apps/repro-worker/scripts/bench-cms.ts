import { performance } from "node:perf_hooks";
import { ContentDocument, SplitDocumentCms } from "@repro/cms-domain/Document/Document.aggregate";
import { SaveDocumentDraft } from "@repro/cms-domain/Document/Document.commands";
import { DocumentId, WorkspaceId } from "@repro/cms-domain/Ids";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import { SearchCatalog } from "@repro/cms-domain/Workspace/SearchCatalog.query";
import { Workspace } from "@repro/cms-domain/Workspace/Workspace.aggregate";
import { BulkImportDocuments, SaveDraft } from "@repro/cms-domain/Workspace/Workspace.commands";
import {
  WorkspaceCms,
  WorkspaceCmsApi,
  WorkspaceCmsHandlers,
} from "@repro/cms-domain/Workspace/Workspace.model";
import type { DocumentMeta } from "@repro/cms-domain/Workspace/WorkspaceState";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  generateCmsTape,
  SQLITE_DO_SINGLE_VALUE_LIMIT_BYTES,
} from "../benchmarks/synthetic-tapes.ts";
import { createInstrumentedDoPlatform } from "./instrumented-do-platform.ts";

const formatKB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const toDocumentMeta = (
  d: ReturnType<typeof generateCmsTape>["seedDocs"][number],
): DocumentMeta => ({
  id: DocumentId.make(d.documentId),
  title: d.title,
  kind: d.kind,
  slug: d.slug,
  ownershipType: d.ownershipType,
  showIds: d.showIds.map((id) => DocumentId.make(id)),
  releaseDate: d.releaseDate,
  audioMasterId: d.audioMasterId ? DocumentId.make(d.audioMasterId) : null,
  clipOnlyMode: d.clipOnlyMode,
  closerKind: d.closerKind,
  playableAudio: d.playableAudio,
  durationSeconds: d.durationSeconds,
  chapters: d.chapters,
  segmentIds: d.segmentIds.map((id) => DocumentId.make(id)),
  hostIds: d.hostIds.map((id) => DocumentId.make(id)),
  managedLinkIds: d.managedLinkIds.map((id) => DocumentId.make(id)),
  mediaAssetIds: d.mediaAssetIds.map((id) => DocumentId.make(id)),
  bodyHash: d.bodyHash,
  strongRefs: d.strongRefs.map((id) => DocumentId.make(id)),
  strengthenOnPublish: [],
  retiredAt: null,
  revision: 1,
  publishedRevision: d.published ? 1 : null,
  publishedTitle: d.published ? d.title : null,
  publishedReleaseDate: d.published ? d.releaseDate : null,
  publishedBodyHash: d.published ? d.bodyHash : null,
  publishedStrongRefs: [],
  updatedAt: Date.UTC(2026, 10, 20, 12, 0, 0),
});

const runWorkspaceScalingProbe = (docCount: number) =>
  Effect.gen(function* () {
    const tape = generateCmsTape(docCount, 20);
    const host = createInstrumentedDoPlatform();
    const modelLayer = WorkspaceCms.layer(
      WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)),
      { legacyData: false },
    ).pipe(Layer.provide(host.layer));

    const result = yield* Effect.gen(function* () {
      const workspace = yield* Workspace;
      const wsId = WorkspaceId.make(`ws-${docCount}`);

      yield* workspace.send(
        new BulkImportDocuments({
          workspaceId: wsId,
          documents: tape.seedDocs.map(toDocumentMeta),
        }),
        { commandId: `bulk-${docCount}` },
      );
      yield* host.drainBackground;
      host.resetCounters();

      const editDoc = tape.seedDocs.find((d) => d.documentId === tape.fixtures.editEpisodeId)!;
      const edits = docCount >= 5000 ? 5 : 20;
      const t0 = performance.now();
      for (let e = 0; e < edits; e++) {
        yield* workspace.send(
          new SaveDraft({
            workspaceId: wsId,
            documentId: DocumentId.make(editDoc.documentId),
            expectedRevision: 1 + e,
            title: `${editDoc.title} (rev ${2 + e})`,
            kind: editDoc.kind,
            slug: editDoc.slug,
            ownershipType: editDoc.ownershipType,
            showIds: editDoc.showIds.map((id) => DocumentId.make(id)),
            releaseDate: editDoc.releaseDate,
            audioMasterId: editDoc.audioMasterId ? DocumentId.make(editDoc.audioMasterId) : null,
            clipOnlyMode: editDoc.clipOnlyMode,
            closerKind: editDoc.closerKind,
            playableAudio: editDoc.playableAudio,
            durationSeconds: editDoc.durationSeconds,
            chapters: editDoc.chapters,
            segmentIds: editDoc.segmentIds.map((id) => DocumentId.make(id)),
            hostIds: editDoc.hostIds.map((id) => DocumentId.make(id)),
            managedLinkIds: editDoc.managedLinkIds.map((id) => DocumentId.make(id)),
            mediaAssetIds: editDoc.mediaAssetIds.map((id) => DocumentId.make(id)),
            bodyHash: `sha256:${String(e + 1000).padStart(64, "0")}`,
            strongRefs: editDoc.strongRefs.map((id) => DocumentId.make(id)),
            strengthenOnPublish: [],
            retiredAt: null,
          }),
          { commandId: `edit-${docCount}-${e}` },
        );
      }
      const editMs = performance.now() - t0;
      yield* host.drainBackground;

      const wsMetric = host.inspectAll().find((m) => m.instanceName === `ws-${docCount}`)!;
      return {
        docCount,
        metaBytes: wsMetric.metaBytes,
        pctOf2MiB: +((wsMetric.metaBytes / SQLITE_DO_SINGLE_VALUE_LIMIT_BYTES) * 100).toFixed(1),
        msPerEdit: editMs / edits,
        putBytesPerEdit: Math.round(wsMetric.totalPutBytes / edits),
        putKeysPerEdit: +(wsMetric.putKeys / edits).toFixed(1),
      };
    }).pipe(Effect.provide(modelLayer));

    yield* host.close;
    return result;
  });

const runSplitComparisonProbe = () =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform();
    const modelLayer = SplitDocumentCms.layer(Layer.empty, { legacyData: false }).pipe(
      Layer.provide(host.layer),
    );

    const result = yield* Effect.gen(function* () {
      const docs = yield* ContentDocument;
      const wsId = WorkspaceId.make("ws-split");
      const docId = DocumentId.make("ep-00000");

      yield* docs.send(
        new SaveDocumentDraft({
          documentId: docId,
          workspaceId: wsId,
          expectedRevision: null,
          title: "Podcast Episode #0",
          releaseDate: "2024-01-02",
          bodyHash: `sha256:${"1".padStart(64, "0")}`,
          strongRefs: [DocumentId.make("master-00000")],
        }),
        { commandId: "split-seed" },
      );
      host.resetCounters();

      const edits = 20;
      const t0 = performance.now();
      for (let e = 0; e < edits; e++) {
        yield* docs.send(
          new SaveDocumentDraft({
            documentId: docId,
            workspaceId: wsId,
            expectedRevision: 1 + e,
            title: `Podcast Episode #0 (rev ${2 + e})`,
            releaseDate: "2024-01-02",
            bodyHash: `sha256:${String(e + 1000).padStart(64, "0")}`,
            strongRefs: [DocumentId.make("master-00000")],
          }),
          { commandId: `split-edit-${e}` },
        );
      }
      const editMs = performance.now() - t0;
      const metric = host.inspectAll().find((m) => m.instanceName === "ep-00000")!;
      return {
        metaBytes: metric.metaBytes,
        msPerEdit: editMs / edits,
        putBytesPerEdit: Math.round(metric.totalPutBytes / edits),
      };
    }).pipe(Effect.provide(modelLayer));

    yield* host.close;
    return result;
  });

const runReadYourWritesProbe = () =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform({ commitDelayMs: 5, rpcDelayMs: 5 });
    const modelLayer = WorkspaceCms.layer(
      WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)),
      { legacyData: false },
    ).pipe(Layer.provide(host.layer));

    const result = yield* Effect.gen(function* () {
      const api = yield* WorkspaceCmsApi.clientInProcess;
      const wsId = WorkspaceId.make("ws-ryw");
      const docId = DocumentId.make("ep-ryw");

      const t0 = performance.now();
      const receipt = yield* api.SaveDraft(
        {
          workspaceId: wsId,
          documentId: docId,
          expectedRevision: null,
          title: "Freshly Saved Episode",
          kind: "episode",
          slug: "freshly-saved-episode",
          ownershipType: null,
          showIds: [],
          releaseDate: "2026-11-25",
          audioMasterId: null,
          clipOnlyMode: false,
          closerKind: "none",
          playableAudio: false,
          durationSeconds: null,
          chapters: [],
          segmentIds: [],
          hostIds: [],
          managedLinkIds: [],
          mediaAssetIds: [],
          bodyHash: "sha256:fresh",
          strongRefs: [],
          strengthenOnPublish: [],
          retiredAt: null,
        },
        { commandId: "ryw-1" },
      );
      const saveMs = performance.now() - t0;

      const t1 = performance.now();
      const page = yield* api.SearchCatalog(
        { workspaceId: wsId, query: "Freshly" },
        { atLeast: receipt },
      );
      const queryMs = performance.now() - t1;

      return {
        saveMs: +saveMs.toFixed(1),
        queryCatchUpMs: +queryMs.toFixed(1),
        matchedRows: page.entries.length,
      };
    }).pipe(Effect.scoped, Effect.provide(modelLayer));

    yield* host.close;
    return result;
  });

const main = Effect.gen(function* () {
  console.log("=== Case 2: Podcast Network CMS Probes (up to 25,000 docs on DurableObjects) ===\n");
  const sizes = [100, 500, 2_500, 25_000];
  console.log(
    "| Docs | `meta` size | % of 2 MiB SQLite DO cap | Put bytes/edit | ms/edit (local SQLite) |",
  );
  console.log("|---:|---:|---:|---:|---:|");

  for (const n of sizes) {
    const r = yield* runWorkspaceScalingProbe(n);
    console.log(
      `| ${r.docCount.toLocaleString()} | ${formatKB(r.metaBytes)} | ${r.pctOf2MiB}% | ${formatKB(r.putBytesPerEdit)} | ${r.msPerEdit.toFixed(2)} ms |`,
    );
  }

  console.log("\nSplit ContentDocument baseline (same 20 edits):");
  const split = yield* runSplitComparisonProbe();
  console.log(
    `  meta=${formatKB(split.metaBytes)}, putBytes/edit=${formatKB(split.putBytesPerEdit)}, ms/edit=${split.msPerEdit.toFixed(2)} ms`,
  );

  console.log(
    "\nRead-your-writes via Domain.Query `atLeast` (5 ms commit + 5 ms RPC, 25 ms batch wait):",
  );
  const ryw = yield* runReadYourWritesProbe();
  console.log(
    `  SaveDraft=${ryw.saveMs} ms, SearchCatalog(atLeast)=${ryw.queryCatchUpMs} ms, rows=${ryw.matchedRows}`,
  );
});

Effect.runPromise(main.pipe(Effect.provide(SecureRandom.layerWebCrypto))).catch((err) => {
  console.error(err);
  process.exit(1);
});
