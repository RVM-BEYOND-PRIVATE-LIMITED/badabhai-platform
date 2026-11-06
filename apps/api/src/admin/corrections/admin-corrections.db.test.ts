import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import { EffectiveFactsService } from "../../profiles/effective-facts.service";
import { WorkersRepository } from "../../workers/workers.repository";
import { WorkersService } from "../../workers/workers.service";
import { AdminActionsRepository } from "../admin-actions.repository";
import { AdminCorrectionsRepository } from "./admin-corrections.repository";
import { AdminCorrectionService } from "./admin-corrections.service";

/**
 * #2561 — the correction layer's POSTGRES contract (ADR-0062 §3.1–§3.4):
 *
 *   - a city correction writes the override AND `workers.current_city` in one transaction;
 *   - a re-correction keeps the ORIGINAL previous value and links the old row to the new one;
 *   - revert writes previous back and supersedes with `superseded_by = NULL`;
 *   - a WORKER self-edit supersedes the live correction in the same transaction (A1);
 *   - the partial unique index refuses two live rows for one (worker, fact);
 *   - the CHECKs refuse a short reason, an unknown fact key and a non-AES envelope;
 *   - RLS is both enabled and FORCED, and the worker cascade erases the correction;
 *   - the résumé trigger CHECK now admits `admin_edit`.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-corrections.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `corrections-db-${TAG}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };
const WORKER = randomUUID();
const REASON = {
  reason_code: "worker_request" as const,
  reason_text: "Worker called support and asked us to correct the city",
};

describe.skipIf(!RUN)("#2561 admin corrections — against Postgres", () => {
  let client!: DbClient;
  let corrections!: AdminCorrectionsRepository;
  let service!: AdminCorrectionService;
  let workersRepo!: WorkersRepository;
  let workersService!: WorkersService;
  let effectiveFacts!: EffectiveFactsService;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const pii = new PiiCryptoService({
      PII_HASH_PEPPER: "corrections-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      PIN_PEPPER: "corrections-test-pin",
    } as never);
    corrections = new AdminCorrectionsRepository(client.db);
    workersRepo = new WorkersRepository(client.db);
    effectiveFacts = new EffectiveFactsService(client.db, pii, events);
    const attributes = new WorkerAttributesRepository(client.db);
    const queue = { add: async () => ({}) } as never;
    const preferences = new WorkerPreferencesService(
      attributes,
      workersRepo,
      events,
      queue,
      effectiveFacts,
      client.db,
    );
    workersService = new WorkersService(
      workersRepo,
      pii,
      events,
      {} as never,
      {} as never,
      queue,
      attributes,
      effectiveFacts,
    );
    service = new AdminCorrectionService(
      corrections,
      new AdminActionsRepository(client.db),
      workersRepo,
      workersService,
      preferences,
      pii,
      events,
    );

    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${WORKER}::uuid, ${`enc:${TAG}`}, ${`hmac:${TAG}`}, 'active')`;
    await client.sql`UPDATE workers SET current_city = 'Mumbai' WHERE id = ${WORKER}::uuid`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM audit_logs WHERE entity_id = ${WORKER}::uuid`;
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await client.sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  const cityOf = async (): Promise<string | null> => {
    const [row] = await client.sql<{ current_city: string | null }[]>`
      SELECT current_city FROM workers WHERE id = ${WORKER}::uuid`;
    return row?.current_city ?? null;
  };

  it("a city correction writes the override AND the worker row in one transaction", async () => {
    const result = await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Pune", ...REASON },
      CTX,
    );
    expect(result.changed).toBe(true);
    expect(await cityOf()).toBe("Pune");
    const [row] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' AND superseded_at IS NULL`;
    expect(row?.count).toBe(1);
    const [audit] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_logs
      WHERE entity_id = ${WORKER}::uuid AND action = 'candidate_field_corrected'`;
    expect(audit?.count).toBe(1);
    const [spine] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.candidate_field_corrected'`;
    expect(spine?.count).toBe(1);
    const effective = await effectiveFacts.resolve(WORKER);
    expect(effective.get("current_city")).toBe("Pune");
  });

  it("re-correcting keeps the ORIGINAL previous value and links the superseded row", async () => {
    const result = await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Nashik", ...REASON },
      CTX,
    );
    expect(await cityOf()).toBe("Nashik");
    const rows = await client.sql<
      { id: string; superseded_by_id: string | null; live: boolean }[]
    >`
      SELECT id, superseded_by_id, superseded_at IS NULL AS live FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' ORDER BY created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.live).toBe(false);
    expect(rows[0]?.superseded_by_id).toBe(result.override_id);
    expect(rows[1]?.live).toBe(true);
  });

  it("revert writes the ORIGINAL previous city back and clears the live row", async () => {
    const result = await service.revert(
      ADMIN as never,
      WORKER,
      "current_city",
      { reason_code: "verification_error", reason_text: "The correction was based on a wrong address" },
      CTX,
    );
    expect(result.changed).toBe(true);
    expect(await cityOf()).toBe("Mumbai");
    const [live] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' AND superseded_at IS NULL`;
    expect(live?.count).toBe(0);
    const [reverted] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.candidate_field_reverted'`;
    expect(reverted?.count).toBe(1);
  });

  it("a WORKER self-edit supersedes the live correction in the same transaction (A1)", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Pune", ...REASON },
      CTX,
    );
    await workersService.setLocation(WORKER, { city: "Delhi" }, CTX);
    expect(await cityOf()).toBe("Delhi");
    const [live] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' AND superseded_at IS NULL`;
    expect(live?.count).toBe(0);
    expect((await effectiveFacts.resolve(WORKER)).has("current_city")).toBe(false);
    const [superseded] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid
        AND event_name = 'worker.admin_correction_superseded'`;
    expect(superseded?.count).toBe(1);
  });

  it("preferred_locations writes the attribute list and revert clears it", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "preferred_locations", value: ["Pune", "Nashik"], ...REASON },
      CTX,
    );
    const [attr] = await client.sql<{ value_text_list: string[] | null }[]>`
      SELECT value_text_list FROM worker_attributes
      WHERE worker_id = ${WORKER}::uuid AND attribute_key = 'preferred_locations'`;
    expect(attr?.value_text_list).toEqual(["Pune", "Nashik"]);
    expect((await effectiveFacts.resolve(WORKER)).get("preferred_locations")).toEqual([
      "Pune",
      "Nashik",
    ]);

    await service.revert(
      ADMIN as never,
      WORKER,
      "preferred_locations",
      { reason_code: "worker_request", reason_text: "Worker asked us to undo the earlier city list" },
      CTX,
    );
    const [after] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_attributes
      WHERE worker_id = ${WORKER}::uuid AND attribute_key = 'preferred_locations'`;
    expect(after?.count).toBe(0);
  });

  it("the database refuses a second LIVE row, a short reason, an unknown key and a plaintext envelope", async () => {
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'current_city', 'v1.aaaaaaaaaaaaaaaa.bbbb.cccc', ${ADMIN.id}::uuid,
                'other', 'A valid-length reason that is definitely long enough')`,
    ).resolves.toBeDefined();
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'current_city', 'v1.aaaaaaaaaaaaaaaa.bbbb.cccc', ${ADMIN.id}::uuid,
                'other', 'A second live row for the same worker and fact')`,
    ).rejects.toThrow(/worker_admin_override_live_uq/);
    // Use a fact with NO live row, so each case fails on the check it names (not the unique index).
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'preferred_locations', 'v1.aaaaaaaaaaaaaaaa.bbbb.dddd', ${ADMIN.id}::uuid,
                'other', 'short')`,
    ).rejects.toThrow(/worker_admin_override_reason_chk/);
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'not_a_fact', 'v1.aaaaaaaaaaaaaaaa.bbbb.eeee', ${ADMIN.id}::uuid,
                'other', 'A valid-length reason that is definitely long enough')`,
    ).rejects.toThrow(/worker_admin_override_fact_key_chk/);
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'preferred_locations', '{"corrected":"Pune"}', ${ADMIN.id}::uuid,
                'other', 'A valid-length reason that is definitely long enough')`,
    ).rejects.toThrow(/worker_admin_override_value_enc_chk/);
    // Clean the deliberate live row so the cascade test starts clean.
    await client.sql`
      UPDATE worker_admin_override SET superseded_at = now()
      WHERE worker_id = ${WORKER}::uuid AND superseded_at IS NULL`;
  });

  it("RLS is ENABLED and FORCED, and the worker cascade erases the corrections", async () => {
    const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'worker_admin_override'`;
    expect(rls).toEqual({ enabled: true, forced: true });

    const [constraint] = await client.sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'generated_resumes_generation_trigger_chk'`;
    expect(constraint?.def).toContain("admin_edit");

    await client.sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
    const [left] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override WHERE worker_id = ${WORKER}::uuid`;
    expect(left?.count).toBe(0);
  });
});
