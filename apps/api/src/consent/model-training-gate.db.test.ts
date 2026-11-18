import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDbClient, workerConsents, workers, type DbClient } from "@badabhai/db";
import type { ConsentPurpose } from "@badabhai/types";

import { ConsentRepository } from "./consent.repository";
import { modelTrainingAllowed } from "./model-training-gate";

/**
 * #2753 item 13 — the model-training gate against Postgres: `findLatestStatesByWorkers` reads each
 * worker's LATEST consent row (by `accepted_at`) in one query, and the gate answers from that row
 * alone. An older row that granted `model_training` does not survive a newer one that does not,
 * and an older row that did not is replaced by a newer grant.
 *
 * Run it through a throwaway LOCAL database only:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…localhost… pnpm --filter @badabhai/api run test model-training-gate.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`model-training-gate.db refuses a non-local host (${host})`);
  }
}

describe.skipIf(!RUN)("#2753 item 13 — the model-training gate (Postgres)", () => {
  let client!: DbClient;
  let consents!: ConsentRepository;
  const created: string[] = [];

  async function worker(
    rows: { purposes: ConsentPurpose[]; minutesAgo: number; revoked?: boolean }[],
  ): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await client.db.insert(workers).values({
      id,
      phoneE164: "v1.model-training-gate-db-test",
      phoneHash: `model-training-gate-db-test-${id}`,
      status: "active" as const,
    });
    for (const row of rows) {
      await client.db.insert(workerConsents).values({
        workerId: id,
        consentVersion: "test-2753",
        purposes: row.purposes,
        acceptedAt: new Date(Date.now() - row.minutesAgo * 60_000),
        revokedAt: row.revoked ? new Date() : null,
      });
    }
    return id;
  }

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 2 });
    consents = new ConsentRepository(client.db);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      if (created.length > 0) await client.db.delete(workers).where(inArray(workers.id, created));
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("answers from each worker's latest row, for a whole batch in one read", async () => {
    const grantedNow = await worker([
      { purposes: ["profiling"], minutesAgo: 10 },
      { purposes: ["profiling", "model_training"], minutesAgo: 1 },
    ]);
    const grantedThenNarrowed = await worker([
      { purposes: ["profiling", "model_training"], minutesAgo: 10 },
      { purposes: ["profiling"], minutesAgo: 1 },
    ]);
    const grantedThenRevoked = await worker([
      { purposes: ["profiling", "model_training"], minutesAgo: 1, revoked: true },
    ]);
    const profilingOnly = await worker([{ purposes: ["profiling"], minutesAgo: 1 }]);
    const neverConsented = await worker([]);

    const states = await consents.findLatestStatesByWorkers([
      grantedNow,
      grantedThenNarrowed,
      grantedThenRevoked,
      profilingOnly,
      neverConsented,
    ]);
    expect(states.get(grantedNow)?.purposes).toEqual(["profiling", "model_training"]);
    expect(states.get(grantedThenNarrowed)?.purposes).toEqual(["profiling"]);
    expect(states.has(neverConsented)).toBe(false);

    const allowed = await modelTrainingAllowed(consents, [
      grantedNow,
      grantedThenNarrowed,
      grantedThenRevoked,
      profilingOnly,
      neverConsented,
    ]);
    expect([...allowed]).toEqual([grantedNow]);
    await expect(modelTrainingAllowed(consents, grantedNow)).resolves.toBe(true);
    await expect(modelTrainingAllowed(consents, grantedThenNarrowed)).resolves.toBe(false);
  });
});
