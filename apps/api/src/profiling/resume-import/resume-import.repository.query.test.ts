import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "@badabhai/db";
import { describe, expect, it } from "vitest";

import {
  markFailedStatement,
  ResumeImportRepository,
  saveIdentitySummaryStatement,
  settleParsedStatement,
} from "./resume-import.repository";

/**
 * The status GUARDS on the two terminal writes, read off the compiled SQL — no database.
 *
 * WHY THIS FILE EXISTS WHEN `resume-import.repository.db.test.ts` DOES. CI runs DB suites from a
 * HAND-LISTED set (`.github/workflows/ci.yml`, step "DB-backed gates", `RUN_DB_TESTS=1`), and
 * this feature's DB suite is not on that list yet — adding it is a follow-up. Until it is, a
 * guard pinned only there is a guard this pipeline does not check. Dropping `status = 'parsing'`
 * from the settle reintroduces the bug the settle fixes — a late write overwriting a settled row
 * — and would pass every other CI test, because every other test fakes the repository.
 * `drizzle.mock()` builds the real statement without a connection, so the WHERE clause itself is
 * the thing under test.
 *
 * The real CHECKs and the real zero-row behaviour are the DB suite's; this proves that the right
 * SQL is asked for, and that the row count coming back is mapped the way the callers read it.
 */

const db = drizzle.mock() as unknown as Database;
const ID = "22222222-2222-4222-8222-222222222222";

/** The value bound to the `$n` placeholder that follows `column =` in `sql`. */
function boundTo(compiled: { sql: string; params: unknown[] }, clause: RegExp): unknown {
  const match = compiled.sql.match(clause);
  expect(match, `expected ${clause} in: ${compiled.sql}`).not.toBeNull();
  return compiled.params[Number(match![1]) - 1];
}

const WHERE_STATUS = /where .*"worker_resume_import"\."status" = \$(\d+)/;
const WHERE_ID = /where .*"worker_resume_import"\."id" = \$(\d+)/;

/**
 * THE WHOLE PREDICATE, NOT TWO SIGHTINGS OF IT.
 *
 * `WHERE_STATUS` and `WHERE_ID` each only prove their column appears somewhere after `where`,
 * and `id = $n OR status = $m` satisfies both. That mutation is not academic: `or` makes the id
 * optional, so ONE settle would move EVERY in-flight `parsing` import — every worker's — to
 * `parsed` carrying this worker's route, form kind and sealed suggestions, and the next worker
 * would be offered another man's résumé. This pins the conjunction, the order and the anchor.
 */
const WHERE_GUARD =
  / where \("worker_resume_import"\."id" = \$\d+ and "worker_resume_import"\."status" = \$\d+\) returning "id"$/;

describe("settleParsedStatement", () => {
  const compiled = settleParsedStatement(
    db,
    ID,
    { extractionMethod: "ocr", pageCount: 2, ocrConfidence: 0.8 , fieldsExtracted: 3},
    { route: "form", formKind: "cnc_turner", associationKind: "cnc_turner", suggestionsEnc: "v1:token" },
  ).toSQL();

  it("is guarded WHERE id AND status = 'parsing' — a settled row is never written twice", () => {
    expect(compiled.sql).toMatch(WHERE_GUARD);
    expect(boundTo(compiled, WHERE_STATUS)).toBe("parsing");
    expect(boundTo(compiled, WHERE_ID)).toBe(ID);
  });

  it("writes status AND route AND form kind AND the token AND the facts in the ONE statement", () => {
    // THE WHOLE FIX IN ONE ASSERTION. If any of these moves to a second statement, a reader can
    // once again see `parsed` beside a null route.
    const setClause = compiled.sql.slice(0, compiled.sql.indexOf(" where "));
    expect(boundTo({ sql: setClause, params: compiled.params }, /"status" = \$(\d+)/)).toBe("parsed");
    expect(boundTo({ sql: setClause, params: compiled.params }, /"route" = \$(\d+)/)).toBe("form");
    expect(boundTo({ sql: setClause, params: compiled.params }, /"form_kind" = \$(\d+)/)).toBe(
      "cnc_turner",
    );
    // Task 1 B2 — the judgment rides the same single statement (a reader can
    // never see `parsed` beside a missing judgment).
    expect(boundTo({ sql: setClause, params: compiled.params }, /"association_kind" = \$(\d+)/)).toBe(
      "cnc_turner",
    );
    expect(boundTo({ sql: setClause, params: compiled.params }, /"suggestions_enc" = \$(\d+)/)).toBe(
      "v1:token",
    );
    expect(
      boundTo({ sql: setClause, params: compiled.params }, /"extraction_method" = \$(\d+)/),
    ).toBe("ocr");
    expect(boundTo({ sql: setClause, params: compiled.params }, /"page_count" = \$(\d+)/)).toBe(2);
    expect(boundTo({ sql: setClause, params: compiled.params }, /"ocr_confidence" = \$(\d+)/)).toBe(
      0.8,
    );
    expect(compiled.sql).toMatch(/returning "id"/);
  });

  it("nulls form kind on the chat route and confidence off OCR — both CHECKs are equivalences", () => {
    const chat = settleParsedStatement(
      db,
      ID,
      { extractionMethod: "pdf_text", pageCount: 1, ocrConfidence: 0.8 , fieldsExtracted: 3},
      { route: "chat", formKind: "cnc_turner", associationKind: "fitter", suggestionsEnc: null },
    ).toSQL();
    const set = { sql: chat.sql.slice(0, chat.sql.indexOf(" where ")), params: chat.params };
    expect(boundTo(set, /"form_kind" = \$(\d+)/)).toBeNull();
    expect(boundTo(set, /"ocr_confidence" = \$(\d+)/)).toBeNull();
    // …but the judgment is kept on chat rows: "judged none/other" is the signal.
    expect(boundTo(set, /"association_kind" = \$(\d+)/)).toBe("fitter");
    expect(boundTo(chat, WHERE_STATUS)).toBe("parsing");
  });
});

describe("saveIdentitySummaryStatement", () => {
  const compiled = saveIdentitySummaryStatement(db, ID, {
    roleKind: "welder",
    experienceText: "2 saal ka tajurba",
    summaryText: "Welding ka kaam",
  }).toSQL();

  it("is guarded WHERE id AND status IN (parsing, parsed) — failed/discarded rows stage nothing", () => {
    // A redelivery that finds the row settled may still backfill a lost line; a row that
    // failed or was discarded must never grow one. `parsing`/`parsed` is the whole list.
    // `inArray` parameterizes the list (unlike the `=` guards above), so the membership is
    // read off the bound params, not the SQL text.
    expect(compiled.sql).toMatch(
      / where \("worker_resume_import"\."id" = \$\d+ and "worker_resume_import"\."status" in \(\$\d+, ?\$\d+\)\) returning "id"$/,
    );
    expect(boundTo(compiled, WHERE_ID)).toBe(ID);
    expect(compiled.params).toContain("parsing");
    expect(compiled.params).toContain("parsed");
    expect(compiled.params).not.toContain("failed");
    expect(compiled.params).not.toContain("discarded");
  });

  it("writes ONLY the identity line — never status, route, or suggestions", () => {
    // THE SEPARATION THE SETTLE FIX DEMANDS. This write runs beside the settle on the same
    // job; sharing a column with it would reopen the two-statement defect in a new shape.
    const setClause = compiled.sql.slice(0, compiled.sql.indexOf(" where "));
    expect(
      boundTo({ sql: setClause, params: compiled.params }, /"identity_role_kind" = \$(\d+)/),
    ).toBe("welder");
    expect(
      boundTo({ sql: setClause, params: compiled.params }, /"identity_experience_text" = \$(\d+)/),
    ).toBe("2 saal ka tajurba");
    expect(
      boundTo({ sql: setClause, params: compiled.params }, /"identity_summary_text" = \$(\d+)/),
    ).toBe("Welding ka kaam");
    expect(setClause).not.toContain('"status"');
    expect(setClause).not.toContain('"route"');
    expect(setClause).not.toContain('"suggestions_enc"');
    expect(compiled.sql).toMatch(/returning "id"/);
  });
});

describe("markFailedStatement", () => {
  const compiled = markFailedStatement(db, ID, "parse_output_invalid", null).toSQL();

  it("is guarded WHERE id AND status = 'parsing' — a late failure never overwrites a parsed row", () => {
    expect(compiled.sql).toMatch(WHERE_GUARD);
    expect(boundTo(compiled, WHERE_STATUS)).toBe("parsing");
    expect(boundTo(compiled, WHERE_ID)).toBe(ID);
  });

  it("writes the status and its reason together (`wri_failure_reason_chk` is a biconditional)", () => {
    const set = {
      sql: compiled.sql.slice(0, compiled.sql.indexOf(" where ")),
      params: compiled.params,
    };
    expect(boundTo(set, /"status" = \$(\d+)/)).toBe("failed");
    expect(boundTo(set, /"failure_reason" = \$(\d+)/)).toBe("parse_output_invalid");
    expect(compiled.sql).toMatch(/returning "id"/);
  });
});

/**
 * The OTHER half of the guard: what the repository does with the rows the guard sends back.
 *
 * THE SQL BEING RIGHT IS NOT ENOUGH. Both callers treat the boolean as their ENTITLEMENT TO
 * EMIT — `settleParsed` -> `profile.resume_parsed`, `markFailed` -> `profile.resume_parse_failed`
 * — so a `return true` that ignores the row count re-arms the double-count the guard removed: a
 * redelivery would match zero rows and emit anyway. Only the DB suite builds a real repository,
 * and that suite is not yet on ci.yml's DB-gate list, so this maps the rows here instead.
 *
 * A STUB EXECUTOR, NOT A DATABASE. The statement builders are covered above; all this needs is
 * something that returns the array `RETURNING` would.
 */
describe("rows -> boolean: zero rows means this call settled nothing", () => {
  /** The update chain, ending in one queued `RETURNING` result per execution. */
  function queuedExecutor(results: { id: string }[][]) {
    let executions = 0;
    const chain = {
      update: () => chain,
      set: () => chain,
      where: () => chain,
      returning: () => Promise.resolve(results[executions++] ?? []),
    };
    return { tx: chain as unknown as Database, executions: () => executions };
  }

  // `null` AS THE INJECTED DATABASE IS DELIBERATE. `tx` is required, not defaulted; a settle
  // that reached for `this.db` instead would throw here rather than quietly run off-transaction.
  const repo = new ResumeImportRepository(null as unknown as Database);
  const FACTS = { extractionMethod: "pdf_text" as const, pageCount: 1, ocrConfidence: null , fieldsExtracted: 3};
  const ROUTING = { route: "form" as const, formKind: "cnc_turner", associationKind: "cnc_turner", suggestionsEnc: "v1:token" };

  it("settleParsed: [] -> false (a redelivery emits nothing), [{id}] -> true", async () => {
    const executor = queuedExecutor([[], [{ id: ID }]]);

    await expect(repo.settleParsed(ID, FACTS, ROUTING, executor.tx)).resolves.toBe(false);
    await expect(repo.settleParsed(ID, FACTS, ROUTING, executor.tx)).resolves.toBe(true);
    // VACUITY CHECK: both answers came from an executed statement, not from a short-circuit.
    expect(executor.executions()).toBe(2);
  });

  it("markFailed: [] -> false (the row had already left `parsing`), [{id}] -> true", async () => {
    const executor = queuedExecutor([[], [{ id: ID }]]);

    await expect(
      repo.markFailed(ID, "parse_output_invalid", null, executor.tx),
    ).resolves.toBe(false);
    await expect(
      repo.markFailed(ID, "parse_output_invalid", "ocr", executor.tx),
    ).resolves.toBe(true);
    expect(executor.executions()).toBe(2);
  });
});
