import * as Domain from "@alchemy.run/domain";
import { AudioMaster, Episode, LibraryItem, Show, ShowHandle } from "./Content.aggregates.ts";
import { EpisodePublication, Scheduling, ShowNaming } from "./Content.decisions.ts";
import { EpisodeHistory, EpisodeHistoryLive, EpisodeRevisions } from "./Content.history.ts";

/** Topology F: the content domain, with each rule owned by what it's about. */
export class ContentDomain extends Domain.Model("ContentDomain", {
  aggregates: [LibraryItem, AudioMaster, ShowHandle, Show, Episode],
  decisions: [ShowNaming, Scheduling, EpisodePublication],
  projections: [EpisodeHistory],
  streams: [EpisodeRevisions],
}) {}

/** The model's handlers: the projection that writes each episode's revision history. */
export const ContentDomainHandlers = EpisodeHistoryLive;
