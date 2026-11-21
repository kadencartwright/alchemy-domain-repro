import * as Effect from "effect/Effect";
import type { DocumentId } from "../Ids.ts";
import type { DocumentMeta } from "../Workspace/WorkspaceState.ts";
import {
  AudioMaster,
  AudioMasterImported,
  EditEpisodeDraft,
  Episode,
  EpisodeImported,
  HandleTaken,
  handleOf,
  LibraryItem,
  LibraryItemImported,
  type LibraryKind,
  libraryRefsOf,
  Show,
  ShowHandle,
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

type Options = { readonly commandId?: string };
export type EpisodeEdit = Omit<ConstructorParameters<typeof EditEpisodeDraft>[0], "_tag">;

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

  return {
    episodes,
    shows,
    library,
    masters,
    edit: (e: EpisodeEdit, options?: Options) => episodes.send(new EditEpisodeDraft(e), options),
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
    publish: (episodeId: DocumentId, publishAudioMaster = false, options?: Options) =>
      Effect.flatMap(episodes.get(episodeId), (ep) =>
        publication.send(
          new PublishEpisode({
            episodeId,
            audioMasterId: ep?.audioMasterId ?? null,
            showIds: ep?.showIds ?? [],
            libraryIds: ep === null ? [] : libraryRefsOf(ep),
            publishAudioMaster,
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
        publishedRevision: d.publishedRevision,
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
