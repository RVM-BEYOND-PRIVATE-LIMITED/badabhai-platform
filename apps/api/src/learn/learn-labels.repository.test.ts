import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, learnLabels, type DbClient } from "@badabhai/db";
import { LearnLabelsRepository, type LearnEventRow } from "./learn-labels.repository";

/**
 * DB-backed regression test for the LEARN label store's claimed replay-safety
 * (migration 0091, Medium finding on the post-merge review of PR #1204):
 *
 *   - impression ingest dedupes via `ON CONFLICT (impression_event_id) DO NOTHING`
 *     (the `learn_labels_impression_uq` unique index);
 *   - a resolution is guarded by `resolved_at IS NULL`, so a replayed/duplicate
 *     application event can never flip an already-resolved label's outcome.
 *
 * `learn-labels.service.test.ts` mocks `LearnLabelsRepository` entirely, so neither
 * property was ever checked against a real Postgres constraint. This file is.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test -- learn-labels.repository
 *
 * SKIPS by default so `pnpm --filter @badabhai/api test` stays DB-free.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(9501);
const PAYER = uuid(9502);
const POSTING = uuid(9503);
const IMPRESSION_EVENT_ID = uuid(9601);

function shownEvent(): LearnEventRow {
  return {
    id: IMPRESSION_EVENT_ID,
    eventName: "feed.shown_v2",
    subjectType: "job_posting",
    payload: {
      worker_id: WORKER,
      job_posting_id: POSTING,
      rank: 3,
      match_tier: 2,
      boosted: false,
      matched_skill_id: "mskill_cnc_turner",
    },
    createdAt: new Date("2026-08-01T10:00:00Z"),
  };
}

function applicationEvent(id: string, createdAt: Date): LearnEventRow {
  return {
    id,
    eventName: "application.submitted",
    subjectType: "job_posting",
    payload: { worker_id: WORKER, job_id: POSTING, rank: null, source_surface: "feed" },
    createdAt,
  };
}

describe.skipIf(!RUN)("LearnLabelsRepository — replay-safety against real Postgres", () => {
  let client: DbClient;
  let repo: LearnLabelsRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new LearnLabelsRepository(client.db);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  it("ingesting the SAME impression twice leaves exactly one row (ON CONFLICT DO NOTHING)", async () => {
    const ev = shownEvent();
    const first = await repo.ingestImpression(ev);
    const second = await repo.ingestImpression(ev);
    expect(first).toBe(true);
    expect(second, "the duplicate insert must be a no-op, not a second row").toBe(false);

    const rows = await client.db
      .select()
      .from(learnLabels)
      .where(eq(learnLabels.impressionEventId, IMPRESSION_EVENT_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("none");
  });

  it("a SECOND resolution of an already-resolved label is a no-op (resolved_at IS NULL guard)", async () => {
    const applied = applicationEvent(uuid(9602), new Date("2026-08-01T10:05:00Z"));
    const resolvedFirst = await repo.resolvePending(applied, "applied");
    expect(resolvedFirst, "the first resolution must succeed").toBe(true);

    const afterFirst = await client.db
      .select()
      .from(learnLabels)
      .where(eq(learnLabels.impressionEventId, IMPRESSION_EVENT_ID));
    expect(afterFirst[0]!.outcome).toBe("applied");
    expect(afterFirst[0]!.label).toBe(1);
    expect(afterFirst[0]!.outcomeEventId).toBe(applied.id);
    const resolvedAtFirst = afterFirst[0]!.resolvedAt;
    expect(resolvedAtFirst).not.toBeNull();

    // A SECOND, different-outcome application event for the same pair (e.g. a replayed
    // or duplicate delivery) must NOT flip an already-resolved label.
    const skipped = applicationEvent(uuid(9603), new Date("2026-08-01T10:10:00Z"));
    const resolvedSecond = await repo.resolvePending(skipped, "skipped");
    expect(resolvedSecond, "resolving an already-resolved pending row must be a no-op").toBe(
      false,
    );

    const afterSecond = await client.db
      .select()
      .from(learnLabels)
      .where(eq(learnLabels.impressionEventId, IMPRESSION_EVENT_ID));
    // The outcome from the FIRST resolution survives untouched.
    expect(afterSecond[0]!.outcome).toBe("applied");
    expect(afterSecond[0]!.label).toBe(1);
    expect(afterSecond[0]!.outcomeEventId).toBe(applied.id);
    expect(afterSecond[0]!.resolvedAt?.getTime()).toBe(resolvedAtFirst?.getTime());
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:learn-labels-repo-worker', 'hash:learn-labels-repo-worker', 'active'),
           (${PAYER}::uuid, 'enc:learn-labels-repo-payer', 'hash:learn-labels-repo-payer', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                              status, match_skill_ids, reach_skill_ids, published_at)
    VALUES (${POSTING}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Learn Labels Fixture',
            'VMC Operator', '1', 'open', '["mskill_vmc_operator"]'::jsonb,
            '["mskill_vmc_operator", "mskill_cnc_turner"]'::jsonb, now())
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM learn_labels WHERE job_posting_id = ${POSTING}::uuid`;
  await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
  await sql`DELETE FROM workers WHERE id IN (${WORKER}::uuid, ${PAYER}::uuid)`;
}
