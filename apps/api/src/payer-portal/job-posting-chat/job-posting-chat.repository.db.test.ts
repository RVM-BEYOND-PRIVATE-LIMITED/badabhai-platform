import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  createDbClient,
  events,
  jobPostings,
  payerJobPostingChatSessions,
  payers,
  type Database,
  type DbClient,
} from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { sqlStateOf, PG_UNIQUE_VIOLATION } from "../../common/db-error";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { JobPostingsRepository } from "../../job-postings/job-postings.repository";
import { JobPostingsService } from "../../job-postings/job-postings.service";
import { PayersRepository } from "../../payers/payers.repository";
import { defaultModeResolver } from "../../payers/payer-tenant-scope.test-support";
import { JobPostingChatRepository } from "./job-posting-chat.repository";
import { JobPostingChatService } from "./job-posting-chat.service";

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
 * The second block is #1928 — a publish whose `job_posting.created` emit FAILS, run through the
 * real `JobPostingChatService.publish` and the real `JobPostingsService` (see its header).
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

/**
 * #1928 — A PUBLISH WHOSE `job_posting.created` EMIT FAILS, AGAINST A REAL POSTGRES.
 *
 * Before #1928, `JobPostingsService.insertAndEmit` committed the posting row on its own and
 * emitted afterwards, outside any transaction. A failed emit threw into `publish`, which released
 * the claim. The release is guarded on "nothing bound", and nothing was (the bind never ran), so
 * the session went live again, the retry created a SECOND posting, and the first had no
 * `job_posting.created` on the spine.
 *
 * The row and its event are now one transaction. A stubbed executor can only show that the code
 * passed `tx`. Only Postgres can show that the rollback takes the row with it.
 *
 * THE FAILURE IS A REAL POSTGRES ERROR on the events insert. It is raised inside the transaction
 * AFTER an event row was already written on it: the spy inserts the same event twice, and the
 * second insert violates `events.id`'s primary key (23505; `ON CONFLICT` arbitrates only the
 * idempotency key). So the rollback has to take the posting AND that event row.
 *
 * Everything on the path is real: `JobPostingChatService.publish`, `JobPostingsService`,
 * `EventsService` and all four repositories. Only the org-name decrypt is stubbed, because the
 * fixture payer's `org_name_enc` is a placeholder rather than ciphertext. The ai-service is never
 * reached: the draft has no skill phrases, a chat publish sends no `match_skill_ids`, and publish
 * makes no LLM call. Each case gets its own payer (placeholder text, no PII) and correlation id;
 * afterAll deletes the events by correlation, then the postings and the payers.
 */
describe.skipIf(!RUN)(
  "#1928 job-posting chat publish — a failed job_posting.created leaves no posting, against Postgres",
  () => {
    let client!: DbClient;
    let chat!: JobPostingChatRepository;
    let eventsRepo!: EventsRepository;
    let publisher!: JobPostingChatService;
    const payerIds: string[] = [];
    const correlationIds: string[] = [];

    beforeAll(async () => {
      // TWO connections, not one. A write that escaped the transaction then autocommits on the
      // other connection and is COUNTED below, rather than deadlocking a single connection and
      // surfacing as a timeout that says nothing about why.
      client = createDbClient(DATABASE_URL, { max: 2 });
      chat = new JobPostingChatRepository(client.db);
      eventsRepo = new EventsRepository(client.db);
      const eventsService = new EventsService(eventsRepo, { NODE_ENV: "test" } as never);
      // ADR-0053 — the default mode (off): the publishing payer is the posting's tenant.
      const tenancy = defaultModeResolver();
      const postings = new JobPostingsService(
        new JobPostingsRepository(client.db),
        eventsService,
        {} as never, // AiService — no skill phrases, so canonicalization returns before any call
        {} as never, // AiCostRecorder — likewise
        {} as never, // AiTraceRecorder — likewise
        {} as never, // PublishReachService — a create never materializes reach
        {} as never, // MatchSkillsService — a chat publish sends no match_skill_ids
        tenancy,
      );
      publisher = new JobPostingChatService(
        chat,
        eventsService,
        {} as never, // AiService — publish makes no LLM call
        {} as never,
        {} as never,
        new PayersRepository(client.db, {} as never),
        { decrypt: () => "Lane Test Works" } as never,
        postings,
        tenancy,
      );
    });

    afterAll(async () => {
      if (client === undefined) return;
      if (correlationIds.length) {
        await client.db.delete(events).where(inArray(events.correlationId, correlationIds));
      }
      if (payerIds.length) {
        // Postings have no FK to payers; the payer delete cascades the sessions.
        await client.db.delete(jobPostings).where(inArray(jobPostings.payerId, payerIds));
        await client.db.delete(payers).where(inArray(payers.id, payerIds));
      }
      await client.sql.end({ timeout: 5 });
    });

    /** A fresh payer whose session holds a publishable draft, plus a fresh correlation id. */
    async function readyToPublish(): Promise<{
      payerId: string;
      sessionId: string;
      ctx: RequestContext;
    }> {
      const [payer] = await client.db
        .insert(payers)
        .values({
          role: "employer",
          emailEnc: "jpc-1928-db-test",
          emailHash: `jpc-1928-db-test-${TAG}-${payerIds.length}`,
          orgNameEnc: "jpc-1928-db-test",
        })
        .returning({ id: payers.id });
      const payerId = payer!.id;
      payerIds.push(payerId);

      const session = await chat.createSession(payerId);
      const stored = await chat.saveTurn(session.id, payerId, {
        draft: { role_title: "CNC Operator", vacancy_band: "2-5", skills: [] },
        status: "draft_ready",
        lastMessageAt: new Date(),
      });
      expect(stored).toBe(true);

      const correlationId = randomUUID();
      correlationIds.push(correlationId);
      return {
        payerId,
        sessionId: session.id,
        ctx: { correlationId, requestId: `jpc-1928-${TAG}` },
      };
    }

    /** Fail the NEXT events insert with a real Postgres error, after its row is written on the tx. */
    function failNextEventInsert(): void {
      const real = eventsRepo.insert.bind(eventsRepo);
      vi.spyOn(eventsRepo, "insert").mockImplementationOnce(async (event, key, executor) => {
        await real(event, key, executor);
        return real(event, key, executor); // the same event_id again → 23505 on events.id
      });
    }

    const postingsOf = (payerId: string) =>
      client.db
        .select({ id: jobPostings.id })
        .from(jobPostings)
        .where(eq(jobPostings.payerId, payerId));

    const createdEventsFor = (ctx: RequestContext) =>
      client.db
        .select({ subjectId: events.subjectId })
        .from(events)
        .where(
          and(
            eq(events.correlationId, ctx.correlationId),
            eq(events.eventName, "job_posting.created"),
          ),
        );

    it("CONTROL: a publish whose emit succeeds commits ONE posting, bound, with its one job_posting.created", async () => {
      const { payerId, sessionId, ctx } = await readyToPublish();
      const res = await publisher.publish(payerId, sessionId, ctx);

      expect((await postingsOf(payerId)).map((p) => p.id)).toEqual([res.job_posting_id]);
      expect(await createdEventsFor(ctx)).toEqual([{ subjectId: res.job_posting_id }]);
      const session = await chat.findOwnedSession(sessionId, payerId);
      expect(session?.status).toBe("published");
      expect(session?.publishedJobPostingId).toBe(res.job_posting_id);
    });

    it("an events insert Postgres rejects inside the transaction takes the posting with it, and the session is released", async () => {
      const { payerId, sessionId, ctx } = await readyToPublish();
      failNextEventInsert();

      const err = await publisher.publish(payerId, sessionId, ctx).catch((e: unknown) => e);
      // The vacuity guard: the failure really is Postgres refusing the events insert.
      expect(sqlStateOf(err)).toBe(PG_UNIQUE_VIOLATION);

      // Before #1928 the posting had committed here, and the first event row had too.
      expect(await postingsOf(payerId)).toEqual([]);
      expect(await createdEventsFor(ctx)).toEqual([]);
      // The release is now correct: there is no posting for the session to be bound to.
      const session = await chat.findOwnedSession(sessionId, payerId);
      expect(session?.status).toBe("draft_ready");
      expect(session?.publishedJobPostingId).toBeNull();
      expect(session?.endedAt).toBeNull();
    });

    it("the retry after that failure creates exactly ONE posting; a further publish is a 409 and creates nothing", async () => {
      const { payerId, sessionId, ctx } = await readyToPublish();
      failNextEventInsert();
      await expect(publisher.publish(payerId, sessionId, ctx)).rejects.toThrow();

      const res = await publisher.publish(payerId, sessionId, ctx);
      expect((await postingsOf(payerId)).map((p) => p.id)).toEqual([res.job_posting_id]);
      expect(await createdEventsFor(ctx)).toEqual([{ subjectId: res.job_posting_id }]);

      await expect(publisher.publish(payerId, sessionId, ctx)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await postingsOf(payerId)).toHaveLength(1);
    });
  },
);
