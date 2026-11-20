import { performance } from "node:perf_hooks";
import { ContentDocument, SplitDocumentCms } from "@repro/cms-domain/Document/Document.aggregate";
import { SaveDocumentDraft } from "@repro/cms-domain/Document/Document.commands";
import { DocumentId, WorkspaceId } from "@repro/cms-domain/Ids";
import { MemoryCatalogStore } from "@repro/cms-domain/Workspace/CatalogStore";
import { SearchCatalog } from "@repro/cms-domain/Workspace/SearchCatalog.query";
import { Workspace } from "@repro/cms-domain/Workspace/Workspace.aggregate";
import { SaveDraft } from "@repro/cms-domain/Workspace/Workspace.commands";
import {
  WorkspaceCms,
  WorkspaceCmsApi,
  WorkspaceCmsHandlers,
} from "@repro/cms-domain/Workspace/Workspace.model";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createInstrumentedDoPlatform } from "./instrumented-do-platform.ts";

const CLOUDFLARE_KV_VALUE_LIMIT_BYTES = 128 * 1024; // 128 KiB per KV value

const formatKB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const runWorkspaceScalingProbe = (docCount: number) =>
  Effect.gen(function* () {
    const host = createInstrumentedDoPlatform();
    const modelLayer = WorkspaceCms.layer(
      WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)),
      { legacyData: false },
    ).pipe(Layer.provide(host.layer));

    const result = yield* Effect.gen(function* () {
      const workspace = yield* Workspace;
      const wsId = WorkspaceId.make(`ws-${docCount}`);

      // Seed `docCount` documents (bodies already externalized as sha256 hashes).
      for (let i = 0; i < docCount; i++) {
        const releaseDate =
          i === 0 ? null : new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
        yield* workspace.send(
          wsId,
          new SaveDraft({
            documentId: DocumentId.make(`doc-${String(i).padStart(5, "0")}`),
            expectedRevision: null,
            title: `Scheduled Editorial Article #${i} — Weekly Curriculum Series`,
            kind: i === 0 ? "asset" : "article",
            releaseDate,
            bodyHash: `sha256:${String(i).padStart(64, "0")}`,
            strongRefs: i === 0 ? [] : [DocumentId.make("doc-00000")],
            strengthenOnPublish: [],
          }),
          { commandId: `seed-${docCount}-${i}` },
        );
      }

      yield* host.drainBackground;
      host.resetCounters();

      // Measure 25 single-field title edits on doc-00001.
      const edits = 25;
      const targetDoc = DocumentId.make("doc-00001");
      const t0 = performance.now();
      for (let e = 0; e < edits; e++) {
        yield* workspace.send(
          wsId,
          new SaveDraft({
            documentId: targetDoc,
            expectedRevision: 1 + e,
            title: `Scheduled Editorial Article #1 (rev ${2 + e})`,
            kind: "article",
            releaseDate: "2026-01-02",
            bodyHash: `sha256:${String(e + 1000).padStart(64, "0")}`,
            strongRefs: [DocumentId.make("doc-00000")],
            strengthenOnPublish: [],
          }),
          { commandId: `edit-${docCount}-${e}` },
        );
      }
      const editMs = performance.now() - t0;
      yield* host.drainBackground;

      const metrics = host.inspectAll();
      const wsMetric = metrics.find((m) => m.className.includes("WorkspaceAggregate"))!;
      const projMetric = metrics.find((m) => m.className.includes("CatalogIndex"));

      return {
        docCount,
        metaBytes: wsMetric.metaBytes,
        exceeds128KiB: wsMetric.metaBytes > CLOUDFLARE_KV_VALUE_LIMIT_BYTES,
        msPerEdit: editMs / edits,
        putBytesPerEdit: Math.round(wsMetric.totalPutBytes / edits),
        putKeysPerEdit: +(wsMetric.putKeys / edits).toFixed(1),
        getsPerEdit: +(wsMetric.gets / edits).toFixed(1),
        totalWsKeys: wsMetric.totalStoredKeys,
        totalWsBytes: wsMetric.totalStoredBytes,
        projKeys: projMetric?.totalStoredKeys ?? 0,
        projPutKeysPerEdit: projMetric ? +(projMetric.putKeys / edits).toFixed(1) : 0,
        wsPrefixes: wsMetric.keysByPrefix,
        projPrefixes: projMetric?.keysByPrefix ?? {},
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
      const docId = DocumentId.make("doc-00001");

      yield* docs.send(
        docId,
        new SaveDocumentDraft({
          workspaceId: wsId,
          expectedRevision: null,
          title: "Scheduled Editorial Article #1",
          releaseDate: "2026-01-02",
          bodyHash: `sha256:${"1".padStart(64, "0")}`,
          strongRefs: [DocumentId.make("doc-00000")],
        }),
        { commandId: "split-seed" },
      );
      host.resetCounters();

      const edits = 25;
      const t0 = performance.now();
      for (let e = 0; e < edits; e++) {
        yield* docs.send(
          docId,
          new SaveDocumentDraft({
            workspaceId: wsId,
            expectedRevision: 1 + e,
            title: `Scheduled Editorial Article #1 (rev ${2 + e})`,
            releaseDate: "2026-01-02",
            bodyHash: `sha256:${String(e + 1000).padStart(64, "0")}`,
            strongRefs: [DocumentId.make("doc-00000")],
          }),
          { commandId: `split-edit-${e}` },
        );
      }
      const editMs = performance.now() - t0;
      const metric = host.inspectAll().find((m) => m.className.includes("ContentDocumentAggregate"))!;
      return {
        metaBytes: metric.metaBytes,
        msPerEdit: editMs / edits,
        putBytesPerEdit: Math.round(metric.totalPutBytes / edits),
        putKeysPerEdit: +(metric.putKeys / edits).toFixed(1),
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
      const docId = DocumentId.make("doc-ryw");

      const t0 = performance.now();
      const receipt = yield* api.SaveDraft(
        wsId,
        {
          documentId: docId,
          expectedRevision: null,
          title: "Freshly Saved Article",
          kind: "article",
          releaseDate: "2026-11-25",
          bodyHash: "sha256:fresh",
          strongRefs: [],
          strengthenOnPublish: [],
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
  console.log("=== Case 1: CMS Probes (@alchemy.run/domain 2.0.0-beta.87 DurableObjects) ===\n");

  const sizes = [10, 100, 350, 500, 750];
  console.log("1) Workspace-as-Aggregate single-field edit cost vs workspace size:");
  console.log(
    "| Docs | `meta` size | >128 KiB KV? | Put bytes/edit | Put keys/edit (Agg / Proj) | ms/edit (local SQLite) | Total Agg keys |",
  );
  console.log("|---:|---:|:---:|---:|---:|---:|---:|");

  for (const n of sizes) {
    const r = yield* runWorkspaceScalingProbe(n);
    console.log(
      `| ${r.docCount} | ${formatKB(r.metaBytes)} | ${r.exceeds128KiB ? "YES" : "no"} | ${formatKB(r.putBytesPerEdit)} | ${r.putKeysPerEdit} / ${r.projPutKeysPerEdit} | ${r.msPerEdit.toFixed(2)} ms | ${r.totalWsKeys} |`,
    );
    if (n === 750) {
      console.log("\n   Stored key prefixes in 750-doc Workspace DO (no built-in compaction):");
      for (const [prefix, stats] of Object.entries(r.wsPrefixes).sort()) {
        console.log(`   - ${prefix.padEnd(14)} ${String(stats.count).padStart(5)} keys  (${formatKB(stats.bytes)})`);
      }
      if (Object.keys(r.projPrefixes).length > 0) {
        console.log("\n   Stored key prefixes in CatalogIndex Projection DO:");
        for (const [prefix, stats] of Object.entries(r.projPrefixes).sort()) {
          console.log(`   - ${prefix.padEnd(14)} ${String(stats.count).padStart(5)} keys  (${formatKB(stats.bytes)})`);
        }
      }
    }
  }

  console.log("\n2) Split ContentDocument aggregate baseline (same 25 single-field edits):");
  const split = yield* runSplitComparisonProbe();
  console.log(
    `   meta=${formatKB(split.metaBytes)}, putBytes/edit=${formatKB(split.putBytesPerEdit)}, putKeys/edit=${split.putKeysPerEdit}, ms/edit=${split.msPerEdit.toFixed(2)} ms`,
  );
  console.log(
    "   (Flat O(1) edit size, but loses atomic cross-doc strong-ref checks and atomic multi-doc publish.)",
  );

  console.log("\n3) Read-your-writes via Domain.Query `atLeast` (5 ms commit + 5 ms DO RPC, 25 ms projection batch wait):");
  const ryw = yield* runReadYourWritesProbe();
  console.log(
    `   SaveDraft=${ryw.saveMs} ms, SearchCatalog(atLeast)=${ryw.queryCatchUpMs} ms, rows=${ryw.matchedRows}`,
  );
});

Effect.runPromise(main.pipe(Effect.provide(SecureRandom.layerWebCrypto))).catch((err) => {
  console.error(err);
  process.exit(1);
});
