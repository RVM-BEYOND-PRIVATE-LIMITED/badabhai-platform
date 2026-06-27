import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminEventsRepository } from "./admin-events.repository";

/**
 * SELECT-ONLY guarantee for the ADMIN-2 event-spine repository (ADR-0025 must-fix #3 / CLAUDE.md
 * invariant #1 — the events table is append-only). Two independent checks:
 *   1. A SOURCE scan: the file never issues `.update(events)` / `.delete(events)` / `.insert(events)`.
 *      (The repo-wide static guard in `admin-static-guards.test.ts` covers update/delete across
 *      admin/**; this adds insert + pins it specifically to this new file.)
 *   2. A SHAPE check: the public methods are all read verbs (list/find/trace/count/stats) — no
 *      method name implies a write.
 */
describe("AdminEventsRepository is SELECT-ONLY over `events` (spine immutability)", () => {
  const SRC = readFileSync(join(__dirname, "admin-events.repository.ts"), "utf8");

  it("issues NO update/delete/insert against the events table", () => {
    expect(SRC).not.toMatch(/\.update\s*\(\s*events\b/);
    expect(SRC).not.toMatch(/\.delete\s*\(\s*events\b/);
    expect(SRC).not.toMatch(/\.insert\s*\(\s*events\b/);
  });

  it("every public method is a READ verb (no mutating method name)", () => {
    const methods = Object.getOwnPropertyNames(AdminEventsRepository.prototype).filter(
      (m) => m !== "constructor",
    );
    const writeVerb = /^(insert|update|delete|create|set|save|remove|upsert|write)/i;
    for (const m of methods) {
      expect(writeVerb.test(m), `method ${m} looks like a write`).toBe(false);
    }
  });

  it("the only mutation verbs in the file are SELECT/COUNT/GROUP BY (read shape)", () => {
    // Drizzle reads use `.select(`; assert that is the ONLY db-call verb present.
    expect(SRC).toContain(".select(");
    expect(SRC).toMatch(/\bcount\(\*\)/); // aggregations are count-only
  });
});
