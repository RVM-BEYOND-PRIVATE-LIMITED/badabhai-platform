import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, workers, workerProfiles, type DbClient } from "@badabhai/db";

/**
 * TD14 — a partial-success extraction retry must not duplicate a profile.
 *
 * The processor creates the profile and THEN marks the ai_job completed; a crash
 * in between (or a BullMQ stalled-job redelivery) used to orphan a second profile.
 * With the unique `ai_job_id`, re-creating for the same job is a no-op
 * (`ON CONFLICT DO NOTHING`) and the caller converges on the existing row.
 *
 * This exercises the exact insert chain ProfilesRepository.create uses, against
 * real Postgres, proving the DB-level guarantee. Profiles with NULL ai_job_id
 * (legacy/non-extraction) still always insert.
 *
 * Opt-in (same lane as the Phase 1 flow):
 *   1. docker compose up -d postgres
 *   2. pnpm db:migrate            # applies 0007 (ai_job_id + unique index)
 *   3. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 */

const RUN = process.env.RUN_E2E === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("Profile creation is idempotent per ai_job_id (TD14)", () => {
  let client!: DbClient;
  let workerId = "";

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    // A worker to own the profiles (worker_profiles.worker_id is NOT NULL + FK).
    const [w] = await client.db
      .insert(workers)
      .values({ phoneE164: "v1.td14-test", phoneHash: randomUUID(), status: "active" })
      .returning({ id: workers.id });
    workerId = w!.id;
  });

  afterAll(async () => {
    await client.sql`delete from worker_profiles where worker_id = ${workerId}`;
    await client.sql`delete from workers where id = ${workerId}`;
    await client.sql.end({ timeout: 5 });
  });

  /** Mirror of ProfilesRepository.create: insert-or-return-existing, keyed on ai_job_id. */
  async function idempotentCreate(aiJobId: string | null): Promise<string | null> {
    const inserted = await client.db
      .insert(workerProfiles)
      .values({ workerId, aiJobId })
      .onConflictDoNothing({ target: workerProfiles.aiJobId })
      .returning({ id: workerProfiles.id });
    if (inserted[0]) return inserted[0].id;
    if (aiJobId) {
      const all = await client.db.select().from(workerProfiles);
      return all.find((p) => p.aiJobId === aiJobId)?.id ?? null;
    }
    return null;
  }

  async function profilesForJob(aiJobId: string): Promise<number> {
    const all = await client.db.select().from(workerProfiles);
    return all.filter((p) => p.aiJobId === aiJobId).length;
  }

  async function profilesForWorker(): Promise<number> {
    const all = await client.db.select().from(workerProfiles);
    return all.filter((p) => p.workerId === workerId).length;
  }

  it("a partial-success retry returns the SAME profile, not a duplicate", async () => {
    const aiJobId = randomUUID();

    const first = await idempotentCreate(aiJobId); // processor run #1: created
    const second = await idempotentCreate(aiJobId); // crash → redelivery: must NOT duplicate

    expect(first).toBeTruthy();
    expect(second).toBe(first); // converges on the same profile id
    expect(await profilesForJob(aiJobId)).toBe(1); // exactly one profile for the job
  });

  it("distinct jobs produce distinct profiles", async () => {
    const a = randomUUID();
    const b = randomUUID();

    const pa = await idempotentCreate(a);
    const pb = await idempotentCreate(b);

    expect(pa).toBeTruthy();
    expect(pb).toBeTruthy();
    expect(pa).not.toBe(pb);
    expect(await profilesForJob(a)).toBe(1);
    expect(await profilesForJob(b)).toBe(1);
  });

  it("never dedups profiles with NULL ai_job_id (legacy/non-extraction)", async () => {
    const before = await profilesForWorker();

    await idempotentCreate(null);
    await idempotentCreate(null);

    expect(await profilesForWorker()).toBe(before + 2);
  });
});
