/**
 * The write-path probe's pure parts.
 *
 * The runner itself needs a live database, so what is testable here is the reporting logic and
 * `causeOf` — and `causeOf` is worth more than it looks. Drizzle's error message is the SQL
 * TEXT, so a probe that reports `e.message` prints the statement back and hides whether the
 * INSERT was refused by the CHECK it was testing, by a full connection pooler, or by an aborted
 * transaction. All three rendered identically in the first run of this tool, and two of them
 * were misreported as schema failures.
 */
import { describe, expect, it } from "vitest";

import {
  PROBE_EXPECTATIONS,
  RollbackSignal,
  allPassed,
  causeOf,
  formatResults,
  type ProbeResult,
} from "./verify-unresolved-write";

const pass = (id: string): ProbeResult => ({ id, expectation: PROBE_EXPECTATIONS[id] ?? id, passed: true });
const fail = (id: string, detail: string): ProbeResult => ({
  id,
  expectation: PROBE_EXPECTATIONS[id] ?? id,
  passed: false,
  detail,
});

describe("causeOf — the reason, not the statement", () => {
  it("prefers the driver cause over drizzle's SQL-text message", () => {
    const e = {
      message: "Failed query: INSERT INTO unresolved_phrase (phrase, lang, domain_id...",
      cause: { message: 'new row violates check constraint "unresolved_phrase_one_domain_chk"', code: "23514" },
    };
    expect(causeOf(e)).toContain("one_domain_chk");
    expect(causeOf(e)).not.toContain("Failed query");
  });

  it("carries the SQLSTATE, because 23514 and 25P02 mean opposite things here", () => {
    // 23514 = the CHECK fired, which is a PASS for the negative probe.
    // 25P02 = the transaction was already aborted, which means the probe never ran at all.
    expect(causeOf({ message: "x", cause: { message: "boom", code: "25P02" } })).toBe("boom [25P02]");
  });

  it("falls back to the wrapper's first line when there is no cause", () => {
    expect(causeOf(new Error("plain failure\nstack line"))).toBe("plain failure");
  });

  it("survives a thrown non-Error", () => {
    expect(causeOf("just a string")).toBe("just a string");
  });
});

describe("allPassed", () => {
  it("is true only when every probe passed", () => {
    expect(allPassed([pass("legacy-insert"), pass("canonical-insert")])).toBe(true);
    expect(allPassed([pass("legacy-insert"), fail("canonical-insert", "nope")])).toBe(false);
  });

  it("is FALSE on an empty result set rather than vacuously true", () => {
    // A run that produced no probes did not prove the write path healthy — it proved nothing,
    // and the exit code has to say so.
    expect(allPassed([])).toBe(false);
  });
});

describe("formatResults", () => {
  it("marks pass and fail distinctly and aligns the ids", () => {
    const lines = formatResults([pass("legacy-insert"), fail("distinct-job-domains", "1 row, expected 2")]);
    expect(lines[0]).toContain("PASS");
    expect(lines.join("\n")).toContain("FAIL");
  });

  it("prints the detail only for failures", () => {
    expect(formatResults([pass("legacy-insert")])).toHaveLength(1);
    expect(formatResults([fail("legacy-insert", "why")])).toHaveLength(2);
    expect(formatResults([fail("legacy-insert", "why")])[1]).toContain("why");
  });
});

describe("the probe set", () => {
  it("covers the property a presence check structurally cannot see", () => {
    // `unresolved_phrase_scope_uq` of the right NAME and the pre-0078 four-column SHAPE merges
    // two canonical misses into one row. `db:audit:schema-contract` checks the shape from
    // `indexdef`; this checks it from BEHAVIOUR, which is the one that cannot be fooled.
    expect(PROBE_EXPECTATIONS["distinct-job-domains"]).toMatch(/two rows/);
  });

  it("asserts the rollback held rather than assuming it", () => {
    expect(PROBE_EXPECTATIONS["nothing-committed"]).toMatch(/identical after/);
  });

  it("has a stated expectation for every probe id, so no result prints its bare id", () => {
    for (const [id, text] of Object.entries(PROBE_EXPECTATIONS)) {
      expect(text.length, id).toBeGreaterThan(20);
    }
  });
});

describe("RollbackSignal", () => {
  it("is identifiable by instanceof, so the catch cannot swallow a real error", () => {
    // The runner rethrows anything that is not this. If it were a plain Error matched on
    // message text, a genuine failure with a similar message would be discarded as "expected".
    expect(new RollbackSignal("verify:unresolved-write")).toBeInstanceOf(RollbackSignal);
    expect(new Error("verify:unresolved-write — deliberate rollback")).not.toBeInstanceOf(RollbackSignal);
  });
});
