import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { DocumentId, Revision } from "../Ids.ts";
import {
  ClipOnlyRuleViolation,
  DocumentNotFound,
  PublishReadinessViolation,
  RevisionConflict,
  ScheduleDateConflict,
  SlugConflict,
  StrongReferenceViolation,
} from "../Workspace/WorkspaceRule.rejection.ts";
import {
  ClaimKey,
  ClaimReleased,
  ClaimTaken,
  CmsDocumentDeleted,
  CmsDocumentPublished,
  CmsDraftSaved,
  DraftFields,
  InboundRefAdded,
  InboundRefRemoved,
} from "./DecisionCms.aggregates.ts";

/**
 * A decision reads only the instances `keyOf` names, and `keyOf` sees only the
 * command. Instances that follow from a document's *current* state (the
 * claims it holds and the documents it references)
 * therefore have to be named by the caller, from what it last read. The
 * decision checks it was given every instance it needs, and refuses with
 * `StaleRead` otherwise; the caller re-reads and retries.
 */
export class StaleRead extends Domain.Rejection(
  "StaleRead",
  {
    missing: Schema.Literals(["claim", "inboundRefs", "document"]),
    id: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** What the caller last read about the documents a command changes. */
export const Observed = Schema.Struct({
  claimKeys: Schema.Array(ClaimKey),
  references: Schema.Array(DocumentId),
});
export type Observed = typeof Observed.Type;

export const noneObserved: Observed = { claimKeys: [], references: [] };

const AllWrites = [ClaimTaken, ClaimReleased, InboundRefAdded, InboundRefRemoved] as const;

export class SaveCmsDraft extends Domain.Command("SaveCmsDraft", {
  input: {
    documentId: DocumentId,
    expectedRevision: Schema.NullOr(Revision),
    ...DraftFields,
    observed: Observed,
  },
  events: [CmsDraftSaved, ...AllWrites],
  rejects: [
    RevisionConflict,
    SlugConflict,
    ScheduleDateConflict,
    StrongReferenceViolation,
    ClipOnlyRuleViolation,
    StaleRead,
  ],
  reply: { revision: Revision },
}) {}

export class DeleteCmsDocument extends Domain.Command("DeleteCmsDocument", {
  input: {
    documentId: DocumentId,
    expectedRevision: Revision,
    observed: Observed,
  },
  events: [CmsDocumentDeleted, ...AllWrites],
  rejects: [DocumentNotFound, RevisionConflict, StrongReferenceViolation, StaleRead],
}) {}

export class PublishCmsDocuments extends Domain.Command("PublishCmsDocuments", {
  input: {
    documentIds: Schema.Array(DocumentId),
    /** Documents the batch depends on but doesn't publish (refs, audio masters, shows). */
    dependencyIds: Schema.Array(DocumentId),
    observed: Observed,
  },
  events: [CmsDocumentPublished, ...AllWrites],
  rejects: [
    DocumentNotFound,
    StrongReferenceViolation,
    PublishReadinessViolation,
    ClipOnlyRuleViolation,
    StaleRead,
  ],
}) {}
