import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENCY_TWIN_ORG_LABEL, AGENCY_TWIN_SYSTEM_ACTOR_ID } from "@badabhai/config";
import {
  createDbClient,
  syncAgencyTwin,
  syncAgencyTwinInTransaction,
  type AgencyTwinContext,
  type DbClient,
} from "@badabhai/db";
import { ApplicationsRepository } from "../applications/applications.repository";
import { JobsRepository } from "../jobs/jobs.repository";
import { AdminPostingsRepository } from "./admin-postings.repository";

/**
 * #2566 — the acceptance criteria that are properties of POSTGRES, not of the service:
 *
 *   - a HIDDEN posting (and agency job) is absent from the worker feed AND search, and
 *     unhide restores it;
 *   - the twin sync copies the hidden state + verification review, so a hidden agency job
 *     stays hidden after the sweep re-derives its twin;
 *   - the DB refuses a PARTIAL hidden state (all four columns together, or all NULL);
 *   - the new `jobs.verification_status` is pinned to the same closed set as postings.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-postings.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const WORKER_ID = randomUUID();
const CREATED_BY = randomUUID();
const SKILL = "mskill_vmc_operator";

describe.skipIf(!RUN)("#2566 hidden postings — against Postgres", () => {
  let client!: DbClient;
  let repo!: AdminPostingsRepository;
  let applications!: ApplicationsRepository;
  let jobs!: JobsRepository;

  const POSTING = randomUUID();
  const TWIN_SOURCE = randomUUID();
  let TWIN = "";

  const ctx: AgencyTwinContext = {
    matchV1Enabled: true,
    relatedSkillsDefault: "on",
    systemActorId: AGENCY_TWIN_SYSTEM_ACTOR_ID,
    orgLabel: AGENCY_TWIN_ORG_LABEL,
  };

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    repo = new AdminPostingsRepository(client.db);
    applications = new ApplicationsRepository(client.db);
    jobs = new JobsRepository(client.db);

    // A native company posting, published and visible.
    await client.sql`
      INSERT INTO job_postings
        (id, created_by, org_label, role_title, vacancy_band, status, published_at)
      VALUES
        (${POSTING}::uuid, ${CREATED_BY}::uuid, ${`org-${TAG}`},
         ${`Role ${TAG}`}, '1', 'open', now())`;

    // An agency job + its source payer, with a pick so the twin is servable.
    const agency = randomUUID();
    await client.sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${agency}::uuid, 'agent', ${`enc:${TAG}`}, ${`hash:${TAG}`},
              ${`enc:org-${TAG}`}, 'active')`;
    await client.sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, match_skill_ids)
      VALUES (${TWIN_SOURCE}::uuid, 'machine_operator', ${`Agency ${TAG}`}, 'Pune',
              'open', ${agency}::uuid, ${JSON.stringify([SKILL])}::jsonb)`;

    const outcome = await syncAgencyTwin(client.db, TWIN_SOURCE, ctx, { apply: true });
    if (outcome.kind !== "written" || outcome.jobPostingId === null) {
      throw new Error(`fixture twin was not created: ${outcome.kind}`);
    }
    TWIN = outcome.jobPostingId;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      if (TWIN) {
        await client.sql`DELETE FROM job_reach WHERE job_posting_id = ${TWIN}::uuid`;
        await client.sql`DELETE FROM job_postings WHERE id = ${TWIN}::uuid`;
      }
      await client.sql`DELETE FROM job_reach WHERE job_posting_id = ${POSTING}::uuid`;
      await client.sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
      await client.sql`DELETE FROM jobs WHERE id = ${TWIN_SOURCE}::uuid`;
      await client.sql`DELETE FROM payers WHERE org_name_enc = ${`enc:org-${TAG}`}`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  const feedIds = async (): Promise<string[]> => {
    const rows = await applications.findOpenPostingsForFeed(WORKER_ID, 200, {
      wantedSkillIds: [],
    });
    return rows.map((r) => r.id);
  };

  const searchIds = async (): Promise<string[]> => {
    const { rows } = await jobs.searchOpenPostings({
      workerId: WORKER_ID,
      q: null,
      profileSkillIds: [],
      city: null,
      state: null,
      limit: 200,
      offset: 0,
    });
    return rows.map((r) => r.id);
  };

  it("a visible posting is served by the feed and search", async () => {
    expect(await feedIds()).toContain(POSTING);
    expect(await searchIds()).toContain(POSTING);
  });

  it("hide removes a posting from the feed, search and direct reads; unhide restores all three", async () => {
    const hiddenAt = new Date();
    await repo.withTransaction(async (tx) => {
      const row = await repo.hidePosting(
        POSTING,
        {
          hiddenAt,
          hiddenBy: CREATED_BY,
          hiddenReasonCode: "misleading",
          hiddenReasonText: "Pay band in the title does not match the posting",
        },
        tx,
      );
      expect(row?.hiddenAt?.getTime()).toBe(hiddenAt.getTime());
    });

    expect(await feedIds()).not.toContain(POSTING);
    expect(await searchIds()).not.toContain(POSTING);
    expect(await jobs.findWorkerVisibleJobById(POSTING)).toBeUndefined();
    expect(await applications.findOpenPostingRef(POSTING)).toBeUndefined();

    await repo.withTransaction(async (tx) => {
      expect(await repo.unhidePosting(POSTING, tx)).toBeDefined();
    });
    expect(await feedIds()).toContain(POSTING);
    expect(await searchIds()).toContain(POSTING);
    expect(await jobs.findWorkerVisibleJobById(POSTING)).toBeDefined();
    expect(await applications.findOpenPostingRef(POSTING)).toBeDefined();
  });

  const legacyFeedIds = async (): Promise<string[]> => {
    const rows = await applications.findOpenJobs(WORKER_ID, 500);
    return rows.map((r) => r.id);
  };

  it("hiding the agency SOURCE drops it from the jobs feed, hides its twin via the in-tx sync, and search drops the twin", async () => {
    // While the source is open the union serves the SOURCE (jobs arm) and holds the twin back
    // (guard 4); search serves the twin row directly. Both must lose it when the source hides.
    expect(await legacyFeedIds()).toContain(TWIN_SOURCE);
    expect(await searchIds()).toContain(TWIN);

    await repo.withTransaction(async (tx) => {
      await repo.hideJob(
        TWIN_SOURCE,
        {
          hiddenAt: new Date(),
          hiddenBy: CREATED_BY,
          hiddenReasonCode: "policy_violation",
          hiddenReasonText: "Agency job carries a direct contact number in the description",
        },
        tx,
      );
      await syncAgencyTwinInTransaction(tx, TWIN_SOURCE, ctx);
    });

    const [twin] = await client.sql<{ hidden_at: Date | null; hidden_by: string | null }[]>`
      SELECT hidden_at, hidden_by FROM job_postings WHERE id = ${TWIN}::uuid`;
    expect(twin?.hidden_at).not.toBeNull();
    expect(twin?.hidden_by).toBe(CREATED_BY);
    expect(await legacyFeedIds()).not.toContain(TWIN_SOURCE);
    expect(await searchIds()).not.toContain(TWIN);
    // Guard 4 still holds the copy back (source open), so hiding cannot surface it either.
    expect(await feedIds()).not.toContain(TWIN);
    expect(await jobs.findWorkerVisibleJobById(TWIN_SOURCE)).toBeUndefined();
    expect(await jobs.findWorkerVisibleJobById(TWIN)).toBeUndefined();

    // Unhide the source → the same sync clears the twin and both surfaces serve it again.
    await repo.withTransaction(async (tx) => {
      await repo.unhideJob(TWIN_SOURCE, tx);
      await syncAgencyTwinInTransaction(tx, TWIN_SOURCE, ctx);
    });
    const [shown] = await client.sql<{ hidden_at: Date | null }[]>`
      SELECT hidden_at FROM job_postings WHERE id = ${TWIN}::uuid`;
    expect(shown?.hidden_at).toBeNull();
    expect(await legacyFeedIds()).toContain(TWIN_SOURCE);
    expect(await searchIds()).toContain(TWIN);
  });

  it("the twin sync copies the verification review onto the synced copy", async () => {
    await repo.withTransaction(async (tx) => {
      await repo.setJobVerification(TWIN_SOURCE, "unverified", "verified", tx);
      await syncAgencyTwinInTransaction(tx, TWIN_SOURCE, ctx);
    });
    const [twin] = await client.sql<{ verification_status: string }[]>`
      SELECT verification_status FROM job_postings WHERE id = ${TWIN}::uuid`;
    expect(twin?.verification_status).toBe("verified");
  });

  it("a PARTIAL hidden state is refused by both tables", async () => {
    await expect(
      client.sql`UPDATE job_postings SET hidden_at = now() WHERE id = ${POSTING}::uuid`,
    ).rejects.toThrow(/job_postings_hidden_state_chk/);
    await expect(
      client.sql`UPDATE jobs SET hidden_reason_code = 'spam' WHERE id = ${TWIN_SOURCE}::uuid`,
    ).rejects.toThrow(/jobs_hidden_state_chk/);
  });

  it("jobs.verification_status is pinned to the same closed set", async () => {
    await expect(
      client.sql`UPDATE jobs SET verification_status = 'approved' WHERE id = ${TWIN_SOURCE}::uuid`,
    ).rejects.toThrow(/jobs_verification_status_chk/);
  });
});
