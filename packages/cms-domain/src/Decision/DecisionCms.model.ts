import * as Domain from "@alchemy.run/domain";
import {
  CmsDocument,
  InboundRefs,
  SegmentEpisodes,
  UniqueClaim,
} from "./DecisionCms.aggregates.ts";
import {
  CmsDocumentDeletion,
  CmsDraftSaving,
  CmsPublication,
  CmsSegmentTagSync,
} from "./DecisionCms.decisions.ts";

/** Topology E: per-document aggregates, cross-document invariants held by `Domain.Decision`s. */
export class DecisionCms extends Domain.Model("DecisionCms", {
  aggregates: [CmsDocument, UniqueClaim, InboundRefs, SegmentEpisodes],
  decisions: [CmsDraftSaving, CmsDocumentDeletion, CmsPublication, CmsSegmentTagSync],
}) {}
