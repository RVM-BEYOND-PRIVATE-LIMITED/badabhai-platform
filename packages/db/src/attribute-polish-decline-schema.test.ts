/**
 * `worker_attributes.value_text_polished_declined` — the fresher's refusal, declared by `0103`.
 *
 * Zone 4 for a fresher is his ITI training, and its one worker-written segment
 * (`iti_project_work`) is a sentence #1350 lets a model rewrite and print on the sheet an
 * employer reads. #1354 gave that refusal to a worker per employment; a fresher has no
 * employment, so he had none. This column is his, and everything downstream of it — the
 * repository's CASE on the upsert, `loadTradeSheet`'s `declinedAttributes`, the processor's gate
 * — reads a boolean that only the model and the migration define. These tests read the drizzle
 * model and the generated SQL, never a live database, so they run in ordinary CI.
 *
 * What they defend, in the order it would break:
 *
 * 1. THE DEFAULT. `false` means "the worker has not objected", which is what every row written
 *    before 0103 holds and what the repository's CASE preserves. A nullable column, or one
 *    defaulting true, turns the absence of an objection into one — and the ordinary state of
 *    this flag is the absence of an objection, so that is every row.
 * 2. THE SCOPE. `wa_value_text_polished_declined_chk` is the brace on the repository's belt: a
 *    refusal on a slug answer is meaningless, because nothing may rephrase closed vocabulary.
 *    The UPDATE scopes itself to `value_kind = 'text'`; a CHECK cannot be forgotten.
 * 3. THE LEDGER. This repository has had `_journal.json` drift before (manual applies), and the
 *    failure is silent: drizzle-kit reads the journal, so a file it does not list is a column
 *    that exists in the model, in this test, and in no deployed database.
 * 4. THE BARREL. `workerAttributes` missing from the hand-maintained `schema` object surfaces as
 *    a bare RLS drift count in a suite that has nothing to do with this one — the failure mode
 *    `qualification-schema.test.ts` was written for.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Column, is } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "./schema";
import { workerAttributes } from "./schema/profiling";

const MIGRATIONS = join(__dirname, "../migrations");
const TAG = "0103_plain_anthem";
const MIGRATION = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");

/**
 * The migration with every `--` line removed.
 *
 * The additive-only assertions are about what Postgres will EXECUTE. House convention is for a
 * migration header to document its own rollback, which necessarily contains `DROP COLUMN`;
 * matching the raw text would conflate "this migration drops a column" with "this migration
 * explains how to undo itself", and the second is a virtue.
 */
const EXECUTABLE = MIGRATION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

/** Statements as Postgres sees them, with drizzle's breakpoint marker stripped. */
const STATEMENTS = EXECUTABLE.split(/;|-->\s*statement-breakpoint/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const config = getTableConfig(workerAttributes);
const columns = new Map(config.columns.map((c) => [c.name, c]));
const checkNames = config.checks.map((c) => c.name);

/**
 * A CHECK's predicate as text, WITH its column references rendered as their SQL names.
 *
 * THE COLUMNS ARE THE HALF WORTH PINNING, and dropping them is how this helper first read. A
 * predicate rendered as only its literal fragments — "= false OR", "= 'text'" — is identical for
 * `value_text_polished_declined = false OR value_kind = 'text'` and for a model that had drifted
 * onto `value_text_polished = false OR source = 'text'`. The migration pins the real columns, but
 * the migration is applied and frozen; the MODEL is what the next `db:generate` diffs, so a
 * model-only drift would ship as a fresh ALTER nobody asked for and this file would be green.
 */
const predicateOf = (name: string): string => {
  const check = config.checks.find((c) => c.name === name);
  expect(check, `${name} must exist on the model`).toBeDefined();
  return check!.value.queryChunks
    .map((chunk) => {
      if (is(chunk, Column)) return chunk.name;
      return typeof chunk === "object" && chunk !== null && "value" in chunk
        ? [chunk.value].flat().join("")
        : "";
    })
    .join("");
};

describe("the refusal column is declared on the model the repository writes through", () => {
  it("carries the TS name the repository names and the SQL name the UPDATE names", () => {
    // Both halves. `WorkerAttributesRepository` reaches the flag as `valueTextPolishedDeclined`
    // on the model and Postgres stores it as `value_text_polished_declined`; a rename on either
    // side is a compile error in one place and a 42703 at runtime in the other.
    expect(Object.keys(workerAttributes)).toContain("valueTextPolishedDeclined");
    expect(columns.has("value_text_polished_declined")).toBe(true);
    expect(workerAttributes.valueTextPolishedDeclined.name).toBe("value_text_polished_declined");
  });

  /**
   * FALSE IS THE SAFE DEFAULT AND IT IS THE WHOLE REASON THIS IS NOT NULLABLE.
   *
   * `false` means "the worker has not objected" — what every row written before 0103 holds, and
   * what a reader may always assume without checking when the row was written. Nullable would
   * put a third state ("unknown") in front of every consumer: `loadTradeSheet` builds a sparse
   * set from truthiness, so a NULL would read as not-declined anyway, and the column would have
   * gained a state that means the same thing as one it already had. Defaulting TRUE is worse in
   * the other direction: it would silence the rewrite for every fresher on the platform, which
   * is #1350 reverted by a DDL choice nobody would connect to it.
   */
  it("is NOT NULL and defaults to false — the state of every pre-0103 row", () => {
    const column = columns.get("value_text_polished_declined");
    expect(column?.notNull).toBe(true);
    expect(column?.hasDefault).toBe(true);
    expect(column?.default).toBe(false);
    // And in the SQL, because the model is what `db:generate` diffs and the file is what
    // Postgres runs. A NOT NULL whose default arrived only in the model cannot be applied to a
    // table that already holds rows at all.
    expect(EXECUTABLE).toContain(
      'ADD COLUMN "value_text_polished_declined" boolean DEFAULT false NOT NULL',
    );
  });

  it("is a boolean — a refusal has two states, not a timestamp and not a reason code", () => {
    // The column answers one question the renderer asks (`declined.has(key)`). Widening it to
    // carry WHEN or WHY would make every reader parse a value whose only use is truthiness, and
    // the event `worker.answer_text_source_set` is already the record of when and by whom.
    expect(columns.get("value_text_polished_declined")?.getSQLType()).toBe("boolean");
  });
});

describe("the refusal is scoped to text answers, by a CHECK and not by trust", () => {
  /**
   * WHAT THIS PREVENTS: a refusal attached to a slug answer.
   *
   * It is meaningless, because nothing may rephrase closed vocabulary — a slug, a number and a
   * boolean have nothing to rewrite, and sending one to a model is the §8 violation
   * `value_text_polished` is carefully scoped to avoid. This CHECK is the same scope
   * `wa_value_text_polished_chk` enforces for the rewrite itself, applied to the refusal of it,
   * so the two cannot drift into disagreeing about which rows a model may touch.
   *
   * `setTextPolishDeclined` scopes its UPDATE to `value_kind = 'text'` as the belt. This is the
   * brace: a second writer (a backfill, an ops script, the next endpoint) cannot forget it.
   */
  it("declares wa_value_text_polished_declined_chk on the table, beside the rewrite's own", () => {
    expect(checkNames).toContain("wa_value_text_polished_declined_chk");
    // Both, named together: a change that scoped one to text answers and not the other would
    // leave a row a model may not rewrite but a worker may refuse.
    expect(checkNames).toContain("wa_value_text_polished_chk");
    expect(MIGRATION).toContain('ADD CONSTRAINT "wa_value_text_polished_declined_chk" CHECK');
  });

  it("permits exactly two shapes: not declined, or declined on a text answer", () => {
    // Read off the MODEL, which is what the next `db:generate` diffs — pinning only the SQL is
    // a two-of-three pin, and the migration is the half that is already applied and frozen.
    const predicate = predicateOf("wa_value_text_polished_declined_chk");
    // THE WHOLE PREDICATE, COLUMNS INCLUDED, normalised for whitespace only. Asserting the
    // fragments alone cannot tell this predicate from one that had drifted onto the rewrite column
    // or onto `source` — see {@link predicateOf}.
    expect(predicate.replace(/\s+/g, " ").trim()).toBe(
      "value_text_polished_declined = false OR value_kind = 'text'",
    );
    // The discriminating half: the predicate must NOT be satisfiable by a declined slug. The
    // two spellings that would be — dropping the second arm, or inverting the first — differ
    // from the above only in text, so assert the full statement as Postgres received it.
    expect(MIGRATION).toContain(
      'CHECK ("worker_attributes"."value_text_polished_declined" = false ' +
        'OR "worker_attributes"."value_kind" = \'text\')',
    );
    expect(predicate).not.toContain("= true OR");
  });
});

describe("0103 is additive and reversible against a table that already holds answers", () => {
  /**
   * THE SAFETY ARGUMENT FOR APPLYING THIS TO A LIVE DATABASE, as an assertion.
   *
   * `worker_attributes` is the record of what every worker answered, so "additive" here means
   * something stricter than it does on an empty table: no rewrite, no rewritten type, nothing
   * that can fail on a row already stored. A DEFAULT-bearing `ADD COLUMN` is catalog-only on
   * Postgres 11+, and a CHECK that every existing row already satisfies (they all hold `false`,
   * by that same default) validates without a table scan of consequence. Either property lost
   * turns a deploy-time DDL into an outage on the platform's widest table.
   */
  it("only ADDs — no DROP, no ALTER COLUMN, no data statement", () => {
    for (const pattern of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bALTER COLUMN\b/i, // covers SET/DROP DEFAULT, SET NOT NULL and `... TYPE`
      /\bCREATE TABLE\b/i,
      /\bCREATE INDEX\b/i,
    ]) {
      expect(EXECUTABLE, `must not contain ${pattern}`).not.toMatch(pattern);
    }
    // The discriminating half, without which the loop above passes for an EMPTY file: this
    // migration really does carry the two statements it is being scanned for.
    expect(STATEMENTS).toHaveLength(2);
    expect(STATEMENTS.filter((s) => /ADD COLUMN/.test(s))).toHaveLength(1);
    expect(STATEMENTS.filter((s) => /ADD CONSTRAINT/.test(s))).toHaveLength(1);
  });

  it("attaches a DEFAULT to the NOT NULL — the only form that can apply to existing rows", () => {
    // `ADD COLUMN ... NOT NULL` with no default cannot succeed against a single stored row, and
    // `worker_attributes` has them in production. Asserted per statement rather than over the
    // whole file so a later migration that adds two columns cannot satisfy it by having a
    // default somewhere else.
    for (const statement of STATEMENTS.filter((s) => /ADD COLUMN/.test(s))) {
      if (!/\bNOT NULL\b/i.test(statement)) continue;
      expect(statement, "a NOT NULL column must arrive with a DEFAULT").toMatch(/\bDEFAULT\b/i);
    }
  });

  it("touches worker_attributes and nothing else", () => {
    const subjects = STATEMENTS.map((s) => /^ALTER TABLE "([^"]+)"/.exec(s)?.[1]).filter(
      (t): t is string => t !== undefined,
    );
    expect(new Set(subjects)).toEqual(new Set(["worker_attributes"]));
  });

  it("is reversible by two statements, neither of which loses a worker's answer", () => {
    // Not a header assertion — a property one. The undo of this migration is
    // `DROP CONSTRAINT ... / DROP COLUMN "value_text_polished_declined"`, and it is lossless
    // for the ANSWER: `value_text` and `value_text_polished` are untouched here, so a rollback
    // costs the refusals and nothing a worker typed. That is only true while this file adds a
    // column and reads none.
    expect(EXECUTABLE).not.toContain('"value_text"');
    expect(EXECUTABLE).not.toContain('"value_text_polished"');
    expect(EXECUTABLE).not.toMatch(/\bSELECT\b/i);
  });

  it("adds no grant and no policy — the table-level RLS posture still governs", () => {
    // RLS is a TABLE-level property, so a new column inherits it and 0103 re-applies nothing.
    // A copied `GRANT` here would not be harmless: this table holds the worker's own prose.
    expect(EXECUTABLE).not.toMatch(/\bGRANT\b/i);
    expect(EXECUTABLE).not.toMatch(/\bPOLICY\b/i);
    expect(EXECUTABLE).not.toMatch(/ROW LEVEL SECURITY/i);
  });
});

describe("the migration ledger lists 0103, and lists nothing it does not have", () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));

  /**
   * PINNED BECAUSE THIS REPOSITORY HAS DRIFTED HERE BEFORE, and the drift is silent in the worst
   * direction: `drizzle-kit migrate` reads the JOURNAL, not the directory, so a `.sql` file it
   * does not list is never executed anywhere. Every test in this file would still pass — they
   * read the model and the file text — while the column exists in no deployed database and the
   * first `setTextPolishDeclined` is a 42703 on the worker's own request.
   */
  it("has one journal entry per .sql file, and one file per entry", () => {
    expect(files).toHaveLength(journal.entries.length);
    // Set equality names the drifting tag; the count above alone would pass for a journal that
    // lists one migration twice and another not at all.
    expect(new Set(journal.entries.map((e) => e.tag))).toEqual(new Set(files));
  });

  it("lists 0103's tag, under the filename it actually has", () => {
    // `_journal.json` binds the tag to the filename, so renaming one means renaming both.
    const entry = journal.entries.find((e) => e.tag === TAG);
    expect(entry, `${TAG} has no journal entry`).toBeDefined();
    expect(files).toContain(TAG);
  });

  /**
   * THE SILENT-SKIP TRAP. `drizzle-kit migrate` branches on a HIGH-WATER MARK, not on set
   * membership: an entry stamped at or below the newest `when` recorded before it is skipped
   * silently and permanently. drizzle-kit's own stamp has been below it twice on this
   * repository, which is why every migration asserts this for itself.
   *
   * Compared against PREDECESSORS ONLY — a later migration has its own watermark and says
   * nothing about this one.
   */
  it("is stamped above every entry before it", () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThanOrEqual(0);
    for (const before of journal.entries.slice(0, at)) {
      expect(before.when, `${before.tag} must be stamped below ${TAG}`).toBeLessThan(
        journal.entries[at]!.when,
      );
    }
  });
});

describe("worker_attributes is registered in the model", () => {
  /**
   * The e2e RLS drift guard asserts `live.size === Object.keys(schema).length`, so a table
   * re-exported from its module but missing from the barrel's hand-maintained `schema` object
   * fails an unrelated suite with a bare count mismatch that names no table. Catching it here
   * names it — and on this table the omission would also take the new column's RLS coverage
   * with it, on the table that holds the worker's own prose.
   */
  it("is in the exported schema object, not only re-exported from the module", () => {
    expect(Object.keys(schema)).toContain("workerAttributes");
    expect(schema.workerAttributes).toBe(workerAttributes);
  });
});
