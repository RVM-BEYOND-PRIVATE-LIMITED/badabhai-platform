import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  createDbClient,
  creditRulesConfig,
  grantCreditsWithinTx,
  spendCreditsWithinTx,
  type DbClient,
} from "@badabhai/db";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { isUniqueViolation } from "../common/db-error";
import { CreditRulesRepository } from "./credit-rules.repository";
import { WelcomeCreditsRepository } from "./welcome-credits.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { RvmWaiversRepository } from "../rvm-waivers/rvm-waivers.repository";
import { UnlocksRepository } from "../unlocks/unlocks.repository";
import { ReachDeskRepository } from "../reach-desk/reach-desk.repository";
import { AdminActionsRepository } from "../admin/admin-actions.repository";
import { istQuarterStart } from "../admin/admin-actions.service";

/**
 * #2750 item 1 — the credit rules' revisions against real Postgres.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test credit-rules.db
 *
 * What only a real database proves: a revision is written with its audit row in one transaction;
 * the old row stops being active; a stale `expectedRevision` writes nothing; and two admins saving
 * the SAME revision at once never both commit (`credit_rules_config_revision_uq` refuses one, or
 * the second reads the first's row and answers stale). After every write exactly one row is active.
 *
 * The table is global, so the test starts from whatever revision is stored, deletes only the rows
 * it wrote, and puts the previously active row back.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const ADMIN = "a2750000-0000-4000-8000-000000000001";

describe.skipIf(!RUN)("credit rules revisions — against real Postgres", () => {
  let client: DbClient;
  let repo: CreditRulesRepository;
  let startRevision: number;
  let previouslyActive: string | null;
  const written: string[] = [];

  const publish = (expectedRevision: number, higherCost: number) =>
    repo.publish(
      {
        rules: { ...DEFAULT_CREDIT_RULES, higherCost },
        expectedRevision,
        adminId: ADMIN,
        audit: { action: "credit_rules_changed", metadata: { test: "2750" } },
      },
      async () => undefined,
    );

  const activeRows = () =>
    client.db
      .select({ id: creditRulesConfig.id, revision: creditRulesConfig.revision })
      .from(creditRulesConfig)
      .where(eq(creditRulesConfig.isActive, true));

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    repo = new CreditRulesRepository(client.db);
    const [latest] = await client.sql<{ max: number | null }[]>`
      SELECT max(revision)::int AS max FROM credit_rules_config`;
    startRevision = latest?.max ?? 0;
    previouslyActive = (await repo.getActive())?.id ?? null;
  });

  afterAll(async () => {
    if (written.length > 0) {
      await client.db
        .delete(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "credit_rules_config"),
            inArray(auditLogs.entityId, written),
          ),
        );
      await client.db.delete(creditRulesConfig).where(inArray(creditRulesConfig.id, written));
    }
    if (previouslyActive !== null) {
      await client.db
        .update(creditRulesConfig)
        .set({ isActive: true })
        .where(eq(creditRulesConfig.id, previouslyActive));
    }
    await client.sql.end();
  });

  it("writes the next revision with its audit row, and it becomes the only active row", async () => {
    const result = await publish(startRevision, 3);
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;
    written.push(result.row.id);
    expect(result.row.revision).toBe(startRevision + 1);

    const active = await activeRows();
    expect(active).toEqual([{ id: result.row.id, revision: startRevision + 1 }]);
    expect((await repo.getActive())?.rules).toMatchObject({ higherCost: 3 });

    const audit = await client.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityType, "credit_rules_config"), eq(auditLogs.entityId, result.row.id)),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "admin",
      actorId: ADMIN,
      action: "credit_rules_changed",
    });
  });

  it("a stale expectedRevision writes nothing", async () => {
    const before = await activeRows();
    expect(await publish(startRevision, 4)).toEqual({ outcome: "stale" });
    expect(await activeRows()).toEqual(before);
  });

  it("an afterWrite that throws rolls the revision and its audit row back", async () => {
    const before = await activeRows();
    await expect(
      repo.publish(
        {
          rules: DEFAULT_CREDIT_RULES,
          expectedRevision: startRevision + 1,
          adminId: ADMIN,
          audit: { action: "credit_rules_changed", metadata: {} },
        },
        async () => {
          throw new Error("event failed");
        },
      ),
    ).rejects.toThrow("event failed");
    expect(await activeRows()).toEqual(before);
  });

  it("two saves of the same revision at once: exactly one commits", async () => {
    const expected = startRevision + 1;
    const settled = await Promise.allSettled([publish(expected, 5), publish(expected, 6)]);
    const published = settled.flatMap((s) =>
      s.status === "fulfilled" && s.value.outcome === "published" ? [s.value.row] : [],
    );
    for (const row of published) written.push(row.id);
    expect(published).toHaveLength(1);
    // The loser either read the winner's row (stale) or hit the revision index (23505).
    for (const s of settled) {
      if (s.status === "rejected") expect(isUniqueViolation(s.reason)).toBe(true);
    }
    const active = await activeRows();
    expect(active).toEqual([{ id: published[0]!.id, revision: expected + 1 }]);
  });
});

/**
 * #2750 item 4 — the welcome grant against real Postgres: the eligibility read (approval, GSTIN,
 * an approved posting) and the grant itself — ONE `welcome` lot expiring at its date and ONE
 * `welcome` ledger line, whatever the number of triggers, concurrent ones included.
 */
describe.skipIf(!RUN)("welcome credits — against real Postgres", () => {
  let client: DbClient;
  let repo: WelcomeCreditsRepository;
  const T = randomUUID().slice(0, 8);
  const COMPANY = randomUUID();
  const RACE = randomUUID();
  const companies = [COMPANY, RACE];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    repo = new WelcomeCreditsRepository(client.db);
    const { sql } = client;
    for (const id of companies) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, 'employer', ${`enc:2750w-${T}-${id}`}, ${`hash:2750w-${T}-${id}`},
                ${`enc:co-${T}`}, 'active')`;
    }
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      for (const id of companies) {
        await sql`DELETE FROM credit_ledger WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM credit_lots WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payer_credits WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM job_postings WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM employer_profiles WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payers WHERE id = ${id}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  const tenant = (id: string) => id as TenantKey;

  it("eligibility: each condition is read from its own record", async () => {
    const { sql } = client;
    expect(await repo.eligibility(tenant(COMPANY))).toEqual({
      role: "employer",
      status: "active",
      verificationStatus: null,
      hasGstNumber: false,
      phoneProven: false,
      hasApprovedPosting: false,
    });
    await sql`
      INSERT INTO employer_profiles (payer_id, verification_status, gst_number_enc)
      VALUES (${COMPANY}::uuid, 'verified', ${`enc:gst-${T}`})`;
    await sql`
      INSERT INTO job_postings
        (id, created_by, payer_id, org_label, role_title, vacancy_band, status, verification_status)
      VALUES (${randomUUID()}::uuid, ${COMPANY}::uuid, ${COMPANY}::uuid, 'Welcome Co',
              'CNC Operator', '1', 'open', 'verified')`;
    expect(await repo.eligibility(tenant(COMPANY))).toEqual({
      role: "employer",
      status: "active",
      verificationStatus: "verified",
      hasGstNumber: true,
      phoneProven: false,
      hasApprovedPosting: true,
    });
  });

  it("grants ONE welcome lot with its expiry and ONE ledger line, and a second call adds nothing", async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    const lots: string[] = [];
    const first = await repo.grantOnce(
      tenant(COMPANY),
      { credits: 5, expiresAt },
      async (_tx, lot) => {
        lots.push(lot);
      },
    );
    const second = await repo.grantOnce(
      tenant(COMPANY),
      { credits: 5, expiresAt },
      async (_tx, lot) => {
        lots.push(lot);
      },
    );
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(lots).toHaveLength(1);

    const { sql } = client;
    const lotRows = await sql<{ source: string; credits_remaining: number; expires_at: Date }[]>`
      SELECT source, credits_remaining, expires_at FROM credit_lots WHERE payer_id = ${COMPANY}::uuid`;
    expect(lotRows).toHaveLength(1);
    expect(lotRows[0]).toMatchObject({ source: "welcome", credits_remaining: 5 });
    expect(Math.abs(new Date(lotRows[0]!.expires_at).getTime() - expiresAt.getTime())).toBeLessThan(
      1000,
    );
    const lines = await sql<{ reason: string; delta: number; idempotency_key: string }[]>`
      SELECT reason, delta, idempotency_key FROM credit_ledger WHERE payer_id = ${COMPANY}::uuid`;
    expect(lines.map((l) => [l.reason, Number(l.delta), l.idempotency_key])).toEqual([
      ["welcome", 5, `welcome_credits:${COMPANY}`],
    ]);
    const [wallet] = await sql<{ balance: number }[]>`
      SELECT balance FROM payer_credits WHERE payer_id = ${COMPANY}::uuid`;
    expect(Number(wallet!.balance)).toBe(5);
  });

  it("an afterGrant that throws rolls the lot and the line back", async () => {
    const { sql } = client;
    await expect(
      repo.grantOnce(
        tenant(RACE),
        { credits: 5, expiresAt: new Date(Date.now() + 1e9) },
        async () => {
          throw new Error("event failed");
        },
      ),
    ).rejects.toThrow("event failed");
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_lots WHERE payer_id = ${RACE}::uuid`;
    expect(Number(n!.n)).toBe(0);
  });

  it("concurrent triggers on one company: exactly one grant", async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        repo.grantOnce(tenant(RACE), { credits: 5, expiresAt }, async () => {}),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    const { sql } = client;
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger WHERE payer_id = ${RACE}::uuid AND reason = 'welcome'`;
    expect(Number(n!.n)).toBe(1);
  });
});

/**
 * #2750 item 5 — the placement team's waivers against real Postgres: one ACTIVE waiver per company
 * and per job (the partial unique indexes), the CHECKs tying scope to posting and `active` to
 * `cleared_at`, which waiver frees which worker (`waiversFor`: he must have APPLIED, a job waiver
 * wins, another company's posting frees nothing), and a waived open's writes: one zero-credit
 * `waived` line naming the open, its use row, and a balance that does not move.
 */
describe.skipIf(!RUN)("rvm applicant waivers — against real Postgres", () => {
  let client: DbClient;
  let waivers: RvmWaiversRepository;
  let unlocksRepo: UnlocksRepository;
  const T = randomUUID().slice(0, 8);
  const COMPANY = randomUUID();
  const OTHER = randomUUID();
  const companies = [COMPANY, OTHER];
  const P_WAIVED = randomUUID(); // COMPANY's posting with a job waiver
  const P_PLAIN = randomUUID(); // COMPANY's posting with none
  const P_OTHER = randomUUID(); // OTHER's posting
  const A = randomUUID(); // applied to P_WAIVED
  const B = randomUUID(); // applied to P_PLAIN
  const C = randomUUID(); // applied to P_OTHER only
  const D = randomUUID(); // skipped P_WAIVED
  const workers = [A, B, C, D];
  const STAFF = randomUUID();
  const tenant = (id: string) => id as TenantKey;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    waivers = new RvmWaiversRepository(client.db);
    unlocksRepo = new UnlocksRepository(client.db);
    const { sql } = client;
    for (const id of companies) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, 'employer', ${`enc:2750c-${T}-${id}`}, ${`hash:2750c-${T}-${id}`},
                ${`enc:co-${T}`}, 'active')`;
    }
    for (const [id, owner] of [
      [P_WAIVED, COMPANY],
      [P_PLAIN, COMPANY],
      [P_OTHER, OTHER],
    ] as const) {
      await sql`
        INSERT INTO job_postings
          (id, created_by, payer_id, org_label, role_title, vacancy_band, status, verification_status)
        VALUES (${id}::uuid, ${owner}::uuid, ${owner}::uuid, 'Waiver Co', 'CNC Operator', '1',
                'open', 'verified')`;
    }
    for (const id of workers) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:2750c-${T}-${id}`}, ${`hash:2750c-${T}-${id}`}, 'active')`;
    }
    for (const [worker, posting, action] of [
      [A, P_WAIVED, "applied"],
      [B, P_PLAIN, "applied"],
      [C, P_OTHER, "applied"],
      [D, P_WAIVED, "skipped"],
    ] as const) {
      await sql`
        INSERT INTO applications (job_posting_id, worker_id, action, source_surface)
        VALUES (${posting}::uuid, ${worker}::uuid, ${action}, 'other')`;
    }
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      for (const id of companies) {
        await sql`DELETE FROM rvm_waiver_uses WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM rvm_applicant_waivers WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM credit_ledger WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM unlocks WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM job_postings WHERE payer_id = ${id}::uuid`;
      }
      await sql`DELETE FROM workers WHERE phone_hash LIKE ${`hash:2750c-${T}-%`}`;
      for (const id of companies) await sql`DELETE FROM payers WHERE id = ${id}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  const set = (scope: "company" | "job", jobPostingId: string | null) =>
    client.db.transaction((tx) =>
      waivers.insert(tx as never, {
        scope,
        tenant: tenant(COMPANY),
        jobPostingId,
        source: "campus",
        setByRef: STAFF,
        setByLabelEnc: "enc:staff",
        reason: "Drive partner",
      }),
    );

  it("no waiver yet: nobody is freed", async () => {
    expect((await waivers.waiversFor(tenant(COMPANY), workers)).size).toBe(0);
  });

  it("a job waiver frees only who APPLIED to that job, never a skip or another company's applicant", async () => {
    const job = await set("job", P_WAIVED);
    const freed = await waivers.waiversFor(tenant(COMPANY), workers);
    expect([...freed.entries()]).toEqual([[A, { waiverId: job.id, scope: "job" }]]);
    // The waiver is this company's: another company asking frees nobody.
    expect((await waivers.waiversFor(tenant(OTHER), workers)).size).toBe(0);
  });

  it("one active waiver per job: a second one is refused by the index", async () => {
    await expect(set("job", P_WAIVED)).rejects.toSatisfy(isUniqueViolation);
  });

  it("a company waiver frees every applicant of the company's jobs; the job waiver still wins for A", async () => {
    const company = await set("company", null);
    const freed = await waivers.waiversFor(tenant(COMPANY), workers);
    expect(freed.get(A)?.scope).toBe("job");
    expect(freed.get(B)).toEqual({ waiverId: company.id, scope: "company" });
    expect(freed.has(C)).toBe(false);
    expect(freed.has(D)).toBe(false);
    await expect(set("company", null)).rejects.toSatisfy(isUniqueViolation);
  });

  it("the CHECKs: a job waiver needs its posting, and a company waiver may not name one", async () => {
    await expect(set("job", null)).rejects.toThrow();
    await expect(
      client.db.transaction((tx) =>
        waivers.insert(tx as never, {
          scope: "company",
          tenant: tenant(OTHER),
          jobPostingId: P_OTHER,
          source: "admin",
          setByRef: STAFF,
          setByLabelEnc: null,
          reason: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("a waived open: one zero-credit `waived` line naming it, its use, and no balance moved", async () => {
    const { sql } = client;
    const freed = await waivers.waiversFor(tenant(COMPANY), [B]);
    const waiverId = freed.get(B)!.waiverId;
    const [unlock] = await sql<{ id: string }[]>`
      INSERT INTO unlocks (payer_id, worker_id, status, granted_at, expires_at, routing_token_ref)
      VALUES (${COMPANY}::uuid, ${B}::uuid, 'granted', now(), now() + interval '10 days',
              ${randomUUID()}::uuid)
      RETURNING id`;
    await client.db.transaction(async (tx) => {
      expect(await waivers.isActiveForShare(tx as never, waiverId)).toBe(true);
      await unlocksRepo.appendLedger(tx as never, {
        payerId: tenant(COMPANY),
        delta: 0,
        reason: "waived",
        unlockId: unlock!.id,
        idempotencyKey: `waived:${unlock!.id}`,
      });
      await waivers.recordUse(tx as never, {
        waiverId,
        unlockId: unlock!.id,
        tenant: tenant(COMPANY),
      });
    });
    const lines = await sql<{ reason: string; delta: number; lot_id: string | null; key: string }[]>`
      SELECT reason, delta, lot_id, idempotency_key AS key FROM credit_ledger
      WHERE payer_id = ${COMPANY}::uuid`;
    expect(lines.map((l) => [l.reason, Number(l.delta), l.lot_id, l.key])).toEqual([
      ["waived", 0, null, `waived:${unlock!.id}`],
    ]);
    expect((await waivers.usesOf([waiverId])).get(waiverId)).toBe(1);
    // One open is waived at most once.
    await expect(
      client.db.transaction((tx) =>
        waivers.recordUse(tx as never, { waiverId, unlockId: unlock!.id, tenant: tenant(COMPANY) }),
      ),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("clearing: the row keeps who and why, frees nobody after, and a new waiver may be set", async () => {
    const company = (await waivers.list({
      tenant: tenant(COMPANY),
      includeCleared: false,
      after: null,
      limit: 10,
    })).find((w) => w.scope === "company")!;
    expect(company.waivedOpens).toBe(1);
    const cleared = await client.db.transaction((tx) =>
      waivers.clear(tx as never, company.id, {
        clearedByRef: STAFF,
        clearedByLabelEnc: "enc:staff",
        clearReason: "Drive over",
        at: new Date(),
      }),
    );
    expect(cleared).toMatchObject({ active: false, clearReason: "Drive over" });
    expect(await client.db.transaction((tx) => waivers.isActiveForShare(tx as never, company.id))).toBe(
      false,
    );
    // Clearing again changes nothing.
    expect(
      await client.db.transaction((tx) =>
        waivers.clear(tx as never, company.id, {
          clearedByRef: STAFF,
          clearedByLabelEnc: null,
          clearReason: "again",
          at: new Date(),
        }),
      ),
    ).toBeUndefined();
    expect((await waivers.waiversFor(tenant(COMPANY), [B])).has(B)).toBe(false);
    const again = await set("company", null);
    expect(again.active).toBe(true);
    const all = await waivers.list({
      tenant: tenant(COMPANY),
      includeCleared: true,
      after: null,
      limit: 10,
    });
    expect(all.filter((w) => w.scope === "company").map((w) => w.active)).toEqual([true, false]);
  });
});

/**
 * #2750 item 6 — the opening limits' counts against real Postgres: a worker's NEW opens in the
 * window by every company (granted, revealed and lapsed rows count; a denied row and an open from
 * before the window do not), and one company's new opens since a given instant.
 */
describe.skipIf(!RUN)("opening-limit counts — against real Postgres", () => {
  let client: DbClient;
  let repo: UnlocksRepository;
  const T = randomUUID().slice(0, 8);
  const WORKER = randomUUID();
  const OTHER_WORKER = randomUUID();
  const companies = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    repo = new UnlocksRepository(client.db);
    const { sql } = client;
    for (const id of companies) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, 'agent', ${`enc:2750d-${T}-${id}`}, ${`hash:2750d-${T}-${id}`},
                ${`enc:co-${T}`}, 'active')`;
    }
    for (const id of [WORKER, OTHER_WORKER]) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:2750d-${T}-${id}`}, ${`hash:2750d-${T}-${id}`}, 'active')`;
    }
    const grant = (payer: string, worker: string, status: string, ago: string) => sql`
      INSERT INTO unlocks (payer_id, worker_id, status, granted_at, expires_at, routing_token_ref)
      VALUES (${payer}::uuid, ${worker}::uuid, ${status}, now() - ${ago}::interval,
              now() + interval '10 days', ${randomUUID()}::uuid)`;
    // WORKER: granted, revealed and lapsed this week (3 opens), a denied row (no open) and an open
    // 8 days ago (outside the window).
    await grant(companies[0]!, WORKER, "granted", "1 hour");
    await grant(companies[1]!, WORKER, "revealed", "2 days");
    await grant(companies[2]!, WORKER, "expired", "6 days");
    await grant(companies[3]!, WORKER, "denied", "1 hour");
    await grant(companies[4]!, WORKER, "granted", "8 days");
    // companies[0] opened OTHER_WORKER too, earlier today.
    await grant(companies[0]!, OTHER_WORKER, "granted", "2 hours");
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      for (const id of companies) await sql`DELETE FROM unlocks WHERE payer_id = ${id}::uuid`;
      await sql`DELETE FROM workers WHERE phone_hash LIKE ${`hash:2750d-${T}-%`}`;
      for (const id of companies) await sql`DELETE FROM payers WHERE id = ${id}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("a worker's opens in the rolling week: every company, contacts only, inside the window", async () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const n = await client.db.transaction((tx) =>
      repo.countOpensSince(tx as never, WORKER, weekAgo),
    );
    expect(n).toBe(3);
  });

  it("one company's opens since an instant, on the pool and under its own lock", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
    expect(await repo.countTenantOpensSince(companies[0]! as TenantKey, threeHoursAgo)).toBe(2);
    expect(await repo.countTenantOpensSince(companies[3]! as TenantKey, threeHoursAgo)).toBe(0);
    const underLock = await client.db.transaction(async (tx) => {
      await repo.lockTenantOpens(tx as never, companies[0]! as TenantKey);
      return repo.countTenantOpensSince(companies[0]! as TenantKey, threeHoursAgo, tx as never);
    });
    expect(underLock).toBe(2);
  });
});

/**
 * #2750 item 7 — the couldn't-reach desk against real Postgres: one case per open, the CHECK that
 * ties a close to who closed it, and the return — a 2-credit open spent from two lots comes back
 * as two `returned` lots naming the open, the live lot's expiry kept and the gone lot's 30 days
 * ahead, the wallet invariant whole, and a second return changing nothing.
 */
describe.skipIf(!RUN)("couldn't-reach desk — against real Postgres", () => {
  let client: DbClient;
  let desk: ReachDeskRepository;
  let unlocksRepo: UnlocksRepository;
  const T = randomUUID().slice(0, 8);
  const COMPANY = randomUUID();
  const WORKER = randomUUID();
  let unlockId = "";
  let caseId = "";
  const liveExpiry = new Date(Date.now() + 20 * 86_400_000);

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    desk = new ReachDeskRepository(client.db);
    unlocksRepo = new UnlocksRepository(client.db);
    const { sql } = client;
    await sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${COMPANY}::uuid, 'employer', ${`enc:2750e-${T}`}, ${`hash:2750e-${T}`},
              ${`enc:co-${T}`}, 'active')`;
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${WORKER}::uuid, ${`enc:2750e-${T}`}, ${`hash:2750e-${T}`}, 'active')`;
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO unlocks (payer_id, worker_id, status, granted_at, expires_at, routing_token_ref)
      VALUES (${COMPANY}::uuid, ${WORKER}::uuid, 'granted', now(), now() + interval '10 days',
              ${randomUUID()}::uuid)
      RETURNING id`;
    unlockId = u!.id;
    // Two lots of one credit: one live 20 days, one that will be past due when the credit returns.
    await client.db.transaction(async (tx) => {
      await grantCreditsWithinTx(tx, {
        payerId: COMPANY,
        credits: 1,
        lot: { source: "pack", expiresAt: new Date(Date.now() + 3_600_000) },
        ledger: { reason: "grant" },
      });
      await grantCreditsWithinTx(tx, {
        payerId: COMPANY,
        credits: 1,
        lot: { source: "pack", expiresAt: liveExpiry },
        ledger: { reason: "grant" },
      });
      const spent = await spendCreditsWithinTx(tx, COMPANY, 2);
      if (!spent.ok) throw new Error("fixture spend failed");
      for (const take of spent.takes) {
        await unlocksRepo.appendLedger(tx as never, {
          payerId: COMPANY as TenantKey,
          delta: -take.credits,
          reason: "unlock_debit",
          unlockId,
          lotId: take.lotId,
        });
      }
    });
    // The soon lot falls due before the return.
    await sql`
      UPDATE credit_lots SET expires_at = now() - interval '1 day'
      WHERE payer_id = ${COMPANY}::uuid AND expires_at < now() + interval '1 day'`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM contact_reach_cases WHERE payer_id = ${COMPANY}::uuid`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ${COMPANY}::uuid`;
      await sql`DELETE FROM credit_lots WHERE payer_id = ${COMPANY}::uuid`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ${COMPANY}::uuid`;
      await sql`DELETE FROM unlocks WHERE payer_id = ${COMPANY}::uuid`;
      await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
      await sql`DELETE FROM payers WHERE id = ${COMPANY}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("one case per open: a second insert writes nothing", async () => {
    const row = {
      unlockId,
      tenant: COMPANY as TenantKey,
      workerId: WORKER,
      reportedBy: COMPANY,
      deadlineAt: new Date(Date.now() + 48 * 3_600_000),
    };
    const first = await client.db.transaction((tx) => desk.insertCase(tx as never, row));
    const second = await client.db.transaction((tx) => desk.insertCase(tx as never, row));
    expect(first?.status).toBe("open");
    expect(second).toBeUndefined();
    caseId = first!.id;
    expect((await desk.findCaseByUnlock(unlockId))?.id).toBe(caseId);
  });

  it("an attempt is logged against the case, and the queue lists it", async () => {
    await client.db.transaction((tx) =>
      desk.insertAttempt(tx as never, { caseId, adminId: randomUUID(), result: "switched_off" }),
    );
    expect((await desk.attemptCounts([caseId])).get(caseId)).toBe(1);
    const queue = await desk.listCases({ status: "open", after: null, limit: 200 });
    expect(queue.find((c) => c.id === caseId)?.attempts).toBe(1);
  });

  it("the return: one `returned` lot per spent lot, naming the open, with the right expiry", async () => {
    const { sql } = client;
    const returned = await client.db.transaction(async (tx) => {
      const spent = await desk.spentFromLots(tx as never, COMPANY, unlockId);
      expect(spent.map((s) => s.credits)).toEqual([1, 1]);
      let n = 0;
      for (const s of spent) {
        const expiresAt =
          s.lotExpiresAt && s.lotExpiresAt.getTime() > Date.now()
            ? s.lotExpiresAt
            : new Date(Date.now() + 30 * 86_400_000);
        if (await desk.returnCredits(tx as never, COMPANY, unlockId, s, expiresAt)) n += s.credits;
      }
      return n;
    });
    expect(returned).toBe(2);
    const lots = await sql<{ expires_at: Date; credits_remaining: number }[]>`
      SELECT expires_at, credits_remaining FROM credit_lots
      WHERE payer_id = ${COMPANY}::uuid AND source = 'returned' ORDER BY expires_at`;
    expect(lots.map((l) => Number(l.credits_remaining))).toEqual([1, 1]);
    expect(Math.abs(new Date(lots[0]!.expires_at).getTime() - liveExpiry.getTime())).toBeLessThan(
      1000,
    );
    expect(new Date(lots[1]!.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const lines = await sql<{ reason: string; delta: number; unlock_id: string | null }[]>`
      SELECT reason, delta, unlock_id FROM credit_ledger
      WHERE payer_id = ${COMPANY}::uuid AND reason = 'returned'`;
    expect(lines.map((l) => [l.reason, Number(l.delta), l.unlock_id])).toEqual([
      ["returned", 1, unlockId],
      ["returned", 1, unlockId],
    ]);
    // The wallet invariant: the balance is the sum of the ledger.
    const [w] = await sql<{ balance: number; total: number }[]>`
      SELECT pc.balance, (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger cl
                          WHERE cl.payer_id = pc.payer_id)::int AS total
      FROM payer_credits pc WHERE pc.payer_id = ${COMPANY}::uuid`;
    expect(Number(w!.balance)).toBe(Number(w!.total));
  });

  it("a second return of the same lots changes nothing", async () => {
    const again = await client.db.transaction(async (tx) => {
      const spent = await desk.spentFromLots(tx as never, COMPANY, unlockId);
      const applied: boolean[] = [];
      for (const s of spent) {
        applied.push(await desk.returnCredits(tx as never, COMPANY, unlockId, s, null));
      }
      return applied;
    });
    expect(again).toEqual([false, false]);
  });

  it("closing: once, and a deadline close names no admin (the CHECK)", async () => {
    await expect(
      client.db.transaction((tx) =>
        desk.resolve(tx as never, caseId, {
          status: "not_reached",
          creditsReturned: 2,
          resolvedBy: "deadline",
          adminId: randomUUID(),
          at: new Date(),
        }),
      ),
    ).rejects.toThrow();
    const closed = await client.db.transaction((tx) =>
      desk.resolve(tx as never, caseId, {
        status: "not_reached",
        creditsReturned: 2,
        resolvedBy: "deadline",
        adminId: null,
        at: new Date(),
      }),
    );
    expect(closed).toMatchObject({
      status: "not_reached",
      creditsReturned: 2,
      resolvedBy: "deadline",
    });
    const twice = await client.db.transaction((tx) =>
      desk.resolve(tx as never, caseId, {
        status: "reached_declined",
        creditsReturned: 0,
        resolvedBy: "desk",
        adminId: null,
        at: new Date(),
      }),
    );
    expect(twice).toBeUndefined();
    expect(await desk.dueCaseIds(50, new Date(Date.now() + 365 * 86_400_000))).not.toContain(
      caseId,
    );
  });
});

/**
 * #2750 item 11 — the goodwill cap against real Postgres: a goodwill grant writes a `goodwill`
 * line and a lot valid the given days; the quarter's sum counts goodwill lines only; and grants
 * taken under the per-company lock can never pass the cap together, however many run at once.
 */
describe.skipIf(!RUN)("goodwill grants — against real Postgres", () => {
  let client: DbClient;
  let repo: AdminActionsRepository;
  const T = randomUUID().slice(0, 8);
  const COMPANY = randomUUID();
  const RACE = randomUUID();
  const companies = [COMPANY, RACE];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    repo = new AdminActionsRepository(client.db);
    const { sql } = client;
    for (const id of companies) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, 'employer', ${`enc:2750g-${T}-${id}`}, ${`hash:2750g-${T}-${id}`},
                ${`enc:co-${T}`}, 'active')`;
    }
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      for (const id of companies) {
        await sql`DELETE FROM credit_ledger WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM credit_lots WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payer_credits WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payers WHERE id = ${id}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("a goodwill grant: a goodwill line, a lot expiring in 30 days, counted in the quarter", async () => {
    await client.db.transaction((tx) =>
      repo.grantCredits(COMPANY, 2, randomUUID(), tx as never, { reason: "goodwill", validityDays: 30 }),
    );
    // A plain grant does not count toward the cap.
    await client.db.transaction((tx) => repo.grantCredits(COMPANY, 4, randomUUID(), tx as never));
    const { sql } = client;
    const lines = await sql<{ reason: string; delta: number }[]>`
      SELECT reason, delta FROM credit_ledger WHERE payer_id = ${COMPANY}::uuid ORDER BY reason`;
    expect(lines.map((l) => [l.reason, Number(l.delta)])).toEqual([
      ["goodwill", 2],
      ["grant", 4],
    ]);
    const [lot] = await sql<{ days: number }[]>`
      SELECT round(extract(epoch FROM (expires_at - created_at)) / 86400)::int AS days
      FROM credit_lots WHERE payer_id = ${COMPANY}::uuid AND expires_at IS NOT NULL`;
    expect(Number(lot!.days)).toBe(30);
    const used = await client.db.transaction((tx) =>
      repo.goodwillGrantedSince(tx as never, COMPANY, istQuarterStart(new Date())),
    );
    expect(used).toBe(2);
  });

  it("four grants of 2 at once under a cap of 5: exactly two apply", async () => {
    const attempt = () =>
      client.db.transaction(async (tx) => {
        await repo.lockGoodwill(tx as never, RACE);
        const used = await repo.goodwillGrantedSince(tx as never, RACE, istQuarterStart(new Date()));
        if (used + 2 > 5) return false;
        await repo.grantCredits(RACE, 2, randomUUID(), tx as never, {
          reason: "goodwill",
          validityDays: 30,
        });
        return true;
      });
    const results = await Promise.all([attempt(), attempt(), attempt(), attempt()]);
    expect(results.filter(Boolean)).toHaveLength(2);
    const used = await client.db.transaction((tx) =>
      repo.goodwillGrantedSince(tx as never, RACE, istQuarterStart(new Date())),
    );
    expect(used).toBe(4);
  });
});
