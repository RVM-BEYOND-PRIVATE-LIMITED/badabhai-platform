import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { AdminCandidatesRepository } from "./admin-candidates.repository";
import { AdminDashboardRepository } from "./admin-dashboard.repository";
import { AdminFunnelRepository } from "./admin-funnel.repository";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";

/**
 * #2752 part D — the admin reads and a Campus-linked student, against Postgres:
 *   - a row the link created that he never signed in to (`pending`, origin `institute`) is in no
 *     funnel cohort, has no journey and is in no dashboard status count; his first sign-in
 *     (status `active`) brings him into all three;
 *   - a legacy `pending` row with no institute origin is counted exactly as before;
 *   - the candidates search labels an actively linked row `rvm` and filters on it, and an
 *     unlinked (withdrawn) row loses the label at once.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-institute-scope.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);

describe.skipIf(!RUN)("#2752 admin scope for Campus-linked students — against Postgres", () => {
  let client!: DbClient;
  let funnel!: AdminFunnelRepository;
  let journey!: AdminWorkerJourneyRepository;
  let dashboard!: AdminDashboardRepository;
  let candidates!: AdminCandidatesRepository;
  const ids = { linkedPending: randomUUID(), legacyPending: randomUUID(), active: randomUUID() };
  const windowStart = new Date(Date.now() - 60_000);

  const pendingCount = async () =>
    (await dashboard.countWorkersByStatus()).find((r) => r.key === "pending")?.count ?? 0;
  const cohortIds = async () =>
    (await funnel.listCohort({ signupFrom: windowStart, testAccounts: "include" })).map(
      (w) => w.id,
    );
  const search = (institute_linked?: boolean) =>
    candidates.search({
      filters: institute_linked === undefined ? {} : { institute_linked },
      textLike: null,
      phoneHash: null,
      nameHashes: null,
      sort: "created_at",
      dir: "desc",
      limit: 100,
      offset: 0,
    });

  let pendingBefore = 0;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 2 });
    funnel = new AdminFunnelRepository(client.db);
    journey = new AdminWorkerJourneyRepository(client.db);
    dashboard = new AdminDashboardRepository(client.db);
    candidates = new AdminCandidatesRepository(client.db);
    pendingBefore = await pendingCount();

    const { sql } = client;
    for (const [key, id] of Object.entries(ids)) {
      const status = key === "active" ? "active" : "pending";
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:2752d-${TAG}-${key}`}, ${`hash:2752d-${TAG}-${key}`}, ${status})`;
      await sql`
        INSERT INTO admin_candidate_index (worker_id, status, phone_hash, created_at, updated_at)
        VALUES (${id}::uuid, ${status}, ${`hash:2752d-${TAG}-${key}`}, now(), now())`;
    }
    await sql`
      INSERT INTO worker_origins (worker_id, kind, ref)
      VALUES (${ids.linkedPending}::uuid, 'institute', 'rvm')`;
    await sql`
      INSERT INTO worker_institute_links
        (worker_id, institute_code, student_ref, status, linked_at, synced_at)
      VALUES (${ids.linkedPending}::uuid, 'rvm', ${randomUUID()}, 'active', now(), now())`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      for (const id of Object.values(ids)) {
        await client.sql`DELETE FROM workers WHERE id = ${id}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("keeps the never-signed-in linked row out of the funnel cohort, legacy pending in", async () => {
    const cohort = await cohortIds();
    expect(cohort).not.toContain(ids.linkedPending);
    expect(cohort).toContain(ids.legacyPending);
    expect(cohort).toContain(ids.active);
  });

  it("gives the never-signed-in linked row no journey", async () => {
    expect(await journey.findWorkerCore(ids.linkedPending)).toBeUndefined();
    expect(await journey.findWorkerCore(ids.legacyPending)).toBeDefined();
  });

  it("counts the legacy pending row in the dashboard and not the linked one", async () => {
    expect((await pendingCount()) - pendingBefore).toBe(1);
  });

  it("labels the actively linked row rvm and filters on it", async () => {
    const linked = await search(true);
    expect(linked.rows.map((r) => r.workerId)).toContain(ids.linkedPending);
    expect(new Set(linked.rows.map((r) => r.instituteCode))).toEqual(new Set(["rvm"]));

    const others = await search(false);
    const otherIds = others.rows.map((r) => r.workerId);
    expect(otherIds).toContain(ids.active);
    expect(otherIds).not.toContain(ids.linkedPending);
    expect(new Set(others.rows.map((r) => r.instituteCode))).toEqual(new Set([null]));
  });

  it("drops the label at once when the link is withdrawn", async () => {
    await client.sql`
      UPDATE worker_institute_links SET status = 'withdrawn', withdrawn_at = now()
      WHERE worker_id = ${ids.linkedPending}::uuid`;
    const row = (await search()).rows.find((r) => r.workerId === ids.linkedPending);
    expect(row?.instituteCode).toBeNull();
  });

  it("brings him into the cohort and the journey at his first sign-in", async () => {
    await client.sql`UPDATE workers SET status = 'active' WHERE id = ${ids.linkedPending}::uuid`;
    expect(await cohortIds()).toContain(ids.linkedPending);
    expect(await journey.findWorkerCore(ids.linkedPending)).toBeDefined();
  });
});
