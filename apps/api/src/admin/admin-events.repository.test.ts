import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminEventsRepository } from "./admin-events.repository";
import { captureQueries } from "./testing/query-capture";

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

describe("countByPayloadField — the BP-5 cap-breach split", () => {
  it("filters on the INDEXED event_name and a windowed occurred_at", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date("2026-08-01T00:00:00.000Z"),
    );
    // `events_event_name_idx` is what keeps this off the full spine — `events` is the largest
    // table in the system, and an unindexed group-by over it is not a dashboard query.
    expect(c.sql()).toContain('"events"."event_name"');
    expect(c.sql()).toContain('"events"."occurred_at"');
    expect(c.params).toContain("ai.spend_cap_exceeded");
  });

  it("groups by the payload field as a BOUND PARAMETER, never interpolated text", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date(0),
    );
    // `->>` takes a text operand, so the field name travels as a parameter. If it were spliced
    // into the SQL string, this key would appear in the statement text instead.
    expect(c.params).toContain("reason");
    expect(c.sql()).not.toContain("'reason'");
    expect(c.sql()).toContain('"events"."payload"->>');
  });

  it("a payload with no such field groups under 'unknown' rather than being dropped", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField("x", "reason", new Date(0));
    // A breach whose reason did not serialize is still a breach; a silently-omitted bucket is
    // how "silence means zero" starts.
    expect(c.sql()).toMatch(/coalesce\("events"\."payload"->>\$\d+, 'unknown'\)/);
  });
});
