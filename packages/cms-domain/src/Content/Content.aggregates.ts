import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  AudioChapterSection,
  DocumentId,
  EpisodeCloserKind,
  OwnershipType,
  Revision,
} from "../Ids.ts";
import { DocumentNotFound, RevisionConflict } from "../Workspace/WorkspaceRule.rejection.ts";

/**
 * Topology F — the content domain itself.
 *
 * Earlier models treat the podcast network as a CMS would: documents with
 * typed strong references. Here the aggregates are the things the network is
 * about, and each rule lives with what owns it:
 *
 * - `Show` owns its episode schedule (episode slugs and release dates).
 * - `ShowHandle` is a show's public slug, unique per ownership type.
 * - `Episode` owns its draft; editing it is a plain single-aggregate command.
 * - `AudioMaster` and `LibraryItem` (segments, hosts, tags, links, media,
 *   channel welcomes) are content an episode uses.
 *
 * Three rules are restated as content rules rather than kept as reference
 * integrity (see the README): content is retired, never hard-deleted, and an
 * episode may not publish against missing or retired content; reference and
 * `clipOnlyMode` checks run when an episode publishes, not on every edit; and
 * an episode's tags come from its primary segment when it's read, rather than
 * being written to every episode when the segment changes.
 */

const at = (now: DateTime.Utc) => DateTime.toEpochMillis(now);
const ids = Schema.Array(DocumentId);

// --- LibraryItem: segments, hosts, tags, managed links, media, channel welcomes ---

export const LibraryKind = Schema.Literals([
  "segment",
  "host",
  "taxonomyTag",
  "managedLink",
  "mediaAsset",
  "channelWelcome",
]);
export type LibraryKind = typeof LibraryKind.Type;

export const LibraryItemRecord = Schema.Struct({
  kind: LibraryKind,
  title: Schema.String,
  /** For a segment: the tags every episode using it as primary segment carries. */
  tagIds: ids,
  retired: Schema.Boolean,
  revision: Revision,
});
export const LibraryItemState = Schema.NullOr(LibraryItemRecord);
export type LibraryItemState = typeof LibraryItemState.Type;

export class LibraryItemSaved extends Domain.Event("LibraryItemSaved", {
  kind: LibraryKind,
  title: Schema.String,
  tagIds: ids,
  revision: Revision,
}) {}
export class LibraryItemRetired extends Domain.Event("LibraryItemRetired", {
  retiredAt: Schema.Number,
}) {}
export class LibraryItemImported extends Domain.Event("LibraryItemImported", {
  item: LibraryItemRecord,
}) {}

export class SaveLibraryItem extends Domain.Command("SaveLibraryItem", {
  input: {
    itemId: DocumentId,
    expectedRevision: Schema.NullOr(Revision),
    kind: LibraryKind,
    title: Schema.String,
    tagIds: ids,
  },
  events: [LibraryItemSaved],
  rejects: [RevisionConflict],
  reply: { revision: Revision },
}) {}

/** Retiring is always allowed. Published episodes keep what they published; new publishes refuse it. */
export class RetireLibraryItem extends Domain.Command("RetireLibraryItem", {
  input: { itemId: DocumentId },
  events: [LibraryItemRetired],
  rejects: [DocumentNotFound],
}) {}

export class LibraryItem extends Domain.Aggregate("LibraryItem", {
  id: DocumentId,
  state: LibraryItemState,
  initial: null,
  commands: [SaveLibraryItem, RetireLibraryItem],
  events: [LibraryItemImported],
  keyOf: (cmd) => cmd.itemId,
  decide: {
    SaveLibraryItem: (s, cmd) => {
      const actual = s?.revision ?? null;
      if (actual !== cmd.expectedRevision) {
        return new RevisionConflict({
          documentId: cmd.itemId,
          expected: cmd.expectedRevision,
          actual,
        });
      }
      return [
        new LibraryItemSaved({
          kind: cmd.kind,
          title: cmd.title,
          tagIds: cmd.tagIds,
          revision: (actual ?? 0) + 1,
        }),
      ];
    },
    RetireLibraryItem: (s, cmd, ctx) =>
      s === null
        ? new DocumentNotFound({ documentId: cmd.itemId })
        : s.retired
          ? []
          : [new LibraryItemRetired({ retiredAt: at(ctx.now) })],
  },
  evolve: {
    LibraryItemSaved: (s, e) => ({
      kind: e.kind,
      title: e.title,
      tagIds: e.tagIds,
      retired: s?.retired ?? false,
      revision: e.revision,
    }),
    LibraryItemRetired: (s) => (s === null ? s : { ...s, retired: true }),
    LibraryItemImported: (_, e) => e.item,
  },
  reply: { SaveLibraryItem: (s) => ({ revision: s?.revision ?? 0 }) },
}) {}

// --- AudioMaster ---------------------------------------------------------

export const AudioMasterRecord = Schema.Struct({
  title: Schema.String,
  playableAudio: Schema.Boolean,
  durationSeconds: Schema.NullOr(Schema.Number),
  chapters: Schema.Array(AudioChapterSection),
  published: Schema.Boolean,
  retired: Schema.Boolean,
  revision: Revision,
});
export const AudioMasterState = Schema.NullOr(AudioMasterRecord);
export type AudioMasterState = typeof AudioMasterState.Type;

export class AudioMasterSaved extends Domain.Event("AudioMasterSaved", {
  title: Schema.String,
  playableAudio: Schema.Boolean,
  durationSeconds: Schema.NullOr(Schema.Number),
  chapters: Schema.Array(AudioChapterSection),
  revision: Revision,
}) {}
export class AudioMasterPublished extends Domain.Event("AudioMasterPublished", {
  publishedAt: Schema.Number,
}) {}
export class AudioMasterRetired extends Domain.Event("AudioMasterRetired", {
  retiredAt: Schema.Number,
}) {}
export class AudioMasterImported extends Domain.Event("AudioMasterImported", {
  master: AudioMasterRecord,
}) {}

export class SaveAudioMaster extends Domain.Command("SaveAudioMaster", {
  input: {
    audioMasterId: DocumentId,
    expectedRevision: Schema.NullOr(Revision),
    title: Schema.String,
    playableAudio: Schema.Boolean,
    durationSeconds: Schema.NullOr(Schema.Number),
    chapters: Schema.Array(AudioChapterSection),
  },
  events: [AudioMasterSaved],
  rejects: [RevisionConflict],
  reply: { revision: Revision },
}) {}

export class PublishAudioMaster extends Domain.Command("PublishAudioMaster", {
  input: { audioMasterId: DocumentId },
  events: [AudioMasterPublished],
  rejects: [DocumentNotFound],
}) {}

export class RetireAudioMaster extends Domain.Command("RetireAudioMaster", {
  input: { audioMasterId: DocumentId },
  events: [AudioMasterRetired],
  rejects: [DocumentNotFound],
}) {}

export class AudioMaster extends Domain.Aggregate("AudioMaster", {
  id: DocumentId,
  state: AudioMasterState,
  initial: null,
  commands: [SaveAudioMaster, PublishAudioMaster, RetireAudioMaster],
  events: [AudioMasterImported],
  keyOf: (cmd) => cmd.audioMasterId,
  decide: {
    SaveAudioMaster: (s, cmd) => {
      const actual = s?.revision ?? null;
      if (actual !== cmd.expectedRevision) {
        return new RevisionConflict({
          documentId: cmd.audioMasterId,
          expected: cmd.expectedRevision,
          actual,
        });
      }
      const { _tag: _, audioMasterId: _id, expectedRevision: _e, ...fields } = cmd;
      return [new AudioMasterSaved({ ...fields, revision: (actual ?? 0) + 1 })];
    },
    PublishAudioMaster: (s, cmd, ctx) =>
      s === null
        ? new DocumentNotFound({ documentId: cmd.audioMasterId })
        : s.published
          ? []
          : [new AudioMasterPublished({ publishedAt: at(ctx.now) })],
    RetireAudioMaster: (s, cmd, ctx) =>
      s === null
        ? new DocumentNotFound({ documentId: cmd.audioMasterId })
        : s.retired
          ? []
          : [new AudioMasterRetired({ retiredAt: at(ctx.now) })],
  },
  evolve: {
    AudioMasterSaved: (s, e) => ({
      title: e.title,
      playableAudio: e.playableAudio,
      durationSeconds: e.durationSeconds,
      chapters: e.chapters,
      published: s?.published ?? false,
      retired: s?.retired ?? false,
      revision: e.revision,
    }),
    AudioMasterPublished: (s) => (s === null ? s : { ...s, published: true }),
    AudioMasterRetired: (s) => (s === null ? s : { ...s, retired: true }),
    AudioMasterImported: (_, e) => e.master,
  },
  reply: { SaveAudioMaster: (s) => ({ revision: s?.revision ?? 0 }) },
}) {}

// --- ShowHandle: a show's slug, unique per ownership type ----------------

export const ShowHandleId = Schema.String.pipe(Schema.brand("ShowHandleId"));
export type ShowHandleId = typeof ShowHandleId.Type;
export const handleOf = (ownershipType: OwnershipType, slug: string): ShowHandleId =>
  ShowHandleId.make(`${ownershipType}:${slug}`);

export class HandleTaken extends Domain.Event("HandleTaken", { showId: DocumentId }) {}
export class HandleReleased extends Domain.Event("HandleReleased", { showId: DocumentId }) {}

export class ShowHandle extends Domain.Aggregate("ShowHandle", {
  id: ShowHandleId,
  state: Schema.Struct({ showId: Schema.NullOr(DocumentId) }),
  initial: { showId: null },
  events: [HandleTaken, HandleReleased],
  evolve: {
    HandleTaken: (_, e) => ({ showId: e.showId }),
    HandleReleased: (s, e) => (s.showId === e.showId ? { showId: null } : s),
  },
}) {}

// --- Show: owns its episode schedule ------------------------------------

export const ShowRecord = Schema.Struct({
  title: Schema.String,
  slug: Schema.String,
  ownershipType: OwnershipType,
  retired: Schema.Boolean,
  revision: Revision,
  /** Episode slug -> the episode holding it, within this show. */
  episodeSlugs: Schema.Record(Schema.String, DocumentId),
  /** Release date -> the episode holding it, within this show. */
  episodeDates: Schema.Record(Schema.String, DocumentId),
});
export const ShowState = Schema.NullOr(ShowRecord);
export type ShowState = typeof ShowState.Type;

export class ShowSaved extends Domain.Event("ShowSaved", {
  title: Schema.String,
  slug: Schema.String,
  ownershipType: OwnershipType,
  revision: Revision,
}) {}
export class ShowRetired extends Domain.Event("ShowRetired", { retiredAt: Schema.Number }) {}
export class EpisodeSlotsTaken extends Domain.Event("EpisodeSlotsTaken", {
  episodeId: DocumentId,
  slug: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
}) {}
export class EpisodeSlotsReleased extends Domain.Event("EpisodeSlotsReleased", {
  episodeId: DocumentId,
  slug: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
}) {}
export class ShowImported extends Domain.Event("ShowImported", { show: ShowRecord }) {}

export class RetireShow extends Domain.Command("RetireShow", {
  input: { showId: DocumentId },
  events: [ShowRetired],
  rejects: [DocumentNotFound],
}) {}

const without = (
  record: Readonly<Record<string, DocumentId>>,
  key: string | null,
  holder: DocumentId,
) => {
  if (key === null || record[key] !== holder) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

export class Show extends Domain.Aggregate("Show", {
  id: DocumentId,
  state: ShowState,
  initial: null,
  commands: [RetireShow],
  events: [ShowSaved, EpisodeSlotsTaken, EpisodeSlotsReleased, ShowImported],
  keyOf: (cmd) => cmd.showId,
  decide: {
    RetireShow: (s, cmd, ctx) =>
      s === null
        ? new DocumentNotFound({ documentId: cmd.showId })
        : s.retired
          ? []
          : [new ShowRetired({ retiredAt: at(ctx.now) })],
  },
  evolve: {
    ShowSaved: (s, e) => ({
      title: e.title,
      slug: e.slug,
      ownershipType: e.ownershipType,
      retired: s?.retired ?? false,
      revision: e.revision,
      episodeSlugs: s?.episodeSlugs ?? {},
      episodeDates: s?.episodeDates ?? {},
    }),
    ShowRetired: (s) => (s === null ? s : { ...s, retired: true }),
    EpisodeSlotsTaken: (s, e) =>
      s === null
        ? s
        : {
            ...s,
            episodeSlugs:
              e.slug === null ? s.episodeSlugs : { ...s.episodeSlugs, [e.slug]: e.episodeId },
            episodeDates:
              e.releaseDate === null
                ? s.episodeDates
                : { ...s.episodeDates, [e.releaseDate]: e.episodeId },
          },
    EpisodeSlotsReleased: (s, e) =>
      s === null
        ? s
        : {
            ...s,
            episodeSlugs: without(s.episodeSlugs, e.slug, e.episodeId),
            episodeDates: without(s.episodeDates, e.releaseDate, e.episodeId),
          },
    ShowImported: (_, e) => e.show,
  },
}) {}

// --- Episode: owns its draft ---------------------------------------------

export const EpisodeContentFields = {
  title: Schema.String,
  bodyHash: Schema.String,
  closerKind: EpisodeCloserKind,
  clipOnlyMode: Schema.Boolean,
  audioMasterId: Schema.NullOr(DocumentId),
  segmentIds: ids,
  hostIds: ids,
  tagIds: ids,
  managedLinkIds: ids,
  mediaAssetIds: ids,
};

export const EpisodeRecord = Schema.Struct({
  ...EpisodeContentFields,
  showIds: ids,
  slug: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
  revision: Revision,
  publishedRevision: Schema.NullOr(Revision),
});
export const EpisodeState = Schema.NullOr(EpisodeRecord);
export type EpisodeState = typeof EpisodeState.Type;

export class EpisodeDraftEdited extends Domain.Event("EpisodeDraftEdited", {
  ...EpisodeContentFields,
  revision: Revision,
  editedAt: Schema.Number,
}) {}
export class EpisodeScheduled extends Domain.Event("EpisodeScheduled", {
  showIds: ids,
  slug: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
}) {}
export class EpisodePublished extends Domain.Event("EpisodePublished", {
  publishedRevision: Revision,
  publishedAt: Schema.Number,
}) {}
export class EpisodeImported extends Domain.Event("EpisodeImported", {
  episode: EpisodeRecord,
}) {}

/** An editor's autosave: content only, so a plain command on one aggregate. */
export class EditEpisodeDraft extends Domain.Command("EditEpisodeDraft", {
  input: {
    episodeId: DocumentId,
    expectedRevision: Schema.NullOr(Revision),
    ...EpisodeContentFields,
  },
  events: [EpisodeDraftEdited],
  rejects: [RevisionConflict],
  reply: { revision: Revision },
}) {}

export class Episode extends Domain.Aggregate("Episode", {
  id: DocumentId,
  state: EpisodeState,
  initial: null,
  commands: [EditEpisodeDraft],
  events: [EpisodeScheduled, EpisodePublished, EpisodeImported],
  keyOf: (cmd) => cmd.episodeId,
  decide: {
    EditEpisodeDraft: (s, cmd, ctx) => {
      const actual = s?.revision ?? null;
      if (actual !== cmd.expectedRevision) {
        return new RevisionConflict({
          documentId: cmd.episodeId,
          expected: cmd.expectedRevision,
          actual,
        });
      }
      const { _tag: _, episodeId: _id, expectedRevision: _e, ...fields } = cmd;
      return [
        new EpisodeDraftEdited({ ...fields, revision: (actual ?? 0) + 1, editedAt: at(ctx.now) }),
      ];
    },
  },
  evolve: {
    EpisodeDraftEdited: (s, e) => {
      const { _tag: _, revision, editedAt: _at, ...fields } = e;
      return {
        ...fields,
        showIds: s?.showIds ?? [],
        slug: s?.slug ?? null,
        releaseDate: s?.releaseDate ?? null,
        revision,
        publishedRevision: s?.publishedRevision ?? null,
      };
    },
    EpisodeScheduled: (s, e) =>
      s === null ? s : { ...s, showIds: e.showIds, slug: e.slug, releaseDate: e.releaseDate },
    EpisodePublished: (s, e) => (s === null ? s : { ...s, publishedRevision: e.publishedRevision }),
    EpisodeImported: (_, e) => e.episode,
  },
  reply: { EditEpisodeDraft: (s) => ({ revision: s?.revision ?? 0 }) },
}) {}

/** The tags an episode carries: its primary segment's when it has one, read at the time. */
export const effectiveTagsOf = (
  episode: EpisodeState,
  primarySegment: LibraryItemState,
): ReadonlyArray<DocumentId> =>
  episode === null
    ? []
    : primarySegment !== null && episode.segmentIds[0]
      ? primarySegment.tagIds
      : episode.tagIds;

/** Every library item an episode uses. */
export const libraryRefsOf = (e: NonNullable<EpisodeState>): Array<DocumentId> => [
  ...new Set([...e.segmentIds, ...e.hostIds, ...e.tagIds, ...e.managedLinkIds, ...e.mediaAssetIds]),
];
