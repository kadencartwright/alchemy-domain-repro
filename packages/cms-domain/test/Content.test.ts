import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PublishAudioMaster,
  RetireLibraryItem,
  SaveAudioMaster,
  SaveLibraryItem,
} from "../src/Content/Content.aggregates.ts";
import { ContentClient, type EpisodeEdit } from "../src/Content/Content.client.ts";
import { ContentDomain } from "../src/Content/Content.model.ts";
import { DocumentId } from "../src/Ids.ts";

const World = ContentDomain.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory));
const id = DocumentId.make;

const seg1 = id("seg-opening");
const host = id("host-1");
const internal = id("show-internal");
const partner = id("show-partner");
const master = id("master-1");
const draftMaster = id("master-draft");
const ep1 = id("ep-1");
const highlight = [
  { sectionType: "intro" as const, startSec: 0, endSec: 30, lufs: -16 },
  { sectionType: "highlight" as const, startSec: 30, endSec: 60, lufs: -14 },
];

const episode = (o: Partial<EpisodeEdit> & Pick<EpisodeEdit, "episodeId">): EpisodeEdit => ({
  expectedRevision: null,
  title: "Episode",
  bodyHash: "sha256:0",
  closerKind: "none",
  clipOnlyMode: false,
  audioMasterId: master,
  segmentIds: [seg1],
  hostIds: [host],
  managedLinkIds: [],
  mediaAssetIds: [],
  ...o,
});

const setUp = Effect.gen(function* () {
  const c = yield* ContentClient;
  for (const [itemId, kind] of [
    [seg1, "segment"],
    [host, "host"],
  ] as const) {
    yield* c.library.send(
      new SaveLibraryItem({ itemId, expectedRevision: null, kind, title: itemId }),
    );
  }
  yield* c.saveShow({
    showId: internal,
    expectedRevision: null,
    title: "Daily",
    slug: "daily",
    ownershipType: "internal",
  });
  yield* c.saveShow({
    showId: partner,
    expectedRevision: null,
    title: "Daily",
    slug: "daily",
    ownershipType: "partner",
  });
  yield* c.masters.send(
    new SaveAudioMaster({
      audioMasterId: master,
      expectedRevision: null,
      title: "Master",
      playableAudio: true,
      durationSeconds: 120,
      chapters: highlight,
    }),
  );
  yield* c.masters.send(new PublishAudioMaster({ audioMasterId: master }));
  yield* c.masters.send(
    new SaveAudioMaster({
      audioMasterId: draftMaster,
      expectedRevision: null,
      title: "Draft master",
      playableAudio: true,
      durationSeconds: 90,
      chapters: highlight,
    }),
  );
  yield* c.edit(episode({ episodeId: ep1, clipOnlyMode: true }));
  yield* c.schedule(ep1, [partner], "ep-001", "2026-11-23");
  return c;
});

describe("Topology F: the content domain", () => {
  it.effect("keeps invariants 1, 2, 3, 6 and 8 as they are", () =>
    Effect.gen(function* () {
      const c = yield* setUp;
      // (1) stale revision on an autosave, a plain single-aggregate command
      const autosave = yield* c.edit(
        episode({ episodeId: ep1, clipOnlyMode: true, expectedRevision: 1, title: "Edited" }),
      );
      expect(autosave.stream).toBe(`Episode/${ep1}`);
      const stale = yield* c
        .edit(episode({ episodeId: ep1, expectedRevision: 7 }))
        .pipe(Effect.flip);
      expect(stale._tag).toBe("RevisionConflict");
      // (2) show slugs are unique per ownership type ("daily" exists once in each)
      const dupShow = yield* c
        .saveShow({
          showId: id("show-dup"),
          expectedRevision: null,
          title: "Dup",
          slug: "daily",
          ownershipType: "internal",
        })
        .pipe(Effect.flip);
      expect(dupShow).toMatchObject({ _tag: "SlugConflict", conflictingDocumentId: internal });
      // (3) episode slug and date, per owning show: the show's own rule
      yield* c.edit(episode({ episodeId: id("ep-2") }));
      const dupSlug = yield* c.schedule(id("ep-2"), [partner], "ep-001", null).pipe(Effect.flip);
      expect(dupSlug).toMatchObject({ _tag: "SlugConflict", conflictingDocumentId: ep1 });
      const dupDate = yield* c
        .schedule(id("ep-2"), [partner], "ep-002", "2026-11-23")
        .pipe(Effect.flip);
      expect(dupDate).toMatchObject({ _tag: "ScheduleDateConflict", conflictingDocumentId: ep1 });
      // ...and the same slug in a different show is fine
      yield* c.schedule(id("ep-2"), [internal], "ep-001", "2026-11-23");
      // (6) an unpublished audio master blocks publish
      yield* c.edit(episode({ episodeId: id("ep-3"), audioMasterId: draftMaster }));
      yield* c.schedule(id("ep-3"), [internal], "ep-003", "2026-11-24");
      const notReady = yield* c.publish(id("ep-3")).pipe(Effect.flip);
      expect(notReady).toMatchObject({
        _tag: "PublishReadinessViolation",
        reason: "audio_master_unpublished",
      });
      // (8) publishing it together with its audio master is one atomic step
      const both = yield* c.publish(id("ep-3"), true);
      expect(both.commits.map((x) => x.stream)).toContain(`AudioMaster/${draftMaster}`);
      expect((yield* c.masters.get(draftMaster))?.published).toBe(true);
    }).pipe(Effect.provide(World)),
  );

  it.effect("restates invariants 4, 5 and 7 as content rules", () =>
    Effect.gen(function* () {
      const c = yield* setUp;
      // (4) a missing reference is allowed while drafting, refused at publish
      yield* c.edit(episode({ episodeId: id("ep-dangling"), mediaAssetIds: [id("missing")] }));
      const dangling = yield* c.publish(id("ep-dangling")).pipe(Effect.flip);
      expect(dangling).toMatchObject({
        _tag: "StrongReferenceViolation",
        reason: "target_missing",
      });
      // (5) content is retired, never deleted; publishing against it is refused
      yield* c.library.send(new RetireLibraryItem({ itemId: host }));
      const retired = yield* c.publish(ep1).pipe(Effect.flip);
      expect(retired).toMatchObject({ _tag: "RetiredContentViolation", targetId: host });
      yield* c.edit(
        episode({ episodeId: ep1, clipOnlyMode: true, hostIds: [], expectedRevision: 1 }),
      );
      // (7) clipOnlyMode is checked at publish: an internal show refuses it
      yield* c.edit(episode({ episodeId: id("ep-clip"), clipOnlyMode: true, hostIds: [] }));
      yield* c.schedule(id("ep-clip"), [internal], "ep-clip", "2026-12-01");
      const clip = yield* c.publish(id("ep-clip")).pipe(Effect.flip);
      expect(clip).toMatchObject({
        _tag: "ClipOnlyRuleViolation",
        reason: "requires_partner_show",
      });
      // ...and a partner show with one valid highlight publishes
      yield* c.publish(ep1);
    }).pipe(Effect.provide(World)),
  );
});
