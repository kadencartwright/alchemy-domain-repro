import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { CatalogStore, type CatalogRow } from "./CatalogStore.ts";
import { Workspace } from "./Workspace.aggregate.ts";
import { DocumentDeleted, DraftSaved, WorkspacePublished } from "./Workspace.commands.ts";

/**
 * Projects Workspace mutations into an external queryable catalog store.
 *
 * Uses @alchemy.run/domain 2.0.0-beta.87 projection batching.
 * Note: even with `batch`, the aggregate still drains its outbox serially
 * key-by-key, and the projection DO persists an `in:<seq>` log row for every
 * incoming delivery with no built-in compaction.
 */
export class CatalogIndex extends Domain.Projection("CatalogIndex", {
  from: [Workspace],
  key: Workspace,
  on: [DraftSaved, DocumentDeleted, WorkspacePublished],
}) {}

export const CatalogIndexLive = CatalogIndex.toLayer(
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    return Effect.fn(function* (batch) {
      const upserts: Array<CatalogRow> = [];
      for (const { key, event } of batch) {
        if (event._tag === "DraftSaved") {
          upserts.push({
            workspaceId: key.id,
            documentId: event.documentId,
            title: event.title,
            kind: event.kind,
            releaseDate: event.releaseDate,
            revision: event.revision,
            published: false,
            updatedAt: event.savedAt,
          });
        } else if (event._tag === "WorkspacePublished") {
          if (upserts.length > 0) {
            yield* store.upsertBatch(upserts.splice(0, upserts.length));
          }
          yield* store.markPublished(key.id, event.documentIds);
        } else if (event._tag === "DocumentDeleted") {
          if (upserts.length > 0) {
            yield* store.upsertBatch(upserts.splice(0, upserts.length));
          }
          yield* store.remove(key.id, event.documentId);
        }
      }
      if (upserts.length > 0) {
        yield* store.upsertBatch(upserts);
      }
    });
  }),
  { batch: { size: 50, wait: "25 millis" } },
);
