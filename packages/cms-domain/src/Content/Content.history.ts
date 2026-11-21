import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Revision } from "../Ids.ts";
import {
  contentOf,
  Episode,
  EpisodeField,
  EpisodeFieldsSaved,
  EpisodeImported,
  EpisodePatch,
} from "./Content.aggregates.ts";

/**
 * One revision of an episode's draft: who saved it, the fields it changed, and
 * the fields it skipped because a co-editor had changed them first.
 */
export class EpisodeRevisionRecorded extends Domain.Event("EpisodeRevisionRecorded", {
  revision: Revision,
  editor: Schema.String,
  changes: EpisodePatch,
  skipped: Schema.Array(EpisodeField),
  savedAt: Schema.Number,
}) {}

/**
 * Every revision of an episode's draft, oldest first: requirement 9 (full
 * revision history). One entry per autosave, holding only what it changed;
 * the content at a revision is the changes up to it, folded.
 */
export class EpisodeRevisions extends Domain.Stream("EpisodeRevisions", {
  key: Episode,
  entries: [EpisodeRevisionRecorded],
}) {}

/**
 * Appends a revision for every autosave. Aggregate clients can only `get` an
 * aggregate's state, not read its events, so the history is a second copy of
 * them, written here.
 */
export class EpisodeHistory extends Domain.Projection("EpisodeHistory", {
  from: [Episode],
  key: Episode,
  on: [EpisodeFieldsSaved, EpisodeImported],
  writes: [EpisodeRevisions],
}) {}

export const EpisodeHistoryLive = EpisodeHistory.toLayer(
  Effect.gen(function* () {
    const revisions = yield* EpisodeRevisions;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const e = input.event;
        if (e._tag === "EpisodeFieldsSaved") {
          yield* revisions.append(
            input,
            new EpisodeRevisionRecorded({
              revision: e.revision,
              editor: e.editor,
              changes: e.changes,
              skipped: e.skipped,
              savedAt: e.savedAt,
            }),
          );
        } else if (e._tag === "EpisodeImported") {
          yield* revisions.append(
            input,
            new EpisodeRevisionRecorded({
              revision: e.episode.revision,
              editor: "import",
              changes: contentOf(e.episode),
              skipped: [],
              savedAt: DateTime.toEpochMillis(input.envelope.at),
            }),
          );
        }
      }
    });
  }),
);
