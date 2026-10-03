import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, count, eq, inArray } from "drizzle-orm";

import { createDbClient, type DbClient } from "./client";
import { decryptPii, decryptPiiWithKeyring, encryptPii, encryptPiiWithKeyring } from "./crypto";
import { hostClass } from "./ops-guard";
import { piiCodec } from "./pii-keyring-env";
import { workerEducations, workerEmployment, workerEmploymentRole, workers } from "./schema";
import {
  buildTargets,
  runTitleCaseBackfill,
  type TitleCaseColumn,
  type TitleCaseRunOptions,
  type TitleCaseRunResult,
} from "./title-case-backfill";

/**
 * #1432 — the title-case backfill against a REAL Postgres, through the real drizzle driver.
 *
 * What only a database can show: that a dry run writes NOTHING (every column of every row, and
 * every `updated_at`, identical afterwards); that `--apply` fixes the lowercase rows across several
 * batches and leaves a correct row BYTE-IDENTICAL — for the encrypted column that means the very
 * same ciphertext, which is only true if the row was never written; that a re-run changes nothing;
 * that a token which will not decrypt is skipped and counted; that the optimistic
 * `WHERE id = ? AND col = ?` really refuses a row that moved since it was read; and that an
 * `--apply` whose write key no stored token proves refuses before it writes anything.
 *
 * ── CI DOES NOT RUN THIS FILE. The DB-backed gate step in ci.yml runs a fixed list of apps/api
 *    suites; this one needs its own scratch URL. Run it by hand before changing the write path.
 *
 * ── IT RUNS THE BACKFILL OVER WHOLE TABLES, so it refuses any database that is not local and any
 *    whose three tables already hold rows, and it has NO default target — not even the local dev
 *    database. Point it at a scratch database, migrated from empty:
 *
 *   docker exec badabhai-postgres psql -U badabhai -d postgres -c "CREATE DATABASE bb_scratch_1432"
 *   DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/bb_scratch_1432 \
 *     pnpm --filter @badabhai/db db:migrate
 *   RUN_DB_TESTS=1 \
 *   TITLE_CASE_BACKFILL_DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/bb_scratch_1432 \
 *     pnpm --filter @badabhai/db exec vitest run title-case-backfill.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL = process.env.TITLE_CASE_BACKFILL_DATABASE_URL ?? "";

const LEGACY = Buffer.alloc(32, 21).toString("base64");
const K1 = Buffer.alloc(32, 22).toString("base64");
const K2 = Buffer.alloc(32, 23).toString("base64");
const FOREIGN = Buffer.alloc(32, 24).toString("base64");
/** The API's configuration under test: keyring armed, writing under k2, k1 still readable. */
const KEYRING = { activeKid: "k2", keys: { k1: K1, k2: K2 } };
const codec = piiCodec(LEGACY, KEYRING);
const decrypt = (token: string) => decryptPiiWithKeyring(token, KEYRING, LEGACY);

/** Every worker-typed string seeded below — none may ever appear in the runner's output. */
const PLAINTEXTS = [
  "recursive global infotech pvt ltd",
  "RVM CAD",
  "sandhar technologies",
  "lost key works",
  "unknown kid industries",
  "Acme Forgings",
  "cnc turner",
  "CNC Operator",
  "fitter",
  "helper",
  "Welder",
  "electrician",
  "Mechanical Engineering",
  "cnc programming",
  "Fitter",
  // …and what the run turns them into.
  "Recursive Global Infotech Pvt Ltd",
  "Sandhar Technologies",
  "Cnc Turner",
  "Helper",
  "Electrician",
  "Cnc Programming",
];

const randomPhone = () => `+9198${randomBytes(4).readUInt32BE(0) % 100_000_000}`;

const statsOf = (result: TitleCaseRunResult, name: TitleCaseColumn) =>
  result.columns.find((c) => c.name === name)!.stats;

async function insertWorker(client: DbClient, phoneE164: string): Promise<string> {
  const [row] = await client.db
    .insert(workers)
    .values({ phoneE164, phoneHash: randomBytes(32).toString("hex") })
    .returning({ id: workers.id });
  return row!.id;
}

/** A NAMED, LOCAL, EMPTY database — each suite runs the backfill over whole tables. */
async function openEmptyScratch(): Promise<DbClient> {
  expect(DATABASE_URL, "set TITLE_CASE_BACKFILL_DATABASE_URL to a scratch database").not.toBe("");
  expect(hostClass(DATABASE_URL), "refusing a non-local database").toBe("LOCAL DOCKER");
  const client = createDbClient(DATABASE_URL, { max: 1 });
  for (const table of [workerEmployment, workerEmploymentRole, workerEducations]) {
    const [{ n }] = (await client.db.select({ n: count() }).from(table)) as [{ n: number }];
    expect(n, "refusing a database whose target tables already hold rows").toBe(0);
  }
  return client;
}

describe.skipIf(!RUN)("title-case backfill against a real database (#1432)", () => {
  let client: DbClient;
  const workerIds: string[] = [];
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let phoneUnderActiveKid: string;

  async function seedWorker(phoneE164 = encryptPii(randomPhone(), LEGACY)): Promise<string> {
    const id = await insertWorker(client, phoneE164);
    workerIds.push(id);
    return id;
  }

  async function seedEmployment(
    key: string,
    workerId: string,
    token: string,
    sortOrder: number,
    roles: string[],
  ): Promise<void> {
    tokens[key] = token;
    const [emp] = await client.db
      .insert(workerEmployment)
      .values({ workerId, employerNameEnc: token, sortOrder, startYm: "2020-01" })
      .returning({ id: workerEmployment.id });
    ids[key] = emp!.id;
    for (const [i, roleLabel] of roles.entries()) {
      const [role] = await client.db
        .insert(workerEmploymentRole)
        .values({ employmentId: emp!.id, roleLabel, sortOrder: i })
        .returning({ id: workerEmploymentRole.id });
      ids[`${key}:role${i}`] = role!.id;
    }
  }

  async function seedEducation(
    key: string,
    workerId: string,
    sortOrder: number,
    values: { field: string | null; credential?: string },
  ): Promise<void> {
    const [row] = await client.db
      .insert(workerEducations)
      .values({ workerId, sortOrder, credential: values.credential ?? "ITI", field: values.field })
      .returning({ id: workerEducations.id });
    ids[key] = row!.id;
  }

  /** Every column of every row of the three tables — the "nothing else moved" oracle. */
  async function snapshot() {
    return {
      employment: await client.db.select().from(workerEmployment).orderBy(asc(workerEmployment.id)),
      roles: await client.db
        .select()
        .from(workerEmploymentRole)
        .orderBy(asc(workerEmploymentRole.id)),
      educations: await client.db.select().from(workerEducations).orderBy(asc(workerEducations.id)),
    };
  }

  async function run(
    apply: boolean,
    lines: string[],
    over: Partial<TitleCaseRunOptions> = {},
  ): Promise<TitleCaseRunResult> {
    return runTitleCaseBackfill(client.db, {
      apply,
      // Small on purpose: every column spans several batches, so paging and the per-batch
      // transaction are exercised rather than one page doing all the work.
      batchSize: 2,
      codec,
      columns: null,
      log: (line) => lines.push(line),
      ...over,
    });
  }

  beforeAll(async () => {
    client = await openEmptyScratch();

    const w1 = await seedWorker();
    const w2 = await seedWorker();
    // Already correct everywhere — must not count as affected. Its phone is the one token the API
    // has written under the ACTIVE kid k2, which is what lets an --apply write under k2 at all.
    phoneUnderActiveKid = encryptPiiWithKeyring(randomPhone(), KEYRING);
    const w3 = await seedWorker(phoneUnderActiveKid);

    // Lowercase, legacy v1 token: cased AND moved onto the active kid.
    await seedEmployment("e1", w1, encryptPii("recursive global infotech pvt ltd", LEGACY), 0, [
      "cnc turner",
      "helper",
    ]);
    // Already correct, legacy v1: must keep its exact token.
    await seedEmployment("e2", w1, encryptPii("RVM CAD", LEGACY), 1, ["CNC Operator"]);
    // A token under a key this deployment does not hold: skipped, counted, untouched.
    await seedEmployment("e3", w1, encryptPii("lost key works", FOREIGN), 2, ["fitter"]);
    // Lowercase, v2 under the OLD kid: cased and re-written under k2.
    await seedEmployment(
      "e4",
      w2,
      encryptPiiWithKeyring("sandhar technologies", { activeKid: "k1", keys: KEYRING.keys }),
      0,
      [],
    );
    // A v2 token naming a kid the keyring does not have.
    await seedEmployment(
      "e5",
      w2,
      encryptPiiWithKeyring("unknown kid industries", { activeKid: "k9", keys: { k9: FOREIGN } }),
      1,
      [],
    );
    await seedEmployment("e6", w3, encryptPii("Acme Forgings", LEGACY), 0, ["Welder"]);

    await seedEducation("ed1", w2, 0, { field: "electrician" });
    await seedEducation("ed2", w2, 1, { field: null, credential: "10th" });
    await seedEducation("ed3", w2, 2, { field: "Mechanical Engineering", credential: "Diploma" });
    await seedEducation("ed4", w1, 0, { field: "cnc programming" });
    await seedEducation("ed5", w3, 0, { field: "Fitter" });
  });

  afterAll(async () => {
    if (client === undefined) return; // refused before connecting
    // Employment, roles and educations go with their worker (ON DELETE CASCADE).
    if (workerIds.length) await client.db.delete(workers).where(inArray(workers.id, workerIds));
    await client.sql.end({ timeout: 5 });
  });

  let afterApply: Awaited<ReturnType<typeof snapshot>>;
  let seeded: Awaited<ReturnType<typeof snapshot>>;

  it("a DRY RUN counts the work and writes nothing at all", async () => {
    seeded = await snapshot();
    const lines: string[] = [];
    const result = await run(false, lines);

    expect(statsOf(result, "worker_employment.employer_name_enc")).toEqual({
      scanned: 6,
      unchanged: 2, // e2, e6
      change: 2, // e1, e4
      undecryptable: 2, // e3, e5
      written: 0,
      concurrentSkipped: 0,
    });
    expect(statsOf(result, "worker_employment_role.role_label")).toEqual({
      scanned: 5,
      unchanged: 2, // CNC Operator, Welder
      change: 3, // cnc turner, helper, fitter (its employer's name is unreadable; the label is not)
      undecryptable: 0,
      written: 0,
      concurrentSkipped: 0,
    });
    expect(statsOf(result, "worker_education.field")).toEqual({
      scanned: 4, // ed2's null field is not scanned
      unchanged: 2, // Mechanical Engineering, Fitter
      change: 2, // electrician, cnc programming
      undecryptable: 0,
      written: 0,
      concurrentSkipped: 0,
    });
    expect(result.workersAffected).toBe(2);
    // The stored k2 phone opens under this run's k2, so an --apply may write under it.
    expect(result.employerNameWrites).toBe("v2");
    expect(result.writeKey).toBe("proven");

    expect(await snapshot()).toEqual(seeded);
    // The two undecryptable rows are named by id, and only by id.
    expect(lines.filter((l) => l.includes("will not decrypt"))).toHaveLength(2);
    expect(lines.join("\n")).toContain(ids["e3"]!);
    expect(lines.join("\n")).not.toContain("would refuse");
  });

  it("--apply REFUSES an active kid no stored token proves, though the keyring's other kids are proven", async () => {
    // What a dev .env fills in: the API's two kids plus an active one the API has never written
    // under. Its dry run counts exactly what the API's own configuration counts — only the WARN
    // tells them apart — so the refusal is the only thing between it and unreadable employers.
    const devKeyring = {
      activeKid: "dev-laptop",
      keys: { ...KEYRING.keys, "dev-laptop": FOREIGN },
    };
    const devCodec = piiCodec(LEGACY, devKeyring);

    const lines: string[] = [];
    const dry = await run(false, lines, { codec: devCodec });
    expect(dry.writeKey).toBe("no-token");
    expect(statsOf(dry, "worker_employment.employer_name_enc")).toMatchObject({
      change: 2,
      undecryptable: 2,
    });
    expect(lines.filter((l) => l.includes("an --apply would refuse"))).toHaveLength(1);

    const refusal = await run(true, [], { codec: devCodec }).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(refusal).toContain("REFUSING TO WRITE: a keyring is configured");
    expect(refusal).not.toContain("dev-laptop");
    expect(await snapshot()).toEqual(seeded);
    // `--keyring-is-newly-armed` is exercised in the v1-only suite below.
  });

  it("--apply REFUSES, acknowledged or not, another key behind the API's own kid name", async () => {
    // The API's kid name k2 with other key bytes: the stored k2 phone does not open under it.
    const impostor = piiCodec(LEGACY, { activeKid: "k2", keys: { k1: K1, k2: FOREIGN } });
    for (const keyringNewlyArmed of [false, true]) {
      await expect(run(true, [], { codec: impostor, keyringNewlyArmed })).rejects.toThrow(
        "REFUSING TO WRITE: stored tokens under the keyring's active kid do not decrypt",
      );
    }
    expect(await snapshot()).toEqual(seeded);
  });

  it("--apply cases the lowercase rows and leaves every correct row byte-identical", async () => {
    const lines: string[] = [];
    const result = await run(true, lines);

    expect(statsOf(result, "worker_employment.employer_name_enc")).toMatchObject({
      change: 2,
      written: 2,
      concurrentSkipped: 0,
      undecryptable: 2,
    });
    expect(statsOf(result, "worker_employment_role.role_label")).toMatchObject({
      change: 3,
      written: 3,
    });
    expect(statsOf(result, "worker_education.field")).toMatchObject({ change: 2, written: 2 });
    expect(result.workersAffected).toBe(2);

    afterApply = await snapshot();
    const emp = new Map(afterApply.employment.map((r) => [r.id, r]));
    const role = new Map(afterApply.roles.map((r) => [r.id, r]));
    const edu = new Map(afterApply.educations.map((r) => [r.id, r]));
    const before = {
      emp: new Map(seeded.employment.map((r) => [r.id, r])),
      role: new Map(seeded.roles.map((r) => [r.id, r])),
      edu: new Map(seeded.educations.map((r) => [r.id, r])),
    };

    // Fixed — and re-encrypted under the ACTIVE kid, as the API would write it.
    expect(decrypt(emp.get(ids["e1"]!)!.employerNameEnc)).toBe("Recursive Global Infotech Pvt Ltd");
    expect(emp.get(ids["e1"]!)!.employerNameEnc.startsWith("v2.k2.")).toBe(true);
    expect(decrypt(emp.get(ids["e4"]!)!.employerNameEnc)).toBe("Sandhar Technologies");
    expect(emp.get(ids["e4"]!)!.employerNameEnc.startsWith("v2.k2.")).toBe(true);
    expect(role.get(ids["e1:role0"]!)!.roleLabel).toBe("Cnc Turner");
    expect(role.get(ids["e1:role1"]!)!.roleLabel).toBe("Helper");
    expect(role.get(ids["e3:role0"]!)!.roleLabel).toBe("Fitter");
    expect(edu.get(ids["ed1"]!)!.field).toBe("Electrician");
    expect(edu.get(ids["ed4"]!)!.field).toBe("Cnc Programming");
    // A written row says so in its own `updated_at` (stamped by the model's `$onUpdate`, the same
    // as every other writer). Compared for change, not order: the insert's `now()` is the
    // database's clock and the update's is this process's, and the two need not agree.
    expect(emp.get(ids["e1"]!)!.updatedAt.getTime()).not.toBe(
      before.emp.get(ids["e1"]!)!.updatedAt.getTime(),
    );

    // Untouched rows are untouched in EVERY column — the same ciphertext, the same updated_at.
    for (const key of ["e2", "e3", "e5", "e6"]) {
      expect(emp.get(ids[key]!), key).toEqual(before.emp.get(ids[key]!));
    }
    expect(emp.get(ids["e2"]!)!.employerNameEnc).toBe(tokens["e2"]);
    expect(decrypt(emp.get(ids["e2"]!)!.employerNameEnc)).toBe("RVM CAD");
    for (const key of ["e2:role0", "e6:role0"]) {
      expect(role.get(ids[key]!), key).toEqual(before.role.get(ids[key]!));
    }
    expect(role.get(ids["e2:role0"]!)!.roleLabel).toBe("CNC Operator");
    for (const key of ["ed2", "ed3", "ed5"]) {
      expect(edu.get(ids[key]!), key).toEqual(before.edu.get(ids[key]!));
    }
    // A written row changed in exactly one column (and its updated_at) — nothing else moved.
    const { employerNameEnc: _a, updatedAt: _b, ...e1Rest } = emp.get(ids["e1"]!)!;
    const { employerNameEnc: _c, updatedAt: _d, ...e1Before } = before.emp.get(ids["e1"]!)!;
    expect(e1Rest).toEqual(e1Before);
  });

  it("a RE-RUN changes nothing — the rule is idempotent", async () => {
    const result = await run(true, []);
    for (const { name, stats } of result.columns) {
      expect(stats.change, name).toBe(0);
      expect(stats.written, name).toBe(0);
    }
    expect(statsOf(result, "worker_employment.employer_name_enc").undecryptable).toBe(2);
    expect(result.workersAffected).toBe(0);
    expect(await snapshot()).toEqual(afterApply);
  });

  it("the optimistic guard refuses a row that moved since it was read, on every column", async () => {
    // What a worker re-saving mid-run looks like to the writer: the value it read is gone. Each
    // `before` below is what the seed stored, which the --apply above has since replaced.
    const stale: Record<TitleCaseColumn, { id: string; before: string }> = {
      "worker_employment.employer_name_enc": { id: ids["e1"]!, before: tokens["e1"]! },
      "worker_employment_role.role_label": { id: ids["e1:role0"]!, before: "cnc turner" },
      "worker_education.field": { id: ids["ed1"]!, before: "electrician" },
    };
    for (const target of buildTargets(client.db)) {
      const { id, before } = stale[target.name];
      expect(await target.applyOne(client.db, id, before, "Overwritten"), target.name).toBe(false);
    }
    expect(await snapshot()).toEqual(afterApply);
  });

  it("prints no value — no plaintext, no ciphertext — in any mode", async () => {
    const lines: string[] = [];
    await run(false, lines);
    await run(true, lines);
    const output = lines.join("\n");
    for (const value of PLAINTEXTS) expect(output, value).not.toContain(value);
    for (const token of Object.values(tokens)) expect(output).not.toContain(token);
    for (const row of afterApply.employment) expect(output).not.toContain(row.employerNameEnc);
    expect(output).not.toContain(phoneUnderActiveKid);
  });
});

/**
 * The estate as it stands: TD22-1 is opt-in and the API writes v1 only, so NO token anywhere is
 * v2. A runner that picks up a keyring here — from a shell, or from a root .env dotenv reads — would
 * write every re-cased employer name in a format the API cannot read.
 */
describe.skipIf(!RUN)(
  "title-case backfill — a keyring the API has never written under (#1432)",
  () => {
    let client: DbClient;
    const workerIds: string[] = [];
    let workerId: string;
    let employmentId: string;
    const seededToken = encryptPii("recursive global infotech pvt ltd", LEGACY);

    const storedToken = async (id: string) =>
      (
        await client.db
          .select({ token: workerEmployment.employerNameEnc })
          .from(workerEmployment)
          .where(eq(workerEmployment.id, id))
      )[0]!.token;

    const run = (over: Partial<TitleCaseRunOptions>, lines: string[] = []) =>
      runTitleCaseBackfill(client.db, {
        apply: true,
        batchSize: 500,
        codec,
        columns: ["worker_employment.employer_name_enc"],
        log: (line) => lines.push(line),
        ...over,
      });

    async function seedEmployment(token: string, sortOrder: number): Promise<string> {
      const [row] = await client.db
        .insert(workerEmployment)
        .values({ workerId, employerNameEnc: token, sortOrder, startYm: "2020-01" })
        .returning({ id: workerEmployment.id });
      return row!.id;
    }

    beforeAll(async () => {
      client = await openEmptyScratch();
      workerId = await insertWorker(client, encryptPii(randomPhone(), LEGACY));
      workerIds.push(workerId);
      employmentId = await seedEmployment(seededToken, 0);
    });

    afterAll(async () => {
      if (client === undefined) return; // refused before connecting
      if (workerIds.length) await client.db.delete(workers).where(inArray(workers.id, workerIds));
      await client.sql.end({ timeout: 5 });
    });

    it("the dry run counts the change as usual and WARNS that an --apply would refuse", async () => {
      const lines: string[] = [];
      const result = await run({ apply: false }, lines);
      expect(result.writeKey).toBe("no-token");
      expect(statsOf(result, "worker_employment.employer_name_enc")).toMatchObject({
        change: 1,
        undecryptable: 0,
      });
      expect(lines.filter((l) => l.includes("an --apply would refuse"))).toHaveLength(1);
      expect(await storedToken(employmentId)).toBe(seededToken);
    });

    it("--apply with that keyring REFUSES before its first read, and writes nothing", async () => {
      await expect(run({})).rejects.toThrow("REFUSING TO WRITE: a keyring is configured");
      expect(await storedToken(employmentId)).toBe(seededToken);
    });

    it("--keyring-is-newly-armed lets it write v2 under the active kid", async () => {
      const result = await run({ keyringNewlyArmed: true });
      expect(result.writeKey).toBe("acknowledged");
      expect(statsOf(result, "worker_employment.employer_name_enc").written).toBe(1);
      const token = await storedToken(employmentId);
      expect(token.startsWith("v2.k2.")).toBe(true);
      expect(decrypt(token)).toBe("Recursive Global Infotech Pvt Ltd");
    });

    it("with no keyring — the API's configuration today — it writes v1 and has nothing to prove", async () => {
      const fresh = await seedEmployment(encryptPii("sandhar technologies", LEGACY), 1);
      const result = await run({ codec: piiCodec(LEGACY, null) });
      expect(result.writeKey).toBe("not-applicable");
      expect(result.employerNameWrites).toBe("v1");
      // The v2 row the previous test wrote does not open without a keyring: counted, left alone.
      expect(statsOf(result, "worker_employment.employer_name_enc")).toMatchObject({
        written: 1,
        undecryptable: 1,
      });
      const token = await storedToken(fresh);
      expect(token.startsWith("v1.")).toBe(true);
      expect(decryptPii(token, LEGACY)).toBe("Sandhar Technologies");
    });
  },
);
