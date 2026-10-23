import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbClient, events, workers, type DbClient } from "@badabhai/db";
import { createEvent } from "@badabhai/event-schema";

import { EventsRepository } from "../events/events.repository";
import { WorkersRepository } from "./workers.repository";

/**
 * Token-audit fix A-14 — the deletion event on the delete's own transaction, against a REAL
 * Postgres. The promise is a database property (a throw inside the transaction undoes the DELETE),
 * so a stubbed drizzle handle could only show the callback ran, never that the row came back.
 *
 * Run it:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter @badabhai/api run test hard-delete-event-tx.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const WORKER = "00000000-0000-4000-8000-00000000a140";
const NEVER_EXISTED = "00000000-0000-4000-8000-00000000a141";

function deletedEvent(workerId: string) {
  return createEvent({
    event_name: "worker.account_deleted",
    actor: { actor_type: "worker", actor_id: workerId },
    subject: { subject_type: "worker", subject_id: workerId },
    payload: {
      worker_id: workerId,
      sessions_revoked: 0,
      devices_revoked: 0,
      storage_objects_deleted: 0,
      storage_objects_failed: 0,
      had_pin: false,
    },
    source: "api",
    metadata: { environment: "test", service: "api" },
  });
}

describe.skipIf(!RUN)("a hard delete and its event stand or fall together (fix A-14)", () => {
  let client: DbClient;
  let repo: WorkersRepository;
  let eventsRepo: EventsRepository;

  const workerRows = async (id: string) =>
    client.db.select({ id: workers.id }).from(workers).where(eq(workers.id, id));
  const eventRows = async (id: string) =>
    client.db.select({ id: events.id }).from(events).where(eq(events.subjectId, id));

  async function cleanup(): Promise<void> {
    await client.db.delete(events).where(inArray(events.subjectId, [WORKER, NEVER_EXISTED]));
    await client.db.delete(workers).where(inArray(workers.id, [WORKER, NEVER_EXISTED]));
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new WorkersRepository(client.db);
    eventsRepo = new EventsRepository(client.db);
  });

  beforeEach(async () => {
    await cleanup();
    await client.db.insert(workers).values({
      id: WORKER,
      phoneE164: "v1.hard-delete-event-tx-db-test",
      phoneHash: `hard-delete-event-tx-db-test-${WORKER}`,
      status: "active" as const,
    });
  });

  afterAll(async () => {
    await cleanup();
    await client.sql.end();
  });

  it("a failed write inside the transaction brings the row back and leaves no event", async () => {
    await expect(
      repo.hardDelete(WORKER, {
        inTx: async (tx) => {
          await eventsRepo.insert(deletedEvent(WORKER), `worker.account_deleted:${WORKER}`, tx);
          throw new Error("the event write failed");
        },
      }),
    ).rejects.toThrow("the event write failed");
    expect(await workerRows(WORKER)).toHaveLength(1);
    expect(await eventRows(WORKER)).toHaveLength(0);
  });

  it("a successful write commits the delete and the event together", async () => {
    await expect(
      repo.hardDelete(WORKER, {
        inTx: async (tx) => {
          await eventsRepo.insert(deletedEvent(WORKER), `worker.account_deleted:${WORKER}`, tx);
        },
      }),
    ).resolves.toBe(true);
    expect(await workerRows(WORKER)).toHaveLength(0);
    expect(await eventRows(WORKER)).toHaveLength(1);
  });

  it("a delete that removes nothing runs no callback", async () => {
    let ran = false;
    await expect(
      repo.hardDelete(NEVER_EXISTED, {
        inTx: async () => {
          ran = true;
        },
      }),
    ).resolves.toBe(false);
    expect(ran).toBe(false);
  });

  it("without a callback the delete is today's", async () => {
    await expect(repo.hardDelete(WORKER)).resolves.toBe(true);
    expect(await workerRows(WORKER)).toHaveLength(0);
  });
});
