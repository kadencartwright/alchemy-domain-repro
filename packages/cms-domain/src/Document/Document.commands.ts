import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { DocumentId, Revision, SlotKey, WorkspaceId } from "../Ids.ts";

export class DocumentRevisionConflict extends Domain.Rejection(
  "DocumentRevisionConflict",
  {
    expected: Schema.NullOr(Revision),
    actual: Schema.NullOr(Revision),
  },
  { httpApiStatus: 409 },
) {}

export class SlotAlreadyClaimed extends Domain.Rejection(
  "SlotAlreadyClaimed",
  { claimedBy: DocumentId },
  { httpApiStatus: 409 },
) {}

export class DocumentDraftUpdated extends Domain.Event("DocumentDraftUpdated", {
  workspaceId: WorkspaceId,
  title: Schema.String,
  releaseDate: Schema.NullOr(Schema.String),
  bodyHash: Schema.String,
  strongRefs: Schema.Array(DocumentId),
  revision: Revision,
  savedAt: Schema.Number,
}) {}

export class DocumentPublished extends Domain.Event("DocumentPublished", {
  publishedRevision: Revision,
  publishedAt: Schema.Number,
}) {}

export class SaveDocumentDraft extends Domain.Command("SaveDocumentDraft", {
  target: DocumentId,
  input: {
    workspaceId: WorkspaceId,
    expectedRevision: Schema.NullOr(Revision),
    title: Schema.String,
    releaseDate: Schema.NullOr(Schema.String),
    bodyHash: Schema.String,
    strongRefs: Schema.Array(DocumentId),
  },
  events: [DocumentDraftUpdated],
  rejects: [DocumentRevisionConflict],
  reply: { revision: Revision },
}) {}

export class PublishDocument extends Domain.Command("PublishDocument", {
  target: DocumentId,
  input: {},
  events: [DocumentPublished],
  rejects: [],
  reply: { publishedRevision: Revision },
}) {}

export class SlotClaimed extends Domain.Event("SlotClaimed", {
  documentId: DocumentId,
}) {}

export class SlotReleased extends Domain.Event("SlotReleased", {
  documentId: DocumentId,
}) {}

export class ClaimScheduleSlot extends Domain.Command("ClaimScheduleSlot", {
  target: SlotKey,
  input: { documentId: DocumentId },
  events: [SlotClaimed],
  rejects: [SlotAlreadyClaimed],
  reply: { documentId: DocumentId },
}) {}

export class ReleaseScheduleSlot extends Domain.Command("ReleaseScheduleSlot", {
  target: SlotKey,
  input: { documentId: DocumentId },
  events: [SlotReleased],
  rejects: [],
}) {}
