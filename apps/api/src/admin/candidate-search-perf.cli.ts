/**
 * B5 (#2559) — Candidates search p95 measurement (the acceptance criterion,
 * executed by hand against a LOCAL synthetic seed, never production):
 *
 *   pnpm db:seed:candidates-perf --workers=50000 --tag=<tag>   # seed (local only)
 *   node apps/api/dist/admin/candidate-search-perf.cli.js [--tag=<tag>] [--runs=21]
 *   pnpm db:seed:candidates-perf --clean --tag=<tag>            # remove the fixture
 *
 * (`pnpm --filter @badabhai/api build` first.) Runs a mixed battery — text,
 * phone-hash, name-token, filtered, sorted and faceted reads — through the REAL
 * `AdminCandidatesRepository` (the same statement the endpoint serves, minus
 * HTTP) and reports per-query ms plus p50/p95. READ-ONLY; refuses non-local
 * hosts. Output is counts and timings only.
 */
import { parseArgs } from "node:util";
import { createDbClient } from "@badabhai/db";
import { AdminCandidatesRepository } from "./admin-candidates.repository";
import type { AdminCandidateSearchDto, CandidateSearchSort } from "./admin-candidates.dto";

export const CANDIDATE_SEARCH_PERF_SCRIPT = "candidate-search-perf";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${CANDIDATE_SEARCH_PERF_SCRIPT} refuses non-local host (${host})`);
  }
}

interface BatteryQuery {
  name: string;
  textLike: string | null;
  phoneHash: string | null;
  nameHashes: string[] | null;
  filters: NonNullable<AdminCandidateSearchDto["filters"]>;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
}

async function run(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      tag: { type: "string" },
      runs: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const tag = values.tag ?? "perf";
  const runs = values.runs === undefined ? 21 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) {
    throw new Error("--runs must be an integer in 1..200");
  }
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL is required");
  assertLocalDatabase(cs);
  const client = createDbClient(cs, { max: 1 });
  try {
    const repo = new AdminCandidatesRepository(client.db);
    const battery: BatteryQuery[] = [
      { name: "text", textLike: "%cnc%", phoneHash: null, nameHashes: null, filters: {}, sort: "last_active_at", dir: "desc" },
      { name: "text+filter+sort", textLike: "%welding%", phoneHash: null, nameHashes: null, filters: {}, sort: "total_experience_years", dir: "desc" },
      { name: "phone", textLike: null, phoneHash: `perfphone:${tag}:42`, nameHashes: null, filters: {}, sort: "created_at", dir: "asc" },
      { name: "name", textLike: null, phoneHash: null, nameHashes: ["perftok:7"], filters: {}, sort: "created_at", dir: "asc" },
      { name: "filtered", textLike: null, phoneHash: null, nameHashes: null, filters: {}, sort: "ai_cost_inr", dir: "desc" },
      { name: "facets", textLike: "%pune%", phoneHash: null, nameHashes: null, filters: {}, sort: "resume_count", dir: "desc" },
    ];
    const samples: { name: string; ms: number }[] = [];
    for (let r = 0; r < runs; r++) {
      for (const q of battery) {
        const started = performance.now();
        await repo.search({ ...q, limit: 50, offset: 0 });
        samples.push({ name: q.name, ms: performance.now() - started });
      }
    }
    const all = samples.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (p: number): number => all[Math.min(all.length - 1, Math.floor((p / 100) * all.length))]!;
    const byQuery = new Map<string, number[]>();
    for (const s of samples) byQuery.set(s.name, [...(byQuery.get(s.name) ?? []), s.ms]);
    console.log(`[${CANDIDATE_SEARCH_PERF_SCRIPT}] runs=${runs} queries=${samples.length}`);
    for (const [name, ms] of byQuery) {
      const sorted = [...ms].sort((a, b) => a - b);
      console.log(
        `  ${name}: n=${ms.length} p50=${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms ` +
          `p95=${sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!.toFixed(1)}ms`,
      );
    }
    console.log(`  OVERALL p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms`);
    return 0;
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  // `process.exit`, not `exitCode`: a failed query can leave the pool's socket
  // in a state where the event loop never drains (measured: the process hung
  // after printing the failure). One-shot script — force-exit with the code.
  run(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      console.error(
        `[${CANDIDATE_SEARCH_PERF_SCRIPT}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    },
  );
}
