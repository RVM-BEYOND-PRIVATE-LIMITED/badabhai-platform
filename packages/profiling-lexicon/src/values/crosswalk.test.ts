import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CROSSWALK_DRAFT_FIELDS,
  CROSSWALK_FIELD_IDS,
  FIELD_CROSSWALK,
  crosswalkFor,
} from "./crosswalk.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CONFIG_PY = join(REPO_ROOT, "apps", "ai-service", "app", "config.py");
const CONTRACTS_PY = join(REPO_ROOT, "apps", "ai-service", "app", "contracts.py");

/**
 * Literal patterns selected by name — never `new RegExp(\`${name}…\`)`, which semgrep's
 * detect-non-literal-regexp flags and which cannot be reasoned about if this helper is reused.
 */
const FIELD_LIST_PATTERNS = {
  profiling_required_fields: /profiling_required_fields:\s*str\s*=\s*\(([\s\S]*?)\)/,
  profiling_optional_fields: /profiling_optional_fields:\s*str\s*=\s*\(([\s\S]*?)\)/,
} as const;

function rfsIds(name: keyof typeof FIELD_LIST_PATTERNS): string[] {
  const declaration = FIELD_LIST_PATTERNS[name].exec(readFileSync(CONFIG_PY, "utf8"));
  if (!declaration) throw new Error(`${name} not found in config.py — the mirror has moved`);
  return [...declaration[1]!.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .join("")
    .split(",")
    .filter(Boolean);
}

/** The real `WorkerProfileDraft` field names, read out of the Pydantic model. */
function draftFields(): Set<string> {
  const source = readFileSync(CONTRACTS_PY, "utf8");
  const model = /class WorkerProfileDraft\(BaseModel\):([\s\S]*?)\n\nclass /.exec(source);
  if (!model) throw new Error("WorkerProfileDraft not found in contracts.py — the mirror has moved");
  return new Set([...model[1]!.matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1] as string));
}

describe("THE EXHAUSTIVENESS GATE — the actual fix for the vocabulary drift", () => {
  const required = rfsIds("profiling_required_fields");
  const optional = rfsIds("profiling_optional_fields");

  it("reads a non-empty vocabulary, so nothing below can pass vacuously", () => {
    expect(required.length).toBeGreaterThan(3);
    expect(optional.length).toBeGreaterThan(3);
    expect(optional).toContain("relocation_willingness");
  });

  it("maps EVERY required RFS field", () => {
    // A missing entry is not a crash. It is a captured answer that silently never reaches the
    // worker's profile — which is why this is a build failure, not a runtime warning.
    expect(required.filter((id) => !CROSSWALK_FIELD_IDS.has(id))).toEqual([]);
  });

  it("maps EVERY optional RFS field", () => {
    expect(optional.filter((id) => !CROSSWALK_FIELD_IDS.has(id))).toEqual([]);
  });

  it("maps NOTHING outside the RFS vocabulary", () => {
    // The other direction: an entry for an id nobody can capture is dead weight that reads as
    // coverage.
    const vocabulary = new Set([...required, ...optional]);
    expect([...CROSSWALK_FIELD_IDS].filter((id) => !vocabulary.has(id))).toEqual([]);
  });
});

describe("every destination is a REAL WorkerProfileDraft field", () => {
  it("names no draft column that does not exist", () => {
    // The direction exhaustiveness cannot see: a typo'd target ("expected_salery") satisfies every
    // check above and then writes nowhere.
    const real = draftFields();
    expect([...CROSSWALK_DRAFT_FIELDS].filter((f) => !real.has(f))).toEqual([]);
  });

  it("the draft-field reader is capable of failing", () => {
    const real = draftFields();
    expect(real.size).toBeGreaterThan(20);
    expect(real).toContain("expected_salary");
    expect(real).toContain("controllers");
  });
});

describe("the mapping's own shape", () => {
  it("carries the renames that make this table necessary at all", () => {
    // If the two vocabularies agreed everywhere a crosswalk would be pointless. These are the
    // pairs a name-matching projector would silently drop.
    expect(crosswalkFor("salary_expected")?.draftPath).toBe("expected_salary");
    expect(crosswalkFor("salary_current")?.draftPath).toBe("current_salary");
    expect(crosswalkFor("trade")?.draftPath).toBe("primary_role");
  });

  it("marks the two deliberate non-carriers with an explicit null", () => {
    // Not an omission — a decision, and one the exhaustiveness test can tell apart from a
    // forgotten mapping precisely because the entry EXISTS.
    expect(crosswalkFor("work_history")?.draftPath).toBeNull();
    expect(crosswalkFor("languages")?.draftPath).toBeNull();
  });

  it("declares the splitter on the one field that fans out", () => {
    expect(crosswalkFor("tools_equipment")?.splitter).toBe("machines_controllers");
    // `controllers` is reachable only through the splitter, so it must be declared explicitly.
    expect(CROSSWALK_DRAFT_FIELDS.has("controllers")).toBe(true);
  });

  it("declares a unit wherever a bare number would be ambiguous", () => {
    expect(crosswalkFor("experience_years")?.unit).toBe("years");
    expect(crosswalkFor("salary_expected")?.unit).toBe("inr_per_month");
    expect(crosswalkFor("salary_current")?.unit).toBe("inr_per_month");
  });

  it("gives every numeric entry a unit — an unlabelled number is how a 12x error hides", () => {
    for (const [id, entry] of Object.entries(FIELD_CROSSWALK)) {
      if (entry.type === "number") expect(entry.unit, id).toBeDefined();
    }
  });

  it("returns undefined for an id outside the vocabulary", () => {
    expect(crosswalkFor("employer_name")).toBeUndefined();
  });
});
