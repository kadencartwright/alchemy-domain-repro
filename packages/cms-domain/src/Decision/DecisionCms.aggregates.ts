import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  AudioChapterSection,
  DocumentId,
  EpisodeCloserKind,
  OwnershipType,
  PodcastDocKind,
  Revision,
} from "../Ids.ts";
import { allStrongRefsOf, DocumentMeta } from "../Workspace/WorkspaceState.ts";

/**
 * Topology E — per-document aggregates + `Domain.Decision` (alchemy main).
 *
 * Every cross-document invariant gets an aggregate keyed by what it protects,
 * and every command that spans documents is a decision that reads them all:
 *
 * - `CmsDocument(documentId)`: one document's draft and published state.
 * - `UniqueClaim(claimKey)`: one unique value (a show slug per ownership type,
 *   an episode slug or release date per show), held by at most one document.
 * - `InboundRefs(documentId)`: which documents strongly reference this one
 *   (drafts and published), for delete-in-use.
 * - `SegmentEpisodes(segmentId)`: published episodes whose primary segment
 *   this is, for the tag cascade.
 */

export const ClaimKey = Schema.String.pipe(Schema.brand("ClaimKey"));
export type ClaimKey = typeof ClaimKey.Type;

export const DraftFields = {
  title: Schema.String,
  kind: PodcastDocKind,
  slug: Schema.NullOr(Schema.String),
  ownershipType: Schema.NullOr(OwnershipType),
  showIds: Schema.Array(DocumentId),
  releaseDate: Schema.NullOr(Schema.String),
  audioMasterId: Schema.NullOr(DocumentId),
  clipOnlyMode: Schema.Boolean,
  closerKind: EpisodeCloserKind,
  playableAudio: Schema.Boolean,
  durationSeconds: Schema.NullOr(Schema.Number),
  chapters: Schema.Array(AudioChapterSection),
  segmentIds: Schema.Array(DocumentId),
  hostIds: Schema.Array(DocumentId),
  tagIds: Schema.Array(DocumentId),
  managedLinkIds: Schema.Array(DocumentId),
  mediaAssetIds: Schema.Array(DocumentId),
  bodyHash: Schema.String,
  strongRefs: Schema.Array(DocumentId),
  strengthenOnPublish: Schema.Array(DocumentId),
  retiredAt: Schema.NullOr(Schema.Number),
};

// --- CmsDocument -----------------------------------------------------------

export class CmsDraftSaved extends Domain.Event("CmsDraftSaved", {
  ...DraftFields,
  revision: Revision,
  savedAt: Schema.Number,
}) {}

export class CmsDocumentPublished extends Domain.Event("CmsDocumentPublished", {
  publishedAt: Schema.Number,
}) {}

export class CmsDocumentDeleted extends Domain.Event("CmsDocumentDeleted", {
  deletedAt: Schema.Number,
}) {}

export class CmsTagsSynced extends Domain.Event("CmsTagsSynced", {
  tagIds: Schema.Array(DocumentId),
  syncedAt: Schema.Number,
}) {}

/** Loads an existing document (corpus seeding through `import`). */
export class CmsDocumentImported extends Domain.Event("CmsDocumentImported", {
  document: DocumentMeta,
}) {}

export const CmsDocumentState = Schema.NullOr(DocumentMeta);
export type CmsDocumentState = typeof CmsDocumentState.Type;

export class CmsDocument extends Domain.Aggregate("CmsDocument", {
  id: DocumentId,
  state: CmsDocumentState,
  initial: null,
  events: [
    CmsDraftSaved,
    CmsDocumentPublished,
    CmsDocumentDeleted,
    CmsTagsSynced,
    CmsDocumentImported,
  ],
  evolve: {
    CmsDraftSaved: (prev, e, envelope) => ({
      id: envelope.id,
      title: e.title,
      kind: e.kind,
      slug: e.slug,
      ownershipType: e.ownershipType,
      showIds: e.showIds,
      releaseDate: e.releaseDate,
      audioMasterId: e.audioMasterId,
      clipOnlyMode: e.clipOnlyMode,
      closerKind: e.closerKind,
      playableAudio: e.playableAudio,
      durationSeconds: e.durationSeconds,
      chapters: e.chapters,
      segmentIds: e.segmentIds,
      hostIds: e.hostIds,
      tagIds: e.tagIds,
      managedLinkIds: e.managedLinkIds,
      mediaAssetIds: e.mediaAssetIds,
      bodyHash: e.bodyHash,
      strongRefs: e.strongRefs,
      strengthenOnPublish: e.strengthenOnPublish,
      retiredAt: e.retiredAt,
      revision: e.revision,
      publishedRevision: prev?.publishedRevision ?? null,
      publishedTitle: prev?.publishedTitle ?? null,
      publishedReleaseDate: prev?.publishedReleaseDate ?? null,
      publishedBodyHash: prev?.publishedBodyHash ?? null,
      publishedStrongRefs: prev?.publishedStrongRefs ?? [],
      updatedAt: e.savedAt,
    }),
    CmsDocumentPublished: (doc, e) => {
      if (doc === null) return doc;
      const strongRefs = [...new Set([...doc.strongRefs, ...doc.strengthenOnPublish])];
      return {
        ...doc,
        strongRefs,
        strengthenOnPublish: [],
        publishedRevision: doc.revision,
        publishedTitle: doc.title,
        publishedReleaseDate: doc.releaseDate,
        publishedBodyHash: doc.bodyHash,
        publishedStrongRefs: allStrongRefsOf({ ...doc, strongRefs }),
        updatedAt: e.publishedAt,
      };
    },
    CmsDocumentDeleted: () => null,
    CmsTagsSynced: (doc, e) =>
      doc === null ? doc : { ...doc, tagIds: e.tagIds, updatedAt: e.syncedAt },
    CmsDocumentImported: (_, e) => e.document,
  },
}) {}

// --- UniqueClaim -----------------------------------------------------------

export class ClaimTaken extends Domain.Event("ClaimTaken", { documentId: DocumentId }) {}
export class ClaimReleased extends Domain.Event("ClaimReleased", { documentId: DocumentId }) {}

export class UniqueClaim extends Domain.Aggregate("UniqueClaim", {
  id: ClaimKey,
  state: Schema.Struct({ holder: Schema.NullOr(DocumentId) }),
  initial: { holder: null },
  events: [ClaimTaken, ClaimReleased],
  evolve: {
    ClaimTaken: (_, e) => ({ holder: e.documentId }),
    ClaimReleased: (s, e) => (s.holder === e.documentId ? { holder: null } : s),
  },
}) {}

// --- InboundRefs -----------------------------------------------------------

export class InboundRefAdded extends Domain.Event("InboundRefAdded", { referrerId: DocumentId }) {}
export class InboundRefRemoved extends Domain.Event("InboundRefRemoved", {
  referrerId: DocumentId,
}) {}
/** Seeds a target's referrers in one event (corpus seeding through `import`). */
export class InboundRefsImported extends Domain.Event("InboundRefsImported", {
  referrerIds: Schema.Array(DocumentId),
}) {}

export class InboundRefs extends Domain.Aggregate("InboundRefs", {
  id: DocumentId,
  state: Schema.Struct({ referrers: Schema.Record(Schema.String, Schema.Boolean) }),
  initial: { referrers: {} },
  events: [InboundRefAdded, InboundRefRemoved, InboundRefsImported],
  evolve: {
    InboundRefAdded: (s, e) => ({ referrers: { ...s.referrers, [e.referrerId]: true } }),
    InboundRefRemoved: (s, e) => {
      const referrers = { ...s.referrers };
      delete referrers[e.referrerId];
      return { referrers };
    },
    InboundRefsImported: (s, e) => {
      const referrers = { ...s.referrers };
      for (const id of e.referrerIds) referrers[id] = true;
      return { referrers };
    },
  },
}) {}

// --- SegmentEpisodes -------------------------------------------------------

export class SegmentEpisodeLinked extends Domain.Event("SegmentEpisodeLinked", {
  episodeId: DocumentId,
}) {}
export class SegmentEpisodeUnlinked extends Domain.Event("SegmentEpisodeUnlinked", {
  episodeId: DocumentId,
}) {}
/** Seeds a segment's published episodes in one event (corpus seeding through `import`). */
export class SegmentEpisodesImported extends Domain.Event("SegmentEpisodesImported", {
  episodeIds: Schema.Array(DocumentId),
}) {}

export class SegmentEpisodes extends Domain.Aggregate("SegmentEpisodes", {
  id: DocumentId,
  state: Schema.Struct({ episodes: Schema.Record(Schema.String, Schema.Boolean) }),
  initial: { episodes: {} },
  events: [SegmentEpisodeLinked, SegmentEpisodeUnlinked, SegmentEpisodesImported],
  evolve: {
    SegmentEpisodeLinked: (s, e) => ({ episodes: { ...s.episodes, [e.episodeId]: true } }),
    SegmentEpisodeUnlinked: (s, e) => {
      const episodes = { ...s.episodes };
      delete episodes[e.episodeId];
      return { episodes };
    },
    SegmentEpisodesImported: (s, e) => {
      const episodes = { ...s.episodes };
      for (const id of e.episodeIds) episodes[id] = true;
      return { episodes };
    },
  },
}) {}

// --- What a document implies about the other aggregates -------------------

type ClaimSource = Pick<
  DocumentMeta,
  "kind" | "slug" | "ownershipType" | "showIds" | "releaseDate"
>;

/** The unique values a document holds while it exists. */
export const claimKeysOf = (doc: ClaimSource | null): Array<ClaimKey> => {
  if (doc === null) return [];
  const keys: Array<ClaimKey> = [];
  if (doc.kind === "show" && doc.slug !== null && doc.ownershipType !== null) {
    keys.push(ClaimKey.make(`show-slug:${doc.ownershipType}:${doc.slug}`));
  }
  if (doc.kind === "episode") {
    for (const showId of doc.showIds) {
      if (doc.slug !== null) keys.push(ClaimKey.make(`episode-slug:${showId}:${doc.slug}`));
      if (doc.releaseDate !== null)
        keys.push(ClaimKey.make(`episode-date:${showId}:${doc.releaseDate}`));
    }
  }
  return keys;
};

/** Every document this one strongly references, in its draft or its published version. */
export const referencesOf = (doc: DocumentMeta | null): Array<DocumentId> =>
  doc === null ? [] : [...new Set([...allStrongRefsOf(doc), ...doc.publishedStrongRefs])];

/** The segment whose `SegmentEpisodes` lists this document, if any. */
export const indexedSegmentOf = (doc: DocumentMeta | null): DocumentId | null =>
  doc !== null && doc.kind === "episode" && doc.publishedRevision !== null
    ? (doc.segmentIds[0] ?? null)
    : null;

/**
 * What a caller that last read these documents names in a command's
 * `observed`: the claims they hold, the documents they reference, and the
 * segment indexes they sit in.
 */
export const observedFor = (
  docs: ReadonlyArray<DocumentMeta | null>,
): {
  claimKeys: Array<ClaimKey>;
  references: Array<DocumentId>;
  indexedSegments: Array<DocumentId>;
} => ({
  claimKeys: [...new Set(docs.flatMap((d) => claimKeysOf(d)))],
  references: [...new Set(docs.flatMap((d) => referencesOf(d)))],
  indexedSegments: [
    ...new Set(docs.flatMap((d) => (indexedSegmentOf(d) === null ? [] : [indexedSegmentOf(d)!]))),
  ],
});
