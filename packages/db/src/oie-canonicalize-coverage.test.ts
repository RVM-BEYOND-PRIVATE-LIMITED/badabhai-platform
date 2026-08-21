/**
 * The O2 coverage report — the arithmetic and the two ways it could lie.
 *
 * A coverage number is quoted long after the run that produced it, so the assertions here are
 * mostly about honesty rather than correctness: an empty denominator must not read as 0%, the
 * population the query cannot see must appear in the denominator, and the pin statuses this
 * package hardcodes must not drift from the ones the processor acts on.
 */
import { describe, expect, it } from "vitest";

import { OCCUPATION_MATCH_STATUSES } from "@badabhai/ai-contracts";

import {
  COVERAGE_SQL,
  SCOPING_PIN_STATUSES,
  SESSIONLESS_SQL,
  fractions,
  pct,
  render,
  type CoverageRow,
} from "./oie-canonicalize-coverage";

const row = (o: Partial<CoverageRow> = {}): CoverageRow => ({
  canonicalizing: 10,
  withAnyPin: 6,
  withMatchedPin: 5,
  scoped: 4,
  notCanonicalizing: 8,
  sessionlessJobs: 2,
  oieWithAnyPin: 3,
  oieWithMatchedPin: 2,
  oieScoped: 1,
  ...o,
});

describe("the statuses that scope", () => {
  it("are the four MATCHED members of the contract enum, and nothing else", () => {
    // This package cannot import the processor (`packages/db` must not depend on `apps/api`), so
    // the list is duplicated. Both sides derive from THIS enum, which is what stops them
    // drifting: add a status to the contract without classifying it and this fails here as well
    // as in the processor's own exhaustiveness test.
    const matched = OCCUPATION_MATCH_STATUSES.filter((s) => s.startsWith("matched_"));
    expect([...SCOPING_PIN_STATUSES].sort()).toEqual([...matched].sort());
    expect(SCOPING_PIN_STATUSES).toHaveLength(4);
  });

  it("excludes every unmatched status", () => {
    // Five of seven. `OccupationPinSchema` DEFAULTS `match_status` to `unmatched_degraded`, so
    // counting "a pin object exists" as coverage would have overstated O2 on every degraded
    // interview.
    for (const s of OCCUPATION_MATCH_STATUSES.filter((x) => x.startsWith("unmatched_"))) {
      expect(SCOPING_PIN_STATUSES).not.toContain(s);
    }
  });
});

describe("the fractions", () => {
  it("measure O2 against the branch it is about, not against all sessions", () => {
    const f = fractions(row());
    expect(f.ofCanonicalizing).toBeCloseTo(4 / 10, 10);
    // ...and the whole-population figure counts BOTH the other branch and the sessionless jobs.
    expect(f.ofAll).toBeCloseTo(4 / 20, 10);
  });

  it("attribute every uncovered row to exactly one cause", () => {
    // The four losses plus the scoped rows must reconstruct the population. Without this the
    // breakdown can drift into double-counting and still look plausible.
    const r = row();
    const f = fractions(r);
    expect(f.lostToNoPin + f.lostToAnUnmatchedPin + f.lostToADeadDomain + r.scoped).toBe(
      r.canonicalizing,
    );
    expect(f.lostToTheOtherBranch + r.sessionlessJobs + r.canonicalizing).toBe(
      r.canonicalizing + r.notCanonicalizing + r.sessionlessJobs,
    );
  });

  it("reports NO denominator as null, never as 0%", () => {
    // "0.00% covered" and "there is nothing to cover" are different findings, and the first one
    // is the one that gets quoted in a decision. An empty database must say so.
    const empty = row({
      canonicalizing: 0,
      withAnyPin: 0,
      withMatchedPin: 0,
      scoped: 0,
      notCanonicalizing: 0,
      sessionlessJobs: 0,
    });
    expect(fractions(empty).ofCanonicalizing).toBeNull();
    expect(fractions(empty).ofAll).toBeNull();
    expect(pct(null)).toBe("n/a (no rows)");
    expect(pct(0)).toBe("0.00%");
  });

  it("distinguishes a real 0% from an absent measurement", () => {
    // Production's actual shape on 2026-08-20: 48 canonicalizing sessions, none with a pin.
    const measuredZero = row({
      canonicalizing: 48,
      withAnyPin: 0,
      withMatchedPin: 0,
      scoped: 0,
      notCanonicalizing: 44,
      sessionlessJobs: 18,
    });
    expect(fractions(measuredZero).ofCanonicalizing).toBe(0);
    expect(pct(fractions(measuredZero).ofCanonicalizing)).toBe("0.00%");
    expect(fractions(measuredZero).lostToNoPin).toBe(48);
    expect(fractions(measuredZero).lostToTheOtherBranch).toBe(44);
  });
});

describe("the rendered report", () => {
  it("names the population it cannot scope, beside the fraction", () => {
    // A denominator that silently omits sessionless jobs would read as a total.
    const out = render(row()).join("\n");
    expect(out).toContain("extraction jobs with NO session     2");
    expect(out).toContain("ONLY O1 reaches these");
  });

  it("says the scope is not the same thing as the pass running", () => {
    // The number answers "was a canonical scope sent", not "did canonicalization happen" —
    // the pass is behind a flag that is off. Quoting one as the other is the obvious misread.
    expect(render(row()).join("\n")).toContain("SKILL_CANONICALIZE_ENABLED");
  });
});

describe("the queries", () => {
  it("read only", () => {
    // Structural, because "safe to point at production" is the claim the docstring makes.
    for (const q of [COVERAGE_SQL, SESSIONLESS_SQL]) {
      expect(q).toMatch(/^\s*(WITH|SELECT)\b/);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i);
    }
  });

  it("treat an absent, null, or empty answer_map alike", () => {
    // All three mean "no deterministic record" to the processor — `narrowAnswerRecords` of a
    // non-array yields an empty list — and production's 48 uncovered sessions are the
    // `conversation_state IS NULL` shape, which only the `COALESCE(... , false)` arm catches.
    expect(COVERAGE_SQL).toContain("jsonb_typeof(cs.conversation_state -> 'answer_map') = 'array'");
    expect(COVERAGE_SQL).toContain("jsonb_array_length");
    expect(COVERAGE_SQL).toContain("COALESCE(");
  });

  it("reads the session id out of input_ref, which is where it lives", () => {
    // `ai_jobs` has no `session_id` COLUMN. A query against one would error, not under-count.
    expect(SESSIONLESS_SQL).toContain("input_ref ->> 'session_id'");
    expect(SESSIONLESS_SQL).not.toMatch(/\bsession_id\s+IS\s+NULL/);
  });

  it("requires a domain to be selectable AND active, matching the processor's wall", () => {
    expect(COVERAGE_SQL).toContain("d.selectable = true");
    expect(COVERAGE_SQL).toContain("d.status = 'active'");
  });
});

/**
 * The O1 projection.
 *
 * O2's number answers *"how much of the canonicalizing branch gets Path A"*. On production that
 * is 0.00%, which says O1 is urgent but not what O1 would BUY — "48 sessions go somewhere O2
 * cannot reach" is a ceiling, and an OIE session with no usable pin is no more reachable by O1
 * than by O2. These pin the difference between the ceiling and the projection.
 */
describe("O1 projection — what the restructure would actually add", () => {
  it("counts only OIE sessions with a usable pin, not the whole branch", () => {
    const f = fractions(row({ notCanonicalizing: 8, oieWithAnyPin: 3, oieWithMatchedPin: 2, oieScoped: 1 }));
    expect(f.lostToTheOtherBranch).toBe(8); // the ceiling
    expect(f.o1Adds).toBe(1); // the projection
  });

  it("adds to O2 without overlapping it — the branches are disjoint by construction", () => {
    // `answer_map` empty or not partitions every session, so the union is a plain sum. If this
    // ever needed an overlap term, the predicate would have stopped partitioning and both
    // numbers would be wrong in the same direction.
    const r = row({ canonicalizing: 10, notCanonicalizing: 8, sessionlessJobs: 2, scoped: 4, oieScoped: 3 });
    expect(fractions(r).o1PlusO2OfAll).toBeCloseTo(7 / 20, 10);
    expect(fractions(r).ofAll).toBeCloseTo(4 / 20, 10);
  });

  it("reports what NEITHER option reaches, so the ceiling is never read as 100%", () => {
    // The sessionless jobs are the honest remainder: no state to scope from, so no restructure
    // of the processor's branches can help them.
    const r = row({ canonicalizing: 10, notCanonicalizing: 8, sessionlessJobs: 2, scoped: 4, oieScoped: 3 });
    expect(fractions(r).unreachableByEither).toBe(20 - 4 - 3);
  });

  it("THE PRODUCTION SHAPE: O2 at zero does not imply O1 is worth anything", () => {
    // Measured 2026-08-20/21: 54 canonicalizing sessions, 0 with a pin; 48 OIE; 18 sessionless.
    // If the OIE branch also has no usable pin, O1 buys exactly as much as O2 does — nothing —
    // and the design's premise fails. That is the case this asserts is REPORTABLE, not the case
    // it asserts is true.
    const r = row({
      canonicalizing: 54, withAnyPin: 0, withMatchedPin: 0, scoped: 0,
      notCanonicalizing: 48, sessionlessJobs: 18,
      oieWithAnyPin: 0, oieWithMatchedPin: 0, oieScoped: 0,
    });
    const f = fractions(r);
    expect(f.o1Adds).toBe(0);
    expect(f.o1PlusO2OfAll).toBe(0);
    expect(f.unreachableByEither).toBe(120);
    expect(render(r).join("\n")).toContain("what O1 would ADD");
  });

  it("the report prints the projection next to the coverage, never instead of it", () => {
    const text = render(row()).join("\n");
    expect(text).toContain("O2 coverage of ALL extractions");
    expect(text).toContain("O1 PROJECTION");
    expect(text).toContain("O2 + O1 coverage of ALL extractions");
    expect(text).toContain("reachable by NEITHER");
  });

  it("asks the OIE branch the SAME three questions, from the same SQL", () => {
    // Two definitions of "usable pin" would make the comparison meaningless, so the O1 filters
    // reuse the same `$1` status list and the same selectable-domain EXISTS clause.
    const oie = COVERAGE_SQL.slice(COVERAGE_SQL.indexOf("oie_with_any_pin"));
    expect(oie).toContain("pin_status = ANY($1::text[])");
    expect(oie).toContain("d.selectable = true");
    expect(oie).toContain("d.status = 'active'");
    // ...and against `has_answers`, not `NOT has_answers` — the other branch.
    expect(COVERAGE_SQL).toContain("WHERE has_answers AND jsonb_typeof(pin) = 'object'");
  });
});
