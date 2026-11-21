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
    showId: DocumentId,
    releaseDate: Schema.String,
    conflictingDocumentId: DocumentId,
  },
  { httpApiStatus: 409 },
) {}

export class SlugConflict extends Domain.Rejection(
  "SlugConflict",
  {
    scope: Schema.String,
    slug: Schema.String,
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

export class PublishReadinessViolation extends Domain.Rejection(
  "PublishReadinessViolation",
  {
    documentId: DocumentId,
    targetId: DocumentId,
    reason: Schema.Literals(["audio_master_unpublished", "audio_master_not_playable"]),
  },
  { httpApiStatus: 409 },
) {}

export class ClipOnlyRuleViolation extends Domain.Rejection(
  "ClipOnlyRuleViolation",
  {
    documentId: DocumentId,
    reason: Schema.Literals([
      "missing_show_or_audio",
      "requires_partner_show",
      "requires_valid_highlight_chapter",
    ]),
  },
  { httpApiStatus: 409 },
) {}

export class DocumentNotFound extends Domain.Rejection(
  "DocumentNotFound",
  { documentId: DocumentId },
  { httpApiStatus: 404 },
) {}
