import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "@badabhai/db";
import { describe, expect, it } from "vitest";

import { markFailedStatement, settleParsedStatement } from "./resume-import.repository";

/**
 * The status GUARDS on the two terminal writes, read off the compiled SQL — no database.
 *
 * WHY THIS FILE EXISTS WHEN `resume-import.repository.db.test.ts` DOES. RUN_DB_TESTS suites are
 * skipped in CI, so a guard pinned only there is a guard nobody's pipeline checks. Dropping
 * `status = 'parsing'` from the settle reintroduces the bug the settle fixes — a late write
 * overwriting a settled row — and would pass every other CI test, because every other test
 * fakes the repository. `drizzle.mock()` builds the real statement without a connection, so
 * the WHERE clause itself is the thing under test.
 *
 * The real CHECKs and the real zero-row behaviour are the DB suite's; this proves only that the
 * right SQL is asked for, which is the half CI can see.
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

describe("settleParsedStatement", () => {
  const compiled = settleParsedStatement(
    db,
    ID,
    { extractionMethod: "ocr", pageCount: 2, ocrConfidence: 0.8 },
    { route: "form", formKind: "cnc_turner", suggestionsEnc: "v1:token" },
  ).toSQL();

  it("is guarded WHERE status = 'parsing' — a settled row is never written twice", () => {
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
      { extractionMethod: "pdf_text", pageCount: 1, ocrConfidence: 0.8 },
      { route: "chat", formKind: "cnc_turner", suggestionsEnc: null },
    ).toSQL();
    const set = { sql: chat.sql.slice(0, chat.sql.indexOf(" where ")), params: chat.params };
    expect(boundTo(set, /"form_kind" = \$(\d+)/)).toBeNull();
    expect(boundTo(set, /"ocr_confidence" = \$(\d+)/)).toBeNull();
    expect(boundTo(chat, WHERE_STATUS)).toBe("parsing");
  });
});

describe("markFailedStatement", () => {
  const compiled = markFailedStatement(db, ID, "parse_output_invalid", null).toSQL();

  it("is guarded WHERE status = 'parsing' — a late failure never overwrites a parsed row", () => {
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
