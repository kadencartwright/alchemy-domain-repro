import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DocumentId, PodcastDocKind, Revision, WorkspaceId } from "../Ids.ts";

export const CatalogRow = Schema.Struct({
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  title: Schema.String,
  kind: PodcastDocKind,
  releaseDate: Schema.NullOr(Schema.String),
  revision: Revision,
  published: Schema.Boolean,
  updatedAt: Schema.Number,
});
export type CatalogRow = typeof CatalogRow.Type;

export interface CatalogPage {
  readonly entries: ReadonlyArray<CatalogRow>;
  readonly cursor: string | null;
}

export interface CatalogSearchParams {
  readonly workspaceId: WorkspaceId;
  readonly query?: string;
  readonly kind?: PodcastDocKind;
  readonly publishedOnly?: boolean;
  readonly after?: string | null;
  readonly take: number;
}

export class CatalogStore extends Context.Service<
  CatalogStore,
  {
    readonly upsertBatch: (rows: ReadonlyArray<CatalogRow>) => Effect.Effect<void>;
    readonly markPublished: (
      workspaceId: WorkspaceId,
      documentIds: ReadonlyArray<DocumentId>,
    ) => Effect.Effect<void>;
    readonly remove: (workspaceId: WorkspaceId, documentId: DocumentId) => Effect.Effect<void>;
    readonly search: (params: CatalogSearchParams) => Effect.Effect<CatalogPage>;
    readonly stats: () => Effect.Effect<{ readonly totalRows: number; readonly writes: number }>;
  }
>()("Repro/CatalogStore") {}

export const MemoryCatalogStore = Layer.sync(CatalogStore, () => {
  const rows = new Map<string, CatalogRow>();
  let writes = 0;
  const keyOf = (workspaceId: string, documentId: string) => `${workspaceId}:${documentId}`;

  return {
    upsertBatch: (batch) =>
      Effect.sync(() => {
        for (const row of batch) {
          rows.set(keyOf(row.workspaceId, row.documentId), row);
          writes += 1;
        }
      }),
    markPublished: (workspaceId, documentIds) =>
      Effect.sync(() => {
        for (const id of documentIds) {
          const existing = rows.get(keyOf(workspaceId, id));
          if (existing) {
            rows.set(keyOf(workspaceId, id), { ...existing, published: true });
            writes += 1;
          }
        }
      }),
    remove: (workspaceId, documentId) =>
      Effect.sync(() => {
        rows.delete(keyOf(workspaceId, documentId));
        writes += 1;
      }),
    search: ({ workspaceId, query, kind, publishedOnly, after, take }) =>
      Effect.sync(() => {
        const needle = query?.trim().toLowerCase();
        const filtered = [...rows.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .filter((row) => (kind ? row.kind === kind : true))
          .filter((row) => (publishedOnly ? row.published : true))
          .filter((row) => (needle ? row.title.toLowerCase().includes(needle) : true))
          .sort((a, b) => a.documentId.localeCompare(b.documentId));

        const startIdx = after ? filtered.findIndex((row) => row.documentId > after) : 0;
        const slice = startIdx === -1 ? [] : filtered.slice(startIdx, startIdx + take);
        const last = slice.at(-1);
        const hasMore = startIdx !== -1 && startIdx + slice.length < filtered.length;
        return {
          entries: slice,
          cursor: hasMore && last ? last.documentId : null,
        };
      }),
    stats: () => Effect.sync(() => ({ totalRows: rows.size, writes })),
  };
});
