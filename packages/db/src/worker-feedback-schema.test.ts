/**
 * Worker app feedback (migrations 0080 + 0081) — schema contract tests.
 *
 * Same posture as `canonical-taxonomy-schema.test.ts` and `unresolved-phrase-job-domain.test.ts`:
 * these read the drizzle model and the generated SQL, never a live database, so they run in
 * ordinary CI rather than behind `RUN_DB_TESTS`. What they defend is the set of properties a
 * later `db:generate` or a well-meaning edit could silently undo.
 *
 * The single most valuable assertion here is the LENGTH PARITY one: `WORKER_FEEDBACK_MESSAGE_MAX`
 * lives in `@badabhai/types` because the zod DTO, the event payload and this CHECK all pin the
 * same number, and SQL cannot import it. Nothing but this test stops the request-layer cap and
 * the database cap drifting apart — and the drift is silent in the worse direction: a zod cap
 * raised above the CHECK turns an accepted submission into a 500 at INSERT time, with the
 * worker's typed message already gone.
 *
 * Second most valuable: the RLS tail. drizzle-kit models ENABLE and neither FORCE nor the
 * REVOKEs, so those five statements are hand-appended and are exactly what a regenerate drops.
 * On this table that is not a hygiene issue — `message` is the one column on the spine allowed
 * to contain a worker's own PII, so a lost REVOKE exposes free-text personal data to every
 * PostgREST role.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  WORKER_FEEDBACK_APP_BUILD_MAX,
  WORKER_FEEDBACK_CATEGORIES,
  WORKER_FEEDBACK_MESSAGE_MAX,
  WORKER_FEEDBACK_SCREEN_MAX,
} from "@badabhai/types";

import { workerFeedback } from "./schema/feedback";
import { schema } from "./schema";

const read = (file: string): string => readFileSync(join(__dirname, "../migrations", file), "utf8");

const MIGRATION = read("0080_worker_feedback.sql");
/** The `screen_context` follow-up. Read separately, because "which file introduced it" is
 *  exactly what the column assertions below have to be able to check. */
const MIGRATION_0081 = read("0081_worker_feedback_screen_context.sql");

/**
 * A migration with every `--` comment line removed.
 *
 * The additive-only assertions below are about what Postgres will EXECUTE, and these files
 * document their own rollback in a comment footer that necessarily contains `DROP TABLE` /
 * `DROP COLUMN`. Matching the raw text would conflate "this migration drops a table" with "this
 * migration explains how to undo itself" — the second is a virtue.
 */
const executable = (sql: string): string =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

const EXECUTABLE = executable(MIGRATION);
const EXECUTABLE_0081 = executable(MIGRATION_0081);

const config = getTableConfig(workerFeedback);
const columns = new Map(config.columns.map((c) => [c.name, c]));
const checkNames = config.checks.map((c) => c.name);
const indexNames = config.indexes.map((i) => i.config.name);

describe("0080/0081 — the drizzle model and the SQL describe the same table", () => {
  it("models exactly the seven columns the two migrations create, each in its own file", () => {
    // Both directions. A column added to the model without a migration is a read that fails
    // against every deployed database; a column in the SQL that the model does not know about
    // is one drizzle will never select and `db:generate` will try to drop.
    expect([...columns.keys()].sort()).toEqual([
      "app_build",
      "category",
      "created_at",
      "id",
      "message",
      "screen_context",
      "worker_id",
    ]);
    // WHICH FILE introduces a column is the load-bearing half once there are two: asserting only
    // "it appears somewhere in the migrations" would pass for a column added to 0080 after that
    // file had already been applied to a database, which is a change no database ever runs.
    for (const name of columns.keys()) {
      const sql = name === "screen_context" ? MIGRATION_0081 : MIGRATION;
      expect(sql, `${name} must appear in the migration that introduces it`).toContain(`"${name}"`);
    }
    expect(MIGRATION, "screen_context is 0081's — 0080 must not know about it").not.toContain(
      '"screen_context"',
    );
  });

  /**
   * NULLABLE `category` is a product decision, not an oversight: the shipped client omits the
   * key entirely when the worker did not tag their feedback, and a NOT NULL DEFAULT 'other'
   * would turn "did not tag" into "said other" and put a lie in the histogram ops reads.
   */
  it("keeps category, app_build and screen_context nullable, message and worker_id not", () => {
    expect(columns.get("category")?.notNull).toBe(false);
    expect(columns.get("category")?.hasDefault).toBe(false);
    expect(columns.get("app_build")?.notNull).toBe(false);
    // NULLABLE AND NO DEFAULT is what makes 0081 applicable to a table that already has rows:
    // every pre-existing row keeps NULL, which the admin screen renders as "unknown screen".
    // It is also the sanitizer's landing zone — a route string that fails normalization is
    // stored as NULL rather than failing the worker's submission.
    expect(columns.get("screen_context")?.notNull).toBe(false);
    expect(columns.get("screen_context")?.hasDefault).toBe(false);
    expect(columns.get("message")?.notNull).toBe(true);
    expect(columns.get("worker_id")?.notNull).toBe(true);
  });

  it("declares the four CHECKs and the three indexes in both the model and the SQL", () => {
    for (const name of [
      "worker_feedback_category_chk",
      "worker_feedback_message_len_chk",
      "worker_feedback_app_build_len_chk",
    ]) {
      expect(checkNames, `${name} in the model`).toContain(name);
      expect(MIGRATION, `${name} in the SQL`).toContain(`CONSTRAINT "${name}" CHECK`);
    }
    // The fourth arrives with its column, in 0081.
    expect(checkNames, "the screen_context bound in the model").toContain(
      "worker_feedback_screen_context_len_chk",
    );
    expect(MIGRATION_0081, "the screen_context bound in the SQL").toContain(
      'CONSTRAINT "worker_feedback_screen_context_len_chk" CHECK',
    );
    for (const name of [
      "worker_feedback_worker_id_idx",
      "worker_feedback_admin_keyset_idx",
      "worker_feedback_category_keyset_idx",
    ]) {
      expect(indexNames, `${name} in the model`).toContain(name);
      expect(MIGRATION, `${name} in the SQL`).toContain(`CREATE INDEX "${name}"`);
    }
  });

  /**
   * The admin list is `ORDER BY created_at DESC, id DESC` with a keyset cursor. Losing the
   * DESC on either column does not break the query — it makes it a sort of the whole table,
   * every page, and that degrades as the feature succeeds.
   *
   * NULLS FIRST is asserted as literal text, not as a detail. Postgres reads the repository's
   * bare `ORDER BY created_at DESC` as DESC NULLS FIRST, so an index built NULLS LAST — which
   * is what drizzle's `.desc()` emits on its own — serves the filter and leaves the sort in
   * place. That is the whole cost these indexes exist to remove, it changes no result (both
   * columns are NOT NULL), and it is therefore invisible without an assertion on the text.
   * Same lesson as `chat_messages_session_created_idx` (migration 0067).
   */
  it("orders the admin keyset index newest-first, NULLS FIRST, with id as the tie-breaker", () => {
    expect(MIGRATION).toContain(
      'CREATE INDEX "worker_feedback_admin_keyset_idx" ON "worker_feedback" USING btree ' +
        '("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST)',
    );
    // The filtered page leads on `category` — the unfiltered index above cannot serve it.
    expect(MIGRATION).toContain(
      'CREATE INDEX "worker_feedback_category_keyset_idx" ON "worker_feedback" USING btree ' +
        '("category","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST)',
    );
  });

  /**
   * The e2e RLS drift guard asserts `live.size === Object.keys(schema).length`, so a table
   * missing from the barrel's `schema` object fails the whole suite with a count mismatch
   * rather than anything that names this table. Catching it here names it.
   */
  it("is registered in the exported schema object", () => {
    expect(Object.keys(schema)).toContain("workerFeedback");
    expect(schema.workerFeedback).toBe(workerFeedback);
  });
});

describe("0080/0081 — the bounds are pinned to @badabhai/types, and this is the only thing pinning them", () => {
  /**
   * THE REGRESSION THIS EXISTS FOR. `SubmitFeedbackSchema` caps `message` at
   * WORKER_FEEDBACK_MESSAGE_MAX; the CHECK below hard-codes the same number because SQL cannot
   * import. Raise one and not the other and the failure is asymmetric: a zod cap ABOVE the
   * CHECK means an accepted request throws `23514` at INSERT, the transaction rolls back, and
   * the worker gets a 500 with their typed message already gone. Do not delete this assertion
   * to make a bound change pass.
   */
  it("caps message at WORKER_FEEDBACK_MESSAGE_MAX", () => {
    expect(MIGRATION).toContain(
      `CHECK (char_length("worker_feedback"."message") BETWEEN 1 AND ${WORKER_FEEDBACK_MESSAGE_MAX})`,
    );
  });

  /** Same contract for the untrusted `x-app-build` header the sanitizer bounds at the edge. */
  it("caps app_build at WORKER_FEEDBACK_APP_BUILD_MAX", () => {
    expect(MIGRATION).toContain(
      `char_length("worker_feedback"."app_build") BETWEEN 1 AND ${WORKER_FEEDBACK_APP_BUILD_MAX}`,
    );
  });

  /**
   * And for the route pattern, in 0081. The drift here is LESS dangerous than the message one
   * and still worth pinning: `sanitizeScreenContext` returns null past the shared constant, so a
   * CHECK set BELOW it would be the only thing that could reject — and it would do so as a 23514
   * inside the same transaction as the event, taking the worker's message with it.
   */
  it("caps screen_context at WORKER_FEEDBACK_SCREEN_MAX", () => {
    expect(MIGRATION_0081).toContain(
      `char_length("worker_feedback"."screen_context") BETWEEN 1 AND ${WORKER_FEEDBACK_SCREEN_MAX}`,
    );
  });

  /**
   * A minimum of 1, not 0. An empty message is not feedback, and letting one land would put a
   * blank row on the admin screen that nobody can act on or explain.
   */
  it("refuses an empty message at the database, not only in zod", () => {
    expect(MIGRATION).toMatch(/char_length\("worker_feedback"\."message"\) BETWEEN 1 AND/);
  });

  /**
   * The CHECK is the authority and the TS union is the TypeScript view of it (the house rule
   * stated in `schema/index.ts` — this repo has no pgEnum). A token added to
   * WORKER_FEEDBACK_CATEGORIES without a `DROP CONSTRAINT / ADD CONSTRAINT` migration is
   * accepted by zod and rejected by Postgres, which is a 500 on the worker's submission.
   */
  it("lists exactly WORKER_FEEDBACK_CATEGORIES in the category CHECK", () => {
    const rendered = WORKER_FEEDBACK_CATEGORIES.map((c) => `'${c}'`).join(", ");
    expect(MIGRATION).toContain(
      `CHECK ("worker_feedback"."category" IS NULL OR "worker_feedback"."category" IN (${rendered}))`,
    );
    // NULL is explicitly permitted — untagged feedback is the common case, not a violation.
    expect(MIGRATION).toContain('"worker_feedback"."category" IS NULL OR');
  });
});

describe("0080/0081 — the privacy posture, which is hand-appended and therefore fragile", () => {
  /**
   * drizzle emits ENABLE only. FORCE + the four REVOKEs are the actual deny-by-default posture
   * (ADR-0004 / TD20) and are hand-written into the tail — so they are exactly what a
   * regenerate silently drops. Without FORCE the table OWNER bypasses every policy, and the
   * owner is the only connection the backend uses, so ENABLE alone is decorative.
   */
  it("carries ENABLE, FORCE and the four REVOKEs", () => {
    expect(MIGRATION).toContain('ALTER TABLE "worker_feedback" ENABLE ROW LEVEL SECURITY;');
    expect(MIGRATION).toContain('ALTER TABLE "worker_feedback" FORCE ROW LEVEL SECURITY;');
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(MIGRATION, `REVOKE ${role}`).toContain(
        `REVOKE ALL ON TABLE "worker_feedback" FROM ${role};`,
      );
    }
  });

  /**
   * THE DSAR MECHANISM, AND IT IS THE CASCADE. `WorkersRepository.hardDelete` enumerates no
   * table names, so `ON DELETE cascade` from `workers` IS the erasure coverage for this table
   * — there is no code to forget, and equally no code that would fail if this were weakened.
   * A `set null` or a `no action` here would leave a worker's own free text behind after they
   * exercised erasure, which is the one outcome DPDP does not forgive.
   */
  it("cascades from workers — this is the erasure coverage, with zero code", () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE "worker_feedback" ADD CONSTRAINT "worker_feedback_worker_id_workers_id_fk" ' +
        'FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade',
    );
    expect(MIGRATION).not.toMatch(/worker_feedback_worker_id_workers_id_fk[^;]*ON DELETE set null/);
  });

  it("indexes the FK column — Postgres does not do it for you", () => {
    // Without it, the cascade an erasure triggers is a sequential scan of this table.
    expect(MIGRATION).toContain(
      'CREATE INDEX "worker_feedback_worker_id_idx" ON "worker_feedback" USING btree ("worker_id")',
    );
  });
});

describe("0080/0081 — additive and reversible", () => {
  /**
   * The whole safety argument for applying this to a live database: it creates one empty table
   * and touches nothing that already exists. If any of these ever appears, the migration
   * stopped being the thing that was reviewed.
   */
  it("creates one table and alters no shipped one", () => {
    for (const pattern of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bADD COLUMN\b/i,
      /\bALTER COLUMN\b/i,
    ]) {
      expect(EXECUTABLE, `must not contain ${pattern}`).not.toMatch(pattern);
    }
    const creates = EXECUTABLE.split("\n").filter((l) => l.startsWith("CREATE TABLE"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('"worker_feedback"');
  });

  it("touches no table other than worker_feedback, apart from the FK it takes on workers", () => {
    // `workers` appears only as the REFERENCES target — never as the subject of a statement.
    const subjects = EXECUTABLE.split("\n")
      .map((l) => /^(?:CREATE TABLE|ALTER TABLE|REVOKE ALL ON TABLE) "([^"]+)"/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(new Set(subjects)).toEqual(new Set(["worker_feedback"]));
    const indexed = EXECUTABLE.split("\n")
      .map((l) => /^CREATE INDEX "[^"]+" ON "([^"]+)"/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(new Set(indexed)).toEqual(new Set(["worker_feedback"]));
  });

  it("documents a rollback that reverses every statement it makes", () => {
    // A migration whose rollback is not written down is a migration nobody will dare reverse
    // at 2am. Dropping the table takes its FK and all three indexes with it, so one statement
    // genuinely is the whole undo — the header has to say so, and say what it costs.
    const rollback = MIGRATION.slice(MIGRATION.indexOf("ROLLBACK"));
    expect(rollback).toContain('DROP TABLE IF EXISTS "worker_feedback";');
    expect(rollback).toMatch(/LOCKED_TABLES/);
    // And that it is lossy — the rows ARE the record; the event spine carries lengths only.
    expect(rollback).toMatch(/Lossy/i);
  });

  it("states the deploy ordering, because there is no savepoint behind this write", () => {
    // 0078's postmortem is the reason this is asserted rather than assumed: the ordering claim
    // is the one part of a migration header that is load-bearing at 3am on a deploy.
    expect(MIGRATION).toMatch(/APPLY BEFORE DEPLOY/);
  });
});

describe("0081 — the screen_context column is additive to a table that may already have rows", () => {
  /**
   * 0080 creates an EMPTY table, so "additive" there is nearly free. 0081 alters a table that
   * may hold real feedback, which makes the same word mean something stricter: no rewrite, no
   * default, no NOT NULL, and nothing that could fail on a row already stored.
   */
  it("adds one column and one CHECK, and touches nothing that already exists", () => {
    for (const pattern of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bALTER COLUMN\b/i,
      /\bCREATE TABLE\b/i,
      // A DEFAULT or a NOT NULL is what turns a catalog-only ADD COLUMN into a rewrite (and,
      // for NOT NULL, into a statement that cannot succeed on an existing row at all).
      /\bDEFAULT\b/i,
      /\bNOT NULL\b/i,
    ]) {
      expect(EXECUTABLE_0081, `must not contain ${pattern}`).not.toMatch(pattern);
    }
    const added = EXECUTABLE_0081.split("\n").filter((l) => /ADD COLUMN/.test(l));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('"screen_context" text');
  });

  it("touches only worker_feedback", () => {
    const subjects = EXECUTABLE_0081.split("\n")
      .map((l) => /^ALTER TABLE "([^"]+)"/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(new Set(subjects)).toEqual(new Set(["worker_feedback"]));
  });

  /**
   * The CHECK must admit NULL. Without that arm the ADD CONSTRAINT validates every stored row
   * against `char_length(NULL) BETWEEN 1 AND 128` — which is NULL, not false, so it happens to
   * pass today; but a later `SET NOT VALID`/`VALIDATE` or a stricter predicate written in the
   * same shape would not. Stating the NULL arm is what keeps the intent legible.
   */
  it("explicitly permits NULL — the value every existing row has", () => {
    expect(MIGRATION_0081).toContain('"worker_feedback"."screen_context" IS NULL OR');
  });

  it("states the deploy ordering HONESTLY — apply-before-deploy for the READ too", () => {
    // The tempting and wrong header here is "additive, so the read is safe". `AdminFeedbackRepository`
    // names `screen_context` in its explicit SELECT list, so the admin screen 500s without it —
    // additive describes the DDL, not the deploy.
    expect(MIGRATION_0081).toMatch(/APPLY BEFORE DEPLOY/);
    expect(MIGRATION_0081).toMatch(/READ:/);
  });

  it("documents a rollback that reverses both of its statements", () => {
    const rollback = MIGRATION_0081.slice(MIGRATION_0081.indexOf("ROLLBACK"));
    expect(rollback).toContain('DROP CONSTRAINT IF EXISTS "worker_feedback_screen_context_len_chk"');
    expect(rollback).toContain('DROP COLUMN IF EXISTS "screen_context"');
  });

  /**
   * RLS is a TABLE-level posture, so a new column inherits it and 0081 re-applies nothing. The
   * assertion is that it re-applies nothing DELIBERATELY: a copied FORCE/REVOKE tail here would
   * be harmless but would teach the next author that every migration needs one, and a copied
   * `GRANT` would not be harmless at all on the one table allowed to hold a worker's own prose.
   */
  it("adds no grant and no policy — the table-level posture from 0080 still governs", () => {
    expect(EXECUTABLE_0081).not.toMatch(/\bGRANT\b/i);
    expect(EXECUTABLE_0081).not.toMatch(/\bPOLICY\b/i);
    expect(EXECUTABLE_0081).not.toMatch(/ROW LEVEL SECURITY/i);
  });
});
