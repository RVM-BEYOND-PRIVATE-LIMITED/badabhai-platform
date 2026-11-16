import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { AgencyWorkersRepository } from "../agency/agency-workers.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { WorkersRepository } from "../workers/workers.repository";
import { WorkerActivityRepository } from "./worker-activity.repository";

/**
 * #2753 items 4 and 7 — `worker_activity` (migration 0168) against a real Postgres.
 *
 * The unit suites prove the interceptor, the service and the merge SAY the right thing. Only a
 * database proves:
 *  - the write is idempotent: the same (worker, day) any number of times is one row, a raw
 *    duplicate is refused by the primary key (23505), and two days are two rows;
 *  - erasure: `WorkersRepository.hardDelete` removes his days (the FK cascade);
 *  - `lastActiveDays` is one statement over real `worker_devices` rows: the later of the newest
 *    table day and the newest device sighting, the device time read as an IST day (18:29:59 UTC is
 *    still that day, 18:30 UTC is the next), revoked devices counted, a worker with neither absent;
 *  - the agency list's switched-on ORDER (the LIMIT's membership) is valid SQL and counts the
 *    table: a worker who used the app today but signed in months ago survives a LIMIT 1 that the
 *    device-only order would give to someone else;
 *  - RLS is ENABLED and FORCED with no policy, and no Data-API role holds a grant.
 *
 * Fixtures carry no real PII: synthetic phone placeholders, opaque ids.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run worker-activity.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const IDEMPOTENT = randomUUID();
const ERASED = randomUUID();
const TABLE_LATER = randomUUID();
const DEVICE_LATER = randomUUID();
const BEFORE_BOUNDARY = randomUUID();
const AT_BOUNDARY = randomUUID();
const REVOKED_ONLY = randomUUID();
const NEVER_SEEN = randomUUID();
const AGENCY_DAILY = randomUUID();
const AGENCY_SIGNED_IN = randomUUID();
const WORKERS = [
  IDEMPOTENT,
  ERASED,
  TABLE_LATER,
  DEVICE_LATER,
  BEFORE_BOUNDARY,
  AT_BOUNDARY,
  REVOKED_ONLY,
  NEVER_SEEN,
  AGENCY_DAILY,
  AGENCY_SIGNED_IN,
];
const AGENCY = randomUUID();
/** A clock after every fixture, so no device time is clamped as "future". */
const NOW = new Date("2026-11-16T06:00:00.000Z");

describe.skipIf(!RUN)("worker_activity against Postgres (#2753, migration 0168)", () => {
  let client!: DbClient;
  let repo!: WorkerActivityRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    repo = new WorkerActivityRepository(client.db);
    const { sql } = client;
    for (const [i, w] of WORKERS.entries()) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${w}::uuid, ${`enc:activity-${TAG}-${i}`}, ${`hash:activity-${TAG}-${i}`}, 'active')`;
    }
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM agency_invites WHERE inviter_payer_id = ${AGENCY}::uuid`;
    await sql`DELETE FROM payers WHERE id = ${AGENCY}::uuid`;
    // worker_activity, worker_devices and worker_consents all cascade from workers.
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  async function daysOf(workerId: string): Promise<string[]> {
    const rows = await client.sql<{ d: string }[]>`
      SELECT to_char(active_on, 'YYYY-MM-DD') AS d FROM worker_activity
      WHERE worker_id = ${workerId}::uuid ORDER BY active_on`;
    return rows.map((r) => r.d);
  }

  async function device(workerId: string, lastSeenAt: string, revoked = false): Promise<void> {
    await client.sql`
      INSERT INTO worker_devices (worker_id, device_hash, platform, last_seen_at, revoked_at)
      VALUES (${workerId}::uuid, ${`dev-${TAG}-${randomUUID().slice(0, 8)}`}, 'android',
              ${lastSeenAt}::timestamptz, ${revoked ? lastSeenAt : null}::timestamptz)`;
  }

  describe("the write", () => {
    it("is idempotent: the same day written five times is ONE row; a second day is a second row", async () => {
      for (let i = 0; i < 5; i++) await repo.touch(IDEMPOTENT, "2026-11-15");
      // Concurrent writers (two processes, a burst) are the same no-op.
      await Promise.all([1, 2, 3].map(() => repo.touch(IDEMPOTENT, "2026-11-15")));
      expect(await daysOf(IDEMPOTENT)).toEqual(["2026-11-15"]);
      await repo.touch(IDEMPOTENT, "2026-11-16");
      expect(await daysOf(IDEMPOTENT)).toEqual(["2026-11-15", "2026-11-16"]);
    });

    it("the primary key refuses a raw duplicate (23505): the guarantee is the table, not a cache", async () => {
      const err = await client.sql`
        INSERT INTO worker_activity (worker_id, active_on) VALUES (${IDEMPOTENT}::uuid, '2026-11-15')`.catch(
        (e: unknown) => e,
      );
      expect((err as { code?: string }).code).toBe("23505");
    });

    it("refuses a worker that does not exist (the FK)", async () => {
      const err = await repo.touch(randomUUID(), "2026-11-16").catch((e: unknown) => e);
      const code = (err as { code?: string; cause?: { code?: string } }).cause?.code;
      expect(code ?? (err as { code?: string }).code).toBe("23503");
    });
  });

  it("erasure: WorkersRepository.hardDelete removes his days (ON DELETE CASCADE)", async () => {
    await repo.touch(ERASED, "2026-11-14");
    await repo.touch(ERASED, "2026-11-15");
    expect(await daysOf(ERASED)).toHaveLength(2);
    await expect(new WorkersRepository(client.db).hardDelete(ERASED)).resolves.toBe(true);
    expect(await daysOf(ERASED)).toEqual([]);
  });

  describe("lastActiveDays — the one definition, over real device rows", () => {
    beforeAll(async () => {
      // He used the app on 14 Nov; his last sign-in was in August.
      await repo.touch(TABLE_LATER, "2026-11-14");
      await device(TABLE_LATER, "2026-08-01T10:00:00Z");
      // History from before the table: the device is newer than any table day.
      await repo.touch(DEVICE_LATER, "2026-09-01");
      await device(DEVICE_LATER, "2026-11-12T05:00:00Z");
      await device(DEVICE_LATER, "2026-10-01T05:00:00Z");
      // The IST boundary: 18:29:59 UTC is 23:59:59 IST (that day); 18:30:00 UTC is 00:00 IST (the next).
      await device(BEFORE_BOUNDARY, "2026-11-10T18:29:59Z");
      await device(AT_BOUNDARY, "2026-11-10T18:30:00Z");
      // A signed-out device still says when he used the app.
      await device(REVOKED_ONLY, "2026-11-05T09:00:00Z", true);
    }, 30_000);

    it("merges the table and the devices, reads device time as an IST day, and leaves out the unseen", async () => {
      const days = await repo.lastActiveDays(
        [TABLE_LATER, DEVICE_LATER, BEFORE_BOUNDARY, AT_BOUNDARY, REVOKED_ONLY, NEVER_SEEN],
        NOW,
      );
      expect(days.get(TABLE_LATER)).toBe("2026-11-14");
      expect(days.get(DEVICE_LATER)).toBe("2026-11-12");
      expect(days.get(BEFORE_BOUNDARY)).toBe("2026-11-10");
      expect(days.get(AT_BOUNDARY)).toBe("2026-11-11");
      expect(days.get(REVOKED_ONLY)).toBe("2026-11-05");
      expect(days.has(NEVER_SEEN)).toBe(false);
      expect(days.size).toBe(5);
    });

    it("accepts upper-case ids and duplicates, and keys the answer in lower case", async () => {
      const days = await repo.lastActiveDays(
        [TABLE_LATER.toUpperCase(), TABLE_LATER, randomUUID()],
        NOW,
      );
      expect([...days.entries()]).toEqual([[TABLE_LATER.toLowerCase(), "2026-11-14"]]);
    });
  });

  it("the agency list's switched-on order counts the table, so LIMIT 1 keeps the daily user", async () => {
    const { sql } = client;
    await sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${AGENCY}::uuid, 'agent', ${`enc:activity-${TAG}`}, ${`hash:activity-${TAG}`},
              ${`enc:activity-org-${TAG}`}, 'active')`;
    for (const w of [AGENCY_DAILY, AGENCY_SIGNED_IN]) {
      await sql`
        INSERT INTO agency_invites (inviter_payer_id, code, invited_worker_id)
        VALUES (${AGENCY}::uuid, ${`act-${TAG}-${w.slice(0, 8)}`}, ${w}::uuid)`;
      await sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
        VALUES (${w}::uuid, '2026-11-04', '["agent_activity_visibility"]'::jsonb, now())`;
    }
    // The daily user signed in back in January; the other signed in yesterday and not since.
    await device(AGENCY_DAILY, "2026-01-05T09:00:00Z");
    await repo.touch(AGENCY_DAILY, "2026-11-16");
    await device(AGENCY_SIGNED_IN, "2026-11-15T09:00:00Z");

    const agency = new AgencyWorkersRepository(client.db);
    const tenant = AGENCY as TenantKey;
    const off = await agency.listReferredWithConsent(tenant, 1);
    expect(off.map((r) => r.workerId)).toEqual([AGENCY_SIGNED_IN]);
    const on = await agency.listReferredWithConsent(tenant, 1, { activityOrder: true });
    expect(on.map((r) => r.workerId)).toEqual([AGENCY_DAILY]);
    // The repository's own day is still the device's UTC day; the service replaces it.
    expect(on[0]?.lastActiveOn).toBe("2026-01-05");
  });

  describe("deny by default", () => {
    it("RLS is ENABLED and FORCED, with no policy", async () => {
      const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE oid = 'public.worker_activity'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policies] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'worker_activity'`;
      expect(policies?.n).toBe(0);
    });

    it("no Data-API role (that exists here) holds any privilege on it", async () => {
      const roles = await client.sql<{ rolname: string }[]>`
        SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`;
      for (const { rolname } of roles) {
        const [grant] = await client.sql<{ any: boolean }[]>`
          SELECT has_table_privilege(${rolname}, 'public.worker_activity',
                                     'SELECT, INSERT, UPDATE, DELETE') AS any`;
        expect(grant?.any, `${rolname} holds a grant`).toBe(false);
      }
      const [publicGrant] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.role_table_grants
         WHERE table_name = 'worker_activity' AND grantee = 'PUBLIC'`;
      expect(publicGrant?.n).toBe(0);
    });
  });
});
