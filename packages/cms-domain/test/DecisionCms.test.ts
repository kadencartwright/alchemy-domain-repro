import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CmsDocument,
  InboundRefs,
  observedFor,
  UniqueClaim,
  ClaimKey,
} from "../src/Decision/DecisionCms.aggregates.ts";
import {
  DeleteCmsDocument,
  noneObserved,
  PublishCmsDocuments,
  SaveCmsDraft,
} from "../src/Decision/DecisionCms.commands.ts";
import {
  CmsDocumentDeletion,
  CmsDraftSaving,
  CmsPublication,
} from "../src/Decision/DecisionCms.decisions.ts";
import { DecisionCms } from "../src/Decision/DecisionCms.model.ts";
import { type Draft, DecisionCmsClient } from "../src/Decision/DecisionCms.client.ts";
import { DocumentId } from "../src/Ids.ts";

const World = DecisionCms.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory));

const draft = (o: Partial<Draft> & Pick<Draft, "documentId" | "title" | "kind">): Draft => ({
  expectedRevision: null,
  slug: null,
  ownershipType: null,
  showIds: [],
  releaseDate: null,
  audioMasterId: null,
  clipOnlyMode: false,
  closerKind: "none",
  playableAudio: false,
  durationSeconds: null,
  chapters: [],
  segmentIds: [],
  hostIds: [],
  managedLinkIds: [],
  mediaAssetIds: [],
  bodyHash: "sha256:default",
  strongRefs: [],
  strengthenOnPublish: [],
  retiredAt: null,
  ...o,
});

const client = DecisionCmsClient;

const id = DocumentId.make;
const seg1 = id("seg-opening");
const showInternal = id("show-internal");
const showPartner = id("show-partner");
const masterValid = id("master-valid");
const ep1 = id("ep-1");
const highlight = [
  { sectionType: "intro" as const, startSec: 0, endSec: 30, lufs: -16 },
  { sectionType: "highlight" as const, startSec: 30, endSec: 60, lufs: -14 },
];

describe("Topology E: per-document aggregates + Domain.Decision", () => {
  it.effect("enforces all 8 Podcast Network invariants without a monolithic aggregate", () =>
    Effect.gen(function* () {
      const cms = yield* client;
      const tagOf = (e: { readonly _tag: string }) => e._tag;

      yield* cms.save(draft({ documentId: seg1, title: "Opening", kind: "segment" }));
      // An autosave that keeps its references and claims reads only its own document.
      const autosave = yield* cms.save(
        draft({
          documentId: seg1,
          title: "Opening (edited)",
          kind: "segment",
          expectedRevision: 1,
        }),
      );
      expect(autosave.commits.map((c) => c.stream)).toEqual([`CmsDocument/${seg1}`]);
      yield* cms.save(
        draft({
          documentId: showInternal,
          title: "Daily",
          kind: "show",
          slug: "daily",
          ownershipType: "internal",
        }),
      );
      // (2) the same slug under the other ownership type is a different scope
      yield* cms.save(
        draft({
          documentId: showPartner,
          title: "Daily",
          kind: "show",
          slug: "daily",
          ownershipType: "partner",
        }),
      );
      const dupShow = yield* cms
        .save(
          draft({
            documentId: id("show-dup"),
            title: "Dup",
            kind: "show",
            slug: "daily",
            ownershipType: "internal",
          }),
        )
        .pipe(Effect.flip);
      expect(dupShow).toMatchObject({ _tag: "SlugConflict", conflictingDocumentId: showInternal });

      yield* cms.save(
        draft({
          documentId: masterValid,
          title: "Master",
          kind: "audioMaster",
          playableAudio: true,
          durationSeconds: 120,
          chapters: highlight,
        }),
      );
      const episode = draft({
        documentId: ep1,
        title: "Episode 1",
        kind: "episode",
        slug: "ep-001",
        showIds: [showPartner],
        releaseDate: "2026-11-23",
        audioMasterId: masterValid,
        clipOnlyMode: true,
        segmentIds: [seg1],
      });
      yield* cms.save(episode);

      // (1) stale revision
      const stale = yield* cms.save({ ...episode, expectedRevision: 7 }).pipe(Effect.flip);
      expect(tagOf(stale)).toBe("RevisionConflict");
      // (3) slug and date per owning show
      const dupSlug = yield* cms
        .save(
          draft({
            documentId: id("ep-2"),
            title: "E2",
            kind: "episode",
            slug: "ep-001",
            showIds: [showPartner],
          }),
        )
        .pipe(Effect.flip);
      expect(dupSlug).toMatchObject({ _tag: "SlugConflict", conflictingDocumentId: ep1 });
      const dupDate = yield* cms
        .save(
          draft({
            documentId: id("ep-2"),
            title: "E2",
            kind: "episode",
            showIds: [showPartner],
            releaseDate: "2026-11-23",
          }),
        )
        .pipe(Effect.flip);
      expect(dupDate).toMatchObject({ _tag: "ScheduleDateConflict", conflictingDocumentId: ep1 });
      // (4) dangling strong reference
      const dangling = yield* cms
        .save(
          draft({ documentId: id("ep-3"), title: "E3", kind: "episode", hostIds: [id("missing")] }),
        )
        .pipe(Effect.flip);
      expect(dangling).toMatchObject({
        _tag: "StrongReferenceViolation",
        reason: "target_missing",
      });
      // (7) clipOnlyMode on an internal show
      const clip = yield* cms
        .save(
          draft({
            documentId: id("ep-4"),
            title: "E4",
            kind: "episode",
            showIds: [showInternal],
            audioMasterId: masterValid,
            clipOnlyMode: true,
          }),
        )
        .pipe(Effect.flip);
      expect(clip).toMatchObject({
        _tag: "ClipOnlyRuleViolation",
        reason: "requires_partner_show",
      });
      // (6) the audio master isn't published yet
      const notReady = yield* cms.publish([ep1]).pipe(Effect.flip);
      expect(notReady).toMatchObject({
        _tag: "PublishReadinessViolation",
        reason: "audio_master_unpublished",
      });
      // (5) delete-in-use
      const inUse = yield* cms.remove(masterValid, 1).pipe(Effect.flip);
      expect(inUse).toMatchObject({
        _tag: "StrongReferenceViolation",
        reason: "target_in_use",
        referencedBy: [ep1],
      });

      // (8) atomic multi-document publish
      const published = yield* cms.publish([masterValid, ep1]);
      expect(published.commits.length).toBeGreaterThan(2);
      expect((yield* cms.get(ep1))?.publishedRevision).toBe(1);
      expect((yield* cms.get(masterValid))?.publishedRevision).toBe(1);

      // A freed claim can be taken by someone else.
      yield* cms.remove(showInternal, 1);
      expect(
        (yield* (yield* UniqueClaim).get(ClaimKey.make("show-slug:internal:daily"))).holder,
      ).toBeNull();
      yield* cms.save(
        draft({
          documentId: id("show-new"),
          title: "Daily",
          kind: "show",
          slug: "daily",
          ownershipType: "internal",
        }),
      );
    }).pipe(Effect.provide(World)),
  );

  it.effect(
    "refuses with StaleRead when the caller didn't name an instance the change touches",
    () =>
      Effect.gen(function* () {
        const cms = yield* client;
        const saving = yield* CmsDraftSaving;
        yield* cms.save(
          draft({
            documentId: showPartner,
            title: "Show",
            kind: "show",
            slug: "a",
            ownershipType: "partner",
          }),
        );
        // The show already holds `show-slug:partner:a`; renaming it without naming that claim
        // leaves the decision unable to release it.
        const refused = yield* saving
          .send(
            new SaveCmsDraft({
              ...draft({
                documentId: showPartner,
                title: "Show",
                kind: "show",
                slug: "b",
                ownershipType: "partner",
              }),
              expectedRevision: 1,
              observed: noneObserved,
            }),
          )
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "StaleRead",
          missing: "claim",
          id: "show-slug:partner:a",
        });
      }).pipe(Effect.provide(World)),
  );
});
