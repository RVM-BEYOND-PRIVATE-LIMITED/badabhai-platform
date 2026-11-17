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
import { CampusImportRefusal, importLedgerExists, openBatch, type OpenBatch } from "./import-ledger.repository";
import { readCampusBundle } from "./read-bundle";
import { buildSyntheticBundle } from "./synthetic-bundle";

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
 *    line per bundle line, valid 30 days, the free tier not converted, and a rerun grants nothing.
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
