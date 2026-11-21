import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import { DocumentId, hasValidHighlightChapter, WorkspaceId } from "../Ids.ts";
import {
  BulkImportDocuments,
  CorpusBatchImported,
  DeleteDocument,
  DiscardDraft,
  DocumentDeleted,
  DraftDiscarded,
  DraftSaved,
  PublishWorkspace,
  SaveDraft,
  SegmentTagsCascaded,
  SyncSegmentTags,
  WorkspacePublished,
} from "./Workspace.commands.ts";
import {
  ClipOnlyRuleViolation,
  DocumentNotFound,
  PublishReadinessViolation,
  RevisionConflict,
  ScheduleDateConflict,
  SlugConflict,
  StrongReferenceViolation,
} from "./WorkspaceRule.rejection.ts";
import {
  allStrongRefsOf,
  type DocumentMeta,
  initialWorkspaceState,
  WorkspaceState,
} from "./WorkspaceState.ts";

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
    const refs = allStrongRefsOf(doc);
    if (refs.includes(targetId) || doc.publishedStrongRefs.includes(targetId)) {
      referrers.push(doc.id);
    }
  }
  return referrers;
};

const checkClipOnlyRule = (
  documents: WorkspaceState["documents"],
  docId: DocumentId,
  clipOnlyMode: boolean,
  showIds: ReadonlyArray<DocumentId>,
  audioMasterId: DocumentId | null,
): ClipOnlyRuleViolation | null => {
  if (!clipOnlyMode) return null;
  const primaryShowId = showIds[0];
  if (!primaryShowId || !audioMasterId) {
    return new ClipOnlyRuleViolation({ documentId: docId, reason: "missing_show_or_audio" });
  }
  const show = documents[primaryShowId];
  if (!show || show.kind !== "show" || show.ownershipType !== "partner") {
    return new ClipOnlyRuleViolation({ documentId: docId, reason: "requires_partner_show" });
  }
  const master = documents[audioMasterId];
  if (
    !master ||
    master.kind !== "audioMaster" ||
    !hasValidHighlightChapter(master.durationSeconds, master.chapters)
  ) {
    return new ClipOnlyRuleViolation({
      documentId: docId,
      reason: "requires_valid_highlight_chapter",
    });
  }
  return null;
};

/**
 * Approach A — Monolith Workspace-as-Aggregate for the Podcast Network CMS.
 *
 * Enforces ALL 8 cross-document invariants atomically in a single DO transaction:
 * 1. Optimistic per-document expected revision
 * 2. Scoped `show.slug` uniqueness per `ownershipType` (`internal` / `partner`)
 * 3. Multi-parent `episode.slug` & `releaseDate` uniqueness within every owning `show`
 * 4. Strong reference integrity across 9 podcast document types
 * 5. Delete-in-use protection across drafts and published docs
 * 6. Published playable `audioMaster` gate on episode publish
 * 7. Cross-doc multi-hop `clipOnlyMode` validation (partner show + 1 valid highlight chapter)
 * 8. Atomic multi-document publish + cascading `segment` tag sync
 *
 * Friction at 25,000 documents:
 * Because `@alchemy.run/domain/DurableObjects` serializes all `WorkspaceState`
 * into one `"meta"` JSON key, 25,000 podcast documents hits ~16–20 MiB —
 * roughly 8–10x OVER Cloudflare SQLite DO's 2 MiB per-value limit.
 */
export class Workspace extends Domain.Aggregate("Workspace", {
  id: WorkspaceId,
  state: WorkspaceState,
  initial: initialWorkspaceState,
  commands: [
    SaveDraft,
    BulkImportDocuments,
    DeleteDocument,
    PublishWorkspace,
    SyncSegmentTags,
    DiscardDraft,
  ],
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

      // Invariant 2: show.slug unique per ownershipType
      if (cmd.kind === "show" && cmd.slug !== null && cmd.ownershipType !== null) {
        for (const doc of Object.values(state.documents)) {
          if (
            doc.id !== cmd.documentId &&
            doc.kind === "show" &&
            doc.ownershipType === cmd.ownershipType &&
            doc.slug === cmd.slug
          ) {
            return new SlugConflict({
              scope: `show:${cmd.ownershipType}`,
              slug: cmd.slug,
              conflictingDocumentId: doc.id,
            });
          }
        }
      }

      // Invariant 3: episode.slug and releaseDate unique within EVERY show in showIds
      if (cmd.kind === "episode" && cmd.showIds.length > 0) {
        for (const showId of cmd.showIds) {
          for (const doc of Object.values(state.documents)) {
            if (doc.id === cmd.documentId || doc.kind !== "episode") continue;
            if (!doc.showIds.includes(showId)) continue;
            if (cmd.slug !== null && doc.slug === cmd.slug) {
              return new SlugConflict({
                scope: `episode:${showId}`,
                slug: cmd.slug,
                conflictingDocumentId: doc.id,
              });
            }
            if (cmd.releaseDate !== null && doc.releaseDate === cmd.releaseDate) {
              return new ScheduleDateConflict({
                showId,
                releaseDate: cmd.releaseDate,
                conflictingDocumentId: doc.id,
              });
            }
          }
        }
      }

      // Invariant 4: strong reference integrity across all typed ref arrays
      const allRefs = allStrongRefsOf(cmd);
      const missing = findMissingTarget(state.documents, allRefs);
      if (missing !== null) {
        return new StrongReferenceViolation({
          targetId: missing,
          referencedBy: [cmd.documentId],
          reason: "target_missing",
        });
      }

      // Invariant 7: cross-doc multi-hop clipOnlyMode check
      if (cmd.kind === "episode") {
        const clipErr = checkClipOnlyRule(
          state.documents,
          cmd.documentId,
          cmd.clipOnlyMode,
          cmd.showIds,
          cmd.audioMasterId,
        );
        if (clipErr !== null) return clipErr;
      }

      const nextRevision = (actualRevision ?? 0) + 1;
      const { _tag: _, expectedRevision: _exp, ...fields } = cmd;
      return [
        new DraftSaved({
          ...fields,
          revision: nextRevision,
          savedAt: DateTime.toEpochMillis(ctx.now),
        }),
      ];
    },
    BulkImportDocuments: (_state, cmd) =>
      cmd.documents.length === 0 ? [] : [new CorpusBatchImported({ documents: cmd.documents })],
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
      return [
        new DocumentDeleted({
          documentId: cmd.documentId,
          deletedAt: DateTime.toEpochMillis(ctx.now),
        }),
      ];
    },
    PublishWorkspace: (state, cmd, ctx) => {
      const publishingSet = new Set(cmd.documentIds);
      for (const id of cmd.documentIds) {
        const doc = state.documents[id];
        if (!doc) return new DocumentNotFound({ documentId: id });
        const missing = findMissingTarget(state.documents, [
          ...allStrongRefsOf(doc),
          ...doc.strengthenOnPublish,
        ]);
        if (missing !== null) {
          return new StrongReferenceViolation({
            targetId: missing,
            referencedBy: [id],
            reason: "target_missing",
          });
        }
        // Invariant 6: episode publish requires a published playable audioMaster
        // (either already published or included in the same atomic publish batch).
        if (doc.kind === "episode" && doc.audioMasterId !== null) {
          const master = state.documents[doc.audioMasterId];
          if (!master || master.kind !== "audioMaster") {
            return new StrongReferenceViolation({
              targetId: doc.audioMasterId,
              referencedBy: [id],
              reason: "target_missing",
            });
          }
          const isMasterPublished =
            master.publishedRevision !== null || publishingSet.has(doc.audioMasterId);
          if (!isMasterPublished) {
            return new PublishReadinessViolation({
              documentId: id,
              targetId: doc.audioMasterId,
              reason: "audio_master_unpublished",
            });
          }
          if (!master.playableAudio) {
            return new PublishReadinessViolation({
              documentId: id,
              targetId: doc.audioMasterId,
              reason: "audio_master_not_playable",
            });
          }
          const clipErr = checkClipOnlyRule(
            state.documents,
            id,
            doc.clipOnlyMode,
            doc.showIds,
            doc.audioMasterId,
          );
          if (clipErr !== null) return clipErr;
        }
      }
      return [
        new WorkspacePublished({
          documentIds: cmd.documentIds,
          publishedAt: DateTime.toEpochMillis(ctx.now),
        }),
      ];
    },
    SyncSegmentTags: (state, cmd, ctx) => {
      const seg = state.documents[cmd.segmentId];
      if (!seg || seg.kind !== "segment") {
        return new DocumentNotFound({ documentId: cmd.segmentId });
      }
      const missingTag = findMissingTarget(state.documents, cmd.tagIds);
      if (missingTag !== null) {
        return new StrongReferenceViolation({
          targetId: missingTag,
          referencedBy: [cmd.segmentId],
          reason: "target_missing",
        });
      }
      const updatedEpisodeIds: Array<DocumentId> = [];
      for (const doc of Object.values(state.documents)) {
        if (
          doc.kind === "episode" &&
          doc.publishedRevision !== null &&
          doc.segmentIds[0] === cmd.segmentId
        ) {
          updatedEpisodeIds.push(doc.id);
        }
      }
      return [
        new SegmentTagsCascaded({
          segmentId: cmd.segmentId,
          tagIds: cmd.tagIds,
          updatedEpisodeIds,
          syncedAt: DateTime.toEpochMillis(ctx.now),
        }),
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
        slug: event.slug,
        ownershipType: event.ownershipType,
        showIds: event.showIds,
        releaseDate: event.releaseDate,
        audioMasterId: event.audioMasterId,
        clipOnlyMode: event.clipOnlyMode,
        closerKind: event.closerKind,
        playableAudio: event.playableAudio,
        durationSeconds: event.durationSeconds,
        chapters: event.chapters,
        segmentIds: event.segmentIds,
        hostIds: event.hostIds,
        tagIds: event.tagIds,
        managedLinkIds: event.managedLinkIds,
        mediaAssetIds: event.mediaAssetIds,
        bodyHash: event.bodyHash,
        strongRefs: event.strongRefs,
        strengthenOnPublish: event.strengthenOnPublish,
        retiredAt: event.retiredAt,
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
    CorpusBatchImported: (state, event) => {
      const nextDocs = { ...state.documents };
      for (const doc of event.documents) {
        nextDocs[doc.id] = doc;
      }
      return {
        ...state,
        version: state.version + 1,
        documents: nextDocs,
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
        const allMerged = allStrongRefsOf({ ...doc, strongRefs: mergedStrong });
        nextDocs[id] = {
          ...doc,
          strongRefs: mergedStrong,
          strengthenOnPublish: [],
          publishedRevision: doc.revision,
          publishedTitle: doc.title,
          publishedReleaseDate: doc.releaseDate,
          publishedBodyHash: doc.bodyHash,
          publishedStrongRefs: allMerged,
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
    SegmentTagsCascaded: (state, event) => {
      const nextDocs = { ...state.documents };
      const seg = nextDocs[event.segmentId];
      if (seg) {
        nextDocs[event.segmentId] = { ...seg, tagIds: event.tagIds, updatedAt: event.syncedAt };
      }
      for (const epId of event.updatedEpisodeIds) {
        const ep = nextDocs[epId];
        if (!ep) continue;
        nextDocs[epId] = { ...ep, tagIds: event.tagIds, updatedAt: event.syncedAt };
      }
      return {
        ...state,
        version: state.version + 1,
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
    BulkImportDocuments: (_state, events) => {
      const imp = events.find((e) => e._tag === "CorpusBatchImported");
      return { importedCount: imp ? imp.documents.length : 0 };
    },
    DeleteDocument: (_state, events) => {
      const deleted = events.find((e) => e._tag === "DocumentDeleted");
      return { documentId: deleted ? deleted.documentId : DocumentId.make("") };
    },
    PublishWorkspace: (_state, events) => {
      const pub = events.find((e) => e._tag === "WorkspacePublished");
      return { publishedCount: pub ? pub.documentIds.length : 0 };
    },
    SyncSegmentTags: (_state, events) => {
      const synced = events.find((e) => e._tag === "SegmentTagsCascaded");
      return { updatedEpisodeIds: synced ? synced.updatedEpisodeIds : [] };
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
