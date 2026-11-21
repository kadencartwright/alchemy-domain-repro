import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import { type DocumentId, hasValidHighlightChapter } from "../Ids.ts";
import {
  ClipOnlyRuleViolation,
  DocumentNotFound,
  PublishReadinessViolation,
  RevisionConflict,
  ScheduleDateConflict,
  SlugConflict,
  StrongReferenceViolation,
} from "../Workspace/WorkspaceRule.rejection.ts";
import { allStrongRefsOf, type DocumentMeta } from "../Workspace/WorkspaceState.ts";
import {
  ClaimReleased,
  ClaimTaken,
  claimKeysOf,
  CmsDocument,
  CmsDocumentDeleted,
  CmsDocumentPublished,
  CmsDraftSaved,
  CmsTagsSynced,
  InboundRefAdded,
  InboundRefRemoved,
  InboundRefs,
  indexedSegmentOf,
  referencesOf,
  SegmentEpisodeLinked,
  SegmentEpisodes,
  SegmentEpisodeUnlinked,
  UniqueClaim,
} from "./DecisionCms.aggregates.ts";
import {
  DeleteCmsDocument,
  PublishCmsDocuments,
  SaveCmsDraft,
  StaleRead,
  SyncCmsSegmentTags,
} from "./DecisionCms.commands.ts";

type Read<A extends Domain.Aggregate.Any> = Domain.Decision.Read<A>;
type Recorded = Domain.Decision.Recorded<any>;

const uniq = <A extends string>(xs: ReadonlyArray<A>): Array<A> => [...new Set(xs)];
const byId = <R extends { readonly id: string }>(reads: ReadonlyArray<R>): Map<string, R> =>
  new Map(reads.map((r) => [r.id, r]));

/**
 * The writes a document's change implies on the claims, inbound-reference and
 * segment-index instances, or the `StaleRead` naming the first instance the
 * decision needed but wasn't given.
 */
const sideEffects = (
  documentId: DocumentId,
  before: DocumentMeta | null,
  after: DocumentMeta | null,
  reads: {
    readonly claims: Map<string, Read<typeof UniqueClaim>>;
    readonly inbound: Map<string, Read<typeof InboundRefs>>;
    readonly segments: Map<string, Read<typeof SegmentEpisodes>>;
  },
): Array<Recorded> | StaleRead => {
  const out: Array<Recorded> = [];

  const claimsBefore = new Set<string>(claimKeysOf(before));
  const claimsAfter = new Set<string>(claimKeysOf(after));
  for (const key of claimsBefore) {
    if (claimsAfter.has(key)) continue;
    const claim = reads.claims.get(key);
    if (!claim) return new StaleRead({ missing: "claim", id: key });
    if (claim.state.holder === documentId)
      out.push(claim.record(new ClaimReleased({ documentId })));
  }
  for (const key of claimsAfter) {
    if (claimsBefore.has(key)) continue;
    const claim = reads.claims.get(key);
    if (!claim) return new StaleRead({ missing: "claim", id: key });
    out.push(claim.record(new ClaimTaken({ documentId })));
  }

  const refsBefore = new Set<string>(referencesOf(before));
  const refsAfter = new Set<string>(referencesOf(after));
  for (const id of refsBefore) {
    if (refsAfter.has(id)) continue;
    const inbound = reads.inbound.get(id);
    if (!inbound) return new StaleRead({ missing: "inboundRefs", id });
    out.push(inbound.record(new InboundRefRemoved({ referrerId: documentId })));
  }
  for (const id of refsAfter) {
    if (refsBefore.has(id)) continue;
    const inbound = reads.inbound.get(id);
    if (!inbound) return new StaleRead({ missing: "inboundRefs", id });
    out.push(inbound.record(new InboundRefAdded({ referrerId: documentId })));
  }

  const segBefore = indexedSegmentOf(before);
  const segAfter = indexedSegmentOf(after);
  if (segBefore !== segAfter) {
    if (segBefore !== null) {
      const seg = reads.segments.get(segBefore);
      if (!seg) return new StaleRead({ missing: "segmentIndex", id: segBefore });
      out.push(seg.record(new SegmentEpisodeUnlinked({ episodeId: documentId })));
    }
    if (segAfter !== null) {
      const seg = reads.segments.get(segAfter);
      if (!seg) return new StaleRead({ missing: "segmentIndex", id: segAfter });
      out.push(seg.record(new SegmentEpisodeLinked({ episodeId: documentId })));
    }
  }
  return out;
};

const clipOnlyViolation = (
  documentId: DocumentId,
  doc: Pick<DocumentMeta, "clipOnlyMode" | "showIds" | "audioMasterId">,
  lookup: (id: DocumentId) => DocumentMeta | null,
): ClipOnlyRuleViolation | null => {
  if (!doc.clipOnlyMode) return null;
  const showId = doc.showIds[0];
  if (!showId || !doc.audioMasterId) {
    return new ClipOnlyRuleViolation({ documentId, reason: "missing_show_or_audio" });
  }
  const show = lookup(showId);
  if (!show || show.kind !== "show" || show.ownershipType !== "partner") {
    return new ClipOnlyRuleViolation({ documentId, reason: "requires_partner_show" });
  }
  const master = lookup(doc.audioMasterId);
  if (
    !master ||
    master.kind !== "audioMaster" ||
    !hasValidHighlightChapter(master.durationSeconds, master.chapters)
  ) {
    return new ClipOnlyRuleViolation({ documentId, reason: "requires_valid_highlight_chapter" });
  }
  return null;
};

const nextOf = (
  prev: DocumentMeta | null,
  cmd: SaveCmsDraft,
  revision: number,
  at: number,
): DocumentMeta => ({
  id: cmd.documentId,
  title: cmd.title,
  kind: cmd.kind,
  slug: cmd.slug,
  ownershipType: cmd.ownershipType,
  showIds: cmd.showIds,
  releaseDate: cmd.releaseDate,
  audioMasterId: cmd.audioMasterId,
  clipOnlyMode: cmd.clipOnlyMode,
  closerKind: cmd.closerKind,
  playableAudio: cmd.playableAudio,
  durationSeconds: cmd.durationSeconds,
  chapters: cmd.chapters,
  segmentIds: cmd.segmentIds,
  hostIds: cmd.hostIds,
  tagIds: cmd.tagIds,
  managedLinkIds: cmd.managedLinkIds,
  mediaAssetIds: cmd.mediaAssetIds,
  bodyHash: cmd.bodyHash,
  strongRefs: cmd.strongRefs,
  strengthenOnPublish: cmd.strengthenOnPublish,
  retiredAt: cmd.retiredAt,
  revision,
  publishedRevision: prev?.publishedRevision ?? null,
  publishedTitle: prev?.publishedTitle ?? null,
  publishedReleaseDate: prev?.publishedReleaseDate ?? null,
  publishedBodyHash: prev?.publishedBodyHash ?? null,
  publishedStrongRefs: prev?.publishedStrongRefs ?? [],
  updatedAt: at,
});

/**
 * Save one document's draft: invariants 1–4 and 7, in one atomic step across
 * the document, every document it references, its unique-value claims, the
 * inbound-reference sets it joins or leaves, and its segment index.
 */
export class CmsDraftSaving extends Domain.Decision(SaveCmsDraft, {
  reads: {
    doc: CmsDocument,
    targets: CmsDocument,
    claims: UniqueClaim,
    inbound: InboundRefs,
    segments: SegmentEpisodes,
  },
  // Read only what the save changes, relative to what the caller last saw. A
  // reference the document already held can't have been deleted since
  // (`InboundRefs` blocks that), and a claim it already held is still its own.
  // `clipOnlyMode` re-reads its show and audio master, whose state it depends on.
  keyOf: (cmd) => {
    const next = allStrongRefsOf(cmd).filter((id) => id !== cmd.documentId);
    const seenRefs = new Set<string>(cmd.observed.references);
    const nextClaims = claimKeysOf(cmd);
    const seenClaims = new Set<string>(cmd.observed.claimKeys);
    const prevSegment = cmd.observed.indexedSegments[0] ?? null;
    const nextSegment =
      prevSegment !== null && cmd.kind === "episode" ? (cmd.segmentIds[0] ?? null) : null;
    const clipDeps =
      cmd.kind === "episode" && cmd.clipOnlyMode
        ? [
            ...(cmd.showIds[0] ? [cmd.showIds[0]] : []),
            ...(cmd.audioMasterId ? [cmd.audioMasterId] : []),
          ]
        : [];
    const nextSet = new Set<string>(next);
    return {
      doc: cmd.documentId,
      targets: uniq([...next.filter((id) => !seenRefs.has(id)), ...clipDeps]),
      claims: uniq([
        ...nextClaims.filter((k) => !seenClaims.has(k)),
        ...cmd.observed.claimKeys.filter((k) => !nextClaims.includes(k)),
      ]),
      inbound: uniq([
        ...next.filter((id) => !seenRefs.has(id)),
        ...cmd.observed.references.filter((id) => !nextSet.has(id)),
      ]),
      // A published episode moves between segment indexes only if its primary segment changes.
      segments:
        prevSegment === nextSegment
          ? []
          : uniq([prevSegment, nextSegment].filter((id) => id !== null)),
    };
  },
  decide: ({ doc, targets, claims, inbound, segments }, cmd, ctx) => {
    const prev = doc.state;
    const actual = prev?.revision ?? null;
    if (actual !== cmd.expectedRevision) {
      return new RevisionConflict({
        documentId: cmd.documentId,
        expected: cmd.expectedRevision,
        actual,
      });
    }
    // Invariant 4: every reference the save adds resolves. (One it already held
    // can't have been deleted: `InboundRefs` refuses that delete.)
    const targetDocs = new Map<string, DocumentMeta | null>(targets.map((t) => [t.id, t.state]));
    const held = new Set<string>(referencesOf(prev));
    for (const ref of allStrongRefsOf(cmd)) {
      if (ref === cmd.documentId || held.has(ref)) continue;
      if (!targetDocs.has(ref)) return new StaleRead({ missing: "document", id: ref });
      if (targetDocs.get(ref) === null) {
        return new StrongReferenceViolation({
          targetId: ref,
          referencedBy: [cmd.documentId],
          reason: "target_missing",
        });
      }
    }
    // Invariants 2–3: each unique value it newly takes is free.
    const claimReads = byId(claims);
    const heldClaims = new Set<string>(claimKeysOf(prev));
    for (const key of claimKeysOf(cmd)) {
      if (heldClaims.has(key)) continue;
      const claim = claimReads.get(key);
      if (!claim) return new StaleRead({ missing: "claim", id: key });
      const holder = claim.state.holder;
      if (holder === null || holder === cmd.documentId) continue;
      const [kind, scope, value] = key.split(":") as [string, string, string];
      if (kind === "episode-date") {
        return new ScheduleDateConflict({
          showId: scope as DocumentId,
          releaseDate: value,
          conflictingDocumentId: holder,
        });
      }
      return new SlugConflict({
        scope: kind === "show-slug" ? `show:${scope}` : `episode:${scope}`,
        slug: value,
        conflictingDocumentId: holder,
      });
    }
    // Invariant 7: clipOnlyMode needs a partner show and a valid highlight chapter.
    if (cmd.kind === "episode") {
      const clip = clipOnlyViolation(cmd.documentId, cmd, (id) => targetDocs.get(id) ?? null);
      if (clip !== null) return clip;
    }

    const at = DateTime.toEpochMillis(ctx.now);
    const revision = (actual ?? 0) + 1;
    const next = nextOf(prev, cmd, revision, at);
    const writes = sideEffects(cmd.documentId, prev, next, {
      claims: claimReads,
      inbound: byId(inbound),
      segments: byId(segments),
    });
    if (!Array.isArray(writes)) return writes;
    const { _tag: _, documentId: _id, expectedRevision: _exp, observed: _obs, ...fields } = cmd;
    return [doc.record(new CmsDraftSaved({ ...fields, revision, savedAt: at })), ...writes];
  },
  reply: ({ doc }) => ({ revision: doc?.revision ?? 0 }),
}) {}

/** Delete one document: invariant 5 (nothing references it), releasing what it held. */
export class CmsDocumentDeletion extends Domain.Decision(DeleteCmsDocument, {
  reads: {
    doc: CmsDocument,
    own: InboundRefs,
    claims: UniqueClaim,
    inbound: InboundRefs,
    segments: SegmentEpisodes,
  },
  keyOf: (cmd) => ({
    doc: cmd.documentId,
    own: cmd.documentId,
    claims: uniq(cmd.observed.claimKeys),
    inbound: uniq(cmd.observed.references.filter((id) => id !== cmd.documentId)),
    segments: uniq(cmd.observed.indexedSegments),
  }),
  decide: ({ doc, own, claims, inbound, segments }, cmd, ctx) => {
    const prev = doc.state;
    if (prev === null) return new DocumentNotFound({ documentId: cmd.documentId });
    if (prev.revision !== cmd.expectedRevision) {
      return new RevisionConflict({
        documentId: cmd.documentId,
        expected: cmd.expectedRevision,
        actual: prev.revision,
      });
    }
    const referrers = Object.keys(own.state.referrers) as Array<DocumentId>;
    if (referrers.length > 0) {
      return new StrongReferenceViolation({
        targetId: cmd.documentId,
        referencedBy: referrers,
        reason: "target_in_use",
      });
    }
    const writes = sideEffects(cmd.documentId, prev, null, {
      claims: byId(claims),
      inbound: byId(inbound),
      segments: byId(segments),
    });
    if (!Array.isArray(writes)) return writes;
    return [
      doc.record(new CmsDocumentDeleted({ deletedAt: DateTime.toEpochMillis(ctx.now) })),
      ...writes,
    ];
  },
}) {}

/** Publish several documents at once: invariants 4, 6 and 7 at publish, and 8a (atomic batch). */
export class CmsPublication extends Domain.Decision(PublishCmsDocuments, {
  reads: {
    docs: CmsDocument,
    deps: CmsDocument,
    inbound: InboundRefs,
    segments: SegmentEpisodes,
  },
  keyOf: (cmd) => ({
    docs: uniq(cmd.documentIds),
    deps: uniq(cmd.dependencyIds.filter((id) => !cmd.documentIds.includes(id))),
    inbound: uniq(cmd.observed.references),
    segments: uniq(cmd.observed.indexedSegments),
  }),
  decide: ({ docs, deps, inbound, segments }, cmd, ctx) => {
    const all = new Map<string, DocumentMeta | null>([
      ...deps.map((d) => [d.id, d.state] as const),
      ...docs.map((d) => [d.id, d.state] as const),
    ]);
    const publishing = new Set<string>(cmd.documentIds);
    const lookup = (id: DocumentId) => all.get(id) ?? null;
    for (const d of docs) {
      const doc = d.state;
      if (doc === null) return new DocumentNotFound({ documentId: d.id });
      for (const ref of [...allStrongRefsOf(doc), ...doc.strengthenOnPublish]) {
        if (!all.has(ref)) return new StaleRead({ missing: "document", id: ref });
        if (all.get(ref) === null) {
          return new StrongReferenceViolation({
            targetId: ref,
            referencedBy: [d.id],
            reason: "target_missing",
          });
        }
      }
      // Invariant 6: an episode publishes only with a published, playable audio master.
      if (doc.kind === "episode" && doc.audioMasterId !== null) {
        const master = lookup(doc.audioMasterId);
        if (master === null || master.kind !== "audioMaster") {
          return new StrongReferenceViolation({
            targetId: doc.audioMasterId,
            referencedBy: [d.id],
            reason: "target_missing",
          });
        }
        if (master.publishedRevision === null && !publishing.has(doc.audioMasterId)) {
          return new PublishReadinessViolation({
            documentId: d.id,
            targetId: doc.audioMasterId,
            reason: "audio_master_unpublished",
          });
        }
        if (!master.playableAudio) {
          return new PublishReadinessViolation({
            documentId: d.id,
            targetId: doc.audioMasterId,
            reason: "audio_master_not_playable",
          });
        }
        const clip = clipOnlyViolation(d.id, doc, lookup);
        if (clip !== null) return clip;
      }
    }

    const at = DateTime.toEpochMillis(ctx.now);
    const reads = { claims: new Map(), inbound: byId(inbound), segments: byId(segments) };
    const out: Array<Recorded> = [];
    for (const d of docs) {
      const prev = d.state!;
      const strongRefs = [...new Set([...prev.strongRefs, ...prev.strengthenOnPublish])];
      const next: DocumentMeta = {
        ...prev,
        strongRefs,
        strengthenOnPublish: [],
        publishedRevision: prev.revision,
        publishedStrongRefs: allStrongRefsOf({ ...prev, strongRefs }),
      };
      const writes = sideEffects(d.id, prev, next, reads);
      if (!Array.isArray(writes)) return writes;
      out.push(d.record(new CmsDocumentPublished({ publishedAt: at })), ...writes);
    }
    return out;
  },
}) {}

/**
 * Invariant 8b: a segment's tags cascade to every published episode whose
 * primary segment it is, atomically. The caller names those episodes from the
 * segment's index; the decision checks the index still says exactly that.
 */
export class CmsSegmentTagSync extends Domain.Decision(SyncCmsSegmentTags, {
  reads: {
    segment: CmsDocument,
    episodes: CmsDocument,
    tags: CmsDocument,
    index: SegmentEpisodes,
    inbound: InboundRefs,
  },
  keyOf: (cmd) => ({
    segment: cmd.segmentId,
    episodes: uniq(cmd.episodeIds),
    tags: uniq(cmd.tagIds),
    index: cmd.segmentId,
    inbound: uniq([...cmd.tagIds, ...cmd.observed.references]),
  }),
  decide: ({ segment, episodes, tags, index, inbound }, cmd, ctx) => {
    if (segment.state === null || segment.state.kind !== "segment") {
      return new DocumentNotFound({ documentId: cmd.segmentId });
    }
    for (const t of tags) {
      if (t.state === null) {
        return new StrongReferenceViolation({
          targetId: t.id,
          referencedBy: [cmd.segmentId],
          reason: "target_missing",
        });
      }
    }
    const indexed = new Set(Object.keys(index.state.episodes));
    const named = new Set<string>(cmd.episodeIds);
    if (indexed.size !== named.size || [...indexed].some((id) => !named.has(id))) {
      const id =
        [...indexed].find((x) => !named.has(x)) ?? [...named].find((x) => !indexed.has(x)) ?? "";
      return new StaleRead({ missing: "episodeSet", id });
    }

    const at = DateTime.toEpochMillis(ctx.now);
    const reads = { claims: new Map(), inbound: byId(inbound), segments: new Map() };
    const out: Array<Recorded> = [];
    for (const d of [segment, ...episodes]) {
      const prev = d.state;
      if (prev === null) continue;
      const writes = sideEffects(d.id, prev, { ...prev, tagIds: cmd.tagIds }, reads);
      if (!Array.isArray(writes)) return writes;
      out.push(d.record(new CmsTagsSynced({ tagIds: cmd.tagIds, syncedAt: at })), ...writes);
    }
    return out;
  },
  reply: ({ episodes }) => ({
    updatedEpisodeIds: episodes.flatMap((e) => (e === null ? [] : [e.id])),
  }),
}) {}
