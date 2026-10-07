import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "@badabhai/db";
import { describe, expect, it } from "vitest";

import { workerTurnsStatement } from "./worker-transcript.repository";

/**
 * The résumé's quote/veto reader, read off the compiled SQL — no database (the
 * `resume-import.repository.query.test.ts` pattern). Every consumer of this repository fakes it, so
 * a WHERE clause that lost a conjunct would pass every other test in the suite.
 *
 * ADR-0048 (D10) is the new conjunct: an identity-intake answer ("Ramesh Kumar", "Pune") is an
 * inbound row, and without the exclusion the quote block could print it as the worker's own words
 * about his work.
 */

const db = drizzle.mock() as unknown as Database;
const WORKER = "11111111-1111-4111-8111-111111111111";

describe("workerTurnsStatement", () => {
  const compiled = workerTurnsStatement(db, WORKER, 200).toSQL();

  it("reads the worker's own inbound, non-null rows — and NOT an identity-intake or free-chat line", () => {
    expect(compiled.sql).toMatch(
      /where \("chat_messages"\."worker_id" = \$\d+ and "chat_messages"\."direction" = \$\d+ and "chat_messages"\."body_text" is not null and not \("chat_messages"\."metadata" @> \$\d+::jsonb or "chat_messages"\."metadata" @> \$\d+::jsonb\)\)/,
    );
    expect(compiled.params).toContain(WORKER);
    expect(compiled.params).toContain("inbound");
    // The markers are bound, never interpolated, and they are exactly the ones the flush writes.
    expect(compiled.params).toContain(JSON.stringify({ identity_intake: true }));
    // ADR-0051 §3.5 — a worker's casual talk must never be quoted as his words about his work.
    expect(compiled.params).toContain(JSON.stringify({ free_chat: true }));
  });

  it("stays newest-first and capped — the cost bound is unchanged", () => {
    expect(compiled.sql).toMatch(/order by "chat_messages"\."created_at" desc limit \$\d+$/);
    expect(compiled.params.at(-1)).toBe(200);
  });
});
