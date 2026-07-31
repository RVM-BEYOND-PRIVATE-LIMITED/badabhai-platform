import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG, rankKeyCompare, type RankInputs } from "@badabhai/match-engine";
import { MatchFeedRepository, type CandidateRow } from "./match-feed.repository";
import { MatchCandidatesService } from "./match-candidates.service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE RANK-TUPLE PARITY GATE (ADR-0036).
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * V1's rank key exists in EXACTLY TWO places in this codebase, and that duplication is
 * unavoidable rather than sloppy:
 *
 *   1. `rankKeyCompare` in `@badabhai/match-engine` — the reference comparator, the one
 *      the worked-example suite and the invariant tests are written against.
 *   2. The `ORDER BY` in `MatchFeedRepository.listCandidates` — because a database
 *      cannot call a TypeScript comparator, and paginating in application code would
 *      defeat `applications_rank_idx`, which is the whole point of "every read is an
 *      indexed sort".
 *
 * TWO IMPLEMENTATIONS OF ONE RULE DRIFT. So they are PINNED TO EACH OTHER here: the same
 * rows go through Postgres and through the comparator, and the two orders must be
 * IDENTICAL. Edit one without the other and this fails.
 *
 * The fixtures are chosen to exercise every key in the tuple and every disagreement the
 * two implementations could plausibly have:
 *   - the tier-with-floor CASE, including the INCLUSIVE boundary at exactly 36 months;
 *   - `skill_months` DESC and `industry_months` DESC as separate levels (invariant B:
 *     industry never crosses skill);
 *   - `last_worked_at` DESC NULLS LAST — the one place SQL's null ordering and
 *     JavaScript's `null` comparison most easily disagree;
 *   - NULL `match_tier` / `skill_months` / `industry_months` (legacy or partially
 *     snapshotted rows) — SQL `COALESCE` vs the comparator's finite-number handling;
 *   - a complete tie broken by `created_at` then by `id`.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 * It needs a real Postgres with the 0052–0058 train applied, so it SKIPS by default and
 * `pnpm --filter @badabhai/api test` stays DB-free:
 *
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test -- rank-parity
 *
 * A skipped gate is a disclosed gap, not a passing one — the `describe.skipIf` below is
 * deliberately visible in the run output.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** A deterministic uuid so the fixtures are reproducible and cleanable. */
function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const POSTING_ID = uuid(9001);
const PAYER_ID = uuid(9002);
const OPS_ACTOR = uuid(9003);

/** One fixture application: the frozen snapshot plus the ids that break ties. */
interface Fixture {
  n: number;
  matchTier: number | null;
  skillMonths: number | null;
  industryMonths: number | null;
  lastWorkedAt: string | null;
  /** Minutes after the base instant — drives `created_at`, the penultimate tiebreak. */
  createdAtOffsetMin: number;
}

const FLOOR = DEFAULT_MATCH_CONFIG.tierFloorMonths; // 36

const FIXTURES: Fixture[] = [
  // Tier 1, the spec's E2 ordering: X(48) > Y(24,48 industry) > Z(24,24).
  { n: 1, matchTier: 1, skillMonths: 48, industryMonths: 48, lastWorkedAt: "2026-01-01", createdAtOffsetMin: 0 },
  { n: 2, matchTier: 1, skillMonths: 24, industryMonths: 48, lastWorkedAt: "2026-01-01", createdAtOffsetMin: 1 },
  { n: 3, matchTier: 1, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2026-01-01", createdAtOffsetMin: 2 },
  // Tier 2 BELOW the floor — must stay behind every tier-1 row (invariant A).
  { n: 4, matchTier: 2, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2026-01-01", createdAtOffsetMin: 3 },
  // Tier 2 AT the floor exactly — the INCLUSIVE boundary. Promoted to tier-1 ordering.
  { n: 5, matchTier: 2, skillMonths: FLOOR, industryMonths: FLOOR, lastWorkedAt: "2026-01-01", createdAtOffsetMin: 4 },
  // Tier 2 well ABOVE the floor — the E3 ruling: outranks a thin exact claim.
  { n: 6, matchTier: 2, skillMonths: 120, industryMonths: 120, lastWorkedAt: "2026-01-01", createdAtOffsetMin: 5 },
  // E4 "duration unknown": tier 1 with 0 months. Now sorts BELOW the promoted #6.
  { n: 7, matchTier: 1, skillMonths: 0, industryMonths: 0, lastWorkedAt: null, createdAtOffsetMin: 6 },
  // last_worked_at NULLS LAST: identical months, one dated, one not.
  { n: 8, matchTier: 1, skillMonths: 12, industryMonths: 12, lastWorkedAt: "2025-06-01", createdAtOffsetMin: 7 },
  { n: 9, matchTier: 1, skillMonths: 12, industryMonths: 12, lastWorkedAt: null, createdAtOffsetMin: 8 },
  { n: 10, matchTier: 1, skillMonths: 12, industryMonths: 12, lastWorkedAt: "2025-09-01", createdAtOffsetMin: 9 },
  // A COMPLETE tie on every snapshot key — falls through to created_at then id.
  { n: 11, matchTier: 1, skillMonths: 6, industryMonths: 6, lastWorkedAt: "2025-01-01", createdAtOffsetMin: 10 },
  { n: 12, matchTier: 1, skillMonths: 6, industryMonths: 6, lastWorkedAt: "2025-01-01", createdAtOffsetMin: 10 },
  // Partially/never snapshotted rows: NULL tier and NULL months.
  { n: 13, matchTier: null, skillMonths: null, industryMonths: null, lastWorkedAt: null, createdAtOffsetMin: 11 },
  { n: 14, matchTier: 2, skillMonths: null, industryMonths: null, lastWorkedAt: null, createdAtOffsetMin: 12 },
  // Industry months as a pure tiebreak (invariant B: it never crosses skill months).
  { n: 15, matchTier: 1, skillMonths: 18, industryMonths: 200, lastWorkedAt: "2024-01-01", createdAtOffsetMin: 13 },
  { n: 16, matchTier: 1, skillMonths: 18, industryMonths: 6, lastWorkedAt: "2024-01-01", createdAtOffsetMin: 14 },
];

const BASE_MS = Date.parse("2026-07-01T00:00:00.000Z");

describe.skipIf(!RUN)("Matching V1 — SQL ORDER BY vs rankKeyCompare parity (ADR-0036)", () => {
  let client: DbClient;
  let repo: MatchFeedRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new MatchFeedRepository(client.db);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  it("orders the SAME rows identically in Postgres and in the engine", async () => {
    const fromSql = await repo.listCandidates(POSTING_ID, FLOOR, 500);
    expect(fromSql.length).toBe(FIXTURES.length);

    // The engine's order over the SAME rows, sorted with the SAME comparator the
    // worked-example suite pins. `toRankInputs` carries the null semantics.
    const inputs: RankInputs[] = MatchCandidatesService.toRankInputs(fromSql);
    const fromEngine = [...inputs].sort((a, b) => rankKeyCompare(a, b, DEFAULT_MATCH_CONFIG));

    expect(fromEngine.map((r) => r.id)).toEqual(fromSql.map((r) => r.applicationId));
  });

  it("puts a floor-promoted tier-2 worker above a thin tier-1 worker (the E3 ruling)", async () => {
    const rows = await repo.listCandidates(POSTING_ID, FLOOR, 500);
    const at = (n: number) => rows.findIndex((r) => r.applicationId === uuid(n));
    // #6 (tier 2, 120 months) beats #7 (tier 1, 0 months — "duration not stated").
    expect(at(6)).toBeLessThan(at(7));
    // #5 sits exactly ON the floor and is promoted too (the INCLUSIVE boundary).
    expect(at(5)).toBeLessThan(at(7));
    // #4 is tier 2 BELOW the floor and stays behind every genuine tier-1 row.
    expect(at(4)).toBeGreaterThan(at(3));
  });

  it("never lets industry months cross skill months (invariant B, structural)", async () => {
    const rows = await repo.listCandidates(POSTING_ID, FLOOR, 500);
    for (let i = 0; i < rows.length - 1; i += 1) {
      const a = rows[i]!;
      const b = rows[i + 1]!;
      const tierA = eff(a, FLOOR);
      const tierB = eff(b, FLOOR);
      if (tierA !== tierB) continue;
      // Within a tier, a row can never precede one with MORE skill months.
      expect((a.skillMonths ?? -1) >= (b.skillMonths ?? -1)).toBe(true);
    }
  });

  it("sorts an unknown last_worked_at LAST within its tier+months group", async () => {
    const rows = await repo.listCandidates(POSTING_ID, FLOOR, 500);
    const at = (n: number) => rows.findIndex((r) => r.applicationId === uuid(n));
    // #8 (2025-06) / #9 (null) / #10 (2025-09) all have 12/12 months.
    expect(at(10)).toBeLessThan(at(8)); // more recent first
    expect(at(8)).toBeLessThan(at(9)); // a date always beats "we do not know"
  });

  it("is STABLE — the same query twice returns the identical order (Policy 7)", async () => {
    const a = await repo.listCandidates(POSTING_ID, FLOOR, 500);
    const b = await repo.listCandidates(POSTING_ID, FLOOR, 500);
    expect(b.map((r) => r.applicationId)).toEqual(a.map((r) => r.applicationId));
  });
});

/** The SQL's effective-tier CASE, re-expressed for the assertion above. */
function eff(row: CandidateRow, floor: number): number {
  const tier = row.matchTier ?? 2;
  return tier > 1 && (row.skillMonths ?? 0) >= floor ? 1 : tier;
}

/**
 * Seed a posting + one application per fixture.
 *
 * `workers` rows are required by the `applications.worker_id` FK, and they are inserted
 * with NO PII — an id and the minimum the NOT NULLs demand — because this file must not
 * introduce a PII fixture into a shared database even in a test.
 */
async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                              match_skill_ids, reach_skill_ids, published_at)
    VALUES (${POSTING_ID}::uuid, ${OPS_ACTOR}::uuid, ${PAYER_ID}::uuid,
            'Rank Parity Fixture', 'VMC Operator', '1', 'open',
            '["mskill_vmc_operator"]'::jsonb, '["mskill_vmc_operator"]'::jsonb, now())
  `;

  for (const f of FIXTURES) {
    const workerId = uuid(f.n);
    // `phone_e164` holds the ENCRYPTED phone and `phone_hash` its HMAC — both NOT NULL.
    // These fixtures put a synthetic marker in each: no real phone number exists here,
    // so the fixture cannot leak or resemble PII even in a shared database.
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${workerId}::uuid, ${`enc:rank-parity-${f.n}`},
              ${`hash:rank-parity-${f.n}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    const createdAt = new Date(BASE_MS + f.createdAtOffsetMin * 60_000).toISOString();
    await sql`
      INSERT INTO applications (id, worker_id, job_posting_id, action, source_surface,
                                match_tier, skill_months, industry_months, last_worked_at,
                                engine_version, created_at)
      VALUES (${uuid(f.n)}::uuid, ${workerId}::uuid, ${POSTING_ID}::uuid, 'applied', 'feed',
              ${f.matchTier}, ${f.skillMonths}, ${f.industryMonths},
              ${f.lastWorkedAt}::date, 'v1.0', ${createdAt}::timestamptz)
    `;
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM applications WHERE job_posting_id = ${POSTING_ID}::uuid`;
  await sql`DELETE FROM job_reach WHERE job_posting_id = ${POSTING_ID}::uuid`;
  await sql`DELETE FROM job_postings WHERE id = ${POSTING_ID}::uuid`;
  for (const f of FIXTURES) {
    await sql`DELETE FROM workers WHERE id = ${uuid(f.n)}::uuid`;
  }
}
