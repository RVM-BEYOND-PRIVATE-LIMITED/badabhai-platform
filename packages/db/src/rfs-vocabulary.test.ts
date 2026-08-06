import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateQuestionPackCorpus, loadQuestionPackCorpus } from "./question-pack-corpus";
import { RFS_FIELD_IDS, RFS_OPTIONAL_FIELDS, RFS_REQUIRED_FIELDS, isRfsField } from "./rfs-vocabulary";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const CONFIG_PY = join(REPO_ROOT, "apps", "ai-service", "app", "config.py");

/**
 * Pull a comma-joined string default out of `config.py`.
 *
 * The declaration is a parenthesised implicit concatenation across several lines, so the whole
 * assignment is captured and the quoted fragments are joined — which is exactly how Python builds
 * it. Reading the FILE rather than importing anything keeps this a plain unit test with no Python
 * runtime, in the same spirit as the profiling-lexicon mirror check.
 */
function pythonFieldList(name: string): string[] {
  const source = readFileSync(CONFIG_PY, "utf8");
  const declaration = new RegExp(`${name}:\\s*str\\s*=\\s*\\(([\\s\\S]*?)\\)`).exec(source);
  if (!declaration) throw new Error(`${name} not found in config.py — the mirror has moved`);
  const joined = [...declaration[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  return joined.split(",").filter(Boolean);
}

describe("the RFS vocabulary mirrors the ai-service, and cannot drift from it", () => {
  it("matches profiling_required_fields exactly, in order", () => {
    // The ai-service is authoritative: it is what gates `is_complete` on these ids. A TS copy that
    // silently disagreed would let the pack validator bless a field the interview can never
    // complete on.
    expect([...RFS_REQUIRED_FIELDS]).toEqual(pythonFieldList("profiling_required_fields"));
  });

  it("matches profiling_optional_fields exactly, in order", () => {
    expect([...RFS_OPTIONAL_FIELDS]).toEqual(pythonFieldList("profiling_optional_fields"));
  });

  it("the parity check is capable of failing", () => {
    // Guards against a regex that quietly matches nothing and makes both assertions vacuous.
    expect(pythonFieldList("profiling_required_fields").length).toBeGreaterThan(3);
    expect(pythonFieldList("profiling_optional_fields")).toContain("relocation_willingness");
  });

  it("recognises a member and rejects an invented id", () => {
    expect(isRfsField("current_city")).toBe(true);
    expect(isRfsField("relocation_willingness")).toBe(true);
    // The four ids the universal pack actually shipped with.
    for (const invented of ["city", "experience", "relocation", "education"]) {
      expect(isRfsField(invented), invented).toBe(false);
    }
    expect(isRfsField(null)).toBe(false);
  });
});

describe("THE COMMITTED CORPUS obeys the vocabulary — the check the deploy gate used to skip", () => {
  it("every rfs question in every pack targets a real RFS field", () => {
    // THIS IS THE REGRESSION. `verify-question-packs.ts` called the validator with no `opts`, so
    // `opts.fields?.fieldIds.size` was undefined and this entire rule never ran against the real
    // corpus — while a unit test passed `opts` explicitly and stayed green, which is why it looked
    // covered. Run here against the COMMITTED packs, with the vocabulary supplied.
    const corpus = loadQuestionPackCorpus();
    const problems = validateQuestionPackCorpus(corpus, {
      fields: { fieldIds: RFS_FIELD_IDS },
    }).filter((problem) => problem.includes("Resume Field Set"));
    expect(problems).toEqual([]);
  });
});
