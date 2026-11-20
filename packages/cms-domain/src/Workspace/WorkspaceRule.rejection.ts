import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { DocumentId, Revision } from "../Ids.ts";

export class RevisionConflict extends Domain.Rejection(
  "RevisionConflict",
  {
    documentId: DocumentId,
    expected: Schema.NullOr(Revision),
    actual: Schema.NullOr(Revision),
  },
  { httpApiStatus: 409 },
) {}

export class ScheduleDateConflict extends Domain.Rejection(
  "ScheduleDateConflict",
  {
    releaseDate: Schema.String,
    conflictingDocumentId: DocumentId,
  },
  { httpApiStatus: 409 },
) {}

export class StrongReferenceViolation extends Domain.Rejection(
  "StrongReferenceViolation",
  {
    targetId: DocumentId,
    referencedBy: Schema.Array(DocumentId),
    reason: Schema.Literals(["target_missing", "target_in_use"]),
  },
  { httpApiStatus: 409 },
) {}

export class DocumentNotFound extends Domain.Rejection(
  "DocumentNotFound",
  { documentId: DocumentId },
  { httpApiStatus: 404 },
) {}
