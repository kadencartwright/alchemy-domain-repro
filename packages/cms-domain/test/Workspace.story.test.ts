import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { DocumentId, SlotKey, WorkspaceId } from "../src/Ids.ts";
import {
  ContentDocument,
  ScheduleSlot,
  SplitDocumentCms,
} from "../src/Document/Document.aggregate.ts";
import {
  ClaimScheduleSlot,
  DocumentDraftUpdated,
  SaveDocumentDraft,
  SlotAlreadyClaimed,
  SlotClaimed,
} from "../src/Document/Document.commands.ts";
import { MemoryCatalogStore } from "../src/Workspace/CatalogStore.ts";
import { SearchCatalog } from "../src/Workspace/SearchCatalog.query.ts";
import { Workspace } from "../src/Workspace/Workspace.aggregate.ts";
import {
  DeleteDocument,
  DiscardDraft,
  DraftDiscarded,
  DraftSaved,
  PublishWorkspace,
  SaveDraft,
  WorkspacePublished,
} from "../src/Workspace/Workspace.commands.ts";
import { WorkspaceCms, WorkspaceCmsHandlers } from "../src/Workspace/Workspace.model.ts";
import {
  ScheduleDateConflict,
  StrongReferenceViolation,
} from "../src/Workspace/WorkspaceRule.rejection.ts";

const workspaceStory = Story.make(WorkspaceCms, {
  layer: WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)),
});

const splitStory = Story.make(SplitDocumentCms, {});

const ws = Workspace.ref(WorkspaceId.make("ws-1"));
const assetId = DocumentId.make("asset-1");
const doc1 = DocumentId.make("doc-1");
const doc2 = DocumentId.make("doc-2");

it.effect("Workspace aggregate enforces schedule uniqueness, strong refs, publish, and discard", () =>
  workspaceStory(
    Story.clock("2026-11-20T12:00:00Z"),
    Story.when(
      ws,
      new SaveDraft({
        documentId: assetId,
        expectedRevision: null,
        title: "Cover Artwork",
        kind: "asset",
        releaseDate: null,
        bodyHash: "sha256:asset-v1",
        strongRefs: [],
        strengthenOnPublish: [],
      }),
    ),
    Story.then(
      ws,
      new DraftSaved({
        documentId: assetId,
        title: "Cover Artwork",
        kind: "asset",
        releaseDate: null,
        bodyHash: "sha256:asset-v1",
        strongRefs: [],
        strengthenOnPublish: [],
        revision: 1,
        savedAt: Date.parse("2026-11-20T12:00:00Z"),
      }),
    ),
    Story.replied({ documentId: assetId, revision: 1 }),

    Story.when(
      ws,
      new SaveDraft({
        documentId: doc1,
        expectedRevision: null,
        title: "Monday Reading",
        kind: "article",
        releaseDate: "2026-11-23",
        bodyHash: "sha256:doc1-v1",
        strongRefs: [assetId],
        strengthenOnPublish: [],
      }),
    ),
    Story.then(
      ws,
      new DraftSaved({
        documentId: doc1,
        title: "Monday Reading",
        kind: "article",
        releaseDate: "2026-11-23",
        bodyHash: "sha256:doc1-v1",
        strongRefs: [assetId],
        strengthenOnPublish: [],
        revision: 1,
        savedAt: Date.parse("2026-11-20T12:00:00Z"),
      }),
    ),

    // Cross-document invariant 1: second article on same date is rejected atomically.
    Story.when(
      ws,
      new SaveDraft({
        documentId: doc2,
        expectedRevision: null,
        title: "Conflicting Reading",
        kind: "article",
        releaseDate: "2026-11-23",
        bodyHash: "sha256:doc2-v1",
        strongRefs: [],
        strengthenOnPublish: [],
      }),
    ),
    Story.rejected(
      new ScheduleDateConflict({
        releaseDate: "2026-11-23",
        conflictingDocumentId: doc1,
      }),
    ),

    // Cross-document invariant 2: referenced asset cannot be deleted.
    Story.when(ws, new DeleteDocument({ documentId: assetId, expectedRevision: 1 })),
    Story.rejected(
      new StrongReferenceViolation({
        targetId: assetId,
        referencedBy: [doc1],
        reason: "target_in_use",
      }),
    ),

    // Atomic multi-doc publish + projection query.
    Story.when(ws, new PublishWorkspace({ documentIds: [assetId, doc1] })),
    Story.then(
      ws,
      new WorkspacePublished({
        documentIds: [assetId, doc1],
        publishedAt: Date.parse("2026-11-20T12:00:00Z"),
      }),
    ),
    Story.replied({ publishedCount: 2 }),

    Story.query(
      SearchCatalog,
      { workspaceId: WorkspaceId.make("ws-1"), query: "Monday", publishedOnly: true },
      [{ documentId: doc1, title: "Monday Reading", published: true }],
    ),

    // Draft edit followed by discard restores published metadata.
    Story.when(
      ws,
      new SaveDraft({
        documentId: doc1,
        expectedRevision: 1,
        title: "Monday Reading (WIP)",
        kind: "article",
        releaseDate: "2026-11-23",
        bodyHash: "sha256:doc1-v2",
        strongRefs: [assetId],
        strengthenOnPublish: [],
      }),
    ),
    Story.then(
      ws,
      new DraftSaved({
        documentId: doc1,
        title: "Monday Reading (WIP)",
        kind: "article",
        releaseDate: "2026-11-23",
        bodyHash: "sha256:doc1-v2",
        strongRefs: [assetId],
        strengthenOnPublish: [],
        revision: 2,
        savedAt: Date.parse("2026-11-20T12:00:00Z"),
      }),
    ),
    Story.when(ws, new DiscardDraft({ documentId: doc1 })),
    Story.then(
      ws,
      new DraftDiscarded({
        documentId: doc1,
        restoredRevision: 1,
        discardedAt: Date.parse("2026-11-20T12:00:00Z"),
      }),
    ),
    Story.state(ws, (state) => state.documents[doc1]?.title === "Monday Reading"),
  ),
);

it.effect(
  "Split Document + ScheduleSlot aggregates isolate edits, but cannot guard dangling strong refs locally",
  () => {
    const slot = ScheduleSlot.ref(SlotKey.make("ws-1:2026-11-23"));
    const d1 = ContentDocument.ref(doc1);
    const missingAsset = DocumentId.make("asset-does-not-exist");

    return splitStory(
      Story.clock("2026-11-20T12:00:00Z"),
      Story.when(slot, new ClaimScheduleSlot({ documentId: doc1 })),
      Story.then(slot, new SlotClaimed({ documentId: doc1 })),
      Story.when(slot, new ClaimScheduleSlot({ documentId: doc2 })),
      Story.rejected(new SlotAlreadyClaimed({ claimedBy: doc1 })),
      // Notice: ContentDocument accepts a dangling strongRef because it cannot
      // read another aggregate's existence inside `decide`.
      Story.when(
        d1,
        new SaveDocumentDraft({
          workspaceId: WorkspaceId.make("ws-1"),
          expectedRevision: null,
          title: "Unvalidated Ref Doc",
          releaseDate: "2026-11-23",
          bodyHash: "sha256:d1",
          strongRefs: [missingAsset],
        }),
      ),
      Story.then(
        d1,
        new DocumentDraftUpdated({
          workspaceId: WorkspaceId.make("ws-1"),
          title: "Unvalidated Ref Doc",
          releaseDate: "2026-11-23",
          bodyHash: "sha256:d1",
          strongRefs: [missingAsset],
          revision: 1,
          savedAt: Date.parse("2026-11-20T12:00:00Z"),
        }),
      ),
    );
  },
);
