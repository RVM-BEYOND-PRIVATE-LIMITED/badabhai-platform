import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PRE_PAY_FACT_KEYS } from "./pre-pay-facts";
import { PrePayFactsRepository } from "./pre-pay-facts.repository";
import { PrePayFactsService } from "./pre-pay-facts.service";

const TENANT = "4b1d7c2e-2747-4a01-9e01-0000000000aa" as TenantKey;

/**
 * #2747 items 1 and 4 — the pre-pay facts read and the active-link read against real Postgres.
 *
 * Gated like the other DB release gates (ci.yml "DB-backed gates"):
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test pre-pay-facts.db
 *
 * What only a real database proves: DISTINCT ON with the shared CURRENT_PROFILE_ORDER tail picks
 * the worker's current profile (a newer DRAFT loses to an older confirmed one); the salary
 * attributes arrive from `numeric` as numbers; the latest device wins; the name leaves as the
 * stored CIPHERTEXT (this read never decrypts); a worker with no rows anywhere still gets a row;
 * and only an ACTIVE institute link labels an RVM student.
 *
 * Fixtures are synthetic (`enc:`/`hash:` markers, fixed uuids); every row is deleted afterwards.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const RICH = "4b1d7c2e-2747-4a01-9e01-000000000001";
const SPARSE = "4b1d7c2e-2747-4a01-9e01-000000000002";
const LINKED = "4b1d7c2e-2747-4a01-9e01-000000000003";
const WITHDRAWN = "4b1d7c2e-2747-4a01-9e01-000000000004";
const ALL = [RICH, SPARSE, LINKED, WITHDRAWN];

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of ALL) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status, full_name, current_city)
      VALUES (${id}::uuid, ${`enc:pp-${id.slice(-4)}`}, ${`hash:pp-${id.slice(-4)}`}, 'active',
              ${id === SPARSE ? null : `enc:name-${id.slice(-4)}`},
              ${id === SPARSE ? null : "Pune"})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  // RICH consents to employer sharing on his LATEST row; SPARSE consented once, then a newer row
  // without the purpose replaced it (the "stop employer contact" exit).
  await sql`
    INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
    VALUES (${RICH}::uuid, 'test', '["profiling","employer_sharing"]'::jsonb, now() - interval '1 day'),
           (${SPARSE}::uuid, 'test', '["profiling","employer_sharing"]'::jsonb, now() - interval '2 days'),
           (${SPARSE}::uuid, 'test', '["profiling"]'::jsonb, now() - interval '1 day')
  `;
  // The OLDER confirmed profile is current; the NEWER draft must lose (never recency alone).
  await sql`
    INSERT INTO worker_profiles
      (worker_id, profile_status, canonical_role_id, machines, salary_expectation, created_at)
    VALUES (${RICH}::uuid, 'confirmed', 'role_current', ${JSON.stringify(["machine_a", "machine_b"])}::jsonb,
            ${JSON.stringify({ amount_min: 20000, amount_max: 26000 })}::jsonb, now() - interval '2 days')
  `;
  await sql`
    INSERT INTO worker_profiles
      (worker_id, profile_status, canonical_role_id, machines, salary_expectation, created_at)
    VALUES (${RICH}::uuid, 'draft', 'role_draft', '[]'::jsonb, '{}'::jsonb, now())
  `;
  await sql`
    INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_number, source, question_key)
    VALUES (${RICH}::uuid, 'salary_expected_min', 'number', 18000, 'answer_map', 'salary_expected_min'),
           (${RICH}::uuid, 'salary_expected_max', 'number', 22000, 'answer_map', 'salary_expected_max')
  `;
  await sql`
    INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_text, source, question_key)
    VALUES (${RICH}::uuid, 'salary_period', 'text', 'day', 'answer_map', 'salary_period'),
           (${RICH}::uuid, 'shift_preference', 'text', 'night', 'answer_map', 'shift_preference')
  `;
  await sql`
    INSERT INTO worker_devices (worker_id, device_hash, platform, last_seen_at)
    VALUES (${RICH}::uuid, 'pp-dev-old', 'android', '2026-11-01T10:00:00Z'),
           (${RICH}::uuid, 'pp-dev-new', 'android', '2026-11-14T10:00:00Z')
  `;
  await sql`
    INSERT INTO worker_institute_links
      (worker_id, institute_code, student_ref, status, course, branch, linked_at, synced_at)
    VALUES (${LINKED}::uuid, 'rvm', ${randomUUID()}, 'active', 'Diploma in CNC', 'Nashik', now(), now())
  `;
  await sql`
    INSERT INTO worker_institute_links
      (worker_id, institute_code, student_ref, status, course, branch, linked_at, synced_at, withdrawn_at)
    VALUES (${WITHDRAWN}::uuid, 'rvm', ${randomUUID()}, 'withdrawn', 'Diploma in CNC', 'Nashik',
            now(), now(), now())
  `;
}

async function clean(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of ALL) {
    await sql`DELETE FROM worker_institute_links WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_devices WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_attributes WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_consents WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_profiles WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM workers WHERE id = ${id}::uuid`;
  }
}

describe.skipIf(!RUN)("pre-pay facts — against real Postgres", () => {
  let client: DbClient;
  let repo: PrePayFactsRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    await clean(client);
    await seed(client);
    repo = new PrePayFactsRepository(client.db);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await clean(client);
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("reads the current profile, the salary attributes, the latest device and the name as ciphertext", async () => {
    const rows = await repo.listForWorkers([RICH]);
    expect(rows).toHaveLength(1);
    const rich = rows[0]!;
    expect(rich).toMatchObject({
      workerId: RICH,
      fullNameEnc: "enc:name-0001",
      workersCity: "Pune",
      canonicalRoleId: "role_current",
      machineIds: ["machine_a", "machine_b"],
      salaryContainer: { amount_min: 20000, amount_max: 26000 },
      salaryExpectedMin: 18000,
      salaryExpectedMax: 22000,
      salaryPeriod: "day",
      employerSharing: true,
      // Consent version "test" is no brief-describing notice (the real list is empty).
      onBriefNotice: false,
    });
    expect(new Date(rich.lastSeenAt as string | Date).toISOString()).toBe(
      "2026-11-14T10:00:00.000Z",
    );
  });

  it("gives every id handed in a row, with nulls for a worker with nothing stored", async () => {
    const rows = await repo.listForWorkers([SPARSE, RICH.toUpperCase()]);
    expect(rows.map((r) => r.workerId)).toEqual([SPARSE, RICH.toUpperCase()]);
    expect(rows[0]).toEqual({
      workerId: SPARSE,
      fullNameEnc: null,
      workersCity: null,
      canonicalTradeId: null,
      canonicalRoleId: null,
      machineIds: null,
      salaryContainer: null,
      salaryExpectedMin: null,
      salaryExpectedMax: null,
      salaryPeriod: null,
      lastSeenAt: null,
      // A newer row without the purpose replaced his consent: the LATEST row decides.
      employerSharing: false,
      onBriefNotice: false,
    });
    // An id in another case still finds its rows (Postgres prints uuids in lower case).
    expect(rows[1]!.canonicalRoleId).toBe("role_current");
  });

  it("labels only an ACTIVE link — a withdrawn student is a BadaBhai worker again", async () => {
    const links = await repo.listActiveInstituteLinks([LINKED, WITHDRAWN, RICH]);
    expect(links).toEqual([
      { workerId: LINKED, instituteCode: "rvm", course: "Diploma in CNC", branch: "Nashik" },
    ]);
  });

  it("one page, an RVM applicant and a worker applicant: each labelled, every fact key present", async () => {
    // #2747 §3.8 — no brief-describing notice is approved yet; read RICH's "test" consent as one.
    const onTestNotice = {
      listActiveInstituteLinks: (ids: readonly string[]) => repo.listActiveInstituteLinks(ids),
      listForWorkers: (ids: readonly string[]) =>
        repo.listForWorkers(ids, { briefNoticeVersions: ["test"] }),
    } as unknown as PrePayFactsRepository;
    const svc = new PrePayFactsService(
      onTestNotice,
      { isEnabledFor: async () => true } as unknown as FeatureRolloutService,
      {
        decrypt: (t: string) => (t.endsWith("0003") ? "Sameer Patil" : "Ramesh Kumar"),
      } as unknown as PiiCryptoService,
    );
    const page = await svc.decorate([{ workerId: LINKED }, { workerId: RICH }], TENANT);
    expect(page.map((r) => r.source)).toEqual(["rvm_student", "badabhai_worker"]);
    for (const row of page) for (const key of PRE_PAY_FACT_KEYS) expect(row).toHaveProperty(key);
    expect(page[0]).toMatchObject({
      tradeLine: "Diploma in CNC",
      area: "Nashik",
      firstName: "Sameer",
    });
    expect(page[1]).toMatchObject({ area: "Pune", expectedSalary: "₹20,000 – ₹26,000 / day" });
  });

  it("#2747 §3.8 — the brief-notice column reads the LATEST consent row's version", async () => {
    const [real] = await repo.listForWorkers([RICH]);
    expect(real!.onBriefNotice).toBe(false);
    const [asTest] = await repo.listForWorkers([RICH], { briefNoticeVersions: ["test"] });
    expect(asTest!.onBriefNotice).toBe(true);
    // SPARSE's latest row has no employer_sharing: never on the brief notice, whatever the list.
    const [sparse] = await repo.listForWorkers([SPARSE], { briefNoticeVersions: ["test"] });
    expect(sparse!.onBriefNotice).toBe(false);
  });

  it("reads nothing for an empty page", async () => {
    expect(await repo.listForWorkers([])).toEqual([]);
    expect(await repo.listActiveInstituteLinks([])).toEqual([]);
  });
});
