import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { candidateRecord, facelessRecord, RECORD_WORKER_ID } from "../../test/candidate-record";
import {
  CANDIDATE_FIELDS,
  SOURCE_TAGS,
  candidateIdTitle,
  candidatePosture,
  candidateTitle,
  consentLabel,
  corrections,
  fieldLabel,
  formatAnswer,
  formatAvailability,
  formatMonths,
  formatSalaryPeriod,
  formatStint,
  formatTradeLevel,
  formatYearMonth,
  formatYears,
  humanize,
  sourceTag,
} from "./candidate-view";

/**
 * A7 (#2577) — how the drawer READS a #2560 record: the source tags, the one label list (which
 * must name every field the record carries, or the Edit log could miss a correction), the name
 * posture and the value formatters.
 */

const API = (path: string) =>
  readFileSync(new URL(`../../../api/src/${path}`, import.meta.url), "utf8");

describe("source tags", () => {
  it("words every source the server can send — FIELD_SOURCES, read from the API", () => {
    const src = API("profiles/worker-field-precedence.ts");
    const list = /FIELD_SOURCES = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    const sources = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(SOURCE_TAGS).sort()).toEqual([...sources].sort());
  });

  it("is humanised — a raw code never reaches the screen", () => {
    for (const [code, tag] of Object.entries(SOURCE_TAGS)) {
      expect(tag.label).not.toContain("_");
      expect(tag.label, code).toMatch(/^[A-Z]/);
      expect(tag.meaning.length).toBeGreaterThan(10);
    }
    expect(sourceTag("worker_edit").label).toBe("Worker edit");
    expect(sourceTag("none").label).toBe("Not stored");
  });

  it("a source this build was not taught is shown de-snaked, never blank", () => {
    // #2561 taught `admin_override`, so it is no longer the example of an unknown source.
    expect(sourceTag("future_source")).toEqual({
      label: "Future source",
      meaning: "Source: Future source.",
    });
    // An inherited key is not a tag.
    expect(sourceTag("toString").label).toBe("ToString");
  });
});

describe("the one label list", () => {
  /** Every `{ value, source, correction }` object in a record, by its dotted path. */
  function fieldPaths(node: unknown, path: string[] = []): string[] {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
    const keys = Object.keys(node);
    if (keys.includes("value") && keys.includes("source") && keys.includes("correction")) {
      return [path.join(".")];
    }
    return keys.flatMap((k) => fieldPaths((node as Record<string, unknown>)[k], [...path, k]));
  }

  it("names EVERY field the record carries — and nothing it does not", () => {
    const paths = fieldPaths(candidateRecord()).sort();
    expect(paths.length).toBe(45);
    expect(CANDIDATE_FIELDS.map((f) => f.key).sort()).toEqual(paths);
  });

  it("each spec reaches its own field", () => {
    const d = candidateRecord();
    for (const spec of CANDIDATE_FIELDS) {
      const byPath = spec.key.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], d);
      expect(spec.pick(d), spec.key).toBe(byPath);
    }
  });

  it("labels are unique and read like labels", () => {
    const labels = CANDIDATE_FIELDS.map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l).toMatch(/^[A-Z][^_]*$/);
    expect(fieldLabel("identity.resume_show_photo")).toBe("Photo on resume");
  });
});

describe("the Edit log's corrections", () => {
  it("is EMPTY for a record with no correction — every one until #2561 ships", () => {
    expect(corrections(candidateRecord())).toEqual([]);
  });

  it("lists every correction the record carries, newest first, labelled", () => {
    const d = candidateRecord();
    d.location.current_city = {
      ...d.location.current_city,
      correction: { override_id: "o1", admin_id: "a1", reason_code: "worker_request", created_at: "2026-11-01T00:00:00Z" },
    };
    d.salary.band = {
      ...d.salary.band,
      correction: { override_id: "o2", admin_id: "a2", reason_code: "typo", created_at: "2026-11-03T00:00:00Z" },
    };
    expect(corrections(d).map((c) => [c.label, c.correction.override_id])).toEqual([
      ["Expected salary", "o2"],
      ["Current city", "o1"],
    ]);
  });
});

describe("the name posture", () => {
  it("a record that disclosed a name is named — whatever the session claims", () => {
    expect(candidatePosture(candidateRecord(), true)).toBe("named");
    expect(candidatePosture(candidateRecord(), false)).toBe("named");
  });

  it("an undisclosed name is CAPPED for an entitled session and FACELESS for a role without it", () => {
    expect(candidatePosture(facelessRecord(), true)).toBe("capped");
    expect(candidatePosture(facelessRecord(), false)).toBe("faceless");
  });

  it("the title is the disclosed name — else the short id, never an empty string", () => {
    expect(candidateTitle(candidateRecord())).toBe("Ramesh Kumar");
    expect(candidateTitle(facelessRecord())).toBe("Candidate 0b7f…9a01");
    const blank = candidateRecord();
    blank.identity.name = { ...blank.identity.name, value: "   " };
    expect(candidateTitle(blank)).toBe("Candidate 0b7f…9a01");
    expect(candidateIdTitle(RECORD_WORKER_ID)).toBe("Candidate 0b7f…9a01");
  });
});

describe("value formatters", () => {
  it("year-months and stints; no end is CURRENT", () => {
    expect(formatYearMonth("2021-04")).toBe("Apr 2021");
    expect(formatYearMonth("2021-13")).toBe("2021-13");
    expect(formatYearMonth("April")).toBe("April");
    expect(formatStint("2021-04", null)).toBe("Apr 2021 – present");
    expect(formatStint("2019-01", "2021-03")).toBe("Jan 2019 – Mar 2021");
    expect(formatStint(null, "2021-03")).toBe("start not given – Mar 2021");
    expect(formatStint(null, null)).toBe("dates not given");
  });

  it("months carry years from a year up; years are singular at one", () => {
    expect(formatMonths(7)).toBe("7 months");
    expect(formatMonths(1)).toBe("1 month");
    expect(formatMonths(48)).toBe("48 months (4 yr)");
    expect(formatMonths(30)).toBe("30 months (2.5 yr)");
    expect(formatYears(1)).toBe("1 year");
    expect(formatYears(4.5)).toBe("4.5 years");
  });

  it("an unanswered yes/no is said so — never read as No", () => {
    expect(formatAnswer(null)).toBe("Not answered");
    expect(formatAnswer(false)).toBe("No");
    expect(formatAnswer(true)).toBe("Yes");
  });

  it("salary periods, availability and trade levels read as words", () => {
    expect(formatSalaryPeriod("month")).toBe("a month");
    expect(formatSalaryPeriod("fortnight")).toBe("Fortnight");
    expect(
      formatAvailability({ status: "within_week", status_label: "Within a week", available_from: "2026-11-10", notice_period_days: 15 }),
    ).toBe("Within a week · from 2026-11-10 · 15 days notice");
    expect(
      formatAvailability({ status: "immediate", status_label: null, available_from: null, notice_period_days: null }),
    ).toBe("Immediate");
    expect(
      formatAvailability({ status: null, status_label: null, available_from: null, notice_period_days: null }),
    ).toBeNull();
    expect(
      formatTradeLevel({ skillId: "mskill_tig", skillLabel: null, tradeLevelLabel: "Setter", levelConfirmed: false }),
    ).toBe("Mskill tig — Setter (not confirmed)");
  });

  it("consent states and codes", () => {
    expect(consentLabel("none")).toBe("Never given");
    expect(consentLabel("active")).toBe("Given");
    expect(consentLabel("revoked")).toBe("Withdrawn");
    expect(consentLabel("paused")).toBe("Paused");
    expect(humanize("employer_sharing")).toBe("Employer sharing");
  });
});
