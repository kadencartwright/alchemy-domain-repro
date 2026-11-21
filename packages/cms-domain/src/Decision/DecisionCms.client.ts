import * as Effect from "effect/Effect";
import { type DocumentId } from "../Ids.ts";
import { allStrongRefsOf, type DocumentMeta } from "../Workspace/WorkspaceState.ts";
import {
  ClaimKey,
  ClaimTaken,
  claimKeysOf,
  CmsDocument,
  CmsDocumentImported,
  InboundRefs,
  InboundRefsImported,
  indexedSegmentOf,
  observedFor,
  referencesOf,
  SegmentEpisodes,
  SegmentEpisodesImported,
  UniqueClaim,
} from "./DecisionCms.aggregates.ts";
import {
  DeleteCmsDocument,
  PublishCmsDocuments,
  SaveCmsDraft,
  SyncCmsSegmentTags,
} from "./DecisionCms.commands.ts";
import {
  CmsDocumentDeletion,
  CmsDraftSaving,
  CmsPublication,
  CmsSegmentTagSync,
} from "./DecisionCms.decisions.ts";

export type Draft = Omit<ConstructorParameters<typeof SaveCmsDraft>[0], "observed" | "_tag">;

/**
 * A caller of the decisions. Each call first reads what it has to name in the
 * command (the instances that follow from current state), then sends it: what
 * an editor client would know from the document it has open.
 */
export const DecisionCmsClient = Effect.gen(function* () {
  const docs = yield* CmsDocument;
  const segIndex = yield* SegmentEpisodes;
  const saving = yield* CmsDraftSaving;
  const deletion = yield* CmsDocumentDeletion;
  const publication = yield* CmsPublication;
  const tagSync = yield* CmsSegmentTagSync;

  /** Save with what the caller already knows of the document (an autosave): no read first. */
  const saveKnown = (
    d: Draft,
    known: DocumentMeta | null,
    options?: { readonly commandId?: string },
  ) => saving.send(new SaveCmsDraft({ ...d, observed: observedFor([known]) }), options);

  return {
    saveKnown,
    save: (d: Draft, options?: { readonly commandId?: string }) =>
      Effect.flatMap(docs.get(d.documentId), (prev) => saveKnown(d, prev, options)),
    remove: (
      documentId: DocumentId,
      expectedRevision: number,
      options?: { readonly commandId?: string },
    ) =>
      Effect.flatMap(docs.get(documentId), (prev) =>
        deletion.send(
          new DeleteCmsDocument({ documentId, expectedRevision, observed: observedFor([prev]) }),
          options,
        ),
      ),
    publish: (documentIds: ReadonlyArray<DocumentId>, options?: { readonly commandId?: string }) =>
      Effect.gen(function* () {
        const states = yield* Effect.forEach(documentIds, (id) => docs.get(id), {
          concurrency: "unbounded",
        });
        const deps = [
          ...new Set(
            states.flatMap((s) =>
              s === null ? [] : [...allStrongRefsOf(s), ...s.strengthenOnPublish],
            ),
          ),
        ];
        const observed = observedFor(states);
        return yield* publication.send(
          new PublishCmsDocuments({
            documentIds,
            dependencyIds: deps,
            observed: {
              ...observed,
              references: [...new Set([...observed.references, ...deps])],
              indexedSegments: [
                ...new Set([
                  ...observed.indexedSegments,
                  ...states.flatMap((s) =>
                    s?.kind === "episode" && s.segmentIds[0] ? [s.segmentIds[0]] : [],
                  ),
                ]),
              ],
            },
          }),
          options,
        );
      }),
    syncTags: (
      segmentId: DocumentId,
      tagIds: ReadonlyArray<DocumentId>,
      options?: { readonly commandId?: string },
    ) =>
      Effect.gen(function* () {
        const index = yield* segIndex.get(segmentId);
        const episodeIds = Object.keys(index.episodes) as Array<DocumentId>;
        const states = yield* Effect.forEach([segmentId, ...episodeIds], (id) => docs.get(id), {
          concurrency: "unbounded",
        });
        return yield* tagSync.send(
          new SyncCmsSegmentTags({ segmentId, tagIds, episodeIds, observed: observedFor(states) }),
          options,
        );
      }),
    get: (documentId: DocumentId) => docs.get(documentId),
  };
});

/** Every instance a set of existing documents implies, for seeding through `import`. */
export const seedPlanOf = (documents: ReadonlyArray<DocumentMeta>) => {
  const claims = new Map<string, DocumentId>();
  const inbound = new Map<string, Array<DocumentId>>();
  const segments = new Map<string, Array<DocumentId>>();
  for (const doc of documents) {
    for (const key of claimKeysOf(doc)) claims.set(key, doc.id);
    for (const ref of referencesOf(doc)) inbound.set(ref, [...(inbound.get(ref) ?? []), doc.id]);
    const seg = indexedSegmentOf(doc);
    if (seg !== null) segments.set(seg, [...(segments.get(seg) ?? []), doc.id]);
  }
  return { documents, claims, inbound, segments };
};

/**
 * Seed existing documents: one `import` per instance they imply. Instances
 * already seeded (same `commandId`) are skipped by the platform.
 */
export const DecisionCmsSeeder = Effect.gen(function* () {
  const docs = yield* CmsDocument;
  const claimsClient = yield* UniqueClaim;
  const inboundClient = yield* InboundRefs;
  const segmentsClient = yield* SegmentEpisodes;
  return (documents: ReadonlyArray<DocumentMeta>, options: { readonly concurrency: number }) =>
    Effect.gen(function* () {
      const plan = seedPlanOf(documents);
      const { concurrency } = options;
      yield* Effect.forEach(
        plan.documents,
        (doc) =>
          docs.import(doc.id, [new CmsDocumentImported({ document: doc })], {
            commandId: `seed:${doc.id}`,
          }),
        { concurrency, discard: true },
      );
      yield* Effect.forEach(
        [...plan.claims],
        ([key, holder]) =>
          claimsClient.import(ClaimKey.make(key), [new ClaimTaken({ documentId: holder })], {
            commandId: `seed:${key}`,
          }),
        { concurrency, discard: true },
      );
      yield* Effect.forEach(
        [...plan.inbound],
        ([id, referrerIds]) =>
          inboundClient.import(id as DocumentId, [new InboundRefsImported({ referrerIds })], {
            commandId: `seed:${id}`,
          }),
        { concurrency, discard: true },
      );
      yield* Effect.forEach(
        [...plan.segments],
        ([id, episodeIds]) =>
          segmentsClient.import(id as DocumentId, [new SegmentEpisodesImported({ episodeIds })], {
            commandId: `seed:${id}`,
          }),
        { concurrency, discard: true },
      );
      return {
        documents: plan.documents.length,
        claims: plan.claims.size,
        inboundTargets: plan.inbound.size,
        segmentIndexes: plan.segments.size,
      };
    });
});
