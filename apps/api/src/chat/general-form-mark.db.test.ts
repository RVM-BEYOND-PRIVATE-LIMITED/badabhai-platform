import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { chatSessions, createDbClient, workerProfiles, workers, type DbClient } from "@badabhai/db";

import { ChatCompanionPolicy } from "../chat-companion/chat-companion.policy";
import { ChatCompanionRepository } from "../chat-companion/chat-companion.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { ChatRepository } from "./chat.repository";

/**
 * TD145 — a re-driven general-handover flush keeps the general form's completion mark, against a
 * REAL Postgres. Every claim here is a property of the statement the database runs: the JSONB
 * merge, the absent-not-null key, and the re-evaluation of the SET against a row that changed
 * while the UPDATE waited for its lock. A stubbed drizzle handle can only show the SQL was asked
 * for.
 *
 * THE DEFECT. A general handover whose flush FAILED stays `active`; the worker finishes the form
 * against it (`markGeneralFormCompleted`), then the re-driven flush (`endSession`) replaced the
 * whole `conversation_state` — erasing the mark — and stamped `ended_at` after his confirmation.
 * `ChatCompanionPolicy` rule 4 then read an unfinished handover that closed after the
 * confirmation, with no résumé generated since, and kept him in the interview.
 *
 * Run it:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter @badabhai/api run test general-form-mark.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x1451);
const PROFILE = uuid(0x1452);
const SESSION = uuid(0x1461);

// IN THE PAST, and in the order the defect needs: the redo hands over (T10–T15, flush fails), the
// form is finished (T20), the rebuilt profile is confirmed (T25), the sweep re-drives the flush (T30).
const T = (minutes: number) => new Date(Date.UTC(2026, 0, 20, 10, minutes, 0));
const CONFIRMED_AT = T(25);
const MARKED_AT = T(20);
const FLUSHED_AT = T(30);

const STAMP = {
  v: 1,
  lane: "skills",
  role_label: "Helper",
  domain_label: null,
  skills: [],
  outcome: null,
  handed_over: true,
};

/** What the failed flush's checkpoint left on the row. */
const CHECKPOINT_STATE = { turn_count: 3, general_road: STAMP };

/** What the re-driven flush builds from its buffer — it never holds the form's mark. */
const FLUSH_STATE = {
  role_family: "general",
  turn_count: 4,
  form_kind: null,
  extraction_ready_emitted: false,
  general_road: STAMP,
};

describe.skipIf(!RUN)("TD145 — the general form's completion mark survives the flush", () => {
  let client: DbClient;
  let chat: ChatRepository;
  let policy: ChatCompanionPolicy;

  async function storedState(): Promise<Record<string, unknown>> {
    const rows = await client.db
      .select({ state: chatSessions.conversationState })
      .from(chatSessions)
      .where(eq(chatSessions.id, SESSION));
    return rows[0]!.state ?? {};
  }

  beforeAll(async () => {
    // Three connections: the concurrency case holds one in an open transaction, the flush waits on
    // a second, and the third watches for the wait.
    client = createDbClient(DATABASE_URL, { max: 3 });
    const db = client.db;
    await db.delete(workers).where(eq(workers.id, WORKER));
    await db.insert(workers).values({
      id: WORKER,
      phoneE164: "v1.general-form-mark-db-test",
      phoneHash: `general-form-mark-db-test-${WORKER}`,
      status: "active" as const,
    });
    await db.insert(workerProfiles).values({
      id: PROFILE,
      workerId: WORKER,
      profileStatus: "confirmed",
      source: "chat",
      confirmedAt: CONFIRMED_AT,
    });
    chat = new ChatRepository(db);
    policy = new ChatCompanionPolicy(
      { CHAT_COMPANION_ENABLED: true } as never,
      new WorkersRepository(db),
      new ChatCompanionRepository(db),
    );
  }, 60_000);

  beforeEach(async () => {
    // The handover whose flush failed: still `active`, no `ended_at`, the stamp from its checkpoint.
    await client.db.delete(chatSessions).where(eq(chatSessions.id, SESSION));
    await client.db.insert(chatSessions).values({
      id: SESSION,
      workerId: WORKER,
      status: "active",
      startedAt: T(10),
      lastMessageAt: T(15),
      conversationState: CHECKPOINT_STATE,
    });
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.db.delete(workers).where(eq(workers.id, WORKER));
      await client.sql.end();
    }
  });

  it("the re-driven flush keeps general_form_completed_at, and the companion is served (rule 4)", async () => {
    expect(await chat.markGeneralFormCompleted(SESSION, WORKER, MARKED_AT)).toBe(true);

    expect(
      await chat.withTransaction((tx) => chat.endSession(tx, SESSION, FLUSH_STATE, FLUSHED_AT)),
    ).toBe(true);

    // The flush's state replaced the checkpoint (turn_count 3 → 4) — and the mark rode across it.
    expect(await storedState()).toEqual({
      ...FLUSH_STATE,
      general_form_completed_at: MARKED_AT.toISOString(),
    });
    // The handover closed AFTER the confirmation and no résumé followed — the exact shape rule 4
    // withheld the companion on. The mark is what retires it now.
    const mode = await policy.resolve(WORKER);
    expect(mode.mode).toBe("companion");
  });

  it("CONTROL: an unmarked handover closed after the confirmation still holds the worker in the interview", async () => {
    // Proves the companion case above is decided by the carried mark, not by some other rule.
    await chat.withTransaction((tx) => chat.endSession(tx, SESSION, FLUSH_STATE, FLUSHED_AT));
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("no mark: the key stays ABSENT (not null), so the form can still mark the ended handover", async () => {
    await chat.withTransaction((tx) => chat.endSession(tx, SESSION, FLUSH_STATE, FLUSHED_AT));

    const state = await storedState();
    expect(state).toEqual(FLUSH_STATE);
    expect("general_form_completed_at" in state).toBe(false);
    // A JSON null would fail the mark's `-> 'general_form_completed_at' IS NULL` guard forever.
    expect(await chat.markGeneralFormCompleted(SESSION, WORKER, T(40))).toBe(true);
    expect((await storedState()).general_form_completed_at).toBe(T(40).toISOString());
  });

  it("a mark committed while the flush waits on the row lock is kept", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => (markWritten = resolve));

    // The form's write lands first and holds the row lock, uncommitted.
    let marked: boolean | undefined;
    const mark = client.db.transaction(async (tx) => {
      marked = await new ChatRepository(tx as never).markGeneralFormCompleted(
        SESSION,
        WORKER,
        MARKED_AT,
      );
      markWritten();
      await gate;
    });
    // Racing `mark` too, so a failed write surfaces instead of hanging on `written`.
    await Promise.race([written, mark]);
    expect(marked).toBe(true);

    // The re-driven flush blocks on that lock, having started from the pre-mark row.
    const flush = chat.withTransaction((tx) =>
      chat.endSession(tx, SESSION, FLUSH_STATE, FLUSHED_AT),
    );
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      const rows = await client.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query ilike 'update "chat_sessions"%'`,
      );
      waiting = Number(rows[0]?.n ?? 0);
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(1);

    release();
    await mark;
    expect(await flush).toBe(true);

    // Postgres re-evaluated the SET against the committed mark; a read-then-write would have lost it.
    expect((await storedState()).general_form_completed_at).toBe(MARKED_AT.toISOString());
  }, 15_000);
});
