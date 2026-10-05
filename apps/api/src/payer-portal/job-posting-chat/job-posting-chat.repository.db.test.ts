import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  createDbClient,
  jobPostings,
  payerJobPostingChatSessions,
  payers,
  type Database,
  type DbClient,
} from "@badabhai/db";
import { JobPostingChatRepository } from "./job-posting-chat.repository";

/**
 * #1922 (R52) — A MESSAGE TURN RACING A PUBLISH, AGAINST A REAL POSTGRES.
 *
 * `postMessage` reads the session as live, then waits seconds on the ai-service. A publish
 * can claim the session in that window. Before #1922 the late `saveTurn` wrote `active` /
 * `draft_ready` over `published`, the session was live again, and a second publish created a
 * second posting and overwrote `published_job_posting_id`.
 *
 * `job-posting-chat.repository.test.ts` proves the two WHERE clauses SAY the right thing.
 * Only a database can prove they EVALUATE that way:
 *
 *   - a turn that lands after the claim (before OR after the bind) writes nothing, and the
 *     session stays published, bound and unchanged;
 *   - a turn already queued on the claim's row lock re-reads the row when the claim commits
 *     and writes nothing (two connections, a genuine lock wait, not a pipelined fake);
 *   - a second claim fails, and even a bound session put back to a live status by some other
 *     writer cannot be claimed again (the `published_job_posting_id IS NULL` guard);
 *   - an `abandoned` session takes no turn and cannot be claimed (both read the live list);
 *   - CONTROL: live sessions still take turns, and a released claim reopens the session.
 *
 * The fixtures are one payer and one posting with placeholder text (no PII), tagged per run.
 * The payer delete cascades the sessions; the postings are deleted explicitly (no FK to payers).
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test job-posting-chat.repository.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it
 * EXECUTED rather than skipped.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** Unique to this run, so a re-run against a dirty local database cannot collide. */
const TAG = randomUUID().slice(0, 8);

const STATE_STORED = { turn_count: 4, answered_topics: ["role_title"] };
const DRAFT_STORED = { role_title: "CNC Operator", skills: [] };
const STATE_LATE = { turn_count: 5, answered_topics: [] };
const DRAFT_LATE = { role_title: null, skills: [] };

describe.skipIf(!RUN)("#1922 job-posting chat — a turn racing a publish, against Postgres", () => {
  // THREE clients. `client` seeds, reads and observes; `clientA` holds the claim's open
  // transaction; `clientB` runs the turn that queues behind it. postgres.js pipelines one
  // connection, so a single client could never put the turn into a real lock wait.
  let client!: DbClient;
  let clientA!: DbClient;
  let clientB!: DbClient;
  let repo!: JobPostingChatRepository;
  let repoB!: JobPostingChatRepository;
  let payerId!: string;
  const postingIds: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    clientA = createDbClient(DATABASE_URL, { max: 1 });
    clientB = createDbClient(DATABASE_URL, { max: 1 });
    repo = new JobPostingChatRepository(client.db);
    repoB = new JobPostingChatRepository(clientB.db);

    const [row] = await client.db
      .insert(payers)
      .values({
        role: "employer",
        emailEnc: "jpc-race-db-test",
        emailHash: `jpc-race-db-test-${TAG}`,
        orgNameEnc: "jpc-race-db-test",
      })
      .returning({ id: payers.id });
    payerId = row!.id;
  });

  afterAll(async () => {
    if (client === undefined) return;
    // Sessions go with their payer (ON DELETE CASCADE); postings have no FK to payers.
    if (payerId) await client.db.delete(payers).where(eq(payers.id, payerId));
    if (postingIds.length) {
      await client.db.delete(jobPostings).where(inArray(jobPostings.id, postingIds));
    }
    await Promise.all([client, clientA, clientB].map((c) => c?.sql.end({ timeout: 5 })));
  });

  /** A session that has taken one stored turn and is ready to publish. */
  async function readySession(): Promise<{ id: string; lastMessageAt: Date }> {
    const session = await repo.createSession(payerId);
    const lastMessageAt = new Date("2026-10-03T10:00:00.000Z");
    const stored = await repo.saveTurn(session.id, payerId, {
      conversationState: STATE_STORED,
      draft: DRAFT_STORED,
      status: "draft_ready",
      lastMessageAt,
    });
    expect(stored).toBe(true);
    return { id: session.id, lastMessageAt };
  }

  /** The posting a publish would have created, so the bind has a real row to point at. */
  async function createPosting(): Promise<string> {
    const [row] = await client.db
      .insert(jobPostings)
      .values({
        createdBy: payerId,
        payerId,
        orgLabel: "jpc-race-db-test",
        roleTitle: "jpc-race-db-test",
        vacancyBand: "2-5",
      })
      .returning({ id: jobPostings.id });
    postingIds.push(row!.id);
    return row!.id;
  }

  async function readSession(id: string) {
    const [row] = await client.db
      .select()
      .from(payerJobPostingChatSessions)
      .where(eq(payerJobPostingChatSessions.id, id));
    return row!;
  }

  /** The late turn: a #1911 re-ask, which writes `active` — the case the issue names. */
  const lateTurn = () => ({
    conversationState: STATE_LATE,
    draft: DRAFT_LATE,
    status: "active" as const,
    lastMessageAt: new Date("2026-10-03T10:05:00.000Z"),
  });

  /**
   * Poll from the observer connection until a backend IN THIS DATABASE is waiting on a lock
   * with an UPDATE of the sessions table, so another database on a shared server cannot
   * satisfy the wait. Same probe as `general-form-mark.db.test.ts`.
   */
  async function waitForTurnToQueue(): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const rows = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE 'update "payer_job_posting_chat_sessions"%'`;
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the turn never queued behind the claim's row lock");
  }

  it("a turn that lands after the claim, before or after the bind, writes nothing; a second claim fails", async () => {
    const session = await readySession();
    const claimedAt = new Date("2026-10-03T10:01:00.000Z");

    const claimed = await repo.claimForPublish(session.id, payerId, claimedAt);
    expect(claimed?.status).toBe("published");

    // Between the claim and the bind: the posting is being created, nothing is bound yet.
    await expect(repo.saveTurn(session.id, payerId, lateTurn())).resolves.toBe(false);

    const posting = await createPosting();
    await repo.bindPublishedPosting(session.id, payerId, posting);

    // After the bind: every turn shape, including a blocked turn's activity-clock write.
    await expect(repo.saveTurn(session.id, payerId, lateTurn())).resolves.toBe(false);
    await expect(
      repo.saveTurn(session.id, payerId, { ...lateTurn(), status: "draft_ready" }),
    ).resolves.toBe(false);
    await expect(
      repo.saveTurn(session.id, payerId, { lastMessageAt: new Date("2026-10-03T10:06:00Z") }),
    ).resolves.toBe(false);

    // The session is exactly as the publish left it: published, bound, and holding the
    // last STORED turn's state, draft and clock — none of the late turn's.
    const row = await readSession(session.id);
    expect(row.status).toBe("published");
    expect(row.publishedJobPostingId).toBe(posting);
    expect(row.endedAt?.getTime()).toBe(claimedAt.getTime());
    expect(row.conversationState).toEqual(STATE_STORED);
    expect(row.draft).toEqual(DRAFT_STORED);
    expect(row.lastMessageAt?.getTime()).toBe(session.lastMessageAt.getTime());

    // So a second publish loses the claim and creates nothing.
    await expect(repo.claimForPublish(session.id, payerId, new Date())).resolves.toBeUndefined();
    expect((await readSession(session.id)).publishedJobPostingId).toBe(posting);
  });

  it("a turn queued on the claim's row lock re-reads the row when the claim commits, and writes nothing", async () => {
    const session = await readySession();
    let turn: Promise<boolean> | undefined;

    await clientA.db.transaction(async (tx) => {
      const claimed = await new JobPostingChatRepository(tx as unknown as Database).claimForPublish(
        session.id,
        payerId,
        new Date(),
      );
      expect(claimed?.status).toBe("published");
      // The claim holds the row lock until COMMIT. The turn, read as live seconds ago, now
      // queues behind it on a second connection, and this waits until Postgres reports it so.
      turn = repoB.saveTurn(session.id, payerId, lateTurn());
      await waitForTurnToQueue();
    });

    // On COMMIT the waiting UPDATE re-checks its WHERE against the claimed row: no match.
    await expect(turn).resolves.toBe(false);
    const row = await readSession(session.id);
    expect(row.status).toBe("published");
    expect(row.conversationState).toEqual(STATE_STORED);
    await expect(repo.claimForPublish(session.id, payerId, new Date())).resolves.toBeUndefined();
  });

  it("a bound session put back to a live status by any other writer still cannot be claimed again", async () => {
    const session = await readySession();
    await repo.claimForPublish(session.id, payerId, new Date());
    const posting = await createPosting();
    await repo.bindPublishedPosting(session.id, payerId, posting);

    // What the pre-#1922 `saveTurn` did: status back to live with the posting still bound.
    await client.db
      .update(payerJobPostingChatSessions)
      .set({ status: "draft_ready" })
      .where(eq(payerJobPostingChatSessions.id, session.id));

    // The status is live again, so only the `published_job_posting_id IS NULL` guard stands
    // between this and a second posting.
    await expect(repo.claimForPublish(session.id, payerId, new Date())).resolves.toBeUndefined();
    const row = await readSession(session.id);
    expect(row.publishedJobPostingId).toBe(posting);
    expect(row.status).toBe("draft_ready");
  });

  it("an abandoned session takes no turn and cannot be claimed: both writes read the live list", async () => {
    const session = await readySession();
    // Nothing writes `abandoned` today (STATE_MACHINES §18); a future sweep would.
    await client.db
      .update(payerJobPostingChatSessions)
      .set({ status: "abandoned" })
      .where(eq(payerJobPostingChatSessions.id, session.id));

    await expect(repo.saveTurn(session.id, payerId, lateTurn())).resolves.toBe(false);
    await expect(repo.claimForPublish(session.id, payerId, new Date())).resolves.toBeUndefined();
    const row = await readSession(session.id);
    expect(row.status).toBe("abandoned");
    expect(row.conversationState).toEqual(STATE_STORED);
    expect(row.endedAt).toBeNull();
  });

  it("CONTROL: live sessions take turns, and a released claim reopens the session for turns and a re-claim", async () => {
    const session = await readySession();

    // `draft_ready` is live: a re-ask still writes, back to `active` (#1911).
    await expect(repo.saveTurn(session.id, payerId, lateTurn())).resolves.toBe(true);
    // `active` is live.
    await expect(
      repo.saveTurn(session.id, payerId, { lastMessageAt: new Date("2026-10-03T10:07:00Z") }),
    ).resolves.toBe(true);
    expect((await readSession(session.id)).status).toBe("active");

    // The create failed: the claim is released, nothing was bound, the payer carries on.
    expect(await repo.claimForPublish(session.id, payerId, new Date())).toBeDefined();
    await repo.releasePublishClaim(session.id, payerId, "active");
    await expect(repo.saveTurn(session.id, payerId, lateTurn())).resolves.toBe(true);
    const reclaimed = await repo.claimForPublish(session.id, payerId, new Date());
    expect(reclaimed?.status).toBe("published");
  });
});
