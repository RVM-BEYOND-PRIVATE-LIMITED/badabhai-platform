import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, events, type DbClient } from "@badabhai/db";

/**
 * TD18 — idempotent event emission. Proves the events table dedups at the DB:
 * re-inserting the same logical event (same `idempotency_key`) under an
 * at-least-once retry is a no-op (`ON CONFLICT DO NOTHING`), while unkeyed events
 * (NULL key) always insert. This is the storage-layer guarantee the EventsService
 * relies on — exercised here against real Postgres with the exact insert chain the
 * repository uses.
 *
 * Opt-in (same lane as the Phase 1 flow):
 *   1. docker compose up -d postgres            # or point at Supabase
 *   2. pnpm db:migrate                          # applies 0006 (idempotency_key + unique index)
 *   3. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 */

const RUN = process.env.RUN_E2E === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("Event emission is idempotent under at-least-once retry (TD18)", () => {
  let client!: DbClient;
  // Unique correlation per run so we can count only THIS run's rows.
  const CORR = randomUUID();

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    // Tidy up this run's rows, then close the pool. (`client` is always set here:
    // the whole suite is skipped when RUN is false, so beforeAll has run.)
    await client.sql`delete from events where correlation_id = ${CORR}`;
    await client.sql.end({ timeout: 5 });
  });

  /** Insert one event row exactly as EventsRepository does (ON CONFLICT DO NOTHING). */
  async function insertEvent(idempotencyKey: string | null, name = "worker.otp_requested") {
    const written = await client.db
      .insert(events)
      .values({
        eventName: name,
        eventVersion: 1,
        occurredAt: new Date(),
        actorType: "system",
        subjectType: "worker",
        correlationId: CORR,
        idempotencyKey,
        payload: {},
        metadata: {},
      })
      .onConflictDoNothing({ target: events.idempotencyKey })
      .returning({ id: events.id });
    return written.length > 0; // true = written, false = deduped
  }

  async function rowsWithKey(key: string): Promise<number> {
    const all = await client.db.select().from(events);
    return all.filter((e) => e.idempotencyKey === key).length;
  }

  async function rowsForRun(): Promise<number> {
    const all = await client.db.select().from(events);
    return all.filter((e) => e.correlationId === CORR).length;
  }

  it("writes the first event but DEDUPS a re-emit with the same idempotency_key", async () => {
    const key = `td18.same:${randomUUID()}`;

    const first = await insertEvent(key);
    const second = await insertEvent(key); // simulated at-least-once redelivery

    expect(first).toBe(true); // first insert wrote a row
    expect(second).toBe(false); // retry was a no-op (deduped)
    expect(await rowsWithKey(key)).toBe(1); // exactly one row survives
  });

  it("writes distinct events with different idempotency_keys", async () => {
    const a = `td18.a:${randomUUID()}`;
    const b = `td18.b:${randomUUID()}`;

    expect(await insertEvent(a)).toBe(true);
    expect(await insertEvent(b)).toBe(true);

    expect(await rowsWithKey(a)).toBe(1);
    expect(await rowsWithKey(b)).toBe(1);
  });

  it("never dedups unkeyed (NULL) events — they always insert", async () => {
    const before = await rowsForRun();

    // Two NULL-key inserts must both land (Postgres treats NULLs as DISTINCT).
    expect(await insertEvent(null)).toBe(true);
    expect(await insertEvent(null)).toBe(true);

    expect(await rowsForRun()).toBe(before + 2);
  });
});
