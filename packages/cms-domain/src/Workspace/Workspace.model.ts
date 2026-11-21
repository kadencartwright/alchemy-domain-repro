import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { CatalogIndex, CatalogIndexLive } from "./CatalogIndex.projection.ts";
import { SearchCatalog, SearchCatalogLive } from "./SearchCatalog.query.ts";
import { Workspace } from "./Workspace.aggregate.ts";

export class WorkspaceCms extends Domain.Model("WorkspaceCms", {
  aggregates: [Workspace],
  projections: [CatalogIndex],
  queries: [SearchCatalog],
}) {}

export const WorkspaceCmsHandlers = Layer.mergeAll(CatalogIndexLive, SearchCatalogLive);

export class WorkspaceCmsApi extends Domain.Api("WorkspaceCmsApi", {
  model: WorkspaceCms,
  commands: [
    "SaveDraft",
    "BulkImportDocuments",
    "DeleteDocument",
    "PublishWorkspace",
    "SyncSegmentTags",
    "DiscardDraft",
  ],
  queries: ["SearchCatalog"],
}) {}
