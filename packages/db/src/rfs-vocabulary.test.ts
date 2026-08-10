import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateQuestionPackCorpus, loadQuestionPackCorpus } from "./question-pack-corpus";
import {
  RFS_FIELD_IDS,
  RFS_FIELD_TYPES,
  RFS_OPTIONAL_FIELDS,
  RFS_REQUIRED_FIELDS,
  isRfsField,
} from "./rfs-vocabulary";

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
const FIELD_LIST_PATTERNS = {
  profiling_required_fields: /profiling_required_fields:\s*str\s*=\s*\(([\s\S]*?)\)/,
  profiling_optional_fields: /profiling_optional_fields:\s*str\s*=\s*\(([\s\S]*?)\)/,
} as const;

function pythonFieldList(name: keyof typeof FIELD_LIST_PATTERNS): string[] {
  const source = readFileSync(CONFIG_PY, "utf8");
  // LITERAL PATTERNS, SELECTED BY NAME, rather than one built from `${name}`. The interpolated
  // form is what semgrep's `detect-non-literal-regexp` flags, and although `name` only ever
  // arrives here as one of these two literals, that is a property of today's CALL SITES, not of
  // this function. A lookup cannot become attacker-controlled however the helper is later reused,
  // and the key type makes an unknown name a compile error rather than a silent `undefined`.
  const declaration = FIELD_LIST_PATTERNS[name].exec(source);
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

  it("every chip's value is one its target field can actually hold (#731)", () => {
    // THE SAME FAILURE MODE, ONE LAYER DOWN. `target_field` being a real RFS id says nothing about
    // whether the CHIP's value fits it: `answer-capture.ts` refuses an option value that
    // contradicts the field's declared type, so a mistyped chip is tappable and silently records
    // nothing. Run against the COMMITTED packs with the type table supplied, exactly as
    // `verify-question-packs.ts` runs it.
    const corpus = loadQuestionPackCorpus();
    const problems = validateQuestionPackCorpus(corpus, {
      fields: { fieldIds: RFS_FIELD_IDS, types: RFS_FIELD_TYPES },
    }).filter((problem) => problem.includes("capture REFUSES"));
    expect(problems).toEqual([]);
  });

  it("that pass is not vacuous — mistype one real chip and the gate reports it", () => {
    // The assertion above is `toEqual([])`, which a rule that never fires would also satisfy — the
    // precise shape of the regression this whole describe block was written about. Break a chip in
    // the LOADED corpus and prove the same call reports it, so a green run means the rule ran.
    const corpus = loadQuestionPackCorpus();
    const victim = corpus.packs
      .flatMap((p) => (p.items ?? []).map((item) => ({ pack: p, item })))
      .find(
        ({ item }) =>
          item.target_kind === "rfs" &&
          RFS_FIELD_TYPES.get(item.target_field ?? "") === "string_array" &&
          (item.options?.length ?? 0) > 0,
      );
    expect(victim, "no string_array rfs question with options — pick another probe").toBeDefined();
    victim!.item.options![0]! = { ...victim!.item.options![0]!, value_text: null, value_bool: true };

    const problems = validateQuestionPackCorpus(corpus, {
      fields: { fieldIds: RFS_FIELD_IDS, types: RFS_FIELD_TYPES },
    }).filter((problem) => problem.includes("capture REFUSES"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(victim!.pack.pack_id);
  });

  it("the type table is populated and reaches the fields the rule needs", () => {
    // Guards the vacuous pass: an empty map would make the assertion above green forever. Derived
    // from FIELD_CROSSWALK, so this also fails if the crosswalk stops declaring these.
    expect(RFS_FIELD_TYPES.size).toBeGreaterThan(10);
    expect(RFS_FIELD_TYPES.get("relocation_willingness")).toBe("boolean");
    expect(RFS_FIELD_TYPES.get("experience_years")).toBe("number");
    expect(RFS_FIELD_TYPES.get("skills")).toBe("string_array");
  });

  it("holds EXACTLY ONE documented exception — the corpus may not grow a second", () => {
    // `KNOWN_UNCAPTURABLE_OPTIONS` keeps `qp_universal|relocation|maybe` open while #731 is ruled.
    // Re-deriving the offenders here WITHOUT the allowlist proves the exception is still needed and
    // still singular: a new mistyped chip lands as a second entry and fails this test, and the day
    // #731 ships this drops to zero and the allowlist can go.
    const corpus = loadQuestionPackCorpus();
    const uncapturable: string[] = [];
    for (const pack of corpus.packs) {
      for (const item of pack.items ?? []) {
        if (item.target_kind !== "rfs" || !item.target_field) continue;
        const declared = RFS_FIELD_TYPES.get(item.target_field);
        if (declared === undefined) continue;
        for (const o of item.options ?? []) {
          const value = o.value_bool ?? o.value_number ?? o.value_text ?? undefined;
          if (value === undefined) continue;
          const ok =
            declared === "boolean"
              ? typeof value === "boolean"
              : declared === "number"
                ? typeof value === "number"
                : typeof value === "string";
          if (!ok) uncapturable.push(`${pack.pack_id}|${item.question_key}|${o.option_key}`);
        }
      }
    }
    expect(uncapturable).toEqual(["qp_universal|relocation|maybe"]);
  });
});
