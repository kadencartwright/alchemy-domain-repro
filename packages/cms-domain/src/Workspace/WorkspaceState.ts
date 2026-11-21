import * as Schema from "effect/Schema";
import {
  AudioChapterSection,
  DocumentId,
  EpisodeCloserKind,
  OwnershipType,
  PodcastDocKind,
  Revision,
} from "../Ids.ts";

/**
 * Coordination metadata for one document inside the Podcast Network CMS.
 *
 * Large transcripts and rich-text show notes are ALREADY externalized as
 * `bodyHash` (immutable blob pointer) so this reproduces the O(N) state
 * rewrite and 2 MiB single-DO value cap even with lean metadata.
 */
export const DocumentMeta = Schema.Struct({
  id: DocumentId,
  title: Schema.String,
  kind: PodcastDocKind,
  /** Show slug (unique per ownershipType) or Episode slug (unique per owning show). */
  slug: Schema.NullOr(Schema.String),
  /** For `show`: internal curated vs partner B2B show. */
  ownershipType: Schema.NullOr(OwnershipType),
  /** For `episode` / `channelWelcome`: owning show references (episodes may belong to 1+ shows). */
  showIds: Schema.Array(DocumentId),
  /** ISO date YYYY-MM-DD when scheduled; unique per show among active episodes. */
  releaseDate: Schema.NullOr(Schema.String),
  /** For `episode`: strong ref to primary `audioMaster` (must be published + playable on publish). */
  audioMasterId: Schema.NullOr(DocumentId),
  /** For `episode`: clip-only mode (requires partner show + audioMaster with 1 valid highlight chapter). */
  clipOnlyMode: Schema.Boolean,
  /** Mutually exclusive episode closer (sharePrompt | bonusClip | outroVideo | none). */
  closerKind: EpisodeCloserKind,
  /** For `audioMaster`: whether a valid playable HTTP(S) audio asset is attached. */
  playableAudio: Schema.Boolean,
  /** For `audioMaster`: duration in seconds. */
  durationSeconds: Schema.NullOr(Schema.Number),
  /** For `audioMaster`: timed chapter sections with loudness metadata. */
  chapters: Schema.Array(AudioChapterSection),
  /** Reusable musical/editorial segments (`segmentIds[0]` drives cascading tag sync on episodes). */
  segmentIds: Schema.Array(DocumentId),
  /** Host / guest / producer references. */
  hostIds: Schema.Array(DocumentId),
  /** Hierarchical taxonomy tag references (synced from primary segment when linked). */
  tagIds: Schema.Array(DocumentId),
  /** Managed CTA / sponsor / show-note external links. */
  managedLinkIds: Schema.Array(DocumentId),
  /** Media asset references (cover art, ambient beds, intro/outro bumpers, PDF notes). */
  mediaAssetIds: Schema.Array(DocumentId),
  /** Externalized transcript / rich-text digest. */
  bodyHash: Schema.String,
  /** Additional explicit strong references. */
  strongRefs: Schema.Array(DocumentId),
  /** Weak references in draft that become strong on publish. */
  strengthenOnPublish: Schema.Array(DocumentId),
  /** For `channelWelcome`: permanent retirement tombstone timestamp. */
  retiredAt: Schema.NullOr(Schema.Number),
  revision: Revision,
  publishedRevision: Schema.NullOr(Revision),
  publishedTitle: Schema.NullOr(Schema.String),
  publishedReleaseDate: Schema.NullOr(Schema.String),
  publishedBodyHash: Schema.NullOr(Schema.String),
  publishedStrongRefs: Schema.Array(DocumentId),
  updatedAt: Schema.Number,
});
export type DocumentMeta = typeof DocumentMeta.Type;

export const allStrongRefsOf = (doc: {
  readonly showIds: ReadonlyArray<DocumentId>;
  readonly audioMasterId: DocumentId | null;
  readonly segmentIds: ReadonlyArray<DocumentId>;
  readonly hostIds: ReadonlyArray<DocumentId>;
  readonly tagIds: ReadonlyArray<DocumentId>;
  readonly managedLinkIds: ReadonlyArray<DocumentId>;
  readonly mediaAssetIds: ReadonlyArray<DocumentId>;
  readonly strongRefs: ReadonlyArray<DocumentId>;
}): Array<DocumentId> => {
  const out = new Set<DocumentId>();
  for (const id of doc.showIds) out.add(id);
  if (doc.audioMasterId !== null) out.add(doc.audioMasterId);
  for (const id of doc.segmentIds) out.add(id);
  for (const id of doc.hostIds) out.add(id);
  for (const id of doc.tagIds) out.add(id);
  for (const id of doc.managedLinkIds) out.add(id);
  for (const id of doc.mediaAssetIds) out.add(id);
  for (const id of doc.strongRefs) out.add(id);
  return [...out];
};

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
