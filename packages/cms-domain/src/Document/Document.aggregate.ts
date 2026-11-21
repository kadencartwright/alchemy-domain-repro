import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { DocumentId, Revision, SlotKey, WorkspaceId } from "../Ids.ts";
import {
  ClaimScheduleSlot,
  DocumentDraftUpdated,
  DocumentPublished,
  DocumentRevisionConflict,
  PublishDocument,
  ReleaseScheduleSlot,
  SaveDocumentDraft,
  SlotAlreadyClaimed,
  SlotClaimed,
  SlotReleased,
} from "./Document.commands.ts";

const DocumentState = Schema.Struct({
  workspaceId: Schema.NullOr(WorkspaceId),
  title: Schema.String,
  releaseDate: Schema.NullOr(Schema.String),
  bodyHash: Schema.String,
  strongRefs: Schema.Array(DocumentId),
  revision: Revision,
  publishedRevision: Schema.NullOr(Revision),
});

/**
 * Approach B — Fine-grained per-Document aggregate.
 *
 * Eliminates the O(N) workspace blob rewrite and allows concurrent editors on
 * different documents. However:
 * 1. `SaveDocumentDraft` CANNOT atomically check that `strongRefs` exist or
 *    block concurrent deletion of a referenced target.
 * 2. Publishing N related documents with cross-references has no single
 *    atomic commit boundary.
 * 3. Schedule uniqueness must be extracted into a separate `ScheduleSlot`
 *    aggregate coordinated via reserve-then-commit (extra round-trips and
 *    temporary partial states).
 */
export class ContentDocument extends Domain.Aggregate("ContentDocument", {
  id: DocumentId,
  state: DocumentState,
  initial: {
    workspaceId: null,
    title: "",
    releaseDate: null,
    bodyHash: "",
    strongRefs: [],
    revision: 0,
    publishedRevision: null,
  },
  commands: [SaveDocumentDraft, PublishDocument],
  keyOf: (cmd) => cmd.documentId,
  decide: {
    SaveDocumentDraft: (state, cmd, ctx) => {
      const actual = state.revision === 0 ? null : state.revision;
      if (actual !== cmd.expectedRevision) {
        return new DocumentRevisionConflict({ expected: cmd.expectedRevision, actual });
      }
      return [
        new DocumentDraftUpdated({
          workspaceId: cmd.workspaceId,
          title: cmd.title,
          releaseDate: cmd.releaseDate,
          bodyHash: cmd.bodyHash,
          strongRefs: cmd.strongRefs,
          revision: state.revision + 1,
          savedAt: DateTime.toEpochMillis(ctx.now),
        }),
      ];
    },
    PublishDocument: (state, _cmd, ctx) =>
      state.revision === 0
        ? []
        : [
            new DocumentPublished({
              publishedRevision: state.revision,
              publishedAt: DateTime.toEpochMillis(ctx.now),
            }),
          ],
  },
  evolve: {
    DocumentDraftUpdated: (state, event) => ({
      ...state,
      workspaceId: event.workspaceId,
      title: event.title,
      releaseDate: event.releaseDate,
      bodyHash: event.bodyHash,
      strongRefs: event.strongRefs,
      revision: event.revision,
    }),
    DocumentPublished: (state, event) => ({
      ...state,
      publishedRevision: event.publishedRevision,
    }),
  },
  reply: {
    SaveDocumentDraft: (state) => ({ revision: state.revision }),
    PublishDocument: (state) => ({ publishedRevision: state.publishedRevision ?? 0 }),
  },
}) {}

const SlotState = Schema.Struct({
  claimedBy: Schema.NullOr(DocumentId),
});

/**
 * Invariant-shaped aggregate per `workspaceId:YYYY-MM-DD`, following
 * `@alchemy.run/domain`'s recommended pattern for cross-aggregate uniqueness.
 *
 * Works for 1:1 date uniqueness, but requires callers/sagas to claim-before-save
 * and release-on-reschedule, and still does not solve multi-edge strong-reference
 * graphs or atomic multi-document publish.
 */
export class ScheduleSlot extends Domain.Aggregate("ScheduleSlot", {
  id: SlotKey,
  state: SlotState,
  initial: { claimedBy: null },
  commands: [ClaimScheduleSlot, ReleaseScheduleSlot],
  keyOf: (cmd) => cmd.slotKey,
  decide: {
    ClaimScheduleSlot: (state, cmd) => {
      if (state.claimedBy !== null && state.claimedBy !== cmd.documentId) {
        return new SlotAlreadyClaimed({ claimedBy: state.claimedBy });
      }
      if (state.claimedBy === cmd.documentId) return [];
      return [new SlotClaimed({ documentId: cmd.documentId })];
    },
    ReleaseScheduleSlot: (state, cmd) =>
      state.claimedBy === cmd.documentId ? [new SlotReleased({ documentId: cmd.documentId })] : [],
  },
  evolve: {
    SlotClaimed: (_state, event) => ({ claimedBy: event.documentId }),
    SlotReleased: () => ({ claimedBy: null }),
  },
  reply: {
    ClaimScheduleSlot: (state) => ({
      documentId: state.claimedBy ?? DocumentId.make(""),
    }),
  },
}) {}

export class SplitDocumentCms extends Domain.Model("SplitDocumentCms", {
  aggregates: [ContentDocument, ScheduleSlot],
}) {}
