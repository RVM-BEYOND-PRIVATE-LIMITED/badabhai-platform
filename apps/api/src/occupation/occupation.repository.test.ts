/**
 * DB-free unit of the raw SQL behind retrieval layer L2.
 *
 * WHY THIS IS WORTH A TEST AT ALL. L2 is the only layer whose correctness lives entirely
 * inside one SQL statement, and its failure mode is silent by construction: it returns
 * rows, scores them correctly, and simply considers the wrong candidate set. Nothing
 * throws, no count goes to zero, and the layer only runs when L0 and L1 have already
 * missed — so there is no comparison to notice it against.
 *
 * That is not hypothetical. As first merged the WHERE clause used `%>` while the SELECT
 * ranked on the commutator, which discarded 168 of 186 admissible aliases for "welding"
 * and 65 of 74 for "silai".
 *
 * Same capture-and-render approach as `skills.repository.test.ts`, including its comment
 * stripping — without that, `toContain("<%")` would happily pass on the prose above the
 * query while the predicate itself said something else.
 */
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { OccupationRepository } from "./occupation.repository";

function makeCapturingDb(rows: unknown[] = []) {
  const captured: { sql?: unknown; statements: unknown[] } = { statements: [] };
  const exec = vi.fn((statement: unknown) => {
    captured.statements.push(statement);
    captured.sql = statement;
    return Promise.resolve(rows);
  });
  const db = {
    execute: exec,
    transaction: vi.fn((fn: (tx: unknown) => unknown) => Promise.resolve(fn({ execute: exec }))),
  };
  return { db, captured };
}

function sqlText(statement: unknown): string {
  return new PgDialect()
    .sqlToQuery(statement as never)
    .sql.split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

async function capture(query = "welding", k = 8) {
  const { db, captured } = makeCapturingDb();
  await new OccupationRepository(db as never).trigramCandidates(query, k);
  return { sql: sqlText(captured.sql), statements: captured.statements };
}

describe("OccupationRepository.trigramCandidates — the L2 SQL", () => {
  it("filters with `<%`, the SAME direction the score ranks on", async () => {
    // `A <% B` is word_similarity(A, B) > threshold; `A %> B` is the reverse. The SELECT
    // ranks on word_similarity(query, text_norm), so the WHERE must admit rows on that
    // same expression. Measured: word_similarity('welding', 'welder gas cutting
    // operations') = 0.5000, while the reverse is 0.1875.
    const { sql } = await capture();
    expect(sql).toContain("<%");
  });

  it("does NOT use the commutator `%>`", async () => {
    // Split from the assertion above deliberately. A statement containing both would pass
    // a `toContain("<%")` check while still filtering the wrong way somewhere.
    const { sql } = await capture();
    expect(sql).not.toContain("%>");
  });

  it("scores the query INTO the alias, not the alias into the query", async () => {
    // The asymmetry is the point: a worker says "welding" and the alias is "Welder, Gas
    // Cutting Operations". The short query must be allowed to match a fragment of the long
    // alias without being penalised for the rest of it.
    const { sql } = await capture();
    expect(sql).toMatch(/word_similarity\(\s*\$\d+\s*,\s*a\.text_norm\s*\)/);
  });

  it("carries `is_searchable`, the retrieval-surface predicate", async () => {
    expect((await capture()).sql).toContain("a.is_searchable");
  });

  it("re-checks selectable/active against the SOURCE OF TRUTH", async () => {
    // `is_searchable` is a materialized projection refreshed by a separate runner and goes
    // stale between `db:normalize:aliases` runs. A wrong domain is worse than no domain.
    const { sql } = await capture();
    expect(sql).toContain("d.selectable = true");
    expect(sql).toContain("d.status = 'active'");
  });

  it("dedupes to the best alias per domain", async () => {
    // Otherwise a domain with forty aliases fills the shortlist with itself and crowds out
    // the alternatives the margin needs in order to refuse to guess.
    const { sql } = await capture();
    expect(sql).toContain("group by a.job_domain_id");
    expect(sql).toContain("max(word_similarity");
  });

  it("sets the word-similarity threshold INSIDE the transaction", async () => {
    // `SET LOCAL` outside a transaction warns and does nothing; a plain `SET` would leak
    // the setting into the next user of this pooled connection.
    const { statements } = await capture();
    expect(statements).toHaveLength(2);
    expect(sqlText(statements[0])).toContain("set local pg_trgm.word_similarity_threshold");
  });

  it("bounds the result with a SQL LIMIT rather than slicing in JS", async () => {
    expect((await capture("welding", 8)).sql).toContain("limit");
  });

  it("passes the query as a BOUND PARAMETER, never interpolated", async () => {
    // The one method on this class that receives worker text. Interpolating it would be an
    // injection surface on the chat hot path.
    const { sql } = await capture("welding'; drop table job_domain; --");
    expect(sql).not.toContain("drop table");
  });
});
