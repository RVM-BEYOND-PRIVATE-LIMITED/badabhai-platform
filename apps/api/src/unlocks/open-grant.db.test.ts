import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, payers, type DbClient } from "@badabhai/db";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { ResumeDisclosureRepository } from "../disclosures/resume-disclosure.repository";
import { UnlocksRepository } from "./unlocks.repository";
import { OPEN_FOR_GOOD_UNTIL } from "./open-grant";

/**
 * #2747 item 6 (ADR-0064 §3.4) — "open for good" against real Postgres.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test open-grant.db
 *
 * What only a real database proves: `extendOpenUntil` moves BOTH stored dates (the grant and its
 * relay row) to the for-good date inside one transaction, only ever LATER, never on a row that is
 * not a grant; and the résumé route's SQL (`hasLiveUnlock`) is the twin of `isOpenGrant` — a lapsed
 * grant is open with the rule on and closed with it off.
 *
 * Fixtures are synthetic (`enc:`/`hash:` markers); every row is deleted afterwards.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const WORKER = randomUUID();
const LAPSED = "2026-01-01T00:00:00.000Z";

describe.skipIf(!RUN)("open for good — against real Postgres", () => {
  let client: DbClient;
  let unlocksRepo: UnlocksRepository;
  let disclosures: ResumeDisclosureRepository;
  let payerId: string;
  let lapsedId: string;
  let deniedId: string;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    unlocksRepo = new UnlocksRepository(client.db);
    disclosures = new ResumeDisclosureRepository(client.db);
    const [payer] = await client.db
      .insert(payers)
      .values({
        role: "employer",
        emailEnc: `enc:2747b-${TAG}`,
        emailHash: `hash:2747b-${TAG}`,
        orgNameEnc: `enc:company-${TAG}`,
        status: "active",
      })
      .returning({ id: payers.id });
    payerId = payer!.id;
    const { sql } = client;
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${WORKER}::uuid, ${`enc:2747b-${TAG}`}, ${`hash:2747b-${TAG}`}, 'active')`;
    const [lapsed] = await sql<{ id: string }[]>`
      INSERT INTO unlocks (payer_id, worker_id, status, granted_at, expires_at, routing_token_ref)
      VALUES (${payerId}::uuid, ${WORKER}::uuid, 'revealed', ${LAPSED}::timestamptz - interval '14 days',
              ${LAPSED}::timestamptz, ${randomUUID()}::uuid)
      RETURNING id`;
    lapsedId = lapsed!.id;
    await sql`
      INSERT INTO unlock_routing (unlock_id, routing_token, channel, relay_handle, expires_at)
      VALUES (${lapsedId}::uuid, ${randomUUID()}::uuid, 'in_app_relay', ${`relay-${TAG}`},
              ${LAPSED}::timestamptz)`;
    // A second worker for the denied row (one unlock per (payer, worker)).
    const other = randomUUID();
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${other}::uuid, ${`enc:2747b-o-${TAG}`}, ${`hash:2747b-o-${TAG}`}, 'active')`;
    const [denied] = await sql<{ id: string }[]>`
      INSERT INTO unlocks (payer_id, worker_id, status, deny_reason, expires_at)
      VALUES (${payerId}::uuid, ${other}::uuid, 'denied', 'no_consent', ${LAPSED}::timestamptz)
      RETURNING id`;
    deniedId = denied!.id;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM unlocks WHERE payer_id = ${payerId}::uuid`;
      await sql`DELETE FROM workers WHERE phone_hash LIKE ${`hash:2747b-%${TAG}`}`;
      await sql`DELETE FROM payers WHERE id = ${payerId}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  async function dates(unlockId: string) {
    const [u] = await client.sql<{ expires_at: Date | string }[]>`
      SELECT expires_at FROM unlocks WHERE id = ${unlockId}::uuid`;
    const [r] = await client.sql<{ expires_at: Date | string }[]>`
      SELECT expires_at FROM unlock_routing WHERE unlock_id = ${unlockId}::uuid`;
    return {
      unlock: u ? new Date(u.expires_at).toISOString() : undefined,
      routing: r ? new Date(r.expires_at).toISOString() : undefined,
    };
  }

  it("the résumé route's SQL: a lapsed grant is closed with the rule off and open with it on", async () => {
    const tenant = payerId as TenantKey;
    expect(await disclosures.hasLiveUnlock(tenant, WORKER, { openForGood: false })).toBe(false);
    expect(await disclosures.hasLiveUnlock(tenant, WORKER, { openForGood: true })).toBe(true);
    expect(await disclosures.hasLiveUnlock(tenant, WORKER)).toBe(false);
  });

  it("extendOpenUntil moves the grant AND its relay row to the for-good date", async () => {
    await unlocksRepo.withTransaction((tx) =>
      unlocksRepo.extendOpenUntil(tx, lapsedId, OPEN_FOR_GOOD_UNTIL),
    );
    expect(await dates(lapsedId)).toEqual({
      unlock: OPEN_FOR_GOOD_UNTIL.toISOString(),
      routing: OPEN_FOR_GOOD_UNTIL.toISOString(),
    });
    // Now open by the stored date alone, with the rule off too (a rollback keeps it open).
    expect(
      await disclosures.hasLiveUnlock(payerId as TenantKey, WORKER, { openForGood: false }),
    ).toBe(true);
  });

  it("only ever moves a date LATER: an earlier target changes nothing", async () => {
    await unlocksRepo.withTransaction((tx) =>
      unlocksRepo.extendOpenUntil(tx, lapsedId, new Date("2030-01-01T00:00:00.000Z")),
    );
    expect(await dates(lapsedId)).toEqual({
      unlock: OPEN_FOR_GOOD_UNTIL.toISOString(),
      routing: OPEN_FOR_GOOD_UNTIL.toISOString(),
    });
  });

  it("never touches a row that was not a grant", async () => {
    await unlocksRepo.withTransaction((tx) =>
      unlocksRepo.extendOpenUntil(tx, deniedId, OPEN_FOR_GOOD_UNTIL),
    );
    expect((await dates(deniedId)).unlock).toBe(LAPSED);
  });
});
