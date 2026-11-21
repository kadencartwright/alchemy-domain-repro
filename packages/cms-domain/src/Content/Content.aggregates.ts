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
 * - `AudioMaster` and `LibraryItem` (segments, hosts, links, media,
 *   channel welcomes) are content an episode uses.
 *
 * Three rules are restated as content rules rather than kept as reference
 * integrity (see the README): content is retired, never hard-deleted, and an
 * episode may not publish against missing or retired content; and reference
 * and `clipOnlyMode` checks run when an episode publishes, not on every edit.
 */

const at = (now: DateTime.Utc) => DateTime.toEpochMillis(now);
const ids = Schema.Array(DocumentId);

// --- LibraryItem: segments, hosts, managed links, media, channel welcomes ---

export const LibraryKind = Schema.Literals([
  "segment",
  "host",
  "managedLink",
  "mediaAsset",
  "channelWelcome",
]);
export type LibraryKind = typeof LibraryKind.Type;

export const LibraryItemRecord = Schema.Struct({
  kind: LibraryKind,
  title: Schema.String,
  retired: Schema.Boolean,
  revision: Revision,
});
export const LibraryItemState = Schema.NullOr(LibraryItemRecord);
export type LibraryItemState = typeof LibraryItemState.Type;

export class LibraryItemSaved extends Domain.Event("LibraryItemSaved", {
  kind: LibraryKind,
  title: Schema.String,
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
  managedLinkIds: ids,
  mediaAssetIds: ids,
};
export const EpisodeContent = Schema.Struct(EpisodeContentFields);
export type EpisodeContent = typeof EpisodeContent.Type;

/** The fields an editor edits, each merged and versioned on its own. */
export const EpisodeField = Schema.Literals([
  "title",
  "bodyHash",
  "closerKind",
  "clipOnlyMode",
  "audioMasterId",
  "segmentIds",
  "hostIds",
  "managedLinkIds",
  "mediaAssetIds",
]);
export type EpisodeField = typeof EpisodeField.Type;
export const EPISODE_FIELDS: ReadonlyArray<EpisodeField> = EpisodeField.literals;

/** Some of an episode's fields: what one autosave changes. */
export const EpisodePatch = Schema.Struct({
  title: Schema.optional(Schema.String),
  bodyHash: Schema.optional(Schema.String),
  closerKind: Schema.optional(EpisodeCloserKind),
  clipOnlyMode: Schema.optional(Schema.Boolean),
  audioMasterId: Schema.optional(Schema.NullOr(DocumentId)),
  segmentIds: Schema.optional(ids),
  hostIds: Schema.optional(ids),
  managedLinkIds: Schema.optional(ids),
  mediaAssetIds: Schema.optional(ids),
});
export type EpisodePatch = typeof EpisodePatch.Type;

/** For each field, the episode revision that last changed it (0: never set). */
export const FieldRevisions = Schema.Record(Schema.String, Revision);
export type FieldRevisions = typeof FieldRevisions.Type;

export const EpisodeRecord = Schema.Struct({
  ...EpisodeContentFields,
  showIds: ids,
  slug: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
  /** Counts saves: every autosave that changes a field is one revision. */
  revision: Revision,
  fieldRevisions: FieldRevisions,
  publishedRevision: Schema.NullOr(Revision),
  /** What is live: the content as of `publishedRevision`, kept while the draft moves on. */
  published: Schema.NullOr(EpisodeContent),
});
export const EpisodeState = Schema.NullOr(EpisodeRecord);
export type EpisodeState = typeof EpisodeState.Type;

/** A new episode's content, before its first autosave. */
export const EMPTY_CONTENT: EpisodeContent = {
  title: "",
  bodyHash: "",
  closerKind: "none",
  clipOnlyMode: false,
  audioMasterId: null,
  segmentIds: [],
  hostIds: [],
  managedLinkIds: [],
  mediaAssetIds: [],
};

/**
 * One autosave: the fields it changed, and the fields it skipped because a
 * co-editor changed them after this editor last saw them.
 */
export class EpisodeFieldsSaved extends Domain.Event("EpisodeFieldsSaved", {
  revision: Revision,
  editor: Schema.String,
  changes: EpisodePatch,
  skipped: Schema.Array(EpisodeField),
  savedAt: Schema.Number,
}) {}
export class EpisodeScheduled extends Domain.Event("EpisodeScheduled", {
  showIds: ids,
  slug: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
}) {}
export class EpisodePublished extends Domain.Event("EpisodePublished", {
  publishedRevision: Revision,
  content: EpisodeContent,
  publishedAt: Schema.Number,
}) {}
export class EpisodeImported extends Domain.Event("EpisodeImported", {
  episode: EpisodeRecord,
}) {}

/** Every field this autosave changed had moved on since the editor last saw it. */
export class FieldConflict extends Domain.Rejection(
  "FieldConflict",
  {
    episodeId: DocumentId,
    fields: Schema.Array(Schema.Struct({ field: EpisodeField, revision: Revision })),
  },
  { httpApiStatus: 409 },
) {}

/**
 * An editor's debounced autosave: only the fields that changed, each with the
 * revision of that field the editor started from. Fields a co-editor changed
 * since are skipped (the editor is shown their value); the rest apply. A plain
 * command on one aggregate.
 */
export class SaveEpisodeFields extends Domain.Command("SaveEpisodeFields", {
  input: {
    episodeId: DocumentId,
    editor: Schema.String,
    changes: EpisodePatch,
    /** For each changed field, the field revision the editor last saw (0 for a new episode). */
    basedOn: FieldRevisions,
  },
  events: [EpisodeFieldsSaved],
  rejects: [FieldConflict],
  reply: {
    revision: Revision,
    fieldRevisions: FieldRevisions,
    skipped: Schema.Array(EpisodeField),
  },
}) {}

const changedFields = (changes: EpisodePatch): Array<EpisodeField> =>
  EPISODE_FIELDS.filter((f) => changes[f] !== undefined);

/** Apply a patch to content. */
export const applyPatch = (content: EpisodeContent, patch: EpisodePatch): EpisodeContent => {
  const next: Record<string, unknown> = { ...content };
  for (const f of changedFields(patch)) next[f] = patch[f];
  return next as EpisodeContent;
};

export class Episode extends Domain.Aggregate("Episode", {
  id: DocumentId,
  state: EpisodeState,
  initial: null,
  commands: [SaveEpisodeFields],
  events: [EpisodeScheduled, EpisodePublished, EpisodeImported],
  keyOf: (cmd) => cmd.episodeId,
  decide: {
    SaveEpisodeFields: (s, cmd, ctx) => {
      const fields = changedFields(cmd.changes);
      if (fields.length === 0) return [];
      const current = s?.fieldRevisions ?? {};
      const stale = fields.filter((f) => (current[f] ?? 0) !== (cmd.basedOn[f] ?? 0));
      if (stale.length === fields.length) {
        return new FieldConflict({
          episodeId: cmd.episodeId,
          fields: stale.map((field) => ({ field, revision: current[field] ?? 0 })),
        });
      }
      const changes: Record<string, unknown> = {};
      for (const f of fields) if (!stale.includes(f)) changes[f] = cmd.changes[f];
      return [
        new EpisodeFieldsSaved({
          revision: (s?.revision ?? 0) + 1,
          editor: cmd.editor,
          changes: changes as EpisodePatch,
          skipped: stale,
          savedAt: at(ctx.now),
        }),
      ];
    },
  },
  evolve: {
    EpisodeFieldsSaved: (s, e) => {
      const base: NonNullable<EpisodeState> = s ?? {
        ...EMPTY_CONTENT,
        showIds: [],
        slug: null,
        releaseDate: null,
        revision: 0,
        fieldRevisions: {},
        publishedRevision: null,
        published: null,
      };
      const fieldRevisions = { ...base.fieldRevisions };
      for (const f of changedFields(e.changes)) fieldRevisions[f] = e.revision;
      return { ...base, ...applyPatch(base, e.changes), revision: e.revision, fieldRevisions };
    },
    EpisodeScheduled: (s, e) =>
      s === null ? s : { ...s, showIds: e.showIds, slug: e.slug, releaseDate: e.releaseDate },
    EpisodePublished: (s, e) =>
      s === null ? s : { ...s, publishedRevision: e.publishedRevision, published: e.content },
    EpisodeImported: (_, e) => e.episode,
  },
  reply: {
    SaveEpisodeFields: (s, events) => {
      const saved = events.find((e) => e._tag === "EpisodeFieldsSaved");
      return {
        revision: s?.revision ?? 0,
        fieldRevisions: s?.fieldRevisions ?? {},
        skipped: saved?._tag === "EpisodeFieldsSaved" ? saved.skipped : [],
      };
    },
  },
}) {}

/** An episode's draft content, without its schedule or publish state. */
export const contentOf = (e: EpisodeContent): EpisodeContent => ({
  title: e.title,
  bodyHash: e.bodyHash,
  closerKind: e.closerKind,
  clipOnlyMode: e.clipOnlyMode,
  audioMasterId: e.audioMasterId,
  segmentIds: e.segmentIds,
  hostIds: e.hostIds,
  managedLinkIds: e.managedLinkIds,
  mediaAssetIds: e.mediaAssetIds,
});

/** Every library item an episode uses. */
export const libraryRefsOf = (e: NonNullable<EpisodeState>): Array<DocumentId> => [
  ...new Set([...e.segmentIds, ...e.hostIds, ...e.managedLinkIds, ...e.mediaAssetIds]),
];
