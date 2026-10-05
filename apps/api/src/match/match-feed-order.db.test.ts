import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { MatchFeedRepository } from "./match-feed.repository";

/**
 * MOMENT ④ — the worker feed's ORDER, against real Postgres.
 *
 * Owner ruling (Prakash, 2026-10-05): DIRECT BEFORE RELATED. A job the worker reaches
 * through the POSTED skill (`match_tier` 1) ranks above one he reaches only through a
 * RELATED skill (tier 2). The full order is
 *
 *   (boosted_until > now()) DESC, jr.match_tier ASC, jp.published_at DESC NULLS LAST, jp.id ASC
 *
 * `match-feed.repository.test.ts` proves the statement SAYS that; only a database can
 * prove it EVALUATES to it — that an expired boost really sorts as unboosted, that NULLS
 * LAST really holds inside a band, and that `id ASC` really separates two postings
 * published at the same instant. Each key is made to DISAGREE with the one after it, so a
 * swapped pair of keys produces a different permutation rather than a lucky pass:
 *
 *   - the boosted tier-2 card is the OLDEST in the fixture (boost beats tier and recency);
 *   - every tier-2 card is published AFTER every tier-1 card in its band (tier beats
 *     recency — a recency-first order would put them on top);
 *   - two tier-1 cards share one `published_at` and are inserted in REVERSE id order
 *     (only the id key can order them).
 *
 * Gated like the other DB release gates:
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test match-feed-order.db
 *
 * A skipped gate is a disclosed gap, not a passing one.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(9301);
const SKILL = "mskill_vmc_operator";

interface Fixture {
  id: string;
  tier: 1 | 2;
  /** `'active'` = boosted_until in the future; `'expired'` = in the past; null = never. */
  boost: "active" | "expired" | null;
  /** Hours before now(); null = never published (NULL `published_at`). */
  ageHours: number | null;
}

// Ids are numbered so that `id ASC` alone would give a DIFFERENT order from the ruled one.
// One payer per posting: this is the repository's order, before any interleave.
const P = {
  boostT1New: uuid(9110),
  boostT1Old: uuid(9109),
  boostT2: uuid(9101), // the oldest posting in the fixture, and still second band
  t1Tie_lowId: uuid(9104),
  t1Tie_highId: uuid(9105),
  t1Old: uuid(9103),
  t1Expired: uuid(9102), // boost window closed: sorts exactly as unboosted
  t1Unpublished: uuid(9106),
  t2New: uuid(9108),
  t2Old: uuid(9107),
};

const FIXTURES: Fixture[] = [
  { id: P.boostT1New, tier: 1, boost: "active", ageHours: 30 },
  { id: P.boostT1Old, tier: 1, boost: "active", ageHours: 40 },
  { id: P.boostT2, tier: 2, boost: "active", ageHours: 200 },
  // Two tier-1 postings at ONE instant; the higher id is inserted first.
  { id: P.t1Tie_highId, tier: 1, boost: null, ageHours: 50 },
  { id: P.t1Tie_lowId, tier: 1, boost: null, ageHours: 50 },
  { id: P.t1Expired, tier: 1, boost: "expired", ageHours: 60 },
  { id: P.t1Old, tier: 1, boost: null, ageHours: 70 },
  { id: P.t1Unpublished, tier: 1, boost: null, ageHours: null },
  // Tier 2 is NEWER than every unboosted tier-1 posting: recency must not lift it.
  { id: P.t2New, tier: 2, boost: null, ageHours: 1 },
  { id: P.t2Old, tier: 2, boost: null, ageHours: 2 },
];

/** The ruled order, written out by hand — NOT derived from the fixture by a sort. */
const EXPECTED = [
  // Band 1 — boost active. Tier 1 first (newest first), then tier 2 despite its age.
  P.boostT1New,
  P.boostT1Old,
  P.boostT2,
  // Band 2 — unboosted (an expired boost included). Tier 1, newest first, id breaks the
  // tie, NULL published_at last within the tier.
  P.t1Tie_lowId,
  P.t1Tie_highId,
  P.t1Expired,
  P.t1Old,
  P.t1Unpublished,
  // Then tier 2, newest first — below every tier-1 card although published after them.
  P.t2New,
  P.t2Old,
];

describe.skipIf(!RUN)(
  "Matching V1 — feed order: boost, then DIRECT before RELATED (2026-10-05)",
  () => {
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

    it("returns exactly the ruled order across boost × tier × recency × id", async () => {
      const rows = await repo.listFeed(WORKER, 50, {});
      expect(rows.map((r) => r.jobPostingId)).toEqual(EXPECTED);
    });

    it("carries the tier and boost each card was ordered by", async () => {
      const rows = await repo.listFeed(WORKER, 50, {});
      const byId = new Map(FIXTURES.map((f) => [f.id, f]));
      for (const r of rows) {
        const f = byId.get(r.jobPostingId)!;
        expect(r.matchTier, r.jobPostingId).toBe(f.tier);
        expect(r.boosted, r.jobPostingId).toBe(f.boost === "active");
      }
    });

    it("is a TOTAL order — repeated fetches return the identical sequence (E11/Policy 7)", async () => {
      const runs = await Promise.all(
        Array.from({ length: 5 }, () => repo.listFeed(WORKER, 50, {})),
      );
      for (const run of runs) {
        expect(run.map((r) => r.jobPostingId)).toEqual(EXPECTED);
      }
    });

    it("LIMIT takes a prefix of the same order (page 1 is never a different sort)", async () => {
      const rows = await repo.listFeed(WORKER, 4, {});
      expect(rows.map((r) => r.jobPostingId)).toEqual(EXPECTED.slice(0, 4));
    });
  },
);

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  // `job_reach.matched_skill_id` FKs to `skill.skill_id`; self-sufficient on a bare
  // migrated database, a no-op on one where D1 has run (same upsert as boost-fences).
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'cnc-machining', 'rvm', 'active', 'match_skill',
            'ind_industrial_manufacturing')
    ON CONFLICT (skill_id) DO NOTHING
  `;

  // NO PII: an id and synthetic markers for the two NOT NULL phone columns.
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:feed-order', 'hash:feed-order', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  // ONE base instant for every posting: each statement has its own now(), so deriving
  // the dates in SQL would let the tie pair straddle a clock tick and stop being a tie.
  const base = Date.now();
  for (const f of FIXTURES) {
    // Each posting has its own payer, so `payer_key` never coincides.
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at,
                                boosted_until)
      VALUES (${f.id}::uuid, ${f.id}::uuid, ${f.id}::uuid, 'Feed order', 'VMC Operator', '1',
              'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb,
              ${publishedAt(base, f.ageHours)}::timestamptz,
              CASE ${f.boost}::text
                WHEN 'active'  THEN now() + interval '7 days'
                WHEN 'expired' THEN now() - interval '1 day'
                ELSE NULL END)
    `;
    await sql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${f.id}::uuid, ${WORKER}::uuid, ${f.tier}, ${SKILL})
    `;
  }
}

function publishedAt(base: number, ageHours: number | null): string | null {
  return ageHours === null ? null : new Date(base - ageHours * 3_600_000).toISOString();
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const f of FIXTURES) {
    await sql`DELETE FROM job_reach WHERE job_posting_id = ${f.id}::uuid`;
    await sql`DELETE FROM job_postings WHERE id = ${f.id}::uuid`;
  }
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
}
