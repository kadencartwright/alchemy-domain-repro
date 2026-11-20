import * as Schema from "effect/Schema";
import { DocumentId, Revision } from "../Ids.ts";

/**
 * Metadata for one document inside a workspace.
 *
 * Large editorial bodies are ALREADY externalized as `bodyHash` (e.g. R2/blob
 * storage) so this reproduces the O(N) state rewrite problem even when only
 * coordination metadata (title, schedule date, references, revisions) lives in
 * the aggregate.
 */
export const DocumentMeta = Schema.Struct({
  id: DocumentId,
  title: Schema.String,
  kind: Schema.Literals(["article", "series", "asset"]),
  /** ISO date YYYY-MM-DD when scheduled; unique per workspace among active articles. */
  releaseDate: Schema.NullOr(Schema.String),
  /** Externalized content digest (e.g. immutable blob pointer). */
  bodyHash: Schema.String,
  /** Strong references that MUST exist and block target deletion. */
  strongRefs: Schema.Array(DocumentId),
  /** References that are weak in draft and become strong on publish. */
  strengthenOnPublish: Schema.Array(DocumentId),
  revision: Revision,
  publishedRevision: Schema.NullOr(Revision),
  publishedTitle: Schema.NullOr(Schema.String),
  publishedReleaseDate: Schema.NullOr(Schema.String),
  publishedBodyHash: Schema.NullOr(Schema.String),
  publishedStrongRefs: Schema.Array(DocumentId),
  updatedAt: Schema.Number,
});
export type DocumentMeta = typeof DocumentMeta.Type;

export const WorkspaceState = Schema.Struct({
  version: Schema.Int,
  documents: Schema.Record(Schema.String, DocumentMeta),
  publishedTransactionCount: Schema.Int,
});
export type WorkspaceState = typeof WorkspaceState.Type;

export const initialWorkspaceState: WorkspaceState = {
  version: 0,
  documents: {},
  publishedTransactionCount: 0,
};
