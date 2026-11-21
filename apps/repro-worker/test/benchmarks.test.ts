import { describe, expect, it } from "vitest";
import { runMockCmsBenchmarks, runMockQuotaBenchmarks } from "../benchmarks/mock-baselines.ts";
import {
  DEFAULT_SEED,
  generateCmsTape,
  generateQuotaBurstTape,
  generateQuotaExhaustionTape,
  generateQuotaSkewedTape,
} from "../benchmarks/synthetic-tapes.ts";

describe("Falsifiable synthetic benchmarks & mocked reference baselines", () => {
  it("synthetic tapes are 100% deterministic for a fixed seed (including 25,000-doc Podcast CMS)", () => {
    const a1 = generateQuotaBurstTape(185, 3, DEFAULT_SEED);
    const a2 = generateQuotaBurstTape(185, 3, DEFAULT_SEED);
    expect(a1).toEqual(a2);
    expect(a1.opportunities).toHaveLength(555);

    const c1 = generateCmsTape(25_000, 20, DEFAULT_SEED + 3);
    const c2 = generateCmsTape(25_000, 20, DEFAULT_SEED + 3);
    expect(c1.counts).toEqual(c2.counts);
    expect(c1.seedDocs).toHaveLength(25_000);
    expect(c1.counts.totalRefEdges).toBeGreaterThan(50_000);
  });

  it("MockQuotaReference passes 100% of falsifiable Dynamic Ad Network acceptance gates", () => {
    const burst = generateQuotaBurstTape(185, 3);
    const exhaustion = generateQuotaExhaustionTape();
    const skewed = generateQuotaSkewedTape(240, 8);
    const res = runMockQuotaBenchmarks(burst, exhaustion, skewed);

    expect(res.gates.burstLatencyPass).toBe(true);
    expect(res.gates.burstFillPass).toBe(true);
    expect(res.gates.exhaustionAccuracyPass).toBe(true);
    expect(res.gates.skewedFillPass).toBe(true);
    expect(res.gates.storagePass).toBe(true);
    expect(res.gates.allPassed).toBe(true);
  });

  it("MockCmsReference passes all 8 Podcast Network invariants and scale gates on full 25,000-doc corpus", () => {
    const tape = generateCmsTape(25_000, 20);
    const res = runMockCmsBenchmarks(tape);

    expect(res.invariants.staleRevisionRejected).toBe(true);
    expect(res.invariants.scopedShowSlugRejected).toBe(true);
    expect(res.invariants.perShowEpisodeSlugRejected).toBe(true);
    expect(res.invariants.danglingRefRejected).toBe(true);
    expect(res.invariants.deleteInUseRejected).toBe(true);
    expect(res.invariants.unpublishedAudioMasterRejected).toBe(true);
    expect(res.invariants.clipOnlyRuleRejected).toBe(true);
    expect(res.invariants.atomicPublishSucceeded).toBe(true);
    expect(res.invariants.passedCount).toBe(8);
    expect(res.gates.allPassed).toBe(true);
  });
});
