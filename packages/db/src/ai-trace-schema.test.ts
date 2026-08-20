/**
 * `ai_call_traces` (migration 0083) — the schema contract, in both the forms it can be checked.
 *
 * ── TWO SUITES IN ONE FILE, AND THE SPLIT IS NOT COSMETIC ───────────────────────────────
 * The first describes properties checkable from the drizzle model and the migration TEXT, so it
 * runs in ordinary CI like `worker-feedback-schema.test.ts`. The second needs a LIVE Postgres and
 * is gated behind `RUN_DB_TESTS=1`, because the property it exists for cannot be checked any
 * other way:
 *
 *   THE CIPHERTEXT CHECK IS A REGEX INSIDE POSTGRES, WRITTEN IN A `.ts` FILE, DESCRIBING A TOKEN
 *   FORMAT PRODUCED BY A DIFFERENT `.ts` FILE. SQL cannot import `encryptPii`, so nothing in the
 *   type system, and nothing a static test can read, connects `ENC_TOKEN_SQL_PATTERN` to the
 *   thing it is supposed to match. If the two ever disagree the failure is not subtle — it is
 *   EVERY trace insert raising 23514 forever, silently, because `AiTraceRecorder` catches by
 *   design. The live suite mints REAL tokens with both `encryptPii` and `encryptPiiWithKeyring`
 *   and makes the database itself say whether it accepts them. That is the only honest test of
 *   this constraint, and it is the same device `worker_feedback_message_len_chk` uses for its
 *   bound.
 *
 * Run the live half against a migrated throwaway database:
 *   createdb bb_trace_0083
 *   DATABASE_URL=postgresql://…/bb_trace_0083 pnpm --filter @badabhai/db exec drizzle-kit migrate
 *   RUN_DB_TESTS=1 DATABASE_URL=postgresql://…/bb_trace_0083 \
 *     pnpm --filter @badabhai/db exec vitest run src/ai-trace-schema.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { aiCallTraces } from "./schema/ai-trace";
import { schema } from "./schema";
import { encryptPii, encryptPiiWithKeyring } from "./crypto";
import { createDbClient, type DbClient } from "./client";

const MIGRATION = readFileSync(join(__dirname, "../migrations/0083_ai_call_traces.sql"), "utf8");

/**
 * The migration with every `--` comment line removed.
 *
 * The additive-only assertions below are about what Postgres will EXECUTE, and this file
 * documents its own rollback in a comment footer that necessarily contains `DROP TABLE`.
 * Matching the raw text would conflate "this migration drops a table" with "this migration
 * explains how to undo itself" — the second is a virtue.
 */
const EXECUTABLE = MIGRATION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const config = getTableConfig(aiCallTraces);
const columns = new Map(config.columns.map((c) => [c.name, c]));
const checkNames = config.checks.map((c) => c.name);
const indexNames = config.indexes.map((i) => i.config.name);

// ---------------------------------------------------------------------------
// STATIC — the model, the SQL, and the two agreeing
// ---------------------------------------------------------------------------
describe("0083 — the drizzle model and the SQL describe the same table", () => {
  it("models exactly the eighteen columns the migration creates", () => {
    // Both directions. A column on the model with no migration is a read that fails against
    // every deployed database; a column in the SQL the model does not know about is one drizzle
    // will never select and `db:generate` will try to DROP.
    expect([...columns.keys()].sort()).toEqual(
      [
        "ai_call_id",
        "ai_job_id",
        "correlation_id",
        "created_at",
        "error_code",
        "id",
        "model_name",
        "prompt_chars",
        "prompt_enc",
        "prompt_name",
        "prompt_version",
        "real_call",
        "response_chars",
        "response_enc",
        "session_id",
        "success",
        "task_type",
        "worker_id",
      ].sort(),
    );
    for (const name of columns.keys()) {
      expect(MIGRATION, `${name} must appear in the migration`).toContain(`"${name}"`);
    }
  });

  /**
   * THE DSAR DESIGN, AS A COLUMN CONSTRAINT. `worker_id` NOT NULL is not a tidiness choice: it is
   * what makes `ON DELETE cascade` TOTAL. `WorkersRepository.hardDelete` is one `DELETE FROM
   * workers` enumerating no child table, so the cascade IS the erasure coverage — and a nullable
   * column would quietly create a class of prompt text that survives a deletion request forever,
   * which is precisely the failure DPDP §12 names. The cost is paid at the writer, which drops an
   * unattributable call rather than storing it faceless.
   */
  it("makes worker_id NOT NULL — the erasure guarantee, not a data-quality preference", () => {
    expect(columns.get("worker_id")?.notNull).toBe(true);
    expect(columns.get("session_id")?.notNull).toBe(false);
    expect(columns.get("ai_job_id")?.notNull).toBe(false);
    // `task_type` and `success` are the two other facts a trace is meaningless without.
    expect(columns.get("task_type")?.notNull).toBe(true);
    expect(columns.get("success")?.notNull).toBe(true);
    // The text itself is NULLABLE: a failed call has no response, and STT has no prompt.
    expect(columns.get("prompt_enc")?.notNull).toBe(false);
    expect(columns.get("response_enc")?.notNull).toBe(false);
  });

  it("cascades from workers and from chat_sessions, and SET NULLs from ai_jobs", () => {
    // The two cascades ARE the erasure coverage. `ai_jobs` is deliberately different: it is a
    // faceless operational table with its own lifecycle and no worker FK, so an ai_job
    // disappearing must never take a worker-owned trace with it.
    expect(MIGRATION).toContain(
      'ADD CONSTRAINT "ai_call_traces_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") ' +
        'REFERENCES "public"."workers"("id") ON DELETE cascade',
    );
    expect(MIGRATION).toContain(
      'ADD CONSTRAINT "ai_call_traces_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") ' +
        'REFERENCES "public"."chat_sessions"("id") ON DELETE cascade',
    );
    expect(MIGRATION).toContain(
      'ADD CONSTRAINT "ai_call_traces_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") ' +
        'REFERENCES "public"."ai_jobs"("id") ON DELETE set null',
    );
    // Never the weaker forms on the worker link, which would leave prose behind after erasure.
    expect(MIGRATION).not.toMatch(/ai_call_traces_worker_id_workers_id_fk[^;]*ON DELETE set null/);
    expect(MIGRATION).not.toMatch(/ai_call_traces_worker_id_workers_id_fk[^;]*ON DELETE no action/);
  });

  it("makes ai_call_id UNIQUE — the recorder's idempotency key", () => {
    // A redelivered BullMQ job reaches the recorder again as a matter of routine. Without this
    // the retry writes a second row for one provider call, and every per-call figure derived
    // from this table doubles for exactly the calls that were retried.
    expect(MIGRATION).toContain('CONSTRAINT "ai_call_traces_ai_call_id_unique" UNIQUE("ai_call_id")');
  });

  it("declares both ciphertext CHECKs in the model AND in the SQL", () => {
    for (const name of [
      "ai_call_traces_prompt_enc_token_chk",
      "ai_call_traces_response_enc_token_chk",
    ]) {
      expect(checkNames, `${name} in the model`).toContain(name);
      expect(MIGRATION, `${name} in the SQL`).toContain(`CONSTRAINT "${name}" CHECK`);
    }
    // Both admit NULL explicitly — the value a call with no prompt (STT) or no reply (a failure)
    // legitimately has. Without that arm the CHECK would refuse the honest row.
    expect(MIGRATION).toContain('"ai_call_traces"."prompt_enc" IS NULL OR');
    expect(MIGRATION).toContain('"ai_call_traces"."response_enc" IS NULL OR');
  });

  /**
   * The CHECK is a SHAPE test, not a length or a charset bound, and the difference is the whole
   * point: prose has a length, and a charset cannot say "this is not a sentence". Four or five
   * dot-delimited base64 fields behind a version tag is something no sentence a human or a model
   * produces can satisfy. Pinned as text so a "simplification" to `length > 40` fails here.
   */
  it("bounds the ciphertext columns by TOKEN SHAPE, not by length", () => {
    expect(MIGRATION).toMatch(/prompt_enc" ~ '\^\(v1\\\./);
    expect(MIGRATION).toMatch(/\|v2\\\.\[A-Za-z0-9_-\]\{1,32\}\\\./);
    for (const wrong of [
      /char_length\("ai_call_traces"\."prompt_enc"\)/,
      /char_length\("ai_call_traces"\."response_enc"\)/,
    ]) {
      expect(MIGRATION, "the ciphertext bound must not degrade into a length").not.toMatch(wrong);
    }
  });

  /**
   * 64 CHARS IS A CODE, NOT A MESSAGE, and that bound is the second half of a control whose first
   * half lives in `AiTraceRecorder.toErrorCode` (an allow-list returning one of our own
   * constants). The column exists to hold a closed-set code; a provider error string routinely
   * echoes the request back, so a wide column here would be an UNENCRYPTED channel around the two
   * columns this whole schema encrypts.
   */
  it("bounds error_code at 64 — a code fits, a provider message does not", () => {
    expect(MIGRATION).toContain(
      'CHECK ("ai_call_traces"."error_code" IS NULL OR char_length("ai_call_traces"."error_code") BETWEEN 1 AND 64)',
    );
  });

  it("orders both keyset indexes newest-first, NULLS FIRST, with id as the tie-breaker", () => {
    // NULLS FIRST is asserted as literal text and is LOAD-BEARING. Postgres reads a bare
    // `ORDER BY created_at DESC` as DESC NULLS FIRST, so an index built NULLS LAST — which is
    // what drizzle's `.desc()` emits on its own — serves the filter and leaves the Sort in place.
    // That sort is the entire cost these indexes exist to remove, it changes no result (both
    // columns are NOT NULL), and it is invisible without an assertion on the text.
    expect(MIGRATION).toContain(
      'CREATE INDEX "ai_call_traces_admin_keyset_idx" ON "ai_call_traces" USING btree ' +
        '("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST)',
    );
    expect(MIGRATION).toContain(
      'CREATE INDEX "ai_call_traces_worker_keyset_idx" ON "ai_call_traces" USING btree ' +
        '("worker_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST)',
    );
    for (const name of [
      "ai_call_traces_worker_id_idx",
      "ai_call_traces_session_id_idx",
      "ai_call_traces_ai_job_id_idx",
    ]) {
      expect(indexNames, `${name} in the model`).toContain(name);
      // Postgres does not index a FK column for you, and the cascade an erasure triggers is a
      // sequential scan of this table without them — on the table designed to be the largest.
      expect(MIGRATION, `${name} in the SQL`).toContain(`CREATE INDEX "${name}"`);
    }
  });

  it("carries ENABLE, FORCE and the four REVOKEs (the hand-appended tail)", () => {
    // drizzle emits ENABLE only. FORCE + the four REVOKEs are the actual deny-by-default posture
    // and are hand-written into the tail, so they are exactly what a regenerate silently drops.
    // Without FORCE the table OWNER bypasses every policy, and the owner is the only connection
    // the backend uses — so ENABLE alone is decorative on the table holding every prompt.
    expect(MIGRATION).toContain('ALTER TABLE "ai_call_traces" ENABLE ROW LEVEL SECURITY;');
    expect(MIGRATION).toContain('ALTER TABLE "ai_call_traces" FORCE ROW LEVEL SECURITY;');
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(MIGRATION, `REVOKE ${role}`).toContain(
        `REVOKE ALL ON TABLE "ai_call_traces" FROM ${role};`,
      );
    }
  });

  it("creates one table and alters no shipped one", () => {
    for (const pattern of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bADD COLUMN\b/i,
      /\bALTER COLUMN\b/i,
      /\bGRANT\b/i,
    ]) {
      expect(EXECUTABLE, `must not contain ${pattern}`).not.toMatch(pattern);
    }
    const creates = EXECUTABLE.split("\n").filter((l) => l.startsWith("CREATE TABLE"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('"ai_call_traces"');
  });

  /**
   * The e2e RLS drift guard asserts `live.size === Object.keys(schema).length`, so a table
   * missing from the barrel fails that whole suite with a count mismatch rather than anything
   * that names this table. Catching it here names it.
   */
  it("is registered in the exported schema object", () => {
    expect(Object.keys(schema)).toContain("aiCallTraces");
    expect(schema.aiCallTraces).toBe(aiCallTraces);
  });
});

// ---------------------------------------------------------------------------
// LIVE — the only thing that connects the SQL regex to `encryptPii`
// ---------------------------------------------------------------------------
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** A 32-byte key, base64 — the shape `encryptPii` requires. Test-only; never a real key. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const TEST_KEYRING = { activeKid: "test-kid-1", keys: { "test-kid-1": TEST_KEY } };

describe.skipIf(!RUN)("0083 live — the database accepts real tokens and refuses prose", () => {
  let client!: DbClient;
  let workerId!: string;
  let sessionId!: string;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    // A real parent row: `worker_id` is NOT NULL with an FK, so there is no way to exercise the
    // ciphertext CHECK without one. `phone_e164` and `phone_hash` are the only other NOT NULL
    // columns without a default.
    const [w] = await client.sql`
      INSERT INTO workers (phone_e164, phone_hash)
      VALUES (${`v1.trace-test.${randomUUID()}`}, ${randomUUID()})
      RETURNING id`;
    workerId = (w as { id: string }).id;
    const [s] = await client.sql`
      INSERT INTO chat_sessions (worker_id) VALUES (${workerId}) RETURNING id`;
    sessionId = (s as { id: string }).id;
  });

  afterAll(async () => {
    // Deleting the worker cascades every trace and session created here — which is also the
    // erasure path this table depends on, exercised once as a side effect of cleaning up.
    if (workerId) await client.sql`DELETE FROM workers WHERE id = ${workerId}`;
    await client?.sql.end({ timeout: 5 });
  });

  /** Insert one trace with the given prompt/response column values. Resolves or rejects. */
  const insert = (promptEnc: string | null, responseEnc: string | null) =>
    client.sql`
      INSERT INTO ai_call_traces
        (ai_call_id, worker_id, session_id, task_type, prompt_enc, response_enc, success)
      VALUES
        (${randomUUID()}, ${workerId}, ${sessionId}, 'profiling_chat_turn',
         ${promptEnc}, ${responseEnc}, true)
      RETURNING id`;

  /** The SQLSTATE a rejected insert produced, or null when it was accepted. */
  const sqlstateOf = async (
    promptEnc: string | null,
    responseEnc: string | null,
  ): Promise<string | null> => {
    try {
      await insert(promptEnc, responseEnc);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? "unknown";
    }
  };

  it("ACCEPTS a real v1 token from encryptPii", async () => {
    // The legacy single-key write path — what `PiiCryptoService.encrypt` produces when no
    // keyring is configured, which is the default and therefore what production writes today.
    const prompt = encryptPii("Main Pune mein CNC operator hoon, 4 saal ka tajurba hai.", TEST_KEY);
    const response = encryptPii("Aapko kaunsi machine chalani aati hai?", TEST_KEY);
    expect(prompt.startsWith("v1.")).toBe(true);
    const rows = await insert(prompt, response);
    expect(rows.length).toBe(1);
  });

  it("ACCEPTS a real v2 token from encryptPiiWithKeyring", async () => {
    // The TD22-1 keyring path. It must be accepted TODAY, before anyone opts in — otherwise the
    // opt-in itself becomes the outage: every trace insert would start failing 23514 at the
    // moment the keyring is configured, silently, because the recorder catches by design.
    const prompt = encryptPiiWithKeyring("Welding ka kaam karta hoon.", TEST_KEYRING);
    const response = encryptPiiWithKeyring("Kitne saal se?", TEST_KEYRING);
    expect(prompt.startsWith("v2.test-kid-1.")).toBe(true);
    const rows = await insert(prompt, response);
    expect(rows.length).toBe(1);
  });

  it("REFUSES a plaintext Hinglish sentence with 23514", async () => {
    // THE ASSERTION THIS SUITE EXISTS FOR. A recorder that forgot to encrypt, a migration that
    // wrote raw text, an ops script — all of them are stopped by Postgres rather than by review.
    expect(await sqlstateOf("Main Pune mein CNC operator hoon.", null)).toBe("23514");
    expect(await sqlstateOf(null, "Aapko kaunsi machine chalani aati hai?")).toBe("23514");
  });

  it("REFUSES an untagged base64 blob with 23514 — the near-miss, not just the obvious one", async () => {
    // A charset bound would have accepted this: it is valid base64 of the right sort of length,
    // and it is what a well-meaning "just base64 it" change produces. What refuses it is the
    // VERSION TAG and the field count — the shape, which is why the CHECK is a shape test.
    const blob = Buffer.from("Main Pune mein CNC operator hoon.").toString("base64");
    expect(await sqlstateOf(blob, null)).toBe("23514");
    // ...and the other near-misses: a right-tagged token with too few fields, and a tag that is
    // neither v1 nor v2.
    expect(await sqlstateOf("v1.onlytwo", null)).toBe("23514");
    expect(await sqlstateOf(`v3.${randomUUID()}.aa.bb.cc`, null)).toBe("23514");
  });

  it("ACCEPTS NULL on both columns — a failed call has no reply, STT has no prompt", async () => {
    const rows = await insert(null, null);
    expect(rows.length).toBe(1);
  });

  it("REFUSES a second trace for the same ai_call_id (23505) — the retry guard", async () => {
    const aiCallId = randomUUID();
    const one = client.sql`
      INSERT INTO ai_call_traces (ai_call_id, worker_id, task_type, success)
      VALUES (${aiCallId}, ${workerId}, 'profile_parse', true) RETURNING id`;
    expect((await one).length).toBe(1);
    let code: string | undefined;
    try {
      await client.sql`
        INSERT INTO ai_call_traces (ai_call_id, worker_id, task_type, success)
        VALUES (${aiCallId}, ${workerId}, 'profile_parse', true)`;
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("23505");
  });

  it("REFUSES a trace with no worker (23502) — faceless prompt text is unstorable", async () => {
    // The DSAR guarantee, at the database. The recorder drops such a call before it gets here;
    // this proves the database would refuse it even if the recorder did not.
    let code: string | undefined;
    try {
      await client.sql`
        INSERT INTO ai_call_traces (ai_call_id, worker_id, task_type, success)
        VALUES (${randomUUID()}, NULL, 'skill_embedding', true)`;
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("23502"); // not_null_violation
  });

  it("ERASES every trace when the worker is deleted — the cascade IS the DSAR coverage", async () => {
    // A SECOND worker, so the deletion is isolated from the rows the other cases rely on.
    const [w] = await client.sql`
      INSERT INTO workers (phone_e164, phone_hash)
      VALUES (${`v1.trace-erase.${randomUUID()}`}, ${randomUUID()}) RETURNING id`;
    const doomed = (w as { id: string }).id;
    for (let i = 0; i < 3; i += 1) {
      await client.sql`
        INSERT INTO ai_call_traces (ai_call_id, worker_id, task_type, prompt_enc, success)
        VALUES (${randomUUID()}, ${doomed}, 'profiling_chat_turn',
                ${encryptPii(`turn ${i}`, TEST_KEY)}, true)`;
    }
    const before = await client.sql`SELECT count(*)::int AS n FROM ai_call_traces WHERE worker_id = ${doomed}`;
    expect((before[0] as { n: number }).n).toBe(3);

    // `WorkersRepository.hardDelete` is exactly this statement, enumerating no child table.
    await client.sql`DELETE FROM workers WHERE id = ${doomed}`;

    const after = await client.sql`SELECT count(*)::int AS n FROM ai_call_traces WHERE worker_id = ${doomed}`;
    expect((after[0] as { n: number }).n).toBe(0);
  });
});

/**
 * 0083 live — WHERE the keyset cursor's microseconds are actually lost.
 *
 * ── WHY THIS LIVES HERE AND NOT BESIDE THE REPOSITORY ───────────────────────────────────
 * The property is an interaction between the COLUMN's declared precision, what postgres-js does
 * to a value, and what drizzle does to postgres-js. `apps/api`'s own keyset test asserts the
 * statement text and the bound parameters — and it does — but no static test can say which of
 * those three layers eats the digits. Only a real connection answers that, and the answer is
 * not the layer the first investigation blamed.
 *
 * ── THE MEASUREMENT, INCLUDING THE PART THAT CORRECTED AN EARLIER GUESS ─────────────────
 * `created_at` is `timestamptz`, i.e. microseconds. Measured against this database:
 *
 *   1. On a BARE postgres-js client, `$1::timestamptz` DOES truncate — Postgres resolves the
 *      parameter's type as 1184, and postgres-js's own `date` serializer round-trips the string
 *      through `new Date(...)` on the way out.
 *   2. `drizzle(sql)` MUTATES that client. After the wrap — which is every connection the app
 *      has, because `createDbClient` wraps immediately — the serializer is gone, `$1::timestamptz`
 *      keeps all six digits, and a `timestamptz` column arrives as a RAW STRING rather than a
 *      `Date`. So the driver is NOT where the app loses them.
 *   3. Drizzle's own `timestamp(..., { mode: "date" })` mapper is. It turns that raw string into
 *      a JS `Date`, which holds milliseconds, and the cursor was minted from
 *      `row.created_at.toISOString()`.
 *
 * Consequence, measured end to end before the fix: six rows seeded inside one millisecond, page
 * size 2 → 2 returned, 4 skipped permanently, second page empty, `nextCursor` healthy-looking.
 * They fail BOTH halves of the predicate — not `< at`, and not `= at` — which is exactly what
 * stops the `id` tie-breaker from rescuing them.
 *
 * The fix is therefore the SELECT side (`to_char(... .US ...)`, rendered by Postgres, because by
 * the time a row is in JS the digits are already gone). `::text::timestamptz` on the bind side is
 * belt to that brace: it is correct whether or not the client has been wrapped, and a repository
 * should not depend on a mutation another library performs on a shared connection.
 */
describe.skipIf(!RUN)("0083 live — where the keyset cursor's microseconds are lost", () => {
  let client!: DbClient;

  beforeAll(() => {
    // `createDbClient` calls `drizzle(sql)`, so `client.sql` is a WRAPPED client — the same
    // object the app talks to, not a pristine postgres-js one.
    client = createDbClient(DATABASE_URL, { max: 1 });
  });
  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  const ISO = "2026-08-01T10:00:00.000600Z";
  const FMT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

  it("a timestamptz column arrives as a RAW STRING with the microseconds intact", async () => {
    // The measurement that redirected this whole investigation. If the digits were gone HERE,
    // no amount of `to_char` would help. They are not: drizzle removes postgres-js's date
    // parser so it can run its own mapping, and the wire value is complete.
    const rows = await client.sql`SELECT ${ISO}::text::timestamptz AS d`;
    const d = (rows[0] as { d: unknown }).d;
    expect(typeof d).toBe("string");
    expect(String(d)).toContain(".0006");
  });

  it("both cast forms survive on a drizzle-wrapped client — bind side is not the culprit", async () => {
    // On a BARE postgres-js client the first of these truncates to `.000000`, which is a real
    // trap for any script that talks to Postgres without drizzle. On the app's wrapped client
    // both are correct, so `::text::timestamptz` is defence in depth rather than the fix.
    const plain = await client.sql`SELECT to_char(${ISO}::timestamptz AT TIME ZONE 'UTC', ${FMT}) AS t`;
    const viaText = await client.sql`SELECT to_char(${ISO}::text::timestamptz AT TIME ZONE 'UTC', ${FMT}) AS t`;
    expect((plain[0] as { t: string }).t).toBe(ISO);
    expect((viaText[0] as { t: string }).t).toBe(ISO);
  });

  it("THE ACTUAL LOSS: drizzle's date mapper truncates the sort key to milliseconds", async () => {
    // Selected through `db` (drizzle), not through `sql` (the raw client), because the mapper is
    // the subject. This is the value the service used to mint the cursor from, and this is the
    // assertion that fails the moment someone "simplifies" the sort key back to `created_at`.
    const [w] = await client.sql`
      INSERT INTO workers (phone_e164, phone_hash)
      VALUES (${`v1.trace-keyset.${randomUUID()}`}, ${randomUUID()}) RETURNING id`;
    const worker = (w as { id: string }).id;
    try {
      await client.sql`
        INSERT INTO ai_call_traces (ai_call_id, worker_id, task_type, success, created_at)
        VALUES (${randomUUID()}, ${worker}, 'profiling_chat_turn', true, ${ISO}::text::timestamptz)`;

      const mapped = await client.db
        .select({ createdAt: aiCallTraces.createdAt })
        .from(aiCallTraces)
        .where(eq(aiCallTraces.workerId, worker));
      const asDate = mapped[0]!.createdAt;
      expect(asDate).toBeInstanceOf(Date);
      expect(asDate.toISOString()).toBe("2026-08-01T10:00:00.000Z"); // the 600µs, gone

      // ...and the projection the repository actually uses keeps them.
      const projected = await client.sql`
        SELECT to_char(created_at AT TIME ZONE 'UTC', ${FMT}) AS t
        FROM ai_call_traces WHERE worker_id = ${worker}`;
      expect((projected[0] as { t: string }).t).toBe(ISO);
    } finally {
      await client.sql`DELETE FROM workers WHERE id = ${worker}`;
    }
  });

  it("the keyset predicate finds a row the truncated bound would have skipped", async () => {
    // End to end against the real column. Seed one row at .000400 and page from a cursor at
    // .000600. The full-precision bound sees it; the millisecond-truncated one does not — it is
    // neither `<` nor `=`, which is why the `id` tie-breaker cannot rescue it.
    const [w] = await client.sql`
      INSERT INTO workers (phone_e164, phone_hash)
      VALUES (${`v1.trace-keyset2.${randomUUID()}`}, ${randomUUID()}) RETURNING id`;
    const worker = (w as { id: string }).id;
    try {
      await client.sql`
        INSERT INTO ai_call_traces (ai_call_id, worker_id, task_type, success, created_at)
        VALUES (${randomUUID()}, ${worker}, 'profiling_chat_turn', true,
                '2026-08-01 10:00:00.000400+00'::timestamptz)`;

      const good = await client.sql`
        SELECT count(*)::int AS n FROM ai_call_traces
        WHERE worker_id = ${worker} AND created_at < ${ISO}::text::timestamptz`;
      expect((good[0] as { n: number }).n).toBe(1);

      const truncated = await client.sql`
        SELECT count(*)::int AS n FROM ai_call_traces
        WHERE worker_id = ${worker}
          AND created_at < ${"2026-08-01T10:00:00.000Z"}::text::timestamptz`;
      expect((truncated[0] as { n: number }).n).toBe(0); // the row that used to disappear
    } finally {
      await client.sql`DELETE FROM workers WHERE id = ${worker}`;
    }
  });
});
