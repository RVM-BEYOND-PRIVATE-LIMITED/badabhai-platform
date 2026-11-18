import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { createDbClient, type DbClient } from "@badabhai/db";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { PayersRepository } from "../payers.repository";
import { PayerPhoneProofsRepository } from "../payer-phone-proofs.repository";
import type { CampusBundle } from "./bundle.schema";
import { importCompanies, type CompanyImportDeps } from "./import-companies";
import { importBalances } from "./import-balances";
import { importJobs, UnheldPostingError, type JobImportDeps } from "./import-jobs";
import { buildJobImportDeps, buildRollbackDeps } from "./job-import-wiring";
import { rollbackCompanyImport } from "./rollback";
import { writeRow } from "./import-ledger.repository";
import { importApplications } from "./import-applications";
import { CampusImportRefusal, importLedgerExists, openBatch, type OpenBatch } from "./import-ledger.repository";
import { readCampusBundle } from "./read-bundle";
import { buildSyntheticBundle } from "./synthetic-bundle";
import { compareSides, readBadaBhaiFacts } from "./verify-report";

/**
 * #2754 item 6 — placing Campus companies on BadaBhai accounts, against a REAL Postgres (the
 * throwaway CI service, or a throwaway local database; never a shared one). What only a database
 * can prove:
 *
 *  - a batch CREATES each company once: account `pending`, the employer profile, Campus's proven
 *    phone recorded as proven (`campus_import`), the test mark with its event, one ledger row each;
 *    and grants NO credits (the sign-up grant does not fire);
 *  - a SECOND RUN of the batch adds nothing, and a NEW batch over the same people MATCHES their
 *    accounts (by phone, by e-mail, by GSTIN) instead of creating a second one;
 *  - a phone two BadaBhai accounts already share, or a matched archived account, is an exception
 *    with no account written;
 *  - a batch key is bound to its bundle and its test flag, and a rolled-back key is spent;
 *  - (item 9) unused Campus CV views become ONE `migrated` lot and ONE `campus_conversion` ledger
 *    line per bundle line, valid 30 days, the free tier not converted, and a rerun grants nothing;
 *  - (item 7) each live job becomes ONE open posting of its company through Campus's own creator,
 *    approved for RVM students by the batch; a rerun adds nothing; a posting that comes out without
 *    #2891's worker hold is closed and the step stops; an interrupted creation is never repeated.
 *    The hold itself is #2891's table, absent on main until its migration lands, so these tests
 *    inject the hold check (`isHeld`); the wiring reads the table;
 *  - (items 8, 9) an application moves only for a linked or moved RVM student or an outside
 *    candidate who already has a consenting BadaBhai account: with its Campus date, its stage, the
 *    Campus record for a student, and a contact the company had opened carried over for good and
 *    free; everyone else is held with no personal detail; a rerun adds nothing.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);

/** A synthetic bundle, read through the real reader with every check on (in memory). */
function bundleOf(seed: string, companies: number, phones?: string[]): CampusBundle {
  const { manifest, texts } = buildSyntheticBundle({ companies, seed, phones });
  const files = new Map<string, Buffer>([
    [join("/b", "manifest.json"), Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(texts).map(([n, t]) => [join("/b", n), Buffer.from(t)] as [string, Buffer]),
  ]);
  return readCampusBundle("/b", (p) => {
    const bytes = files.get(p);
    if (!bytes) throw new Error("ENOENT");
    return bytes;
  });
}

// Each test makes several transactions; CI runs every DB gate at once, far slower than a laptop.
describe.skipIf(!RUN)("Campus company import against Postgres (#2754 item 6)", { timeout: 120_000 }, () => {
  let client!: DbClient;
  let config!: ServerConfig;
  let pii!: PiiCryptoService;
  let deps!: CompanyImportDeps;
  const batchKeys: string[] = [];
  const extraPayers: string[] = [];
  const extraWorkers: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    config = loadServerConfig({ NODE_ENV: "test" });
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: `campus-import-${TAG}`,
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } as unknown as ServerConfig);
    deps = {
      db: client.db,
      pii,
      payers: new PayersRepository(client.db, pii),
      phoneProofs: new PayerPhoneProofsRepository(client.db),
      events: new EventsService(new EventsRepository(client.db), config),
    };
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    try {
      const keys = batchKeys.map((k) => `${k}-${TAG}`);
      const rows = await sql<{ target_id: string }[]>`
        SELECT r.target_id FROM company_import_rows r
          JOIN company_import_batches b ON b.id = r.batch_id
         WHERE b.batch_key = ANY(${keys}::text[]) AND r.kind = 'company' AND r.target_id IS NOT NULL`;
      const ids = [...new Set([...rows.map((r) => r.target_id), ...extraPayers])];
      await sql`
        DELETE FROM company_import_rows
         WHERE batch_id IN (SELECT id FROM company_import_batches WHERE batch_key = ANY(${keys}::text[]))`;
      await sql`DELETE FROM company_import_batches WHERE batch_key = ANY(${keys}::text[])`;
      await sql`
        DELETE FROM events
         WHERE event_name = 'admin.payer_test_account_marked' AND payload->>'payer_id' = ANY(${ids}::text[])`;
      await sql`DELETE FROM unlocks WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM workers WHERE id = ANY(${extraWorkers}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM credit_lots WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM employer_profiles WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${ids}::uuid[])`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  async function open(key: string, bundle: CampusBundle, isTest = true): Promise<OpenBatch> {
    if (!batchKeys.includes(key)) batchKeys.push(key);
    return openBatch(client.db, {
      batchKey: `${key}-${TAG}`,
      bundleFormat: bundle.manifest.format,
      bundleVersion: bundle.manifest.version,
      bundleGeneratedAt: new Date(bundle.manifest.generated_at),
      manifestSha256: bundle.manifestSha256,
      isTest,
      runBy: "db-test",
      manifestCounts: bundle.manifest.counts,
    });
  }

  const opts = { agentSourceIds: new Set<string>(), testReason: "pilot_test" as const };

  it("the ledger tables exist (migration company_import applied)", async () => {
    expect(await importLedgerExists(client.db)).toBe(true);
  });

  it("creates each company once, with its profile, proof, test mark and ledger row, and no credits", async () => {
    const bundle = bundleOf(`create-${TAG}`, 3);
    const batch = await open("create", bundle);
    const summary = await importCompanies(deps, batch, bundle, opts);
    expect(summary).toMatchObject({ created: 3, matched: 0, alreadyDone: 0, exceptions: {} });
    const ids = [...summary.placed.values()];
    expect(ids).toHaveLength(3);

    const { sql } = client;
    const accounts = await sql<
      { status: string; is_test_account: boolean; verification_status: string; method: string | null }[]
    >`
      SELECT p.status, p.is_test_account, e.verification_status, pp.method
        FROM payers p
        JOIN employer_profiles e ON e.payer_id = p.id
        LEFT JOIN payer_phone_proofs pp ON pp.payer_id = p.id
       WHERE p.id = ANY(${ids}::uuid[])
       ORDER BY p.created_at`;
    expect(accounts.map((a) => a.status)).toEqual(["pending", "pending", "pending"]);
    expect(accounts.every((a) => a.is_test_account)).toBe(true);
    expect(accounts.map((a) => a.verification_status).sort()).toEqual(["pending", "verified", "verified"]);
    // Companies 1 and 2 had Campus's proven owner phone; company 3 is e-mail only.
    expect(accounts.filter((a) => a.method === "campus_import")).toHaveLength(2);

    const credits = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger WHERE payer_id = ANY(${ids}::uuid[])`)[0]!.n;
    expect(credits).toBe(0);
    const marks = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
       WHERE event_name = 'admin.payer_test_account_marked' AND payload->>'payer_id' = ANY(${ids}::text[])`)[0]!.n;
    expect(marks).toBe(3);
    const rows = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM company_import_rows
       WHERE batch_id = ${batch.id} AND kind = 'company' AND state = 'created'`)[0]!.n;
    expect(rows).toBe(3);
  });

  it("a second run of the batch adds nothing", async () => {
    const bundle = bundleOf(`create-${TAG}`, 3);
    const batch = await open("create", bundle);
    expect(batch.resumed).toBe(true);
    const summary = await importCompanies(deps, batch, bundle, opts);
    expect(summary).toMatchObject({ created: 0, matched: 0, alreadyDone: 3 });
    expect(summary.placed.size).toBe(3);
  });

  it("converts unused CV views into one migrated lot per line, once, and not the free tier", async () => {
    const bundle = bundleOf(`create-${TAG}`, 3);
    const batch = await open("create", bundle);
    const placed = (await importCompanies(deps, batch, bundle, opts)).placed;
    const first = await importBalances(client.db, batch, bundle, placed, { planQuota: {}, validityDays: 30 });
    expect(first).toEqual({
      converted: 3,
      credits: 54,
      alreadyDone: 0,
      notConverted: { free_tier_not_converted: 3 },
    });
    const ids = [...placed.values()];
    const { sql } = client;
    const lots = await sql<{ source: string; credits_granted: number; is_test: boolean; days: number; reason: string; key: string }[]>`
      SELECT l.source, l.credits_granted, l.is_test,
             round(extract(epoch FROM (l.expires_at - l.created_at)) / 86400)::int AS days,
             g.reason, g.idempotency_key AS key
        FROM credit_lots l JOIN credit_ledger g ON g.lot_id = l.id
       WHERE l.payer_id = ANY(${ids}::uuid[])`;
    expect(lots).toHaveLength(3);
    for (const lot of lots) {
      expect(lot).toMatchObject({ source: "migrated", credits_granted: 18, is_test: true, days: 30, reason: "campus_conversion" });
      expect(lot.key).toMatch(/^campus_conversion:campus:cv_views_left_on_plan_jobs:/);
    }
    const balances = await sql<{ balance: number }[]>`
      SELECT balance FROM payer_credits WHERE payer_id = ANY(${ids}::uuid[])`;
    expect(balances.map((b) => b.balance)).toEqual([18, 18, 18]);

    const again = await importBalances(client.db, batch, bundle, placed, { planQuota: {}, validityDays: 30 });
    expect(again).toMatchObject({ converted: 0, credits: 0, alreadyDone: 3 });
    const lotCount = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_lots WHERE payer_id = ANY(${ids}::uuid[])`)[0]!.n;
    expect(lotCount).toBe(3);
  });

  it("a line of a company the import did not place converts nothing", async () => {
    const bundle = bundleOf(`unplaced-${TAG}`, 1);
    const batch = await open("unplaced", bundle);
    const summary = await importBalances(client.db, batch, bundle, new Map(), { planQuota: {}, validityDays: 30 });
    expect(summary).toMatchObject({ converted: 0, notConverted: { company_not_placed: 1, free_tier_not_converted: 1 } });
  });

  // Event envelopes need a uuid correlation id (the CLI passes the batch id).
  const ctx = { requestId: `campus-import-db-${TAG}`, correlationId: randomUUID() };
  /** The real wiring (its own hold check); `held: false` stands in a creator that forgot the hold. */
  function jobDeps(held: boolean): JobImportDeps {
    const real = buildJobImportDeps(client.db, config, deps.events);
    return held ? real : { ...real, isHeld: async () => false };
  }

  it("imports each live job once as an open, RVM-approved posting of its company; a rerun adds nothing", async () => {
    const bundle = bundleOf(`jobs-${TAG}`, 2);
    const batch = await open("jobs", bundle);
    const placed = (await importCompanies(deps, batch, bundle, opts)).placed;
    const first = await importJobs(jobDeps(true), batch, bundle, placed, ctx);
    expect(first).toMatchObject({
      created: 2,
      alreadyDone: 0,
      notMoved: { job_paused: 2, job_past_expiry: 2 },
    });
    const postingIds = [...first.placed.values()];
    const { sql } = client;
    const rows = await sql<{ status: string; payer_id: string; review: string; reviewer: string }[]>`
      SELECT jp.status, jp.payer_id, r.state AS review, r.reviewer_ref AS reviewer
        FROM job_postings jp
        JOIN job_posting_institute_reviews r ON r.job_posting_id = jp.id
       WHERE jp.id = ANY(${postingIds}::uuid[])`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "open", review: "approved", reviewer: batch.id });
      expect([...placed.values()]).toContain(r.payer_id);
    }
    // #2891 — each imported posting is held from BadaBhai workers, as an imported Campus job.
    const holds = await sql<{ state: string; origin: string }[]>`
      SELECT state, origin FROM job_posting_worker_visibility WHERE job_posting_id = ANY(${postingIds}::uuid[])`;
    expect(holds).toEqual([
      { state: "off", origin: "campus_imported" },
      { state: "off", origin: "campus_imported" },
    ]);
    const again = await importJobs(jobDeps(true), batch, bundle, placed, ctx);
    expect(again).toMatchObject({ created: 0, alreadyDone: 2 });
    const count = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_postings WHERE payer_id = ANY(${[...placed.values()]}::uuid[])`)[0]!.n;
    expect(count).toBe(2);
  });

  it("a posting that comes out without the worker hold is closed, and the jobs step stops", async () => {
    const bundle = bundleOf(`unheld-${TAG}`, 1);
    const batch = await open("unheld", bundle);
    const placed = (await importCompanies(deps, batch, bundle, opts)).placed;
    await expect(importJobs(jobDeps(false), batch, bundle, placed, ctx)).rejects.toThrow(UnheldPostingError);
    const { sql } = client;
    const [row] = await sql<{ state: string; reason: string; posting: string }[]>`
      SELECT state, reason, detail->>'posting_id' AS posting FROM company_import_rows
       WHERE batch_id = ${batch.id} AND kind = 'job' AND reason = 'posting_not_held_closed'`;
    expect(row).toMatchObject({ state: "exception" });
    const status = (await sql<{ status: string }[]>`SELECT status FROM job_postings WHERE id = ${row!.posting}`)[0]!.status;
    expect(status).toBe("closed");
  });

  it("an interrupted creation is never repeated: it waits for a person", async () => {
    const bundle = bundleOf(`interrupted-${TAG}`, 1);
    const batch = await open("interrupted", bundle);
    const placed = (await importCompanies(deps, batch, bundle, opts)).placed;
    const live = bundle.jobs.find((j) => j.status === "active" && !j.past_expiry)!;
    await client.db.transaction((tx) =>
      writeRow(tx as never, {
        batchId: batch.id,
        kind: "job",
        sourceId: live.source_id,
        companySourceId: live.company_source_id,
        state: "held",
        targetId: null,
        reason: "creating",
        detail: {},
      }),
    );
    for (let run = 0; run < 2; run += 1) {
      const summary = await importJobs(jobDeps(true), batch, bundle, placed, ctx);
      expect(summary.created).toBe(0);
      expect(summary.notMoved.interrupted_creation).toBe(1);
    }
    const count = (await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_postings WHERE payer_id = ANY(${[...placed.values()]}::uuid[])`)[0]!.n;
    expect(count).toBe(0);
  });

  /** A BadaBhai worker on this 10-digit phone, consenting to employer sharing unless told not to. */
  async function seedWorker(phone10: string, consents = true): Promise<string> {
    const id = randomUUID();
    extraWorkers.push(id);
    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:campus-import-${TAG}-${id}`}, ${pii.hashPhone(`+91${phone10}`)}, 'active')`;
    if (consents) {
      await client.sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
        VALUES (${id}::uuid, 'test', ${JSON.stringify(["employer_sharing"])}::jsonb, now() - interval '1 day')`;
    }
    return id;
  }

  it("moves a consenting outside candidate and a linked student, with date, stage and carried access; a rerun adds nothing", async () => {
    const bundle = bundleOf(`apps-${TAG}`, 1);
    const external = bundle.applications.find((a) => a.candidate.kind === "external")!;
    const student = bundle.applications.find((a) => a.candidate.kind === "rvm_student")!;
    const externalWorker = await seedWorker((external.candidate as { phone: string }).phone);
    const studentWorker = await seedWorker("6000000000".slice(0, 2) + TAG.replace(/[^0-9]/g, "1").padEnd(8, "1").slice(0, 8));
    await client.sql`
      INSERT INTO worker_institute_links (worker_id, institute_code, student_ref, status, synced_at)
      VALUES (${studentWorker}::uuid, 'rvm', ${(student.candidate as { student_ref: string }).student_ref.toLowerCase()}, 'active', now())`;

    const batch = await open("apps", bundle);
    const companies = (await importCompanies(deps, batch, bundle, opts)).placed;
    const jobs = (await importJobs(jobDeps(true), batch, bundle, companies, ctx)).placed;
    const first = await importApplications(client.db, pii, batch, bundle, companies, jobs);
    expect(first).toMatchObject({ moved: 2, alreadyDone: 0, held: {}, skipped: {}, stages: { shortlist: 1, new: 1 }, carriedAccess: 1 });

    const { sql } = client;
    const companyId = companies.get(external.company_source_id)!;
    const postingId = jobs.get(external.job_source_id)!;
    const apps = await sql<{ worker_id: string; created_at: Date }[]>`
      SELECT worker_id, created_at FROM applications WHERE job_posting_id = ${postingId} AND action = 'applied'`;
    expect(apps.map((a) => a.worker_id).sort()).toEqual([externalWorker, studentWorker].sort());
    for (const a of apps) expect(new Date(a.created_at).toISOString()).toBe(new Date(external.applied_at).toISOString());
    const stage = await sql<{ stage: string; actor: string }[]>`
      SELECT stage, actor_payer_id AS actor FROM payer_applicant_stages WHERE posting_id = ${postingId}`;
    expect(stage).toEqual([{ stage: "shortlist", actor: companyId }]);
    const opened = await sql<{ status: string; expires: Date; worker_id: string }[]>`
      SELECT status, expires_at AS expires, worker_id FROM unlocks WHERE payer_id = ${companyId}`;
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ status: "granted", worker_id: externalWorker });
    expect(new Date(opened[0]!.expires).getUTCFullYear()).toBe(2099);
    const credits = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM credit_ledger WHERE payer_id = ${companyId} AND reason <> 'campus_conversion'`)[0]!.n;
    expect(credits).toBe(0);
    const record = await sql<{ ref: string; owns: boolean }[]>`
      SELECT external_ref AS ref, owns_application AS owns FROM institute_applications WHERE worker_id = ${studentWorker}`;
    expect(record).toEqual([{ ref: student.source_id, owns: true }]);

    const again = await importApplications(client.db, pii, batch, bundle, companies, jobs);
    expect(again).toMatchObject({ moved: 0, alreadyDone: 2, carriedAccess: 0 });
    const count = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM applications WHERE job_posting_id = ${postingId}`)[0]!.n;
    expect(count).toBe(2);
  });

  it("holds an applicant with no BadaBhai account, or no consent, and stores nothing personal about him", async () => {
    const bundle = bundleOf(`held-${TAG}`, 1);
    const external = bundle.applications.find((a) => a.candidate.kind === "external")!;
    const batch = await open("held", bundle);
    const companies = (await importCompanies(deps, batch, bundle, opts)).placed;
    const jobs = (await importJobs(jobDeps(true), batch, bundle, companies, ctx)).placed;
    const first = await importApplications(client.db, pii, batch, bundle, companies, jobs);
    expect(first).toMatchObject({ moved: 0, held: { no_badabhai_account: 1, rvm_student_not_moved: 1 } });
    const rows = await client.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM company_import_rows WHERE batch_id = ${batch.id} AND kind = 'application'`;
    const printed = JSON.stringify(rows);
    expect(printed).not.toContain((external.candidate as { phone: string }).phone);
    expect(printed).not.toContain((external.candidate as { name: string }).name);

    // He joins BadaBhai without consenting to employer sharing: still held, for that reason.
    await seedWorker((external.candidate as { phone: string }).phone, false);
    const again = await importApplications(client.db, pii, batch, bundle, companies, jobs);
    expect(again.held).toMatchObject({ no_badabhai_consent: 1, rvm_student_not_moved: 1 });
  });

  it("the verification report reads both sides from the database, and catches a posting closed since", async () => {
    const bundle = bundleOf(`report-${TAG}`, 1);
    const batch = await open("report", bundle);
    const companies = (await importCompanies(deps, batch, bundle, opts)).placed;
    await importBalances(client.db, batch, bundle, companies, { planQuota: {}, validityDays: 30 });
    const jobs = (await importJobs(jobDeps(true), batch, bundle, companies, ctx)).placed;
    await importApplications(client.db, pii, batch, bundle, companies, jobs);

    const clean = compareSides(bundle, {}, await readBadaBhaiFacts(client.db, bundle));
    expect(clean.totals).toMatchObject({
      companies: 1,
      companiesOnBadaBhai: 1,
      campusLiveJobs: 1,
      badabhaiOpenPostings: 1,
      campusApplicants: 2,
      badabhaiApplicantsMoved: 0,
      badabhaiApplicantsHeld: 2,
      campusCredits: 18,
      badabhaiCredits: 18,
      unexplained: 0,
    });
    expect(clean.differences.map((d) => d.code).sort()).toEqual(["no_badabhai_account", "rvm_student_not_moved"]);

    const postingId = [...jobs.values()][0]!;
    await client.sql`UPDATE job_postings SET status = 'closed', closed_at = now() WHERE id = ${postingId}::uuid`;
    const after = compareSides(bundle, {}, await readBadaBhaiFacts(client.db, bundle));
    expect(after.differences.filter((d) => !d.explained)).toEqual([
      expect.objectContaining({ scope: "job", code: "posting_closed", badabhai: `posting:${postingId}` }),
    ]);
  });

  it("the rollback rehearsal returns the stack to its starting counts, once, and spends the key", async () => {
    const bundle = bundleOf(`rollback-${TAG}`, 1);
    const external = bundle.applications.find((a) => a.candidate.kind === "external")!;
    const student = bundle.applications.find((a) => a.candidate.kind === "rvm_student")!;
    const externalWorker = await seedWorker((external.candidate as { phone: string }).phone);
    const studentWorker = await seedWorker(`9${String(Date.now()).slice(-9)}`);
    await client.sql`
      INSERT INTO worker_institute_links (worker_id, institute_code, student_ref, status, synced_at)
      VALUES (${studentWorker}::uuid, 'rvm', ${(student.candidate as { student_ref: string }).student_ref.toLowerCase()}, 'active', now())`;
    const hashes = bundle.companies
      .map((c) => c.proven_phone.value)
      .filter((p): p is string => p !== null)
      .map((p) => pii.hashPhone(`+91${p}`));
    const workerIds = [externalWorker, studentWorker];
    // Scoped to this test's companies and workers: CI runs every DB gate on one database at once.
    const counts = async () => {
      const [row] = await client.sql<Record<string, number>[]>`
        WITH acct AS (SELECT id, status FROM payers WHERE phone_hash = ANY(${hashes}::text[]))
        SELECT
          (SELECT count(*)::int FROM acct WHERE status <> 'archived') AS active_accounts,
          (SELECT count(*)::int FROM job_postings WHERE payer_id IN (SELECT id FROM acct) AND status = 'open') AS open_postings,
          (SELECT coalesce(sum(balance), 0)::int FROM payer_credits WHERE payer_id IN (SELECT id FROM acct)) AS credits,
          (SELECT count(*)::int FROM applications WHERE worker_id = ANY(${workerIds}::uuid[])) AS applications,
          (SELECT count(*)::int FROM institute_applications WHERE worker_id = ANY(${workerIds}::uuid[])) AS campus_records,
          (SELECT count(*)::int FROM unlocks WHERE worker_id = ANY(${workerIds}::uuid[]) AND status = 'granted' AND expires_at > now()) AS opened`;
      return row!;
    };
    const before = await counts();

    const batch = await open("rollback", bundle);
    const companies = (await importCompanies(deps, batch, bundle, opts)).placed;
    await importBalances(client.db, batch, bundle, companies, { planQuota: {}, validityDays: 30 });
    const jobs = (await importJobs(jobDeps(true), batch, bundle, companies, ctx)).placed;
    expect(await importApplications(client.db, pii, batch, bundle, companies, jobs)).toMatchObject({ moved: 2, carriedAccess: 1 });
    expect(await counts()).toEqual({ active_accounts: 1, open_postings: 1, credits: 18, applications: 2, campus_records: 1, opened: 1 });
    // The company spends one converted credit before the rollback: it stays spent.
    const payerId = [...companies.values()][0]!;
    await client.sql`UPDATE credit_lots SET credits_remaining = credits_remaining - 1 WHERE payer_id = ${payerId}::uuid`;
    await client.sql`UPDATE payer_credits SET balance = balance - 1 WHERE payer_id = ${payerId}::uuid`;

    const rollbackDeps = buildRollbackDeps(client.db, config, deps.events);
    const summary = await rollbackCompanyImport(rollbackDeps, `rollback-${TAG}`, "db-test");
    expect(summary).toMatchObject({
      alreadyRolledBack: false,
      access: { ended: 1, keptExisting: 0 },
      applications: { removed: 2, keptExisting: 0 },
      postings: { closed: 1, alreadyClosed: 0, notCloseable: 0 },
      balances: { reversed: 1, creditsTakenBack: 17, creditsAlreadySpent: 1, notReversed: {} },
      accounts: { archived: 1, alreadyArchived: 0, keptExisting: 0, keptInUse: 0 },
    });
    expect(await counts()).toEqual(before);

    const { sql } = client;
    const postingId = [...jobs.values()][0]!;
    const events = await sql<{ name: string; subject: string }[]>`
      SELECT event_name AS name, subject_id AS subject FROM events
       WHERE (event_name = 'payer.archived' AND subject_id = ${payerId})
          OR (event_name = 'job_posting.closed' AND subject_id = ${postingId})`;
    expect(events.map((e) => e.name).sort()).toEqual(["job_posting.closed", "payer.archived"]);
    const reversal = await sql<{ delta: number; reason: string }[]>`
      SELECT delta, reason FROM credit_ledger WHERE payer_id = ${payerId}::uuid AND reason = 'campus_conversion_reversed'`;
    expect(reversal).toEqual([{ delta: -17, reason: "campus_conversion_reversed" }]);
    const ledger = await sql<{ state: string; n: number }[]>`
      SELECT state, count(*)::int AS n FROM company_import_rows WHERE batch_id = ${batch.id} AND target_id IS NOT NULL GROUP BY state`;
    expect(ledger).toEqual([{ state: "rolled_back", n: 6 }]);
    const [b] = await sql<{ state: string; by: string }[]>`
      SELECT state, rolled_back_by AS by FROM company_import_batches WHERE id = ${batch.id}`;
    expect(b).toEqual({ state: "rolled_back", by: "db-test" });

    // Run again: nothing to do. The key is spent, and a new batch finds the archived account.
    expect((await rollbackCompanyImport(rollbackDeps, `rollback-${TAG}`, "db-test")).alreadyRolledBack).toBe(true);
    await expect(open("rollback", bundle)).rejects.toThrow(CampusImportRefusal);
    const again = await importCompanies(deps, await open("rollback-again", bundle), bundle, opts);
    expect(again).toMatchObject({ created: 0, matched: 0, exceptions: { matched_account_archived: 1 } });
  });

  it("a rollback keeps an account the batch only matched, and one in use on its own", async () => {
    const first = bundleOf(`keep-a-${TAG}`, 1);
    const batchA = await open("keep-a", first);
    const companiesA = (await importCompanies(deps, batchA, first, opts)).placed;
    const jobsA = (await importJobs(jobDeps(true), batchA, first, companiesA, ctx)).placed;
    const payerId = [...companiesA.values()][0]!;
    // The company posts a job of its own on BadaBhai (a copy of the imported one, as a draft;
    // every stored column but the id, the status and the generated ones).
    const cols = (
      await client.sql<{ name: string }[]>`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'job_postings' AND is_generated = 'NEVER'
           AND column_name NOT IN ('id', 'status')`
    ).map((c) => `"${c.name}"`);
    await client.sql.unsafe(
      `INSERT INTO job_postings (${cols.join(", ")}, status)
       SELECT ${cols.join(", ")}, 'draft' FROM job_postings WHERE id = $1::uuid`,
      [[...jobsA.values()][0]!],
    );

    const phones = first.companies.map((c) => c.proven_phone.value).filter((p): p is string => p !== null);
    const second = bundleOf(`keep-b-${TAG}`, 1, phones);
    const batchB = await open("keep-b", second);
    const companiesB = (await importCompanies(deps, batchB, second, opts)).placed;
    expect(companiesB.get(second.companies[0]!.source_id)).toBe(payerId);
    await importBalances(client.db, batchB, second, companiesB, { planQuota: {}, validityDays: 30 });

    const rollbackDeps = buildRollbackDeps(client.db, config, deps.events);
    const b = await rollbackCompanyImport(rollbackDeps, `keep-b-${TAG}`, "db-test");
    expect(b).toMatchObject({
      accounts: { archived: 0, keptExisting: 1, keptInUse: 0 },
      balances: { reversed: 1, creditsTakenBack: 18, creditsAlreadySpent: 0 },
    });
    const a = await rollbackCompanyImport(rollbackDeps, `keep-a-${TAG}`, "db-test");
    expect(a).toMatchObject({ postings: { closed: 1 }, accounts: { archived: 0, keptInUse: 1 } });
    const [acct] = await client.sql<{ status: string }[]>`SELECT status FROM payers WHERE id = ${payerId}::uuid`;
    expect(acct!.status).not.toBe("archived");
  });

  it("a new batch over the same phones matches the accounts instead of creating new ones", async () => {
    const first = bundleOf(`create-${TAG}`, 3);
    const phones = first.companies.map((c) => c.proven_phone.value).filter((p): p is string => p !== null);
    const again = bundleOf(`again-${TAG}`, 2, phones);
    const batch = await open("again", again);
    const summary = await importCompanies(deps, batch, again, opts);
    expect(summary).toMatchObject({ created: 0, matched: 2, exceptions: {} });
    const { sql } = client;
    const by = await sql<{ by: string }[]>`
      SELECT detail->>'matched_by' AS by FROM company_import_rows WHERE batch_id = ${batch.id}`;
    expect(by.map((r) => r.by)).toEqual(["phone", "phone"]);
  });

  it("matches by e-mail, then by GSTIN, when the phone finds no one", async () => {
    const bundle = bundleOf(`match-${TAG}`, 2);
    const [c1, c2] = bundle.companies;
    // Company 1's owner e-mail already has an account (no phone).
    const byEmail = await deps.payers.create({ role: "employer", orgName: `Email Co ${TAG}`, email: c1!.contact.email! });
    // Company 2's GSTIN is already on an employer profile (no phone, another e-mail).
    const gstin = `27ABCDE${TAG.replace(/[^0-9]/g, "0").slice(0, 4)}F1Z5`;
    const byGst = await deps.payers.create({ role: "employer", orgName: `Gst Co ${TAG}`, email: `gst-${TAG}@example.invalid` });
    extraPayers.push(byEmail.id, byGst.id);
    await client.sql`
      INSERT INTO employer_profiles (payer_id, gst_number_hash) VALUES (${byGst.id}, ${pii.hashGstin(gstin)})`;
    (c2 as { gst: { gstin: string | null } }).gst = { gstin };
    // Remove the phones, so the match must fall through to e-mail and GSTIN.
    for (const c of [c1!, c2!]) {
      (c as { proven_phone: unknown }).proven_phone = { value: null, verified_at: null };
      (c as { sign_in_phone: unknown }).sign_in_phone = { value: null, class: "missing", source: null };
    }
    (c2 as { contact: unknown }).contact = { name: null, email: `other-${TAG}@example.invalid`, phone: null };
    const batch = await open("match", bundle);
    const summary = await importCompanies(deps, batch, { ...bundle, logins: [] }, opts);
    expect(summary).toMatchObject({ created: 0, matched: 2 });
    expect(summary.placed.get(c1!.source_id)).toBe(byEmail.id);
    expect(summary.placed.get(c2!.source_id)).toBe(byGst.id);
  });

  it("a phone two accounts already share, and an archived match, are exceptions with nothing written", async () => {
    const bundle = bundleOf(`except-${TAG}`, 2);
    const [c1, c2] = bundle.companies;
    const shared = `+91${c1!.proven_phone.value}`;
    const a = await deps.payers.create({ role: "employer", orgName: `Shared A ${TAG}`, phone: shared });
    const b = await deps.payers.create({ role: "employer", orgName: `Shared B ${TAG}`, phone: shared });
    const archived = await deps.payers.create({
      role: "employer",
      orgName: `Archived ${TAG}`,
      phone: `+91${c2!.proven_phone.value}`,
    });
    extraPayers.push(a.id, b.id, archived.id);
    await client.sql`UPDATE payers SET status = 'archived' WHERE id = ${archived.id}`;
    const batch = await open("except", bundle);
    const summary = await importCompanies(deps, batch, bundle, opts);
    expect(summary).toMatchObject({
      created: 0,
      matched: 0,
      exceptions: { phone_shared_on_badabhai: 1, matched_account_archived: 1 },
    });
    const n = (await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM company_import_rows WHERE batch_id = ${batch.id} AND target_id IS NOT NULL`)[0]!.n;
    expect(n).toBe(0);
  });

  it("binds a batch key to its bundle and test flag, and a rolled-back key is spent", async () => {
    const bundle = bundleOf(`key-${TAG}`, 1);
    const other = bundleOf(`key-other-${TAG}`, 1);
    await open("key", bundle);
    await expect(open("key", other)).rejects.toThrow(CampusImportRefusal);
    await expect(open("key", bundle, false)).rejects.toThrow(/--test/);
    await client.sql`
      UPDATE company_import_batches SET state = 'rolled_back', rolled_back_at = now(), rolled_back_by = 'db-test'
       WHERE batch_key = ${`key-${TAG}`}`;
    await expect(open("key", bundle)).rejects.toThrow(/rolled back/);
  });
});
