import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import * as Layer from "effect/Layer";
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
import { DocumentId, SlotKey, WorkspaceId } from "../src/Ids.ts";
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
  SegmentTagsCascaded,
  SyncSegmentTags,
  WorkspacePublished,
} from "../src/Workspace/Workspace.commands.ts";
import { WorkspaceCms, WorkspaceCmsHandlers } from "../src/Workspace/Workspace.model.ts";
import {
  ClipOnlyRuleViolation,
  PublishReadinessViolation,
  SlugConflict,
  StrongReferenceViolation,
} from "../src/Workspace/WorkspaceRule.rejection.ts";

const workspaceStory = Story.make(WorkspaceCms, {
  layer: WorkspaceCmsHandlers.pipe(Layer.provide(MemoryCatalogStore)),
});
const splitStory = Story.make(SplitDocumentCms, {});

const T0 = Date.parse("2026-11-20T12:00:00Z");

const baseDraft = (
  overrides: Partial<Omit<ConstructorParameters<typeof SaveDraft>[0], "_tag">> & {
    documentId: DocumentId;
    title: string;
    kind: ConstructorParameters<typeof SaveDraft>[0]["kind"];
  },
) => ({
  expectedRevision: null,
  slug: null,
  ownershipType: null,
  showIds: [],
  releaseDate: null,
  audioMasterId: null,
  clipOnlyMode: false,
  closerKind: "none" as const,
  playableAudio: false,
  durationSeconds: null,
  chapters: [],
  segmentIds: [],
  hostIds: [],
  tagIds: [],
  managedLinkIds: [],
  mediaAssetIds: [],
  bodyHash: "sha256:default",
  strongRefs: [],
  strengthenOnPublish: [],
  retiredAt: null,
  ...overrides,
});

it.effect(
  "Monolith Workspace enforces all 8 Podcast Network invariants (slugs, refs, publish readiness, clipOnlyMode, tag cascade)",
  () => {
    const ws = Workspace.ref(WorkspaceId.make("ws-podcast"));
    const tag1 = DocumentId.make("tag-tech");
    const tag2 = DocumentId.make("tag-ai");
    const seg1 = DocumentId.make("seg-theme");
    const showInternal = DocumentId.make("show-internal");
    const showPartner = DocumentId.make("show-partner");
    const masterDraftOnly = DocumentId.make("master-draft");
    const masterValid = DocumentId.make("master-valid");
    const ep1 = DocumentId.make("ep-1");
    const ep2 = DocumentId.make("ep-2");

    return workspaceStory(
      Story.clock("2026-11-20T12:00:00Z"),
      // Seed tags & segment
      Story.when(ws, new SaveDraft(baseDraft({ documentId: tag1, title: "Tech", kind: "taxonomyTag" }))),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({ documentId: tag1, title: "Tech", kind: "taxonomyTag" }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      Story.when(ws, new SaveDraft(baseDraft({ documentId: tag2, title: "AI", kind: "taxonomyTag" }))),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({ documentId: tag2, title: "AI", kind: "taxonomyTag" }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      Story.when(
        ws,
        new SaveDraft(baseDraft({ documentId: seg1, title: "Opening Theme", kind: "segment", tagIds: [tag1] })),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({ documentId: seg1, title: "Opening Theme", kind: "segment", tagIds: [tag1] }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      // Seed internal & partner shows with the SAME slug in different ownershipType scopes (allowed!)
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: showInternal,
            title: "Daily Briefing",
            kind: "show",
            slug: "daily-briefing",
            ownershipType: "internal",
          }),
        ),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({
            documentId: showInternal,
            title: "Daily Briefing",
            kind: "show",
            slug: "daily-briefing",
            ownershipType: "internal",
          }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: showPartner,
            title: "Partner Daily Briefing",
            kind: "show",
            slug: "daily-briefing",
            ownershipType: "partner",
          }),
        ),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({
            documentId: showPartner,
            title: "Partner Daily Briefing",
            kind: "show",
            slug: "daily-briefing",
            ownershipType: "partner",
          }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      // Duplicate show slug within same ownershipType -> rejected
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: DocumentId.make("show-dup"),
            title: "Conflicting Show",
            kind: "show",
            slug: "daily-briefing",
            ownershipType: "internal",
          }),
        ),
      ),
      Story.rejected(
        new SlugConflict({
          scope: "show:internal",
          slug: "daily-briefing",
          conflictingDocumentId: showInternal,
        }),
      ),
      // Audio masters: one without highlight chapter (stays draft), one playable + valid highlight chapter
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: masterDraftOnly,
            title: "Unpublished Master",
            kind: "audioMaster",
            playableAudio: true,
            durationSeconds: 1800,
            chapters: [{ sectionType: "main", startSec: 0, endSec: 1800, lufs: -16 }],
          }),
        ),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({
            documentId: masterDraftOnly,
            title: "Unpublished Master",
            kind: "audioMaster",
            playableAudio: true,
            durationSeconds: 1800,
            chapters: [{ sectionType: "main", startSec: 0, endSec: 1800, lufs: -16 }],
          }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: masterValid,
            title: "Playable Master With Highlight",
            kind: "audioMaster",
            playableAudio: true,
            durationSeconds: 1800,
            chapters: [
              { sectionType: "intro", startSec: 0, endSec: 60, lufs: -16 },
              { sectionType: "highlight", startSec: 60, endSec: 420, lufs: -15 },
              { sectionType: "outro", startSec: 420, endSec: 1800, lufs: -16 },
            ],
          }),
        ),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({
            documentId: masterValid,
            title: "Playable Master With Highlight",
            kind: "audioMaster",
            playableAudio: true,
            durationSeconds: 1800,
            chapters: [
              { sectionType: "intro", startSec: 0, endSec: 60, lufs: -16 },
              { sectionType: "highlight", startSec: 60, endSec: 420, lufs: -15 },
              { sectionType: "outro", startSec: 420, endSec: 1800, lufs: -16 },
            ],
          }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      // Cross-doc multi-hop clipOnlyMode rejected on internal show
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: ep1,
            title: "Episode 1",
            kind: "episode",
            slug: "ep-001",
            showIds: [showInternal],
            releaseDate: "2026-11-23",
            audioMasterId: masterValid,
            clipOnlyMode: true,
          }),
        ),
      ),
      Story.rejected(
        new ClipOnlyRuleViolation({ documentId: ep1, reason: "requires_partner_show" }),
      ),
      // Valid clipOnlyMode on partner show + masterValid succeeds
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: ep1,
            title: "Episode 1",
            kind: "episode",
            slug: "ep-001",
            showIds: [showPartner],
            releaseDate: "2026-11-23",
            audioMasterId: masterValid,
            clipOnlyMode: true,
            segmentIds: [seg1],
            tagIds: [tag1],
          }),
        ),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({
            documentId: ep1,
            title: "Episode 1",
            kind: "episode",
            slug: "ep-001",
            showIds: [showPartner],
            releaseDate: "2026-11-23",
            audioMasterId: masterValid,
            clipOnlyMode: true,
            segmentIds: [seg1],
            tagIds: [tag1],
          }),
          revision: 1,
          savedAt: T0,
        }),
      ),
      // Publishing ep1 WITHOUT publishing masterValid fails publish-readiness gate
      Story.when(ws, new PublishWorkspace({ documentIds: [ep1] })),
      Story.rejected(
        new PublishReadinessViolation({
          documentId: ep1,
          targetId: masterValid,
          reason: "audio_master_unpublished",
        }),
      ),
      // Referenced audioMaster cannot be deleted
      Story.when(ws, new DeleteDocument({ documentId: masterValid, expectedRevision: 1 })),
      Story.rejected(
        new StrongReferenceViolation({
          targetId: masterValid,
          referencedBy: [ep1],
          reason: "target_in_use",
        }),
      ),
      // Duplicate episode slug in same show rejected
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: ep2,
            title: "Duplicate Ep",
            kind: "episode",
            slug: "ep-001",
            showIds: [showPartner],
            releaseDate: "2026-11-24",
            audioMasterId: masterValid,
          }),
        ),
      ),
      Story.rejected(
        new SlugConflict({
          scope: `episode:${showPartner}`,
          slug: "ep-001",
          conflictingDocumentId: ep1,
        }),
      ),
      // Atomic multi-doc publish succeeds for [showPartner, masterValid, ep1]
      Story.when(ws, new PublishWorkspace({ documentIds: [showPartner, masterValid, ep1] })),
      Story.then(
        ws,
        new WorkspacePublished({ documentIds: [showPartner, masterValid, ep1], publishedAt: T0 }),
      ),
      Story.replied({ publishedCount: 3 }),
      // Cascading segment tag sync propagates tag2 to published ep1
      Story.when(ws, new SyncSegmentTags({ segmentId: seg1, tagIds: [tag1, tag2] })),
      Story.then(
        ws,
        new SegmentTagsCascaded({
          segmentId: seg1,
          tagIds: [tag1, tag2],
          updatedEpisodeIds: [ep1],
          syncedAt: T0,
        }),
      ),
      Story.state(ws, (s) => s.documents[ep1]?.tagIds.includes(tag2) === true),
      Story.query(
        SearchCatalog,
        { workspaceId: WorkspaceId.make("ws-podcast"), query: "Episode 1", publishedOnly: true },
        [{ documentId: ep1, title: "Episode 1", published: true }],
      ),
      // Discard draft restores published title
      Story.when(
        ws,
        new SaveDraft(
          baseDraft({
            documentId: ep1,
            expectedRevision: 1,
            title: "Episode 1 (WIP)",
            kind: "episode",
            slug: "ep-001",
            showIds: [showPartner],
            releaseDate: "2026-11-23",
            audioMasterId: masterValid,
            clipOnlyMode: true,
            segmentIds: [seg1],
            tagIds: [tag1, tag2],
          }),
        ),
      ),
      Story.then(
        ws,
        new DraftSaved({
          ...baseDraft({
            documentId: ep1,
            title: "Episode 1 (WIP)",
            kind: "episode",
            slug: "ep-001",
            showIds: [showPartner],
            releaseDate: "2026-11-23",
            audioMasterId: masterValid,
            clipOnlyMode: true,
            segmentIds: [seg1],
            tagIds: [tag1, tag2],
          }),
          revision: 2,
          savedAt: T0,
        }),
      ),
      Story.when(ws, new DiscardDraft({ documentId: ep1 })),
      Story.then(ws, new DraftDiscarded({ documentId: ep1, restoredRevision: 1, discardedAt: T0 })),
      Story.state(ws, (s) => s.documents[ep1]?.title === "Episode 1"),
    );
  },
);

it.effect(
  "Naive split ContentDocument + ScheduleSlot cannot guard dangling strong refs locally",
  () => {
    const slot = ScheduleSlot.ref(SlotKey.make("ws-1:2026-11-23"));
    const doc1 = DocumentId.make("ep-1");
    const doc2 = DocumentId.make("ep-2");
    const d1 = ContentDocument.ref(doc1);
    const missingMaster = DocumentId.make("master-does-not-exist");

    return splitStory(
      Story.clock("2026-11-20T12:00:00Z"),
      Story.when(slot, new ClaimScheduleSlot({ documentId: doc1 })),
      Story.then(slot, new SlotClaimed({ documentId: doc1 })),
      Story.when(slot, new ClaimScheduleSlot({ documentId: doc2 })),
      Story.rejected(new SlotAlreadyClaimed({ claimedBy: doc1 })),
      Story.when(
        d1,
        new SaveDocumentDraft({
          workspaceId: WorkspaceId.make("ws-1"),
          expectedRevision: null,
          title: "Unvalidated Ref Episode",
          releaseDate: "2026-11-23",
          bodyHash: "sha256:d1",
          strongRefs: [missingMaster],
        }),
      ),
      Story.then(
        d1,
        new DocumentDraftUpdated({
          workspaceId: WorkspaceId.make("ws-1"),
          title: "Unvalidated Ref Episode",
          releaseDate: "2026-11-23",
          bodyHash: "sha256:d1",
          strongRefs: [missingMaster],
          revision: 1,
          savedAt: T0,
        }),
      ),
    );
  },
);
