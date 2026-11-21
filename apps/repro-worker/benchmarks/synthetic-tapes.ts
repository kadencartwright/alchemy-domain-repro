import type {
  AudioChapterSection,
  EpisodeCloserKind,
  OwnershipType,
  PodcastDocKind,
} from "@repro/cms-domain/Ids";

/**
 * Deterministic seeded synthetic data tapes and falsifiable acceptance gates
 * for both benchmarks:
 *   1. Dynamic Ad Network (185 opps/s open-loop burst, exhaustion, skew, storage)
 *   2. Podcast Network CMS (25,000-document multi-type corpus, 8 invariants, 2 MiB DO cap)
 */

export const DEFAULT_SEED = 20261120;

/** Mulberry32 deterministic PRNG so every benchmark run is 100% reproducible. */
export const createRng = (seed: number = DEFAULT_SEED): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// 1. Dynamic Ad Network — Synthetic Tapes & Falsifiable Acceptance Gates
// ---------------------------------------------------------------------------

export interface SyntheticCampaignSpec {
  readonly campaignId: string;
  readonly name: string;
  readonly weight: number;
  readonly audience: "free" | "paid" | "all";
  readonly bundlePriceCents: number;
  readonly requireCompanion: boolean;
  readonly targets: { readonly primary: number; readonly companion: number; readonly secondary: number };
}

export interface SyntheticOpportunity {
  readonly index: number;
  readonly opportunityId: string;
  readonly audience: "free" | "paid";
  readonly primaryQualifies: boolean;
  readonly companionQualifies: boolean;
  readonly duplicatePrimaryRetry: boolean;
  readonly latePrimaryReport: boolean;
  /** Regional shard skew bucket (50% land on cells 0–1, 50% on cells 2–7). */
  readonly skewedCellIndex: number;
}

export interface QuotaBurstTape {
  readonly name: string;
  readonly ratePerSec: number;
  readonly seconds: number;
  readonly campaigns: ReadonlyArray<SyntheticCampaignSpec>;
  readonly opportunities: ReadonlyArray<SyntheticOpportunity>;
}

export interface QuotaExhaustionTape {
  readonly name: string;
  readonly sponsorA: SyntheticCampaignSpec;
  readonly sponsorB: SyntheticCampaignSpec;
  readonly opportunities: ReadonlyArray<SyntheticOpportunity>;
}

export interface QuotaSkewedTape {
  readonly name: string;
  readonly cellCount: number;
  readonly campaign: SyntheticCampaignSpec;
  readonly opportunities: ReadonlyArray<SyntheticOpportunity>;
}

export const QUOTA_GATES = {
  /** Open-loop burst (185 opps/s × 3s): p95 must stay under 100 ms. */
  burstP95MaxMs: 100,
  /** Open-loop burst wall time for 3s schedule must not pile up past 4.5s. */
  burstMaxWallMs: 4_500,
  /** Minimum fill rate when total budget >= total opportunities. */
  minFillRate: 0.98,
  /** Maximum excess ratio allowed on Sponsor A under exhaustion + late reports. */
  maxExcessRatio: 0.25,
  /** Maximum retained DO storage bytes per opportunity (implies >160 days at 3.5M/mo). */
  maxStoredBytesPerOpp: 600,
  /** Maximum DO storage put keys per opportunity. */
  maxPutKeysPerOpp: 4.0,
} as const;

export const generateQuotaBurstTape = (
  ratePerSec = 185,
  seconds = 3,
  seed = DEFAULT_SEED,
): QuotaBurstTape => {
  const rng = createRng(seed);
  const total = Math.floor(ratePerSec * seconds);
  const campaigns: ReadonlyArray<SyntheticCampaignSpec> = [
    {
      campaignId: "camp-alpha",
      name: "Synthetic Sponsor Alpha",
      weight: 50,
      audience: "all",
      bundlePriceCents: 120_000,
      requireCompanion: true,
      targets: { primary: 100_000, companion: 100_000, secondary: 0 },
    },
    {
      campaignId: "camp-beta",
      name: "Synthetic Sponsor Beta",
      weight: 30,
      audience: "free",
      bundlePriceCents: 80_000,
      requireCompanion: true,
      targets: { primary: 100_000, companion: 100_000, secondary: 0 },
    },
    {
      campaignId: "camp-gamma",
      name: "Synthetic Sponsor Gamma",
      weight: 20,
      audience: "paid",
      bundlePriceCents: 95_000,
      requireCompanion: true,
      targets: { primary: 100_000, companion: 100_000, secondary: 0 },
    },
  ];

  const opportunities: Array<SyntheticOpportunity> = [];
  for (let i = 0; i < total; i++) {
    const audience: "free" | "paid" = rng() < 0.75 ? "free" : "paid";
    const primaryQualifies = rng() < 0.65;
    const companionQualifies = rng() < 0.89;
    const duplicatePrimaryRetry = primaryQualifies && rng() < 0.05;
    const skewedCellIndex = i % 2 === 0 ? Math.floor(i / 2) % 2 : 2 + (i % 6);
    opportunities.push({
      index: i,
      opportunityId: `burst-opp-${String(i).padStart(4, "0")}`,
      audience,
      primaryQualifies,
      companionQualifies,
      duplicatePrimaryRetry,
      latePrimaryReport: false,
      skewedCellIndex,
    });
  }

  return { name: `burst-${ratePerSec}rps-${seconds}s`, ratePerSec, seconds, campaigns, opportunities };
};

export const generateQuotaExhaustionTape = (seed = DEFAULT_SEED + 1): QuotaExhaustionTape => {
  const rng = createRng(seed);
  const sponsorA: SyntheticCampaignSpec = {
    campaignId: "sponsor-a-fixed",
    name: "Exhausting Fixed-Price Sponsor A",
    weight: 85,
    audience: "all",
    bundlePriceCents: 50_000,
    requireCompanion: true,
    targets: { primary: 40, companion: 40, secondary: 0 },
  };
  const sponsorB: SyntheticCampaignSpec = {
    campaignId: "sponsor-b-replacement",
    name: "Funded Replacement Sponsor B",
    weight: 15,
    audience: "all",
    bundlePriceCents: 75_000,
    requireCompanion: true,
    targets: { primary: 500, companion: 500, secondary: 0 },
  };

  const opportunities: Array<SyntheticOpportunity> = [];
  for (let i = 0; i < 120; i++) {
    const latePrimaryReport = i === 4 || i === 12 || i === 22 || i === 30;
    const primaryQualifies = !latePrimaryReport;
    const companionQualifies = true;
    const duplicatePrimaryRetry = rng() < 0.1;
    opportunities.push({
      index: i,
      opportunityId: `exhaust-opp-${String(i).padStart(4, "0")}`,
      audience: rng() < 0.75 ? "free" : "paid",
      primaryQualifies,
      companionQualifies,
      duplicatePrimaryRetry,
      latePrimaryReport,
      skewedCellIndex: i % 8,
    });
  }

  return { name: "exhaustion-handoff-120", sponsorA, sponsorB, opportunities };
};

export const generateQuotaSkewedTape = (
  totalOpps = 240,
  cellCount = 8,
  seed = DEFAULT_SEED + 2,
): QuotaSkewedTape => {
  const rng = createRng(seed);
  const campaign: SyntheticCampaignSpec = {
    campaignId: "camp-tight-skew",
    name: "Tight-Budget Regional Campaign",
    weight: 10,
    audience: "all",
    bundlePriceCents: 40_000,
    requireCompanion: true,
    targets: { primary: totalOpps, companion: totalOpps, secondary: 0 },
  };
  const opportunities: Array<SyntheticOpportunity> = [];
  for (let i = 0; i < totalOpps; i++) {
    const skewedCellIndex = i % 2 === 0 ? Math.floor(i / 2) % 2 : 2 + (i % (cellCount - 2));
    opportunities.push({
      index: i,
      opportunityId: `skew-opp-${String(i).padStart(4, "0")}`,
      audience: rng() < 0.75 ? "free" : "paid",
      primaryQualifies: true,
      companionQualifies: true,
      duplicatePrimaryRetry: false,
      latePrimaryReport: false,
      skewedCellIndex,
    });
  }
  return { name: `skewed-tight-${totalOpps}`, cellCount, campaign, opportunities };
};

// ---------------------------------------------------------------------------
// 2. Podcast Network CMS — 25,000-Document Corpus & 8 Falsifiable Gates
// ---------------------------------------------------------------------------

export interface SyntheticPodcastDoc {
  readonly documentId: string;
  readonly kind: PodcastDocKind;
  readonly title: string;
  readonly slug: string | null;
  readonly ownershipType: OwnershipType | null;
  readonly showIds: ReadonlyArray<string>;
  readonly releaseDate: string | null;
  readonly audioMasterId: string | null;
  readonly clipOnlyMode: boolean;
  readonly closerKind: EpisodeCloserKind;
  readonly playableAudio: boolean;
  readonly durationSeconds: number | null;
  readonly chapters: ReadonlyArray<AudioChapterSection>;
  readonly segmentIds: ReadonlyArray<string>;
  readonly hostIds: ReadonlyArray<string>;
  readonly managedLinkIds: ReadonlyArray<string>;
  readonly mediaAssetIds: ReadonlyArray<string>;
  readonly bodyHash: string;
  readonly strongRefs: ReadonlyArray<string>;
  readonly published: boolean;
}

export interface PodcastCmsCorpusCounts {
  readonly shows: number;
  readonly channelWelcomes: number;
  readonly hosts: number;
  readonly managedLinks: number;
  readonly mediaAssets: number;
  readonly segments: number;
  readonly audioMasters: number;
  readonly episodes: number;
  readonly totalDocs: number;
  readonly totalRefEdges: number;
}

export interface CmsTape {
  readonly name: string;
  readonly workspaceId: string;
  readonly seedDocs: ReadonlyArray<SyntheticPodcastDoc>;
  readonly counts: PodcastCmsCorpusCounts;
  /** Well-known fixture IDs guaranteed to exist in the corpus for the 8 invariant checks. */
  readonly fixtures: {
    readonly editEpisodeId: string;
    readonly editEpisodeSlug: string;
    readonly editEpisodeReleaseDate: string;
    readonly internalShowId: string;
    readonly internalShowSlug: string;
    readonly partnerShowId: string;
    readonly partnerShowSlug: string;
    readonly publishedValidMasterId: string;
    readonly draftOnlyMasterId: string;
    readonly noHighlightMasterId: string;
    readonly referencedAssetId: string;
    readonly missingRefId: string;
  };
  readonly editCount: number;
}

export const SQLITE_DO_SINGLE_VALUE_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MiB Cloudflare SQLite DO cap

export const CMS_GATES = {
  /** All 8 cross-document, publish-readiness, multi-hop and atomic-publish invariants must pass. */
  requiredInvariantsPassed: 8,
  /** Single-field editorial autosave p95 on real local workerd DOs. */
  editP95MaxMs: 30,
  /** Meta state bytes rewritten per single-field autosave (O(1)). */
  maxEditMetaBytes: 4_096,
  /**
   * Max single-DO `"meta"` size across the FULL 25,000-document corpus.
   * Must stay strictly below Cloudflare SQLite DO's 2 MiB (2,048 KiB) single-value limit
   * with a 25% headroom buffer (1,536 KiB).
   */
  maxSingleDoMetaAt25kBytes: 1_536 * 1024,
} as const;

/**
 * Generates a realistic, deterministic Podcast Network CMS corpus of `totalDocs`
 * documents across all 8 document types (default: 25,000 documents with ~67,000
 * directed reference edges, matching a production media CMS).
 *
 * Proportions (exact at 25,000 docs):
 * - shows: 350 (1.4%)            - channelWelcomes: 350 (1.4%)
 * - hosts: 1,200 (4.8%)          - managedLinks: 1,800 (7.2%)
 * - mediaAssets: 3,500 (14.0%)   - segments: 4,500 (18.0%)
 * - audioMasters: 5,000 (20.0%)  - episodes: 8,300 (33.2%)
 */
export const generateCmsTape = (
  totalDocs = 25_000,
  editCount = 20,
  seed = DEFAULT_SEED + 3,
): CmsTape => {
  const rng = createRng(seed);
  const scale = totalDocs / 25_000;
  const shows = Math.max(4, Math.round(350 * scale));
  const channelWelcomes = shows;
  const hosts = Math.max(6, Math.round(1_200 * scale));
  const managedLinks = Math.max(6, Math.round(1_800 * scale));
  const mediaAssets = Math.max(10, Math.round(3_500 * scale));
  const segments = Math.max(10, Math.round(4_500 * scale));
  const audioMasters = Math.max(12, Math.round(5_000 * scale));
  const episodes = Math.max(
    10,
    totalDocs -
      (shows +
        channelWelcomes +
        hosts +
        managedLinks +
        mediaAssets +
        segments +
        audioMasters),
  );

  const seedDocs: Array<SyntheticPodcastDoc> = [];
  let totalRefEdges = 0;

  const pad = (n: number) => String(n).padStart(5, "0");

  // 1. Hosts / guests / producers
  for (let i = 0; i < hosts; i++) {
    seedDocs.push({
      documentId: `host-${pad(i)}`,
      kind: "host",
      title: `Podcast Host & Contributor #${i}`,
      slug: null,
      ownershipType: null,
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: false,
      durationSeconds: null,
      chapters: [],
      segmentIds: [],
      hostIds: [],
      managedLinkIds: [],
      mediaAssetIds: [],
      bodyHash: `sha256:host${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  // 2. Managed external CTA / resource links
  for (let i = 0; i < managedLinks; i++) {
    seedDocs.push({
      documentId: `link-${pad(i)}`,
      kind: "managedLink",
      title: `Managed Show Resource Link #${i}`,
      slug: null,
      ownershipType: null,
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: false,
      durationSeconds: null,
      chapters: [],
      segmentIds: [],
      hostIds: [],
      managedLinkIds: [],
      mediaAssetIds: [],
      bodyHash: `sha256:link${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  // 3. Media assets (cover art, ambient beds, intro/outro bumpers, show-note PDFs)
  for (let i = 0; i < mediaAssets; i++) {
    seedDocs.push({
      documentId: `asset-${pad(i)}`,
      kind: "mediaAsset",
      title: `Media Asset #${i} — Cover Art / Audio Bed`,
      slug: null,
      ownershipType: null,
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: false,
      durationSeconds: null,
      chapters: [],
      segmentIds: [],
      hostIds: [],
      managedLinkIds: [],
      mediaAssetIds: [],
      bodyHash: `sha256:asset${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  // 4. Reusable musical/editorial segments
  for (let i = 0; i < segments; i++) {
    seedDocs.push({
      documentId: `seg-${pad(i)}`,
      kind: "segment",
      title: `Reusable Segment #${i} — Theme / Topic Block`,
      slug: null,
      ownershipType: null,
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: false,
      durationSeconds: null,
      chapters: [],
      segmentIds: [],
      hostIds: [],
      managedLinkIds: [],
      mediaAssetIds: [],
      bodyHash: `sha256:seg${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  // 5. Shows (~63% internal, ~37% partner; show-00000 is internal, show-00001 is partner)
  for (let i = 0; i < shows; i++) {
    const ownershipType: OwnershipType = i === 0 ? "internal" : i === 1 ? "partner" : i % 3 === 0 ? "partner" : "internal";
    const hostId = `host-${pad(i % hosts)}`;
    const assetId = `asset-${pad(i % mediaAssets)}`;
    const linkId = `link-${pad(i % managedLinks)}`;
    totalRefEdges += 3;
    seedDocs.push({
      documentId: `show-${pad(i)}`,
      kind: "show",
      title: `Podcast Show #${i} (${ownershipType})`,
      slug: `show-${pad(i)}`,
      ownershipType,
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: false,
      durationSeconds: null,
      chapters: [],
      segmentIds: [],
      hostIds: [hostId],
      managedLinkIds: [linkId],
      mediaAssetIds: [assetId],
      bodyHash: `sha256:show${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  // 6. System-managed Channel Welcome docs (1 per show)
  for (let i = 0; i < channelWelcomes; i++) {
    const showId = `show-${pad(i)}`;
    const bedAsset = `asset-${pad((i + 1) % mediaAssets)}`;
    totalRefEdges += 2;
    seedDocs.push({
      documentId: `welcome-${pad(i)}`,
      kind: "channelWelcome",
      title: `Channel Welcome — Show #${i}`,
      slug: null,
      ownershipType: null,
      showIds: [showId],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: true,
      durationSeconds: 45,
      chapters: [],
      segmentIds: [],
      hostIds: [],
      managedLinkIds: [],
      mediaAssetIds: [bedAsset],
      bodyHash: `sha256:welcome${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  // 7. Audio Masters (with timed chapters + loudness LUFS)
  // Guaranteed fixtures:
  // - master-00000: published + playable + 1 valid highlight chapter
  // - master-00001: DRAFT ONLY (unpublished) + playable + 1 valid highlight chapter
  // - master-00002: published + playable + NO highlight chapter
  for (let i = 0; i < audioMasters; i++) {
    const isDraftOnly = i === 1;
    const hasHighlight = i === 0 || i === 1 ? true : i === 2 ? false : i % 3 === 0;
    const durationSeconds = 1200 + (i % 1800);
    const chapters: Array<AudioChapterSection> = hasHighlight
      ? [
          { sectionType: "intro", startSec: 0, endSec: 45, lufs: -16 },
          { sectionType: "highlight", startSec: 45, endSec: 360, lufs: -15 },
          { sectionType: "main", startSec: 360, endSec: durationSeconds - 30, lufs: -16 },
          { sectionType: "outro", startSec: durationSeconds - 30, endSec: durationSeconds, lufs: -16 },
        ]
      : [
          { sectionType: "intro", startSec: 0, endSec: 45, lufs: -16 },
          { sectionType: "main", startSec: 45, endSec: durationSeconds, lufs: -16 },
        ];
    const hostId = `host-${pad(i % hosts)}`;
    const segId = `seg-${pad(i % segments)}`;
    totalRefEdges += 2;
    seedDocs.push({
      documentId: `master-${pad(i)}`,
      kind: "audioMaster",
      title: `Audio Master #${i}`,
      slug: null,
      ownershipType: null,
      showIds: [],
      releaseDate: null,
      audioMasterId: null,
      clipOnlyMode: false,
      closerKind: "none",
      playableAudio: true,
      durationSeconds,
      chapters,
      segmentIds: [segId],
      hostIds: [hostId],
      managedLinkIds: [],
      mediaAssetIds: [],
      bodyHash: `sha256:transcript${pad(i)}`,
      strongRefs: [],
      published: !isDraftOnly,
    });
  }

  // 8. Episodes (rich multi-edge references across shows, masters, segments, hosts, links, assets)
  const showEpisodeCounter = new Map<number, number>();
  const closers: ReadonlyArray<EpisodeCloserKind> = ["none", "sharePrompt", "bonusClip", "outroVideo"];
  for (let i = 0; i < episodes; i++) {
    // Episode 0 is our deterministic fixture on partner show-00001 with master-00000 & seg-00000
    const primaryShowIdx = i === 0 ? 1 : i % shows;
    const seqInShow = showEpisodeCounter.get(primaryShowIdx) ?? 0;
    showEpisodeCounter.set(primaryShowIdx, seqInShow + 1);

    const showIds = [`show-${pad(primaryShowIdx)}`];
    // ~15% of episodes belong to 2 shows (testing multi-parent show membership)
    if (i > 0 && rng() < 0.15 && shows > 2) {
      const secondShowIdx = (primaryShowIdx + 1) % shows;
      const secondSeq = showEpisodeCounter.get(secondShowIdx) ?? 0;
      showEpisodeCounter.set(secondShowIdx, secondSeq + 1);
      showIds.push(`show-${pad(secondShowIdx)}`);
    }

    const masterIdx = i === 0 ? 0 : (i % (audioMasters - 3)) + 3; // avoid draft-only master-00001
    const masterDoc = seedDocs[
      hosts + managedLinks + mediaAssets + segments + shows + channelWelcomes + masterIdx
    ]!;
    const primaryShowDoc =
      seedDocs[hosts + managedLinks + mediaAssets + segments + primaryShowIdx]!;

    const canClipOnly =
      primaryShowDoc.ownershipType === "partner" &&
      masterDoc.chapters.some((c) => c.sectionType === "highlight");
    const clipOnlyMode = i === 0 ? true : canClipOnly && rng() < 0.25;

    const seg0 = i === 0 ? "seg-00000" : `seg-${pad(i % segments)}`;
    const seg1 = `seg-${pad((i * 3 + 1) % segments)}`;
    const epSegments = seg0 === seg1 ? [seg0] : [seg0, seg1];
    const epHosts = [`host-${pad(i % hosts)}`];
    const epAssets = [i === 0 ? "asset-00000" : `asset-${pad(i % mediaAssets)}`];
    const epLinks = i % 2 === 0 ? [`link-${pad(i % managedLinks)}`] : [];

    const releaseDate = new Date(Date.UTC(2024, 0, 1 + seqInShow * 2 + (primaryShowIdx % 2)))
      .toISOString()
      .slice(0, 10);

    totalRefEdges +=
      showIds.length + 1 + epSegments.length + epHosts.length + epAssets.length + epLinks.length;

    seedDocs.push({
      documentId: `ep-${pad(i)}`,
      kind: "episode",
      title: `Podcast Episode #${i} — Deep Dive Conversation`,
      slug: `ep-${pad(i)}`,
      ownershipType: null,
      showIds,
      releaseDate,
      audioMasterId: `master-${pad(masterIdx)}`,
      clipOnlyMode,
      closerKind: closers[i % closers.length]!,
      playableAudio: false,
      durationSeconds: null,
      chapters: [],
      segmentIds: epSegments,
      hostIds: epHosts,
      managedLinkIds: epLinks,
      mediaAssetIds: epAssets,
      bodyHash: `sha256:notes${pad(i)}`,
      strongRefs: [],
      published: true,
    });
  }

  return {
    name: `podcast-cms-${seedDocs.length}docs-${editCount}edits`,
    workspaceId: "ws-podcast-network",
    seedDocs,
    counts: {
      shows,
      channelWelcomes,
      hosts,
      managedLinks,
      mediaAssets,
      segments,
      audioMasters,
      episodes,
      totalDocs: seedDocs.length,
      totalRefEdges,
    },
    fixtures: {
      editEpisodeId: "ep-00000",
      editEpisodeSlug: "ep-00000",
      editEpisodeReleaseDate: seedDocs.find((d) => d.documentId === "ep-00000")!.releaseDate!,
      internalShowId: "show-00000",
      internalShowSlug: "show-00000",
      partnerShowId: "show-00001",
      partnerShowSlug: "show-00001",
      publishedValidMasterId: "master-00000",
      draftOnlyMasterId: "master-00001",
      noHighlightMasterId: "master-00002",
      referencedAssetId: "asset-00000",
      missingRefId: "asset-does-not-exist",
    },
    editCount,
  };
};
