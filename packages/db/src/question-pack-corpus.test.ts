/**
 * The question-pack corpus validator.
 *
 * THE ACCEPTANCE CRITERION IS THIS FILE. Phase 4's plan says `db:verify:packs` must FAIL
 * on each seeded-in defect — a cyclic follow-up, a dangling ask_if key, two families on
 * one binding, a missing universal pack, an off-persona prompt. So every test below
 * starts from a corpus that is VALID, injects exactly one defect, and asserts the
 * validator notices. A test that only checked the happy path would pass against a
 * validator that returned `[]` unconditionally.
 *
 * The `valid()` helper is deliberately re-derived per test rather than shared by
 * reference: a mutation in one test leaking into the next would produce failures that
 * look like the check under test.
 */
import { describe, expect, it } from "vitest";

import {
  bindingSpecificity,
  checkPromptPersona,
  loadQuestionPackCorpus,
  summariseQuestionPackCorpus,
  validateQuestionPackCorpus,
  type FieldView,
  type PackOptionRecord,
  type QuestionPackCorpus,
} from "./question-pack-corpus";
import { RFS_FIELD_IDS, RFS_FIELD_TYPES } from "./rfs-vocabulary";

function valid(): QuestionPackCorpus {
  return {
    families: [
      { kind: "family", family_id: "fam_welding", label_en: "Welding", label_hi: "वेल्डिंग" },
      { kind: "family", family_id: "fam_universal", label_en: "Universal", label_hi: "सामान्य" },
    ],
    bindings: [
      { kind: "binding", family_id: "fam_welding", isco_unit_code: "7212" },
      { kind: "binding", family_id: "fam_universal", is_universal: true },
    ],
    packs: [
      {
        pack_id: "qp_welding",
        version: 1,
        family_id: "fam_welding",
        status: "active",
        items: [
          {
            question_key: "welding_type",
            prompt_text: "Gas welding karte ho ya arc?",
            target_kind: "rfs",
            target_field: "skills",
            answer_type: "single_select",
            options: [
              { option_key: "gas", label_text: "Gas welding" },
              { option_key: "arc", label_text: "Arc welding" },
            ],
          },
          {
            question_key: "experience_years",
            prompt_text: "Kitne saal se ye kaam kar rahe ho?",
            target_kind: "rfs",
            target_field: "experience",
            answer_type: "number",
          },
        ],
      },
      {
        pack_id: "qp_universal",
        version: 1,
        family_id: "fam_universal",
        status: "active",
        items: [
          {
            question_key: "current_city",
            prompt_text: "Abhi aap kaunse sheher mein hain?",
            target_kind: "rfs",
            target_field: "city",
            answer_type: "city",
          },
        ],
      },
    ],
  };
}

/** Fatal problems only — WARN lines are advisory and must not fail a corpus. */
function fatal(c: QuestionPackCorpus): string[] {
  return validateQuestionPackCorpus(c).filter((p) => !p.includes("WARN"));
}

describe("a valid corpus", () => {
  it("produces no fatal problems", () => {
    expect(fatal(valid())).toEqual([]);
  });

  it("summarises to ids and counts only", () => {
    expect(summariseQuestionPackCorpus(valid())).toEqual({
      families: 2,
      bindings: 2,
      packs: 2,
      active_packs: 2,
      items: 3,
      options: 2,
    });
  });
});

describe("families and bindings — each defect must be caught", () => {
  it("rejects a family_id without the fam_ prefix", () => {
    const c = valid();
    c.families[0]!.family_id = "welding";
    expect(fatal(c).join()).toContain("family_id must match");
  });

  it("rejects a duplicate family_id", () => {
    const c = valid();
    c.families.push({ ...c.families[0]! });
    expect(fatal(c).join()).toContain("duplicate family_id");
  });

  it("WARNS but does not fail when label_hi is missing", () => {
    // It is the worker-facing confirmation, so its absence matters — but label_en is a
    // working fallback, and failing the corpus over copy would block a schema fix.
    const c = valid();
    c.families[0]!.label_hi = null;
    expect(validateQuestionPackCorpus(c).join()).toContain("WARN label_hi");
    expect(fatal(c)).toEqual([]);
  });

  it("catches TWO FAMILIES CLAIMING ONE TARGET and names both", () => {
    // Most-specific-wins would silently pick one, and that trade gets the wrong
    // interview with nothing to alert on.
    const c = valid();
    c.bindings.push({ kind: "binding", family_id: "fam_universal", isco_unit_code: "7212" });
    const p = fatal(c).join();
    expect(p).toContain("already claimed by fam_welding");
  });

  it("catches a binding with no target", () => {
    const c = valid();
    c.bindings[0] = { kind: "binding", family_id: "fam_welding" };
    expect(fatal(c).join()).toContain("sets no target");
  });

  it("catches a binding with two targets", () => {
    const c = valid();
    c.bindings[0] = {
      kind: "binding",
      family_id: "fam_welding",
      isco_unit_code: "7212",
      isco_major_code: "7",
    };
    expect(fatal(c).join()).toContain("sets 2 targets");
  });

  it("catches a MISSING UNIVERSAL BINDING", () => {
    // Without it an unauthored trade resolves to no pack at all — a dead conversation,
    // not a degraded one.
    const c = valid();
    c.bindings = c.bindings.filter((b) => !b.is_universal);
    c.packs = c.packs.filter((p) => p.family_id !== "fam_universal");
    expect(fatal(c).join()).toContain("no universal binding");
  });

  it("catches TWO universal bindings", () => {
    const c = valid();
    c.bindings.push({ kind: "binding", family_id: "fam_welding", is_universal: true });
    expect(fatal(c).join()).toContain("universal bindings");
  });

  it("catches a binding pointing at an unknown family", () => {
    const c = valid();
    c.bindings[0]!.family_id = "fam_ghost";
    expect(fatal(c).join()).toContain("not a family in this corpus");
  });

  it("checks binding targets against the catalogue when one is supplied", () => {
    const c = valid();
    const problems = validateQuestionPackCorpus(c, {
      taxonomy: {
        jobDomainIds: new Set(),
        iscoUnitCodes: new Set(["9999"]),
        iscoMinorCodes: new Set(),
        iscoSubmajorCodes: new Set(),
        iscoMajorCodes: new Set(),
      },
    });
    expect(problems.join()).toContain("does not exist in the occupation catalogue");
  });

  it("derives specificity from the target", () => {
    expect(bindingSpecificity({ kind: "binding", family_id: "f", job_domain_id: "jd_x" })).toBe(50);
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_unit_code: "7212" })).toBe(
      40,
    );
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_minor_code: "721" })).toBe(
      30,
    );
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_submajor_code: "72" })).toBe(
      20,
    );
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_major_code: "7" })).toBe(10);
    expect(bindingSpecificity({ kind: "binding", family_id: "f", is_universal: true })).toBe(0);
    expect(bindingSpecificity({ kind: "binding", family_id: "f" })).toBeNull();
  });
});

describe("packs — each defect must be caught", () => {
  it("catches a second ACTIVE pack for one family+locale", () => {
    const c = valid();
    c.packs.push({ ...c.packs[0]!, pack_id: "qp_welding_v2" });
    expect(fatal(c).join()).toContain("second ACTIVE pack");
  });

  it("allows a draft alongside the active one", () => {
    const c = valid();
    c.packs.push({ ...c.packs[0]!, pack_id: "qp_welding_next", status: "draft" });
    expect(fatal(c)).toEqual([]);
  });

  it("catches an empty pack", () => {
    const c = valid();
    c.packs[0]!.items = [];
    expect(fatal(c).join()).toContain("no items");
  });

  it("catches a pack whose family has no binding — it could never be resolved", () => {
    const c = valid();
    c.families.push({ kind: "family", family_id: "fam_orphan", label_en: "Orphan", label_hi: "x" });
    c.packs.push({ ...c.packs[0]!, pack_id: "qp_orphan", family_id: "fam_orphan" });
    expect(fatal(c).join()).toContain("has no binding");
  });

  it("catches a question_key that would fail the event-payload slug filter", () => {
    // A bad id does not fail loudly — it makes the flush transaction DISCARD a completed
    // interview, which is the worst possible failure mode.
    const c = valid();
    c.packs[0]!.items[0]!.question_key = "weldingType";
    expect(fatal(c).join()).toContain("question_key must match");
  });

  it("catches an over-length question_key", () => {
    const c = valid();
    c.packs[0]!.items[0]!.question_key = "a".repeat(41);
    expect(fatal(c).join()).toContain("max 40");
  });

  it("catches a duplicate question_key inside one pack", () => {
    const c = valid();
    c.packs[0]!.items[1]!.question_key = "welding_type";
    expect(fatal(c).join()).toContain("duplicate question_key");
  });

  it("catches an rfs question with no target_field", () => {
    const c = valid();
    delete c.packs[0]!.items[1]!.target_field;
    expect(fatal(c).join()).toContain("needs target_field");
  });

  it("catches a select with fewer than two options", () => {
    const c = valid();
    c.packs[0]!.items[0]!.options = [{ option_key: "gas", label_text: "Gas" }];
    expect(fatal(c).join()).toContain("at least 2 options");
  });

  it("catches options on a non-select question", () => {
    const c = valid();
    c.packs[0]!.items[1]!.options = [{ option_key: "a", label_text: "A" }];
    expect(fatal(c).join()).toContain("must not carry options");
  });

  it("catches two options with the SAME LABEL", () => {
    // The label is the worker's recorded answer verbatim, so identical labels make the
    // record ambiguous and are indistinguishable to the worker tapping them.
    const c = valid();
    c.packs[0]!.items[0]!.options![1]!.label_text = "Gas welding";
    expect(fatal(c).join()).toContain("the label is the answer of record");
  });

  it("catches an option phrased as a QUESTION", () => {
    const c = valid();
    c.packs[0]!.items[0]!.options![0]!.label_text = "Gas welding?";
    expect(fatal(c).join()).toContain("options are ANSWERS, never questions");
  });

  it("catches more than one none-of-above option", () => {
    const c = valid();
    c.packs[0]!.items[0]!.options = [
      { option_key: "a", label_text: "A", is_none_of_above: true },
      { option_key: "b", label_text: "B", is_none_of_above: true },
    ];
    expect(fatal(c).join()).toContain("is_none_of_above");
  });

  it("catches min_turn after max_turn", () => {
    const c = valid();
    c.packs[0]!.items[1]!.min_turn = 9;
    c.packs[0]!.items[1]!.max_turn = 3;
    expect(fatal(c).join()).toContain("is after max_turn");
  });
});

describe("conditions and follow-ups", () => {
  it("catches a DANGLING ask_if key", () => {
    // It evaluates false forever, so the gated question silently never appears.
    const c = valid();
    c.packs[0]!.items[1]!.ask_if = { op: "answered", field: "typo_key" };
    expect(fatal(c).join()).toContain("not a question_key in this pack");
  });

  it("catches a question gated on ITSELF", () => {
    const c = valid();
    c.packs[0]!.items[1]!.ask_if = { op: "answered", field: "experience_years" };
    expect(fatal(c).join()).toContain("could never fire");
  });

  it("accepts a well-formed condition", () => {
    const c = valid();
    c.packs[0]!.items[1]!.ask_if = { op: "answered", field: "welding_type" };
    expect(fatal(c)).toEqual([]);
  });

  it("catches a parent_item_key that is not in the pack", () => {
    const c = valid();
    c.packs[0]!.items[1]!.parent_item_key = "ghost";
    expect(fatal(c).join()).toContain("is not a question in this pack");
  });

  it("catches FOLLOW-UP DEPTH GREATER THAN 1", () => {
    // A follow-up to a follow-up is a tree nobody can review, and the engine's ask
    // accounting assumes flat-plus-one.
    const c = valid();
    c.packs[0]!.items.push({
      question_key: "gas_pressure",
      prompt_text: "Kitna pressure use karte ho?",
      target_kind: "none",
      answer_type: "text",
      parent_item_key: "experience_years",
    });
    c.packs[0]!.items[1]!.parent_item_key = "welding_type";
    expect(fatal(c).join()).toContain("depth is capped at 1");
  });
});

describe("checkPromptPersona — the runtime guard promoted to build time", () => {
  it("accepts a compliant prompt", () => {
    expect(checkPromptPersona("Gas welding karte ho ya arc?", "p")).toEqual([]);
  });

  it("requires exactly one question mark", () => {
    expect(checkPromptPersona("Kya aap welder ho? Kitne saal?", "p").join()).toContain(
      "2 question mark",
    );
    expect(checkPromptPersona("Aap welder ho.", "p").join()).toContain("0 question mark");
  });

  it("caps the prompt at 20 words", () => {
    const long = `${"word ".repeat(25)}?`;
    expect(checkPromptPersona(long, "p").join()).toContain("max 20");
  });

  it("rejects an exclamation and an emoji", () => {
    expect(checkPromptPersona("Waah! Aap welder ho?", "p").join()).toContain("exclamation");
    expect(checkPromptPersona("Aap welder ho? 🙂", "p").join()).toContain("emoji");
  });

  it("catches a KEYCAP sequence, which needs the U+FE0F range", () => {
    // Pins the one case that justifies the no-misleading-character-class disable: a
    // keycap is digit + FE0F + U+20E3, and without FE0F in the class none of those code
    // points match, so it would pass as clean text. A heart would NOT prove this —
    // U+2764 is already inside 2600-27BF.
    expect(checkPromptPersona("Aap welder ho? 1\u{FE0F}\u{20E3}", "p").join()).toContain("emoji");
  });

  it("catches an off-persona prompt inside a real pack", () => {
    const c = valid();
    c.packs[0]!.items[0]!.prompt_text =
      "Bahut badhiya! Gas welding karte ho ya arc? Aur kitne saal?";
    const p = fatal(c).join();
    expect(p).toContain("exclamation");
    expect(p).toContain("question mark");
  });
});

describe("no template placeholder may reach a worker", () => {
  /**
   * THE HIGHEST-VALUE CHECK IN THIS VALIDATOR, and the cheapest.
   *
   * The voice form pre-renders every string the engine can serve into TTS audio, keyed by
   * `sha256(text)` and SHARED ACROSS EVERY WORKER. That is safe only while the text depends on
   * nothing about the individual. `{{worker_name}}` is a reviewed affordance of this corpus — the
   * API interpolates it POST-emit, into the client-returned reply only — but an authored prompt
   * carrying it would put ONE worker's name into a clip EVERY other worker hears.
   *
   * Measured when this landed: 0 of 466 corpus items contain `{{` anywhere. So this is a guard
   * against a single careless pack row, not a repair of an existing one.
   */
  const withText = (field: "prompt_text" | "retry_text" | "why_text", text: string) => {
    const c = valid();
    (c.packs[0]!.items[0]! as unknown as Record<string, unknown>)[field] = text;
    return c;
  };

  it.each(["prompt_text", "retry_text", "why_text"] as const)(
    "rejects a placeholder in %s — all three reach a worker",
    (field) => {
      // `why_text` reaches them inside the clarify concatenation and `retry_text` on the second
      // ask, so checking only the prompt would leave two open doors.
      const problems = fatal(withText(field, "Namaste {{worker_name}} ji, aap kahan hain?"));
      expect(problems.join("\n")).toContain("template placeholder");
      expect(problems.join("\n")).toContain(field);
    },
  );

  it("rejects a stray closing brace pair too — a half-written token is still a token", () => {
    expect(fatal(withText("why_text", "Aapke naam }} ke liye.")).join("\n")).toContain(
      "template placeholder",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(fatal(withText("why_text", "Sheher se paas ki naukri milti hai."))).toEqual([]);
  });
});

describe("a chip whose value its field cannot hold (#731)", () => {
  /**
   * A single_select on `relocation_willingness` — a `boolean` field — carrying one chip per
   * `value_*` column. Built fresh per test for the reason at the top of this file.
   */
  function withOptionValue(value: Partial<PackOptionRecord>): QuestionPackCorpus {
    const c = valid();
    c.packs[1]!.items.push({
      question_key: "relocation",
      prompt_text: "Kya aap doosre sheher jaa sakte hain?",
      target_kind: "rfs",
      target_field: "relocation_willingness",
      answer_type: "single_select",
      options: [
        { option_key: "yes", label_text: "Haan, jaa sakta hoon", value_bool: true },
        { option_key: "no", label_text: "Nahi, yahi rehna hai", value_bool: false },
        { option_key: "third", label_text: "Teesra jawab", ...value },
      ],
    });
    return c;
  }

  const BOOLEAN_FIELD: { fields: FieldView } = {
    fields: {
      fieldIds: new Set(["relocation_willingness", "skills", "experience"]),
      types: new Map([
        ["relocation_willingness", "boolean"],
        ["skills", "string_array"],
      ]),
    },
  };

  function typeProblems(c: QuestionPackCorpus, opts = BOOLEAN_FIELD): string[] {
    return validateQuestionPackCorpus(c, opts).filter((p) => p.includes("capture REFUSES"));
  }

  it("FAILS a string chip on a boolean field — the shape that loses a worker's answer", () => {
    // The whole point: capture returns undefined for this, `max_asks` is spent, and nothing
    // anywhere reports that the tap was thrown away.
    const problems = typeProblems(withOptionValue({ value_text: "conditional" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("option third");
    expect(problems[0]).toContain("value is string but target_field relocation_willingness");
  });

  it("FAILS a number chip on a boolean field too — the rule is the type, not the column", () => {
    expect(typeProblems(withOptionValue({ value_number: 1 }))).toHaveLength(1);
  });

  it("passes a boolean chip on a boolean field", () => {
    expect(typeProblems(withOptionValue({ value_bool: true }))).toEqual([]);
  });

  it("passes a chip carrying NO value — the label is the answer of record", () => {
    // Most chips in the corpus are this shape. Flagging them would make the rule useless.
    expect(typeProblems(withOptionValue({}))).toEqual([]);
  });

  it("passes `value_bool: false` on the boolean field it fits", () => {
    expect(typeProblems(withOptionValue({ value_bool: false }))).toEqual([]);
  });

  it.each([{ value_bool: false }, { value_number: 0 }])(
    "FLAGS the falsy value %j on a STRING field — a falsy value is still a value",
    (value) => {
      // THE MUTATION THIS EXISTS FOR. `optionValue` chains with `??`; a truthiness chain would read
      // both of these as "no value" and skip the check silently. On the boolean field above that
      // mistake is invisible — both readings pass — so the probe has to be a field the value does
      // NOT fit, where skipping and checking give opposite answers.
      const c = valid();
      c.packs[1]!.items.push({
        question_key: "education_level",
        prompt_text: "Aapne kahan tak padhai ki hai?",
        target_kind: "rfs",
        target_field: "education_level",
        answer_type: "single_select",
        options: [
          { option_key: "iti", label_text: "ITI", value_text: "iti" },
          { option_key: "odd", label_text: "Kuch aur", ...value },
        ],
      });
      const problems = validateQuestionPackCorpus(c, {
        fields: {
          fieldIds: new Set(["education_level"]),
          types: new Map([["education_level", "string"]]),
        },
      }).filter((p) => p.includes("capture REFUSES"));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("option odd");
    },
  );

  it("passes a string chip on a string_array field — a single_select contributes one item", () => {
    const c = valid();
    (c.packs[0]!.items[0]!.options ?? []).push({
      option_key: "tig",
      label_text: "TIG welding",
      value_text: "tig_welding",
    });
    expect(typeProblems(c)).toEqual([]);
  });

  it("does NOT run when the caller supplies no type table", () => {
    // Same convention as `fieldIds`. Asserted so nobody assumes the rule is on by default —
    // the last check that quietly wasn't took a bad universal pack to production.
    const c = withOptionValue({ value_text: "conditional" });
    expect(typeProblems(c, { fields: { fieldIds: new Set(["relocation_willingness"]) } })).toEqual(
      [],
    );
  });

  it("does NOT run on an attribute item — a pack-local field declares no type", () => {
    const c = withOptionValue({ value_text: "conditional" });
    c.packs[1]!.items[1]!.target_kind = "attribute";
    expect(typeProblems(c)).toEqual([]);
  });
});

/**
 * THE COMMITTED CORPUS ITSELF, validated by the SAME call the CI step makes (R14).
 *
 * WHY THIS FILE DID NOT ALREADY DO IT, AND WHAT THAT COST. Every case above builds a synthetic
 * corpus to exercise one rule. Nothing here had ever read `data/question-packs/`, so the shipped
 * files were checked by exactly one thing: a separate CI step running
 * `pnpm --filter @badabhai/db db:verify:packs --corpus`. `pnpm --filter @badabhai/db test` —
 * 2,333 assertions — was green on a corpus that the runtime schema REFUSES.
 *
 * Measured: the milling pack shipped `option_key: "en8"` and `"en31"`, digits in a field whose
 * contract is `/^[a-z_]+$/`. Local gates green, CI red, and had it reached production the pack
 * registry would have dropped the whole pack and every miller would have fallen through to the
 * universal seven questions — the exact "green corpus, dead trade" failure `OPTION_KEY_RE`'s own
 * docstring describes.
 *
 * SAME OPTIONS AS THE CLI, deliberately. `fieldIds` and `types` ARM rules that otherwise do not
 * run at all; a copy of this call that omitted them would be green for a different and much
 * quieter reason. If the two ever diverge, this file is testing a validator the product does not
 * use.
 */
describe("the COMMITTED question-pack corpus", () => {
  const corpus = loadQuestionPackCorpus();

  it("actually loaded the shipped files — the vacuity check first", () => {
    // Every assertion below is "no problems were found", and a loader that read nothing satisfies
    // all of them. These floors are the shipped scale, not a guess: 144 packs, 647 items.
    const summary = summariseQuestionPackCorpus(corpus);
    expect(summary.packs, "no packs loaded — the validator below proves nothing").toBeGreaterThan(
      100,
    );
    expect(summary.items).toBeGreaterThan(500);
    expect(summary.options).toBeGreaterThan(900);
  });

  it("is VALID under the same call the CI step makes", () => {
    const problems = validateQuestionPackCorpus(corpus, {
      fields: { fieldIds: RFS_FIELD_IDS, types: RFS_FIELD_TYPES },
    }).filter((p) => !p.includes("WARN"));
    expect(problems, `${problems.length} committed pack(s) would be refused at runtime`).toEqual(
      [],
    );
  });
});
