import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import { DocumentId, WorkspaceId } from "../Ids.ts";
import {
  DeleteDocument,
  DiscardDraft,
  DocumentDeleted,
  DraftDiscarded,
  DraftSaved,
  PublishWorkspace,
  SaveDraft,
  WorkspacePublished,
} from "./Workspace.commands.ts";
import {
  DocumentNotFound,
  RevisionConflict,
  ScheduleDateConflict,
  StrongReferenceViolation,
} from "./WorkspaceRule.rejection.ts";
import { type DocumentMeta, initialWorkspaceState, WorkspaceState } from "./WorkspaceState.ts";

const findDateConflict = (
  documents: WorkspaceState["documents"],
  documentId: DocumentId,
  kind: DocumentMeta["kind"],
  releaseDate: string | null,
): DocumentId | null => {
  if (kind !== "article" || releaseDate === null) return null;
  for (const doc of Object.values(documents)) {
    if (doc.id !== documentId && doc.kind === "article" && doc.releaseDate === releaseDate) {
      return doc.id;
    }
  }
  return null;
};

const findMissingTarget = (
  documents: WorkspaceState["documents"],
  refs: ReadonlyArray<DocumentId>,
): DocumentId | null => {
  for (const target of refs) {
    if (!(target in documents)) return target;
  }
  return null;
};

const findReferrers = (
  documents: WorkspaceState["documents"],
  targetId: DocumentId,
): Array<DocumentId> => {
  const referrers: Array<DocumentId> = [];
  for (const doc of Object.values(documents)) {
    if (doc.id === targetId) continue;
    if (doc.strongRefs.includes(targetId) || doc.publishedStrongRefs.includes(targetId)) {
      referrers.push(doc.id);
    }
  }
  return referrers;
};

/**
 * Approach A — Workspace-as-Aggregate (coarse consistency boundary).
 *
 * Enforces cross-document invariants cleanly in a single transaction:
 * - optimistic per-document expected revision
 * - unique releaseDate across active articles in the workspace
 * - strong reference integrity across drafts and published documents
 * - atomic multi-document publish (strengthening pending refs together)
 *
 * Friction under @alchemy.run/domain/Cloudflare:
 * Every command rewrites the ENTIRE `WorkspaceState` ("meta") blob inside
 * `blockConcurrencyWhile`, so editing 1 field on 1 document re-serializes and
 * rewrites metadata for all N documents in the workspace.
 */
export class Workspace extends Domain.Aggregate("Workspace", {
  id: WorkspaceId,
  state: WorkspaceState,
  initial: initialWorkspaceState,
  commands: [SaveDraft, DeleteDocument, PublishWorkspace, DiscardDraft],
  decide: {
    SaveDraft: (state, cmd, ctx) => {
      const existing = state.documents[cmd.documentId];
      const actualRevision = existing?.revision ?? null;
      if (actualRevision !== cmd.expectedRevision) {
        return new RevisionConflict({
          documentId: cmd.documentId,
          expected: cmd.expectedRevision,
          actual: actualRevision,
        });
      }
      const conflict = findDateConflict(state.documents, cmd.documentId, cmd.kind, cmd.releaseDate);
      if (conflict !== null && cmd.releaseDate !== null) {
        return new ScheduleDateConflict({
          releaseDate: cmd.releaseDate,
          conflictingDocumentId: conflict,
        });
      }
      const missing = findMissingTarget(state.documents, cmd.strongRefs);
      if (missing !== null) {
        return new StrongReferenceViolation({
          targetId: missing,
          referencedBy: [cmd.documentId],
          reason: "target_missing",
        });
      }
      const nextRevision = (actualRevision ?? 0) + 1;
      return [
        new DraftSaved({
          documentId: cmd.documentId,
          title: cmd.title,
          kind: cmd.kind,
          releaseDate: cmd.releaseDate,
          bodyHash: cmd.bodyHash,
          strongRefs: cmd.strongRefs,
          strengthenOnPublish: cmd.strengthenOnPublish,
          revision: nextRevision,
          savedAt: DateTime.toEpochMillis(ctx.now),
        }),
      ];
    },
    DeleteDocument: (state, cmd, ctx) => {
      const existing = state.documents[cmd.documentId];
      if (!existing) {
        return new DocumentNotFound({ documentId: cmd.documentId });
      }
      if (existing.revision !== cmd.expectedRevision) {
        return new RevisionConflict({
          documentId: cmd.documentId,
          expected: cmd.expectedRevision,
          actual: existing.revision,
        });
      }
      const referrers = findReferrers(state.documents, cmd.documentId);
      if (referrers.length > 0) {
        return new StrongReferenceViolation({
          targetId: cmd.documentId,
          referencedBy: referrers,
          reason: "target_in_use",
        });
      }
      return [new DocumentDeleted({ documentId: cmd.documentId, deletedAt: DateTime.toEpochMillis(ctx.now) })];
    },
    PublishWorkspace: (state, cmd, ctx) => {
      for (const id of cmd.documentIds) {
        const doc = state.documents[id];
        if (!doc) return new DocumentNotFound({ documentId: id });
        const missing = findMissingTarget(state.documents, [
          ...doc.strongRefs,
          ...doc.strengthenOnPublish,
        ]);
        if (missing !== null) {
          return new StrongReferenceViolation({
            targetId: missing,
            referencedBy: [id],
            reason: "target_missing",
          });
        }
      }
      return [
        new WorkspacePublished({ documentIds: cmd.documentIds, publishedAt: DateTime.toEpochMillis(ctx.now) }),
      ];
    },
    DiscardDraft: (state, cmd, ctx) => {
      const existing = state.documents[cmd.documentId];
      if (!existing || existing.publishedRevision === null) {
        return new DocumentNotFound({ documentId: cmd.documentId });
      }
      return [
        new DraftDiscarded({
          documentId: cmd.documentId,
          restoredRevision: existing.publishedRevision,
          discardedAt: DateTime.toEpochMillis(ctx.now),
        }),
      ];
    },
  },
  evolve: {
    DraftSaved: (state, event) => {
      const prev = state.documents[event.documentId];
      const nextDoc: DocumentMeta = {
        id: event.documentId,
        title: event.title,
        kind: event.kind,
        releaseDate: event.releaseDate,
        bodyHash: event.bodyHash,
        strongRefs: event.strongRefs,
        strengthenOnPublish: event.strengthenOnPublish,
        revision: event.revision,
        publishedRevision: prev?.publishedRevision ?? null,
        publishedTitle: prev?.publishedTitle ?? null,
        publishedReleaseDate: prev?.publishedReleaseDate ?? null,
        publishedBodyHash: prev?.publishedBodyHash ?? null,
        publishedStrongRefs: prev?.publishedStrongRefs ?? [],
        updatedAt: event.savedAt,
      };
      return {
        ...state,
        version: state.version + 1,
        documents: { ...state.documents, [event.documentId]: nextDoc },
      };
    },
    DocumentDeleted: (state, event) => {
      const nextDocs = { ...state.documents };
      delete nextDocs[event.documentId];
      return {
        ...state,
        version: state.version + 1,
        documents: nextDocs,
      };
    },
    WorkspacePublished: (state, event) => {
      const nextDocs = { ...state.documents };
      for (const id of event.documentIds) {
        const doc = nextDocs[id];
        if (!doc) continue;
        const mergedStrong = [...new Set([...doc.strongRefs, ...doc.strengthenOnPublish])];
        nextDocs[id] = {
          ...doc,
          strongRefs: mergedStrong,
          strengthenOnPublish: [],
          publishedRevision: doc.revision,
          publishedTitle: doc.title,
          publishedReleaseDate: doc.releaseDate,
          publishedBodyHash: doc.bodyHash,
          publishedStrongRefs: mergedStrong,
          updatedAt: event.publishedAt,
        };
      }
      return {
        ...state,
        version: state.version + 1,
        publishedTransactionCount: state.publishedTransactionCount + 1,
        documents: nextDocs,
      };
    },
    DraftDiscarded: (state, event) => {
      const doc = state.documents[event.documentId];
      if (!doc || doc.publishedRevision === null) return state;
      return {
        ...state,
        version: state.version + 1,
        documents: {
          ...state.documents,
          [event.documentId]: {
            ...doc,
            title: doc.publishedTitle ?? doc.title,
            releaseDate: doc.publishedReleaseDate,
            bodyHash: doc.publishedBodyHash ?? doc.bodyHash,
            strongRefs: doc.publishedStrongRefs,
            strengthenOnPublish: [],
            revision: doc.revision + 1,
            updatedAt: event.discardedAt,
          },
        },
      };
    },
  },
  reply: {
    SaveDraft: (_state, events) => {
      const saved = events.find((e) => e._tag === "DraftSaved");
      return {
        documentId: saved ? saved.documentId : DocumentId.make(""),
        revision: saved ? saved.revision : 0,
      };
    },
    DeleteDocument: (_state, events) => {
      const deleted = events.find((e) => e._tag === "DocumentDeleted");
      return { documentId: deleted ? deleted.documentId : DocumentId.make("") };
    },
    PublishWorkspace: (_state, events) => {
      const pub = events.find((e) => e._tag === "WorkspacePublished");
      return { publishedCount: pub ? pub.documentIds.length : 0 };
    },
    DiscardDraft: (_state, events) => {
      const discarded = events.find((e) => e._tag === "DraftDiscarded");
      return {
        documentId: discarded ? discarded.documentId : DocumentId.make(""),
        restoredRevision: discarded ? discarded.restoredRevision : 0,
      };
    },
  },
}) {}
