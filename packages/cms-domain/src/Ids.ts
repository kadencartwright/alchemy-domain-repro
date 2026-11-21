import * as Schema from "effect/Schema";

export const WorkspaceId = Schema.String.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const DocumentId = Schema.String.pipe(Schema.brand("DocumentId"));
export type DocumentId = typeof DocumentId.Type;

export const SlotKey = Schema.String.pipe(Schema.brand("SlotKey"));
export type SlotKey = typeof SlotKey.Type;


export const Revision = Schema.Int;
export type Revision = typeof Revision.Type;

/**
 * 9 core document types modeling a ~25,000-document Podcast Network CMS
 * (shows, episodes, audio masters with timed chapters, reusable musical/topic
 * segments, hosts/guests, hierarchical taxonomy tags, managed CTA links,
 * media assets, and system-managed per-show welcome audio projections).
 */
export const PodcastDocKind = Schema.Literals([
  "show",
  "episode",
  "audioMaster",
  "segment",
  "host",
  "taxonomyTag",
  "managedLink",
  "mediaAsset",
  "channelWelcome",
]);
export type PodcastDocKind = typeof PodcastDocKind.Type;

export const OwnershipType = Schema.Literals(["internal", "partner"]);
export type OwnershipType = typeof OwnershipType.Type;

export const ShowCadence = Schema.Literals(["ongoing", "limited"]);
export type ShowCadence = typeof ShowCadence.Type;

export const EpisodeCloserKind = Schema.Literals(["none", "sharePrompt", "bonusClip", "outroVideo"]);
export type EpisodeCloserKind = typeof EpisodeCloserKind.Type;

export const AudioChapterSection = Schema.Struct({
  sectionType: Schema.Literals(["intro", "main", "highlight", "outro"]),
  startSec: Schema.Number,
  endSec: Schema.Number,
  lufs: Schema.Number,
});
export type AudioChapterSection = typeof AudioChapterSection.Type;

/**
 * Pure domain invariant for `clipOnlyMode`:
 * requires a positive audio duration and EXACTLY ONE `"highlight"` chapter
 * with at least 0.1 s length fitting inside `[0, durationSeconds]`.
 */
export const hasValidHighlightChapter = (
  durationSeconds: number | null,
  chapters: ReadonlyArray<AudioChapterSection>,
): boolean => {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return false;
  }
  const highlights = chapters.filter((c) => c.sectionType === "highlight");
  if (highlights.length !== 1) return false;
  const h = highlights[0]!;
  if (!Number.isFinite(h.startSec) || !Number.isFinite(h.endSec)) return false;
  if (h.startSec < 0 || h.endSec <= h.startSec) return false;
  if (h.endSec - h.startSec < 0.1) return false;
  if (h.startSec >= durationSeconds || h.endSec > durationSeconds) return false;
  return true;
};
