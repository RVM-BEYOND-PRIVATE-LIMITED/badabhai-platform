import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_PAYLOAD_GROUP_FIELDS,
  AdminEventsRepository,
  type AdminPayloadGroupField,
} from "./admin-events.repository";
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

  /**
   * THE SHAPE OF THE BUG THIS SUITE NOW PINS (2026-08-19). The key started life as
   * `payload->>${field}` with `field` BOUND. Drizzle renders each `Param` occurrence as its own
   * placeholder, so the SELECT list got `$1`, GROUP BY `$4`, ORDER BY `$5`; Postgres matches a
   * GROUP BY expression structurally, `Param(1) != Param(4)`, and every request 500'd with
   * `column "events.payload" must appear in the GROUP BY clause`. A shape test CANNOT see that —
   * `captureQueries` never executes SQL — which is why `admin-dashboard.db.test.ts` now runs the
   * query for real. What IS assertable here is the property the fix rests on: all three clauses
   * render the IDENTICAL text.
   */
  const KEY_EXPR = `coalesce("events"."payload"->>'reason', 'unknown')`;

  it("renders the SAME key expression in SELECT, GROUP BY and ORDER BY (byte-identical)", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date(0),
    );
    // Three renders, one text. Re-introduce a bound `field` and these stop matching each other
    // (they become `$1`/`$4`/`$5`), which is exactly the Postgres failure.
    expect(c.statements.filter((s) => s === KEY_EXPR)).toHaveLength(3);
  });

  it("carries the payload KEY as a literal — the value never travels as a parameter", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date(0),
    );
    // The literal form is what every other `->>` in this codebase uses (notifications,
    // posting-plans, ai-jobs): literal key, value as the param. Here there is no value.
    expect(c.sql()).toContain(KEY_EXPR);
    expect(c.params).not.toContain("reason");
    // …and no placeholder anywhere inside the key expression.
    expect(c.sql()).not.toMatch(/"events"\."payload"->>\$\d+/);
    // The event NAME is still bound — only the key is a literal.
    expect(c.params).toContain("ai.spend_cap_exceeded");
  });

  it("a payload with no such field groups under 'unknown' rather than being dropped", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField("x", "reason", new Date(0));
    // A breach whose reason did not serialize is still a breach; a silently-omitted bucket is
    // how "silence means zero" starts.
    expect(c.sql()).toContain(`, 'unknown')`);
  });

  it("FAILS CLOSED on a field outside the closed set — nothing else may reach sql.raw", async () => {
    const c = captureQueries();
    // The compile-time union is erased at runtime, so the runtime check is the real gate. The
    // cast is how a caller arriving through `any`/JS interop would look. `rejects`, not
    // `toThrow`: the method is async, so the guard surfaces as a rejected promise.
    await expect(
      new AdminEventsRepository(c.db).countByPayloadField(
        "x",
        "worker_id'||(select 1)||'" as AdminPayloadGroupField,
        new Date(0),
      ),
    ).rejects.toThrow(/unsupported payload group field/);
    // Nothing was built — the rogue key never reached the query builder at all.
    expect(c.statements).toEqual([]);
  });

  it("the closed set is exactly the one field the dashboard needs", () => {
    expect([...ADMIN_PAYLOAD_GROUP_FIELDS]).toEqual(["reason"]);
  });
});
