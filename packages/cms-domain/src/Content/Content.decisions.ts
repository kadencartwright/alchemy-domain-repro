import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { DocumentId, hasValidHighlightChapter, OwnershipType, Revision } from "../Ids.ts";
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
  AudioMaster,
  AudioMasterPublished,
  Episode,
  EpisodePublished,
  EpisodeScheduled,
  EpisodeSlotsReleased,
  EpisodeSlotsTaken,
  HandleReleased,
  HandleTaken,
  handleOf,
  LibraryItem,
  libraryRefsOf,
  Show,
  ShowHandle,
  ShowHandleId,
  ShowSaved,
} from "./Content.aggregates.ts";

type Recorded = Domain.Decision.Recorded<any>;
const uniq = <A extends string>(xs: ReadonlyArray<A>): Array<A> => [...new Set(xs)];

/**
 * The caller named instances from a read that has since gone stale, or left
 * one out. It re-reads and retries.
 */
export class StaleContentRead extends Domain.Rejection(
  "StaleContentRead",
  { id: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Publishing against content that has been retired. */
export class RetiredContentViolation extends Domain.Rejection(
  "RetiredContentViolation",
  { documentId: DocumentId, targetId: DocumentId },
  { httpApiStatus: 409 },
) {}

// --- Naming a show: invariant 2 -------------------------------------------

export class SaveShow extends Domain.Command("SaveShow", {
  input: {
    showId: DocumentId,
    expectedRevision: Schema.NullOr(Revision),
    title: Schema.String,
    slug: Schema.String,
    ownershipType: OwnershipType,
    /** The handle the show held when the caller last read it, if any. */
    fromHandle: Schema.NullOr(ShowHandleId),
  },
  events: [ShowSaved, HandleTaken, HandleReleased],
  rejects: [RevisionConflict, SlugConflict, StaleContentRead],
  reply: { revision: Revision },
}) {}

export class ShowNaming extends Domain.Decision(SaveShow, {
  reads: { show: Show, handles: ShowHandle },
  keyOf: (cmd) => ({
    show: cmd.showId,
    handles: uniq([
      handleOf(cmd.ownershipType, cmd.slug),
      ...(cmd.fromHandle ? [cmd.fromHandle] : []),
    ]),
  }),
  decide: ({ show, handles }, cmd) => {
    const actual = show.state?.revision ?? null;
    if (actual !== cmd.expectedRevision) {
      return new RevisionConflict({
        documentId: cmd.showId,
        expected: cmd.expectedRevision,
        actual,
      });
    }
    const byId = new Map(handles.map((h) => [h.id as string, h]));
    const next = byId.get(handleOf(cmd.ownershipType, cmd.slug))!;
    if (next.state.showId !== null && next.state.showId !== cmd.showId) {
      return new SlugConflict({
        scope: `show:${cmd.ownershipType}`,
        slug: cmd.slug,
        conflictingDocumentId: next.state.showId,
      });
    }
    const out: Array<Recorded> = [
      show.record(
        new ShowSaved({
          title: cmd.title,
          slug: cmd.slug,
          ownershipType: cmd.ownershipType,
          revision: (actual ?? 0) + 1,
        }),
      ),
    ];
    if (next.state.showId === null) out.push(next.record(new HandleTaken({ showId: cmd.showId })));
    const prev = show.state === null ? null : handleOf(show.state.ownershipType, show.state.slug);
    if (prev !== null && prev !== next.id) {
      const old = byId.get(prev);
      if (!old) return new StaleContentRead({ id: prev });
      out.push(old.record(new HandleReleased({ showId: cmd.showId })));
    }
    return out;
  },
  reply: ({ show }) => ({ revision: show?.revision ?? 0 }),
}) {}

// --- Scheduling an episode into its shows: invariant 3 -------------------

export class ScheduleEpisode extends Domain.Command("ScheduleEpisode", {
  input: {
    episodeId: DocumentId,
    showIds: Schema.Array(DocumentId),
    slug: Schema.NullOr(Schema.String),
    releaseDate: Schema.NullOr(Schema.String),
    /** The shows the episode was in when the caller last read it. */
    fromShowIds: Schema.Array(DocumentId),
  },
  events: [EpisodeScheduled, EpisodeSlotsTaken, EpisodeSlotsReleased],
  rejects: [
    DocumentNotFound,
    StrongReferenceViolation,
    SlugConflict,
    ScheduleDateConflict,
    StaleContentRead,
  ],
}) {}

export class Scheduling extends Domain.Decision(ScheduleEpisode, {
  reads: { episode: Episode, shows: Show },
  keyOf: (cmd) => ({ episode: cmd.episodeId, shows: uniq([...cmd.showIds, ...cmd.fromShowIds]) }),
  decide: ({ episode, shows }, cmd) => {
    const ep = episode.state;
    if (ep === null) return new DocumentNotFound({ documentId: cmd.episodeId });
    const byId = new Map(shows.map((s) => [s.id as string, s]));
    for (const id of ep.showIds) if (!byId.has(id)) return new StaleContentRead({ id });
    for (const id of cmd.showIds) {
      const show = byId.get(id)!.state;
      if (show === null || show.retired) {
        return new StrongReferenceViolation({
          targetId: id,
          referencedBy: [cmd.episodeId],
          reason: "target_missing",
        });
      }
      const slugHolder = cmd.slug === null ? undefined : show.episodeSlugs[cmd.slug];
      if (slugHolder !== undefined && slugHolder !== cmd.episodeId) {
        return new SlugConflict({
          scope: `episode:${id}`,
          slug: cmd.slug!,
          conflictingDocumentId: slugHolder,
        });
      }
      const dateHolder = cmd.releaseDate === null ? undefined : show.episodeDates[cmd.releaseDate];
      if (dateHolder !== undefined && dateHolder !== cmd.episodeId) {
        return new ScheduleDateConflict({
          showId: id,
          releaseDate: cmd.releaseDate!,
          conflictingDocumentId: dateHolder,
        });
      }
    }
    const unchanged = ep.slug === cmd.slug && ep.releaseDate === cmd.releaseDate;
    const out: Array<Recorded> = [
      episode.record(
        new EpisodeScheduled({
          showIds: cmd.showIds,
          slug: cmd.slug,
          releaseDate: cmd.releaseDate,
        }),
      ),
    ];
    for (const id of ep.showIds) {
      if (unchanged && cmd.showIds.includes(id)) continue;
      out.push(
        byId
          .get(id)!
          .record(
            new EpisodeSlotsReleased({
              episodeId: cmd.episodeId,
              slug: ep.slug,
              releaseDate: ep.releaseDate,
            }),
          ),
      );
    }
    for (const id of cmd.showIds) {
      if (unchanged && ep.showIds.includes(id)) continue;
      out.push(
        byId
          .get(id)!
          .record(
            new EpisodeSlotsTaken({
              episodeId: cmd.episodeId,
              slug: cmd.slug,
              releaseDate: cmd.releaseDate,
            }),
          ),
      );
    }
    return out;
  },
}) {}

// --- Publishing an episode: invariants 4–8, restated as publish rules ----

export class PublishEpisode extends Domain.Command("PublishEpisode", {
  input: {
    episodeId: DocumentId,
    /** What the episode depends on, as the caller last read it; the decision checks it. */
    audioMasterId: Schema.NullOr(DocumentId),
    showIds: Schema.Array(DocumentId),
    libraryIds: Schema.Array(DocumentId),
    /** Publish its audio master in the same step (invariant 8). */
    publishAudioMaster: Schema.Boolean,
  },
  events: [EpisodePublished, AudioMasterPublished],
  rejects: [
    DocumentNotFound,
    StrongReferenceViolation,
    RetiredContentViolation,
    PublishReadinessViolation,
    ClipOnlyRuleViolation,
    StaleContentRead,
  ],
}) {}

export class EpisodePublication extends Domain.Decision(PublishEpisode, {
  reads: { episode: Episode, master: AudioMaster, shows: Show, library: LibraryItem },
  keyOf: (cmd) => ({
    episode: cmd.episodeId,
    master: cmd.audioMasterId === null ? [] : [cmd.audioMasterId],
    shows: uniq(cmd.showIds),
    library: uniq(cmd.libraryIds),
  }),
  decide: ({ episode, master, shows, library }, cmd, ctx) => {
    const ep = episode.state;
    if (ep === null) return new DocumentNotFound({ documentId: cmd.episodeId });
    const id = cmd.episodeId;
    // The caller must have named exactly what the episode depends on now.
    if (ep.audioMasterId !== cmd.audioMasterId)
      return new StaleContentRead({ id: ep.audioMasterId ?? "no audio master" });
    const named = new Set<string>([...cmd.showIds, ...cmd.libraryIds]);
    for (const dep of [...ep.showIds, ...libraryRefsOf(ep)])
      if (!named.has(dep)) return new StaleContentRead({ id: dep });

    // Invariants 4–5, restated: publish only against content that exists and isn't retired.
    for (const item of library) {
      if (item.state === null) {
        return new StrongReferenceViolation({
          targetId: item.id,
          referencedBy: [id],
          reason: "target_missing",
        });
      }
      if (item.state.retired)
        return new RetiredContentViolation({ documentId: id, targetId: item.id });
    }
    for (const show of shows) {
      if (show.state === null) {
        return new StrongReferenceViolation({
          targetId: show.id,
          referencedBy: [id],
          reason: "target_missing",
        });
      }
      if (show.state.retired)
        return new RetiredContentViolation({ documentId: id, targetId: show.id });
    }
    const m = master[0];
    if (m !== undefined) {
      if (m.state === null) {
        return new StrongReferenceViolation({
          targetId: m.id,
          referencedBy: [id],
          reason: "target_missing",
        });
      }
      if (m.state.retired) return new RetiredContentViolation({ documentId: id, targetId: m.id });
    }
    // Invariant 7, checked at publish: a clip-only episode needs a partner show and one valid highlight.
    if (ep.clipOnlyMode) {
      const primary = shows.find((s) => s.id === ep.showIds[0])?.state ?? null;
      if (primary === null || m === undefined || m.state === null) {
        return new ClipOnlyRuleViolation({ documentId: id, reason: "missing_show_or_audio" });
      }
      if (primary.ownershipType !== "partner") {
        return new ClipOnlyRuleViolation({ documentId: id, reason: "requires_partner_show" });
      }
      if (!hasValidHighlightChapter(m.state.durationSeconds, m.state.chapters)) {
        return new ClipOnlyRuleViolation({
          documentId: id,
          reason: "requires_valid_highlight_chapter",
        });
      }
    }
    // Invariant 6: a published, playable audio master (or one published in this same step).
    if (m !== undefined && m.state !== null) {
      if (!m.state.published && !cmd.publishAudioMaster) {
        return new PublishReadinessViolation({
          documentId: id,
          targetId: m.id,
          reason: "audio_master_unpublished",
        });
      }
      if (!m.state.playableAudio) {
        return new PublishReadinessViolation({
          documentId: id,
          targetId: m.id,
          reason: "audio_master_not_playable",
        });
      }
    }
    const now = DateTime.toEpochMillis(ctx.now);
    const out: Array<Recorded> = [
      episode.record(new EpisodePublished({ publishedRevision: ep.revision, publishedAt: now })),
    ];
    if (cmd.publishAudioMaster && m !== undefined && m.state !== null && !m.state.published) {
      out.push(m.record(new AudioMasterPublished({ publishedAt: now })));
    }
    return out;
  },
}) {}
