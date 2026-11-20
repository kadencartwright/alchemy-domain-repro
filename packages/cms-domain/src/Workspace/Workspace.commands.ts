import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { DocumentId, Revision, WorkspaceId } from "../Ids.ts";
import {
  DocumentNotFound,
  RevisionConflict,
  ScheduleDateConflict,
  StrongReferenceViolation,
} from "./WorkspaceRule.rejection.ts";

export class DraftSaved extends Domain.Event("DraftSaved", {
  documentId: DocumentId,
  title: Schema.String,
  kind: Schema.Literals(["article", "series", "asset"]),
  releaseDate: Schema.NullOr(Schema.String),
  bodyHash: Schema.String,
  strongRefs: Schema.Array(DocumentId),
  strengthenOnPublish: Schema.Array(DocumentId),
  revision: Revision,
  savedAt: Schema.Number,
}) {}

export class DocumentDeleted extends Domain.Event("DocumentDeleted", {
  documentId: DocumentId,
  deletedAt: Schema.Number,
}) {}

export class WorkspacePublished extends Domain.Event("WorkspacePublished", {
  documentIds: Schema.Array(DocumentId),
  publishedAt: Schema.Number,
}) {}

export class DraftDiscarded extends Domain.Event("DraftDiscarded", {
  documentId: DocumentId,
  restoredRevision: Revision,
  discardedAt: Schema.Number,
}) {}

export class SaveDraft extends Domain.Command("SaveDraft", {
  target: WorkspaceId,
  input: {
    documentId: DocumentId,
    expectedRevision: Schema.NullOr(Revision),
    title: Schema.String,
    kind: Schema.Literals(["article", "series", "asset"]),
    releaseDate: Schema.NullOr(Schema.String),
    bodyHash: Schema.String,
    strongRefs: Schema.Array(DocumentId),
    strengthenOnPublish: Schema.Array(DocumentId),
  },
  events: [DraftSaved],
  rejects: [RevisionConflict, ScheduleDateConflict, StrongReferenceViolation],
  reply: { documentId: DocumentId, revision: Revision },
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
  rejects: [DocumentNotFound, StrongReferenceViolation],
  reply: { publishedCount: Schema.Int },
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
