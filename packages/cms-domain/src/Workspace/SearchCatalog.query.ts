import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PodcastDocKind, WorkspaceId } from "../Ids.ts";
import { CatalogIndex } from "./CatalogIndex.projection.ts";
import { CatalogRow, CatalogStore } from "./CatalogStore.ts";

/**
 * Ad-hoc filtered/paginated catalog query backed by the external CatalogStore.
 *
 * Uses @alchemy.run/domain 2.0.0-beta.87's `waitsFor` so callers can pass
 * `{ atLeast: receipt }` for read-your-writes after a single aggregate commit.
 */
export class SearchCatalog extends Domain.Query("SearchCatalog", {
  input: {
    workspaceId: WorkspaceId,
    query: Schema.optional(Schema.String),
    kind: Schema.optional(PodcastDocKind),
    publishedOnly: Schema.optional(Schema.Boolean),
  },
  success: CatalogRow,
  paged: true,
  waitsFor: [CatalogIndex],
}) {}

export const SearchCatalogLive = SearchCatalog.toLayer(
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    return Effect.fn(function* (input, page) {
      return yield* store.search({
        workspaceId: input.workspaceId,
        query: input.query,
        kind: input.kind,
        publishedOnly: input.publishedOnly,
        after: page.after,
        take: page.take,
      });
    });
  }),
  { take: { default: 50, max: 200 } },
);
