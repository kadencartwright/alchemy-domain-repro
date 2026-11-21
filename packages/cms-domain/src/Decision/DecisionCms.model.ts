import * as Domain from "@alchemy.run/domain";
import { CmsDocument, InboundRefs, UniqueClaim } from "./DecisionCms.aggregates.ts";
import { CmsDocumentDeletion, CmsDraftSaving, CmsPublication } from "./DecisionCms.decisions.ts";

/** Topology E: per-document aggregates, cross-document invariants held by `Domain.Decision`s. */
export class DecisionCms extends Domain.Model("DecisionCms", {
  aggregates: [CmsDocument, UniqueClaim, InboundRefs],
  decisions: [CmsDraftSaving, CmsDocumentDeletion, CmsPublication],
}) {}
