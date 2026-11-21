import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const ORIGIN = process.env.REPRO_URL ?? "http://127.0.0.1:8799";

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
};

const postJson = async <T = any>(path: string, body: unknown): Promise<{ status: number; data: T; ms: number }> => {
  const t0 = performance.now();
  const res = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data, ms: performance.now() - t0 };
};

const waitForReady = async (timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/healthz`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${ORIGIN}/healthz`);
};

/**
 * Open-loop arrival generator: fires `ratePerSec` requests/second for `seconds`
 * regardless of server response time so queueing/head-of-line blocking shows up
 * honestly in tail latency (no coordinated omission).
 */
const runOpenLoop = async <T>(
  ratePerSec: number,
  seconds: number,
  fn: (index: number) => Promise<T>,
): Promise<{ results: Array<T>; wallMs: number; total: number }> => {
  const total = Math.floor(ratePerSec * seconds);
  const intervalMs = 1000 / ratePerSec;
  const start = performance.now();
  const promises: Array<Promise<T>> = [];

  for (let i = 0; i < total; i++) {
    const targetMs = start + i * intervalMs;
    const waitMs = targetMs - performance.now();
    if (waitMs > 1) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    promises.push(fn(i));
  }

  const results = await Promise.all(promises);
  return { results, wallMs: performance.now() - start, total };
};

const runQuotaWorkerdBench = async (runId: string) => {
  const rate = Number(process.env.LOAD_RATE ?? 185);
  const seconds = Number(process.env.LOAD_SECONDS ?? 3);
  const totalPlanned = Math.floor(rate * seconds);

  console.log(
    `\n1) Dynamic Ad Network — Open-loop ${rate} opps/s × ${seconds}s (${totalPlanned} opps) against real local workerd DOs:`,
  );

  // --- Topology A: Single Market DO (with ScheduleLeaseExpiry policy) ---
  const marketId = `mkt-${runId}`;
  await postJson("/market/setup", {
    marketId,
    campaignId: "camp-hot",
    name: "Primary Sponsor",
    targets: { primary: 100_000, companion: 100_000, secondary: 0 },
    commandId: `setup-${runId}`,
  });

  const aRun = await runOpenLoop(rate, seconds, async (i) => {
    const oppId = `${runId}-a-${i}`;
    const res = await postJson<{ ok: boolean; reason?: string }>("/market/allocate", {
      marketId,
      opportunityId: oppId,
      audience: "free",
      leaseTtlMs: 120_000,
    });
    return {
      ms: res.ms,
      ok: res.status === 200 && res.data.ok,
      noFill: res.data.reason === "no_fill",
      err: res.status >= 500,
    };
  });

  // --- Topology B: Per-Campaign DOs with 2 candidates (candidate 1 runs out at 25% of burst) ---
  const c1 = `camp-small-${runId}`;
  const c2 = `camp-fallback-${runId}`;
  await postJson("/campaign/setup", {
    campaignId: c1,
    name: "Small Sponsor",
    targets: { primary: Math.floor(totalPlanned / 4), companion: Math.floor(totalPlanned / 4), secondary: 0 },
    commandId: `setup-b1-${runId}`,
  });
  await postJson("/campaign/setup", {
    campaignId: c2,
    name: "Funded Fallback Sponsor",
    targets: { primary: 100_000, companion: 100_000, secondary: 0 },
    commandId: `setup-b2-${runId}`,
  });

  const bRun = await runOpenLoop(rate, seconds, async (i) => {
    const oppId = `${runId}-b-${i}`;
    const res = await postJson<{ ok: boolean; hops?: number; reason?: string }>("/campaign/allocate", {
      campaignIds: [c1, c2],
      opportunityId: oppId,
      audience: "free",
      leaseTtlMs: 120_000,
    });
    return {
      ms: res.ms,
      ok: res.status === 200 && res.data.ok,
      noFill: res.data.reason === "no_fill",
      err: res.status >= 500,
      hops: res.data.hops ?? 1,
    };
  });

  // --- Topology C: 8 Sharded Escrow Cells (exact total quota = totalPlanned, mild routing skew) ---
  const cellIds = Array.from({ length: 8 }, (_, idx) => `cell-${runId}-${idx}`);
  await postJson("/escrow/setup", {
    campaignId: `camp-escrow-${runId}`,
    cellIds,
    targets: { primary: totalPlanned, companion: totalPlanned, secondary: 0 },
    commandId: `setup-c-${runId}`,
  });
  // Allow DistributeGrants policy to install cell grants across all 8 DOs.
  await new Promise((r) => setTimeout(r, 800));

  const cRun = await runOpenLoop(rate, seconds, async (i) => {
    const oppId = `${runId}-c-${i}`;
    // Mild skew: 50% of traffic hits cells 0–1, 50% spreads across cells 2–7.
    const cellIdx = i % 2 === 0 ? Math.floor(i / 2) % 2 : 2 + (i % 6);
    const res = await postJson<{ ok: boolean; reason?: string }>("/escrow/allocate", {
      cellId: cellIds[cellIdx]!,
      opportunityId: oppId,
      audience: "free",
      leaseTtlMs: 120_000,
    });
    return {
      ms: res.ms,
      ok: res.status === 200 && res.data.ok,
      noFill: res.data.reason === "no_fill",
      err: res.status >= 500,
    };
  });

  const summarize = (
    name: string,
    run: { results: ReadonlyArray<{ ms: number; ok: boolean; noFill: boolean; err: boolean; hops?: number }>; wallMs: number },
  ) => {
    const lats = run.results.map((r) => r.ms).sort((a, b) => a - b);
    const filled = run.results.filter((r) => r.ok).length;
    const noFills = run.results.filter((r) => r.noFill).length;
    const errors = run.results.filter((r) => r.err).length;
    const fallbacks = run.results.filter((r) => (r.hops ?? 1) > 1).length;
    return {
      name,
      wallMs: run.wallMs.toFixed(0),
      p50: percentile(lats, 50).toFixed(1),
      p95: percentile(lats, 95).toFixed(1),
      p99: percentile(lats, 99).toFixed(1),
      max: percentile(lats, 100).toFixed(1),
      filled,
      noFills,
      errors,
      fallbacks,
    };
  };

  const rows = [
    summarize("Topology A: Single Market DO", aRun),
    summarize("Topology B: Campaign DOs (2 candidates)", bRun),
    summarize("Topology C: 8 Escrow Cell DOs (mild skew)", cRun),
  ];

  console.log("| Topology | Wall | p50 | p95 | p99 | max | Filled | Stranded no-fills | 5xx |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const label = r.fallbacks > 0 ? `${r.name} (${r.fallbacks} fallback hops)` : r.name;
    console.log(
      `| ${label} | ${r.wallMs} ms | ${r.p50} ms | ${r.p95} ms | ${r.p99} ms | ${r.max} ms | ${r.filled} | ${r.noFills} | ${r.errors} |`,
    );
  }
};

const runCmsWorkerdBench = async (runId: string) => {
  console.log("\n2) CMS Workspace vs Per-Document single-field edit latency on real local workerd DOs:");
  const sizes = [10, 200, 500];
  console.log("| Model / Workspace Docs | 20 sequential single-field edits p50 | p95 | max |");
  console.log("|---|---:|---:|---:|");

  for (const n of sizes) {
    const wsId = `ws-${runId}-${n}`;
    // Seed N docs
    for (let i = 0; i < n; i++) {
      await postJson("/cms/workspace/save", {
        workspaceId: wsId,
        documentId: `doc-${String(i).padStart(5, "0")}`,
        expectedRevision: null,
        title: `Scheduled Podcast Episode #${i} — Weekly Network Series`,
        kind: i === 0 ? "mediaAsset" : "episode",
        slug: i === 0 ? null : `ep-${i}`,
        releaseDate: i === 0 ? null : new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
        bodyHash: `sha256:${String(i).padStart(64, "0")}`,
        strongRefs: i === 0 ? [] : ["doc-00000"],
        commandId: `seed-${runId}-${n}-${i}`,
      });
    }
    const lats: Array<number> = [];
    for (let e = 0; e < 20; e++) {
      const res = await postJson("/cms/workspace/save", {
        workspaceId: wsId,
        documentId: "doc-00001",
        expectedRevision: 1 + e,
        title: `Scheduled Podcast Episode #1 (rev ${2 + e})`,
        kind: "episode",
        slug: "ep-1",
        releaseDate: "2026-01-02",
        bodyHash: `sha256:${String(e + 1000).padStart(64, "0")}`,
        strongRefs: ["doc-00000"],
        commandId: `edit-${runId}-${n}-${e}`,
      });
      lats.push(res.ms);
    }
    lats.sort((a, b) => a - b);
    console.log(
      `| Workspace DO (${n} docs) | ${percentile(lats, 50).toFixed(1)} ms | ${percentile(lats, 95).toFixed(1)} ms | ${percentile(lats, 100).toFixed(1)} ms |`,
    );
  }

  // Split ContentDocument baseline
  const docId = `split-doc-${runId}`;
  await postJson("/cms/document/save", {
    workspaceId: `ws-split-${runId}`,
    documentId: docId,
    expectedRevision: null,
    title: "Article #1",
    releaseDate: "2026-01-02",
    bodyHash: `sha256:${"1".padStart(64, "0")}`,
    strongRefs: ["doc-00000"],
    commandId: `split-seed-${runId}`,
  });
  const splitLats: Array<number> = [];
  for (let e = 0; e < 20; e++) {
    const res = await postJson("/cms/document/save", {
      workspaceId: `ws-split-${runId}`,
      documentId: docId,
      expectedRevision: 1 + e,
      title: `Article #1 (rev ${2 + e})`,
      releaseDate: "2026-01-02",
      bodyHash: `sha256:${String(e + 1000).padStart(64, "0")}`,
      strongRefs: ["doc-00000"],
      commandId: `split-edit-${runId}-${e}`,
    });
    splitLats.push(res.ms);
  }
  splitLats.sort((a, b) => a - b);
  console.log(
    `| ContentDocument DO (split) | ${percentile(splitLats, 50).toFixed(1)} ms | ${percentile(splitLats, 95).toFixed(1)} ms | ${percentile(splitLats, 100).toFixed(1)} ms |`,
  );
};

const main = async () => {
  console.log("=== Real workerd / @alchemy.run/domain/Cloudflare (2.0.0-beta.87) HTTP Load Probe ===");

  let child: ReturnType<typeof spawn> | null = null;
  const alreadyRunning = await fetch(`${ORIGIN}/healthz`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!alreadyRunning) {
    console.log("Starting local `alchemy dev --stage local`...");
    child = spawn("pnpm", ["exec", "alchemy", "dev", "--stage", "local"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    await waitForReady(35_000);
    console.log(`Ready at ${ORIGIN}`);
  }

  try {
    const runId = Date.now().toString(36);
    await runQuotaWorkerdBench(runId);
    await runCmsWorkerdBench(runId);
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
