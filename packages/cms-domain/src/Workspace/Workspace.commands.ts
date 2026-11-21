import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  AudioChapterSection,
  DocumentId,
  EpisodeCloserKind,
  OwnershipType,
  PodcastDocKind,
  Revision,
  WorkspaceId,
} from "../Ids.ts";
import {
  ClipOnlyRuleViolation,
  DocumentNotFound,
  PublishReadinessViolation,
  RevisionConflict,
  ScheduleDateConflict,
  SlugConflict,
  StrongReferenceViolation,
} from "./WorkspaceRule.rejection.ts";
import { DocumentMeta } from "./WorkspaceState.ts";

const DraftPayloadFields = {
  documentId: DocumentId,
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

export class DraftSaved extends Domain.Event("DraftSaved", {
  ...DraftPayloadFields,
  revision: Revision,
  savedAt: Schema.Number,
}) {}

export class CorpusBatchImported extends Domain.Event("CorpusBatchImported", {
  documents: Schema.Array(DocumentMeta),
}) {}

export class DocumentDeleted extends Domain.Event("DocumentDeleted", {
  documentId: DocumentId,
  deletedAt: Schema.Number,
}) {}

export class WorkspacePublished extends Domain.Event("WorkspacePublished", {
  documentIds: Schema.Array(DocumentId),
  publishedAt: Schema.Number,
}) {}

export class SegmentTagsCascaded extends Domain.Event("SegmentTagsCascaded", {
  segmentId: DocumentId,
  tagIds: Schema.Array(DocumentId),
  updatedEpisodeIds: Schema.Array(DocumentId),
  syncedAt: Schema.Number,
}) {}

export class DraftDiscarded extends Domain.Event("DraftDiscarded", {
  documentId: DocumentId,
  restoredRevision: Revision,
  discardedAt: Schema.Number,
}) {}

export class SaveDraft extends Domain.Command("SaveDraft", {
  target: WorkspaceId,
  input: {
    ...DraftPayloadFields,
    expectedRevision: Schema.NullOr(Revision),
  },
  events: [DraftSaved],
  rejects: [
    RevisionConflict,
    ScheduleDateConflict,
    SlugConflict,
    StrongReferenceViolation,
    ClipOnlyRuleViolation,
  ],
  reply: { documentId: DocumentId, revision: Revision },
}) {}

/** Realistic bulk-import command (analogous to CSV / series episode batch import). */
export class BulkImportDocuments extends Domain.Command("BulkImportDocuments", {
  target: WorkspaceId,
  input: {
    documents: Schema.Array(DocumentMeta),
  },
  events: [CorpusBatchImported],
  rejects: [],
  reply: { importedCount: Schema.Int },
}) {}

export class DeleteDocument extends Domain.Command("DeleteDocument", {
  target: WorkspaceId,
  input: {
    documentId: DocumentId,
    expectedRevision: Revision,
  },
  events: [DocumentDeleted],
  rejects: [DocumentNotFound, RevisionConflict, StrongReferenceViolation],
  reply: { documentId: DocumentId },
}) {}

export class PublishWorkspace extends Domain.Command("PublishWorkspace", {
  target: WorkspaceId,
  input: {
    documentIds: Schema.Array(DocumentId),
  },
  events: [WorkspacePublished],
  rejects: [
    DocumentNotFound,
    StrongReferenceViolation,
    PublishReadinessViolation,
    ClipOnlyRuleViolation,
  ],
  reply: { publishedCount: Schema.Int },
}) {}

/**
 * Updates a `segment`'s taxonomy tags and atomically cascades them to every
 * published `episode` whose primary segment (`segmentIds[0]`) is this segment.
 */
export class SyncSegmentTags extends Domain.Command("SyncSegmentTags", {
  target: WorkspaceId,
  input: {
    segmentId: DocumentId,
    tagIds: Schema.Array(DocumentId),
  },
  events: [SegmentTagsCascaded],
  rejects: [DocumentNotFound, StrongReferenceViolation],
  reply: { updatedEpisodeIds: Schema.Array(DocumentId) },
}) {}

export class DiscardDraft extends Domain.Command("DiscardDraft", {
  target: WorkspaceId,
  input: {
    documentId: DocumentId,
  },
  events: [DraftDiscarded],
  rejects: [DocumentNotFound],
  reply: { documentId: DocumentId, restoredRevision: Revision },
}) {}
