import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { DocumentId } from "../Ids.ts";
import type { DocumentMeta } from "../Workspace/WorkspaceState.ts";
import {
  AudioMaster,
  AudioMasterImported,
  applyPatch,
  EMPTY_CONTENT,
  EPISODE_FIELDS,
  Episode,
  type EpisodeContent,
  type EpisodePatch,
  EpisodeImported,
  HandleTaken,
  handleOf,
  LibraryItem,
  LibraryItemImported,
  type LibraryKind,
  libraryRefsOf,
  Show,
  ShowHandle,
  SaveEpisodeFields,
  ShowImported,
} from "./Content.aggregates.ts";
import {
  EpisodePublication,
  PublishEpisode,
  SaveShow,
  ScheduleEpisode,
  Scheduling,
  ShowNaming,
} from "./Content.decisions.ts";
import { EpisodeRevisions } from "./Content.history.ts";

type Options = { readonly commandId?: string };

/**
 * A caller of the content model. Edits are plain commands; scheduling, show
 * naming and publishing read what they must name first, then send.
 */
export const ContentClient = Effect.gen(function* () {
  const episodes = yield* Episode;
  const shows = yield* Show;
  const library = yield* LibraryItem;
  const masters = yield* AudioMaster;
  const naming = yield* ShowNaming;
  const scheduling = yield* Scheduling;
  const publication = yield* EpisodePublication;
  const revisions = yield* EpisodeRevisions;

  /**
   * The draft as of `revision`: the history's changes up to it, folded. Reads
   * the history from its start, which is fine for restores, which are rare.
   */
  const contentAt = (episodeId: DocumentId, revision: number) =>
    Effect.gen(function* () {
      const key = Episode.ref(episodeId);
      let content: EpisodeContent | null = null;
      let after: number | undefined;
      for (;;) {
        const page = yield* revisions.list(key, {
          take: 500,
          ...(after === undefined ? {} : { after }),
        });
        for (const { event } of page.entries) {
          if (event.revision > revision) return Option.fromNullishOr(content);
          content = applyPatch(content ?? EMPTY_CONTENT, event.changes);
          if (event.revision === revision) return Option.some(content);
        }
        if (page.cursor === null) return Option.none<EpisodeContent>();
        after = page.cursor;
      }
    });

  /** An autosave from an editor who has seen the episode as it is now. */
  const edit = (
    episodeId: DocumentId,
    changes: EpisodePatch,
    editor = "editor",
    options?: Options,
  ) =>
    Effect.flatMap(episodes.get(episodeId), (ep) =>
      episodes.send(
        new SaveEpisodeFields({
          episodeId,
          editor,
          changes,
          basedOn: ep?.fieldRevisions ?? {},
        }),
        options,
      ),
    );

  return {
    episodes,
    shows,
    library,
    masters,
    /** An autosave with the field revisions the editor last saw. */
    save: (
      episodeId: DocumentId,
      editor: string,
      changes: EpisodePatch,
      basedOn: Record<string, number>,
      options?: Options,
    ) => episodes.send(new SaveEpisodeFields({ episodeId, editor, changes, basedOn }), options),
    edit,
    saveShow: (
      s: Omit<ConstructorParameters<typeof SaveShow>[0], "_tag" | "fromHandle">,
      options?: Options,
    ) =>
      Effect.flatMap(shows.get(s.showId), (prev) =>
        naming.send(
          new SaveShow({
            ...s,
            fromHandle: prev === null ? null : handleOf(prev.ownershipType, prev.slug),
          }),
          options,
        ),
      ),
    schedule: (
      episodeId: DocumentId,
      showIds: ReadonlyArray<DocumentId>,
      slug: string | null,
      releaseDate: string | null,
      options?: Options,
    ) =>
      Effect.flatMap(episodes.get(episodeId), (prev) =>
        scheduling.send(
          new ScheduleEpisode({
            episodeId,
            showIds,
            slug,
            releaseDate,
            fromShowIds: prev?.showIds ?? [],
          }),
          options,
        ),
      ),
    /**
     * Requirement 9: a page of an episode's revisions, newest first. Follows the
     * autosave a moment later; `EpisodeHistory.caughtUp(receipt)` waits for one.
     */
    history: (episodeId: DocumentId, page?: { readonly take?: number; readonly after?: number }) =>
      revisions.list(Episode.ref(episodeId), {
        order: "desc",
        take: page?.take ?? 50,
        ...(page?.after === undefined ? {} : { after: page.after }),
      }),
    /** The draft's content as of a revision, if it was recorded. */
    contentAt,
    /**
     * Restore an earlier revision (rare): the fields that differ from it now
     * are saved back as a new revision, so a restore can itself be undone.
     */
    restore: (episodeId: DocumentId, revision: number, editor: string, options?: Options) =>
      Effect.gen(function* () {
        const old = yield* contentAt(episodeId, revision);
        const now = yield* episodes.get(episodeId);
        if (Option.isNone(old) || now === null) return Option.none();
        const changes: Record<string, unknown> = {};
        for (const f of EPISODE_FIELDS) {
          if (JSON.stringify(old.value[f]) !== JSON.stringify(now[f])) changes[f] = old.value[f];
        }
        return Option.some(
          yield* episodes.send(
            new SaveEpisodeFields({
              episodeId,
              editor,
              changes: changes as EpisodePatch,
              basedOn: now.fieldRevisions,
            }),
            options,
          ),
        );
      }),
    /**
     * Publish the revision the publisher reviewed (by default, the draft as it
     * is now); refused if the draft has moved past it.
     */
    publish: (
      episodeId: DocumentId,
      how?: { readonly reviewed?: number; readonly publishAudioMaster?: boolean },
      options?: Options,
    ) =>
      Effect.flatMap(episodes.get(episodeId), (ep) =>
        publication.send(
          new PublishEpisode({
            episodeId,
            revision: how?.reviewed ?? ep?.revision ?? 0,
            audioMasterId: ep?.audioMasterId ?? null,
            showIds: ep?.showIds ?? [],
            libraryIds: ep === null ? [] : libraryRefsOf(ep),
            publishAudioMaster: how?.publishAudioMaster ?? false,
          }),
          options,
        ),
      ),
  };
});

const LIBRARY_KINDS = new Set<string>([
  "segment",
  "host",
  "managedLink",
  "mediaAsset",
  "channelWelcome",
]);

/** Every instance a set of existing CMS documents implies in the content model. */
export const contentSeedOf = (documents: ReadonlyArray<DocumentMeta>) => {
  const slotsByShow = new Map<
    string,
    { slugs: Record<string, DocumentId>; dates: Record<string, DocumentId> }
  >();
  for (const d of documents) {
    if (d.kind !== "episode") continue;
    for (const showId of d.showIds) {
      const slots = slotsByShow.get(showId) ?? { slugs: {}, dates: {} };
      if (d.slug !== null) slots.slugs[d.slug] = d.id;
      if (d.releaseDate !== null) slots.dates[d.releaseDate] = d.id;
      slotsByShow.set(showId, slots);
    }
  }
  const shows = documents
    .filter((d) => d.kind === "show")
    .map((d) => ({
      id: d.id,
      show: {
        title: d.title,
        slug: d.slug ?? d.id,
        ownershipType: d.ownershipType ?? ("internal" as const),
        retired: false,
        revision: d.revision,
        episodeSlugs: slotsByShow.get(d.id)?.slugs ?? {},
        episodeDates: slotsByShow.get(d.id)?.dates ?? {},
      },
    }));
  const episodes = documents
    .filter((d) => d.kind === "episode")
    .map((d) => ({
      id: d.id,
      episode: {
        title: d.title,
        bodyHash: d.bodyHash,
        closerKind: d.closerKind,
        clipOnlyMode: d.clipOnlyMode,
        audioMasterId: d.audioMasterId,
        segmentIds: d.segmentIds,
        hostIds: d.hostIds,
        managedLinkIds: d.managedLinkIds,
        mediaAssetIds: d.mediaAssetIds,
        showIds: d.showIds,
        slug: d.slug,
        releaseDate: d.releaseDate,
        revision: d.revision,
        fieldRevisions: Object.fromEntries(EPISODE_FIELDS.map((f) => [f, d.revision])),
        publishedRevision: d.publishedRevision,
        published:
          d.publishedRevision === null
            ? null
            : {
                title: d.publishedTitle ?? d.title,
                bodyHash: d.publishedBodyHash ?? d.bodyHash,
                closerKind: d.closerKind,
                clipOnlyMode: d.clipOnlyMode,
                audioMasterId: d.audioMasterId,
                segmentIds: d.segmentIds,
                hostIds: d.hostIds,
                managedLinkIds: d.managedLinkIds,
                mediaAssetIds: d.mediaAssetIds,
              },
      },
    }));
  const masters = documents
    .filter((d) => d.kind === "audioMaster")
    .map((d) => ({
      id: d.id,
      master: {
        title: d.title,
        playableAudio: d.playableAudio,
        durationSeconds: d.durationSeconds,
        chapters: d.chapters,
        published: d.publishedRevision !== null,
        retired: false,
        revision: d.revision,
      },
    }));
  const items = documents
    .filter((d) => LIBRARY_KINDS.has(d.kind))
    .map((d) => ({
      id: d.id,
      item: {
        kind: d.kind as LibraryKind,
        title: d.title,
        retired: d.retiredAt !== null,
        revision: d.revision,
      },
    }));
  return { shows, episodes, masters, items };
};

/** Seed existing documents into the content model through `import`, once per instance. */
export const ContentSeeder = Effect.gen(function* () {
  const episodes = yield* Episode;
  const shows = yield* Show;
  const handles = yield* ShowHandle;
  const library = yield* LibraryItem;
  const masters = yield* AudioMaster;
  return (documents: ReadonlyArray<DocumentMeta>, options: { readonly concurrency: number }) =>
    Effect.gen(function* () {
      const plan = contentSeedOf(documents);
      const { concurrency } = options;
      const seed = { concurrency, discard: true } as const;
      yield* Effect.forEach(
        plan.shows,
        ({ id, show }) =>
          shows.import(id, [new ShowImported({ show })], { commandId: `seed:${id}` }),
        seed,
      );
      yield* Effect.forEach(
        plan.shows,
        ({ id, show }) =>
          handles.import(
            handleOf(show.ownershipType, show.slug),
            [new HandleTaken({ showId: id })],
            {
              commandId: `seed:${id}`,
            },
          ),
        seed,
      );
      yield* Effect.forEach(
        plan.episodes,
        ({ id, episode }) =>
          episodes.import(id, [new EpisodeImported({ episode })], { commandId: `seed:${id}` }),
        seed,
      );
      yield* Effect.forEach(
        plan.masters,
        ({ id, master }) =>
          masters.import(id, [new AudioMasterImported({ master })], { commandId: `seed:${id}` }),
        seed,
      );
      yield* Effect.forEach(
        plan.items,
        ({ id, item }) =>
          library.import(id, [new LibraryItemImported({ item })], { commandId: `seed:${id}` }),
        seed,
      );
      return {
        shows: plan.shows.length,
        episodes: plan.episodes.length,
        audioMasters: plan.masters.length,
        libraryItems: plan.items.length,
      };
    });
});
