import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  chatMessages,
  chatSessions,
  createDbClient,
  events,
  workerConsents,
  workers,
  type Database,
  type DbClient,
} from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import type { ConsentPurpose } from "@badabhai/types";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import { ConsentRepository } from "../../consent/consent.repository";
import { WorkersRepository } from "../../workers/workers.repository";
import {
  FREE_CHAT_AI_TASKS,
  assertReadOnlyTransaction,
  drawFreeChatSample,
  readProbeEvents,
  type LinkRef,
} from "./free-chat-probe";
import {
  PROBE_TRANSACTION_BOUNDS,
  isSampleEligible,
  latestConsentState,
  readKnownName,
} from "./free-chat-probe.cli";
import { FreeChatProbeRepository } from "./free-chat-probe.repository";

/**
 * The free-chat probe's SQL against a REAL Postgres (ADR-0051 §10, #2128).
 *
 * The unit suites prove the decisions; only a database proves the reads. The first run of this file
 * found a defect no fake could: drizzle's postgres-js driver passes `timestamptz[]` parameters through
 * unserialized, so the link count threw on its first call. Here:
 *   - the transaction the CLI opens IS read-only (the server says `on`, refuses a write with 25006)
 *     and carries the CLI's statement, lock and idle bounds;
 *   - a struggled turn links to its OWN flushed line and the bot line before it — never the turn's own
 *     reply (same `created_at`), an unflagged interview line, or another session's line;
 *   - a link must be PROVEN: exactly one candidate line, AND the session's flagged lines balance its
 *     non-greeting served turns up to the previous turn. Overlapping sends (two, or a chain of three),
 *     a slow turn overtaken, a chip no-op, or an empty line beside a neighbour's all make the turn
 *     AMBIGUOUS, and no text is read for it; the greeting, which has no line, never unbalances it;
 *   - the previous-turn bound is read from the events table, so it holds across the window's start;
 *   - R36 eligibility reads the LATEST consent row (by `accepted_at`) and the deletion flag.
 *
 * EVERY SEEDING TRANSACTION IS ROLLED BACK — nothing is committed, so nothing needs cleaning up and
 * a failed run leaves nothing behind. Fabricated rows only; the target must be LOCAL.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *   pnpm db:migrate     (against a local database)
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test free-chat-probe.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i;

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "free-chat-probe-db-test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);

/** The CLI's transaction options, verbatim. */
const READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

class Rollback extends Error {}

/** A fixed instant far from any real row, so a dev database's own events cannot fall in the window. */
const t = (seconds: number) => new Date(Date.UTC(2031, 0, 1, 10, 0, 0) + seconds * 1000);
const FREE_CHAT = { free_chat: true };

/** A fabricated worker with a name, and helpers that write one session's rows. */
async function seedWorker(db: Database, opts: { deletionScheduledAt?: Date } = {}) {
  const workerId = randomUUID();
  await db.insert(workers).values({
    id: workerId,
    phoneE164: pii.encrypt("+919000000001"),
    phoneHash: pii.hashPhone(`+91-${randomUUID()}`),
    fullName: pii.encrypt("Suresh Kumar"),
    deletionScheduledAt: opts.deletionScheduledAt ?? null,
  });
  /** One `worker_consents` row (the table is append-only; the LATEST by `accepted_at` rules). */
  const consent = (purposes: ConsentPurpose[], acceptedAt: Date, revokedAt: Date | null = null) =>
    db
      .insert(workerConsents)
      .values({ workerId, consentVersion: "fabricated-v1", purposes, acceptedAt, revokedAt });
  const session = async () => {
    const sessionId = randomUUID();
    await db.insert(chatSessions).values({ id: sessionId, workerId });
    return sessionId;
  };
  const line = (
    sessionId: string,
    direction: "inbound" | "outbound",
    bodyText: string | null,
    at: Date,
    metadata: Record<string, unknown> = FREE_CHAT,
  ) =>
    db
      .insert(chatMessages)
      .values({ sessionId, workerId, direction, bodyText, metadata, createdAt: at });
  const turnPayload = (sessionId: string) => ({
    worker_id: workerId,
    session_id: sessionId,
    mode: "resume",
    category: "unclear",
    decided_by: "classifier",
    confidence_bucket: "lt50",
    outcome: "clarify",
    refusal_topic: null,
    strike_count: null,
    cooldown_started: false,
    nudge: false,
    submission_id: null,
  });
  const event = (
    eventName: string,
    sessionId: string,
    occurredAt: Date,
    payload: object,
    eventVersion = 1,
  ) =>
    db.insert(events).values({
      eventName,
      eventVersion,
      occurredAt,
      actorType: "worker",
      actorId: workerId,
      subjectType: "chat_session",
      subjectId: sessionId,
      correlationId: randomUUID(),
      payload,
    });
  const turn = (sessionId: string, at: Date) =>
    event("chat.free_chat_turn_served", sessionId, at, turnPayload(sessionId));
  return { workerId, session, line, turn, event, turnPayload, consent };
}

describe.skipIf(!RUN)("free-chat probe — the reads, against Postgres", () => {
  let client: DbClient;

  beforeAll(() => {
    if (!LOCAL_HOST.test(new URL(DATABASE_URL).hostname)) {
      throw new Error(
        "free-chat-probe.db seeds rows (rolled back); it runs against a LOCAL database only",
      );
    }
    client = createDbClient(DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  /** Run `body` in a transaction that is ALWAYS rolled back. */
  async function rolledBack(body: (db: Database) => Promise<void>): Promise<void> {
    await expect(
      client.db.transaction(async (tx) => {
        await body(tx as unknown as Database);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it("opens a read-only transaction with the CLI's bounds, and it refuses a write", async () => {
    let refused: unknown = null;
    await client.db
      .transaction(async (tx) => {
        const repo = new FreeChatProbeRepository(tx as unknown as Database);
        assertReadOnlyTransaction(await repo.transactionReadOnly());
        await repo.boundTransaction(PROBE_TRANSACTION_BOUNDS);
        const rows = await tx.execute(sql`select
          current_setting('statement_timeout') as statement,
          current_setting('lock_timeout') as lock,
          current_setting('idle_in_transaction_session_timeout') as idle`);
        expect((rows as unknown as Record<string, string>[])[0]).toEqual({
          statement: "1min",
          lock: "5s",
          idle: "2min",
        });
        await tx.execute(sql`update chat_sessions set status = status where false`).catch((err) => {
          refused = err;
          throw err;
        });
      }, READ_ONLY)
      .catch(() => undefined);
    expect((refused as { cause?: { code?: string } } | null)?.cause?.code).toBe("25006");
  });

  it("reads `off` in an ordinary transaction, which the probe's assertion refuses", async () => {
    await rolledBack(async (db) => {
      const setting = await new FreeChatProbeRepository(db).transactionReadOnly();
      expect(setting).toBe("off");
      expect(() => assertReadOnlyTransaction(setting)).toThrow(/not read-only/);
    });
  });

  it("links a struggled turn to its own line and the bot line before it — nothing else", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      await w.consent(["profiling", "resume_generation"], t(-100));
      const sessionId = await w.session();
      const otherSession = await w.session();
      await w.line(sessionId, "outbound", "{{worker_name}} ji, aap kya kaam karte ho?", t(0), {});
      // The struggled turn: the worker's line and its reply share the turn's clock.
      await w.line(sessionId, "inbound", "suresh hoon, pata nahi", t(10));
      await w.line(sessionId, "outbound", "Pehle resume, phir baat.", t(10));
      // An interview answer (unflagged) and another session's free-chat line: never candidates.
      await w.line(sessionId, "inbound", "interview answer", t(20), {});
      await w.line(otherSession, "inbound", "other session", t(24));
      await w.turn(sessionId, t(12));
      // No free-chat line of its own in (t12, t25]: links to nothing, never borrows t(10).
      await w.turn(sessionId, t(25));
      await w.event("chat.free_chat_turn_served", sessionId, t(26), w.turnPayload(sessionId), 2);
      await w.event(
        "ai.cost_recorded",
        sessionId,
        t(12),
        costPayload(w.workerId, sessionId, "profiling_free_classify"),
      );
      await w.event(
        "ai.cost_recorded",
        sessionId,
        t(12),
        costPayload(w.workerId, sessionId, "profile_parse"),
      );

      const window = { since: t(-1), until: t(1000) };
      const turns = readProbeEvents(
        "chat.free_chat_turn_served",
        await repo.eventsInWindow("chat.free_chat_turn_served", window),
      );
      expect(turns.events).toHaveLength(2);
      expect(turns.otherVersions).toBe(1);
      expect(turns.events.every((e) => e.occurredAt instanceof Date)).toBe(true);
      const costs = readProbeEvents(
        "ai.cost_recorded",
        await repo.costEventsInWindow(window, FREE_CHAT_AI_TASKS),
      );
      expect(costs.events.map((e) => e.payload.task_type)).toEqual(["profiling_free_classify"]);

      const workersRepo = new WorkersRepository(db);
      const consents = latestConsentState(new ConsentRepository(db));
      const sample = await drawFreeChatSample(turns.events, 5, {
        eligible: (id) => isSampleEligible(workersRepo, consents, id),
        linkedLines: (refs) => repo.linkedLines(refs),
        linkCounts: (refs) => repo.linkCounts(refs),
        knownName: (id) => readKnownName(workersRepo, pii, id),
      });
      expect(sample).toMatchObject({ struggled: 2, noLinkedText: 1, ambiguous: 0, examined: 2 });
      expect(sample.workerDrops.no_linked_text).toBe(1);
      expect(sample.entries).toEqual([
        {
          ordinal: 1,
          turn: {
            mode: "resume",
            category: "unclear",
            decided_by: "classifier",
            confidence_bucket: "lt50",
            outcome: "clarify",
          },
          bot: { kind: "shown", text: "[NAME] ji, aap kya kaam karte ho?" },
          worker: "[NAME] hoon, pata nahi",
        },
      ]);
    });
  });

  it("makes a turn AMBIGUOUS when two of the worker's lines lie in its span — overlapping sends", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const sessionId = await w.session();
      // X sent at t0, Y at t1 while X was still being answered; X's event at t3, Y's at t4.
      await w.line(sessionId, "inbound", "first message", t(0));
      await w.line(sessionId, "inbound", "second message", t(1));
      await w.turn(sessionId, t(3));
      await w.turn(sessionId, t(4));
      const refs: LinkRef[] = [
        { sessionId, occurredAt: t(3) },
        { sessionId, occurredAt: t(4) },
      ];
      // X's span holds both lines: ambiguous, NOT Y's text. Y's span (t3, t4] holds none.
      expect(await repo.linkedLines(refs)).toEqual([{ kind: "ambiguous" }, { kind: "none" }]);
      expect(await repo.linkCounts(refs)).toEqual({ none: 1, ambiguous: 1 });
    });
  });

  it("counts an EMPTY candidate too, so a neighbour's text never stands in for it", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const both = await w.session();
      await w.line(both, "inbound", "neighbour's words", t(0));
      await w.line(both, "inbound", null, t(2));
      await w.turn(both, t(5));
      const alone = await w.session();
      await w.line(alone, "inbound", "   ", t(2));
      await w.turn(alone, t(5));
      const refs: LinkRef[] = [
        { sessionId: both, occurredAt: t(5) },
        { sessionId: alone, occurredAt: t(5) },
      ];
      // A lone blank line IS the turn's own: linked, and returned as stored — the blank rule is the
      // mask's, in JavaScript (the sampler counts it `no_linked_text`).
      expect(await repo.linkedLines(refs)).toEqual([
        { kind: "ambiguous" },
        { kind: "linked", messageId: expect.any(String), workerText: "   ", botText: null },
      ]);
      expect(await repo.linkCounts(refs)).toEqual({ none: 0, ambiguous: 1 });
    });
  });

  it("B1 chain — B never prints C's line when three sends overlap", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const s = await w.session();
      // A sent t0 (event t4), B sent t3 (event t7), C sent t6 (event t10).
      await w.line(s, "inbound", "message A", t(0));
      await w.line(s, "inbound", "message B", t(3));
      await w.line(s, "inbound", "message C", t(6));
      await w.turn(s, t(4));
      await w.turn(s, t(7));
      await w.turn(s, t(10));
      const refs: LinkRef[] = [t(4), t(7), t(10)].map((at) => ({ sessionId: s, occurredAt: at }));
      // B's span (t4, t7] holds only C's line — but A's and B's lines both sit at or before t4 against
      // one turn, so the balance fails and B is AMBIGUOUS, not C's text under B's label.
      expect(await repo.linkedLines(refs)).toEqual([
        { kind: "ambiguous" },
        { kind: "ambiguous" },
        { kind: "none" },
      ]);
      expect(await repo.linkCounts(refs)).toEqual({ none: 1, ambiguous: 2 });
    });
  });

  it("B1 slow turn overtaken — A never prints C's (fabricated distress) line", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const s = await w.session();
      // A sent t0, answered slowly (its fallback event at t10.1); B sent t3, answered at t3.1; C sent
      // t5 and has no event yet. A's span (t3.1, t10.1] holds only C's line.
      await w.line(s, "inbound", "message A", t(0));
      await w.line(s, "inbound", "message B", t(3));
      await w.line(s, "inbound", "fabricated distress line C", t(5));
      await w.turn(s, t(3.1));
      await w.turn(s, t(10.1));
      const [link] = await repo.linkedLines([{ sessionId: s, occurredAt: t(10.1) }]);
      expect(link).toEqual({ kind: "ambiguous" });
    });
  });

  it("L1 — a LOST line cannot cancel an overtaking send: the first imbalance poisons the session", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const s = await w.session();
      // An earlier served turn whose line never reached chat_messages (lost write, corrupt buffer, cap).
      await w.turn(s, t(-10));
      // Then the "slow turn overtaken" sequence: A sent t0 (event t10.1), B sent t3 (event t3.1), C
      // sent t5 with no event yet. At t3.1 the lines (A, B) and turns (lost, B) count 2 = 2 — a single
      // balance check there passes, and A's only candidate is C's line.
      await w.line(s, "inbound", "message A", t(0));
      await w.line(s, "inbound", "message B", t(3));
      await w.line(s, "inbound", "fabricated distress line C", t(5));
      await w.turn(s, t(3.1));
      await w.turn(s, t(10.1));
      const [link] = await repo.linkedLines([{ sessionId: s, occurredAt: t(10.1) }]);
      expect(link).toEqual({ kind: "ambiguous" });
      expect(await repo.linkCounts([{ sessionId: s, occurredAt: t(10.1) }])).toEqual({
        none: 0,
        ambiguous: 1,
      });
    });
  });

  it("a chip no-op (a flagged line with no event) refuses that turn AND every later one", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const s = await w.session();
      await w.line(s, "inbound", "first", t(0));
      await w.turn(s, t(1));
      await w.line(s, "inbound", "Haan, shuru karein", t(5)); // the no-op: no event
      await w.line(s, "inbound", "second", t(10));
      await w.turn(s, t(11));
      await w.line(s, "inbound", "third", t(20));
      await w.turn(s, t(21));
      const refs: LinkRef[] = [t(1), t(11), t(21)].map((at) => ({ sessionId: s, occurredAt: at }));
      const links = await repo.linkedLines(refs);
      expect(links[0]).toMatchObject({ kind: "linked", workerText: "first" });
      // (t1, t11] holds two lines; and from then on lines outnumber served turns.
      expect(links.slice(1)).toEqual([{ kind: "ambiguous" }, { kind: "ambiguous" }]);
    });
  });

  it("does not count the greeting — it has no worker line — so a greeted session still links", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const s = await w.session();
      await w.event("chat.free_chat_turn_served", s, t(0), {
        ...w.turnPayload(s),
        mode: "greeting",
        category: null,
        decided_by: "flow",
        confidence_bucket: null,
        outcome: "greeting",
      });
      await w.line(s, "inbound", "first", t(5));
      await w.turn(s, t(6));
      await w.line(s, "inbound", "second", t(10));
      await w.turn(s, t(11));
      const links = await repo.linkedLines(
        [t(6), t(11)].map((at) => ({ sessionId: s, occurredAt: at })),
      );
      expect(links).toEqual([
        expect.objectContaining({ kind: "linked", workerText: "first" }),
        expect.objectContaining({ kind: "linked", workerText: "second" }),
      ]);
      expect(new Set(links.map((l) => (l.kind === "linked" ? l.messageId : null))).size).toBe(2);
    });
  });

  it("R36 — eligibility reads the LATEST consent row and the deletion flag", async () => {
    await rolledBack(async (db) => {
      const workersRepo = new WorkersRepository(db);
      const consents = latestConsentState(new ConsentRepository(db));
      const eligible = (workerId: string) => isSampleEligible(workersRepo, consents, workerId);

      const revoked = await seedWorker(db);
      await revoked.consent(["profiling"], t(0), t(1));
      const noProfiling = await seedWorker(db);
      await noProfiling.consent(["resume_generation", "communication"], t(0));
      const deleting = await seedWorker(db, { deletionScheduledAt: t(50) });
      await deleting.consent(["profiling"], t(0));
      const reconsented = await seedWorker(db); // older revoked row, newer active one
      await reconsented.consent(["profiling"], t(0), t(1));
      await reconsented.consent(["profiling"], t(2));
      const laterRevoked = await seedWorker(db); // older active row, newer revoked one
      await laterRevoked.consent(["profiling"], t(0));
      await laterRevoked.consent(["profiling"], t(2), t(3));
      const never = await seedWorker(db);

      expect(await eligible(revoked.workerId)).toBe(false);
      expect(await eligible(noProfiling.workerId)).toBe(false);
      expect(await eligible(deleting.workerId)).toBe(false);
      expect(await eligible(reconsented.workerId)).toBe(true);
      expect(await eligible(laterRevoked.workerId)).toBe(false);
      expect(await eligible(never.workerId)).toBe(false);
      expect(await eligible(randomUUID())).toBe(false);
    });
  });

  it("reads the previous-turn bound from the events table, across the window's start", async () => {
    await rolledBack(async (db) => {
      const repo = new FreeChatProbeRepository(db);
      const w = await seedWorker(db);
      const sessionId = await w.session();
      // An earlier turn, BEFORE any window the probe would read, and its own line.
      await w.line(sessionId, "inbound", "earlier message", t(-5));
      await w.turn(sessionId, t(0));
      await w.line(sessionId, "inbound", "kya matlab", t(20));
      await w.turn(sessionId, t(30));
      // Only the t(30) turn is in a window starting at t(10) — its span is still (t0, t30].
      const [link] = await repo.linkedLines([{ sessionId, occurredAt: t(30) }]);
      expect(link).toEqual({
        kind: "linked",
        messageId: expect.any(String),
        workerText: "kya matlab",
        botText: null,
      });
    });
  });
});

function costPayload(workerId: string, sessionId: string, task_type: string) {
  return {
    ai_call_id: randomUUID(),
    request_id: null,
    ai_job_id: null,
    worker_id: workerId,
    session_id: sessionId,
    task_type,
    model: "fabricated-model",
    provider: "fabricated",
    real_call: true,
    tokens_in: 1,
    tokens_out: 1,
    estimated_cost_inr: 0.01,
    latency_ms: 700,
    cost_alert: false,
    above_target: false,
    success: true,
    error_code: null,
    failure_reason: null,
  };
}
