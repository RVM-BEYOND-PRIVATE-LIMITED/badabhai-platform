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

/**
 * #2750 item 2 — `readContactCostFacts` against real Postgres: the facts a contact is priced from
 * (latest rung per trade, the months in that trade, total years, an ACTIVE RVM link, this
 * company's grant), batched for a page, and empty facts for an id with no rows.
 */
describe.skipIf(!RUN)("contact cost facts — against real Postgres", () => {
  let client: DbClient;
  let repo: UnlocksRepository;
  let companyId: string;
  let otherCompanyId: string;
  const T = randomUUID().slice(0, 8);
  const SETTER = randomUUID();
  const STUDENT = randomUUID();
  const NOBODY = randomUUID();

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    repo = new UnlocksRepository(client.db);
    const { sql } = client;
    const companies = await client.db
      .insert(payers)
      .values([
        {
          role: "employer",
          emailEnc: `enc:2750f-a-${T}`,
          emailHash: `hash:2750f-a-${T}`,
          orgNameEnc: `enc:co-a-${T}`,
          status: "active",
        },
        {
          role: "employer",
          emailEnc: `enc:2750f-b-${T}`,
          emailHash: `hash:2750f-b-${T}`,
          orgNameEnc: `enc:co-b-${T}`,
          status: "active",
        },
      ])
      .returning({ id: payers.id });
    companyId = companies[0]!.id;
    otherCompanyId = companies[1]!.id;
    for (const id of [SETTER, STUDENT]) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:2750f-${T}-${id}`}, ${`hash:2750f-${T}-${id}`}, 'active')`;
    }
    // The D1 vocabulary row the fixtures name — a no-op where D1 has run (the same row
    // admin-candidate-detail.db seeds).
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES ('mskill_cnc_turner', 'CNC Turner', 'cnc-machining', 'rvm', 'active', 'match_skill',
              'ind_industrial_manufacturing')
      ON CONFLICT (skill_id) DO NOTHING`;
    // SETTER: an older profile said operator, the latest says setter; 4 years overall.
    const [older] = await sql<{ id: string }[]>`
      INSERT INTO worker_profiles (worker_id, profile_status, experience, created_at)
      VALUES (${SETTER}::uuid, 'confirmed', ${JSON.stringify({ total_years: 1 })}::jsonb,
              now() - interval '30 days')
      RETURNING id`;
    const [latest] = await sql<{ id: string }[]>`
      INSERT INTO worker_profiles (worker_id, profile_status, experience, created_at)
      VALUES (${SETTER}::uuid, 'confirmed', ${JSON.stringify({ total_years: 4 })}::jsonb, now())
      RETURNING id`;
    await sql`
      INSERT INTO worker_profile_skill (worker_profile_id, skill_id, source, trade_level)
      VALUES (${older!.id}::uuid, 'mskill_cnc_turner', 'worker_confirmed', 'operator'),
             (${latest!.id}::uuid, 'mskill_cnc_turner', 'worker_confirmed', 'setter')`;
    await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${SETTER}::uuid, 'mskill_cnc_turner', 'ind_industrial_manufacturing', 42, true, 'ops')`;
    // The company holds a live grant for SETTER; the other company holds nothing.
    await sql`
      INSERT INTO unlocks (payer_id, worker_id, status, granted_at, expires_at, routing_token_ref)
      VALUES (${companyId}::uuid, ${SETTER}::uuid, 'granted', now(), now() + interval '10 days',
              ${randomUUID()}::uuid)`;
    // STUDENT: an active RVM link, nothing stated.
    await sql`
      INSERT INTO worker_institute_links
        (worker_id, institute_code, student_ref, status, course, branch, linked_at, synced_at)
      VALUES (${STUDENT}::uuid, 'rvm', ${randomUUID()}, 'active', 'Diploma in CNC', 'Nashik', now(), now())`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM unlocks WHERE payer_id IN (${companyId}::uuid, ${otherCompanyId}::uuid)`;
      await sql`DELETE FROM workers WHERE phone_hash LIKE ${`hash:2750f-${T}-%`}`;
      await sql`DELETE FROM payers WHERE id IN (${companyId}::uuid, ${otherCompanyId}::uuid)`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("reads the latest rung per trade with its months, total years from the latest profile, and the grant", async () => {
    const facts = await repo.readContactCostFacts(companyId as TenantKey, [SETTER]);
    expect(facts.get(SETTER)).toEqual({
      rungs: [{ skillId: "mskill_cnc_turner", tradeLevel: "setter", months: 42 }],
      totalYears: 4,
      rvmStudent: false,
      grant: { status: "granted", expiresAt: expect.any(Date) },
    });
  });

  it("another company's grant is not this company's", async () => {
    const facts = await repo.readContactCostFacts(otherCompanyId as TenantKey, [SETTER]);
    expect(facts.get(SETTER)?.grant).toBeNull();
  });

  it("batches a page: an RVM student, and an id with no rows gets empty facts", async () => {
    const facts = await repo.readContactCostFacts(companyId as TenantKey, [
      SETTER,
      STUDENT,
      NOBODY,
    ]);
    expect([...facts.keys()]).toEqual([SETTER, STUDENT, NOBODY]);
    expect(facts.get(STUDENT)).toEqual({
      rungs: [],
      totalYears: null,
      rvmStudent: true,
      grant: null,
    });
    expect(facts.get(NOBODY)).toEqual({
      rungs: [],
      totalYears: null,
      rvmStudent: false,
      grant: null,
    });
  });
});
