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
  summariseQuestionPackCorpus,
  validateQuestionPackCorpus,
  type QuestionPackCorpus,
} from "./question-pack-corpus";

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
    c.bindings[0] = { kind: "binding", family_id: "fam_welding", isco_unit_code: "7212", isco_major_code: "7" };
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
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_unit_code: "7212" })).toBe(40);
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_minor_code: "721" })).toBe(30);
    expect(bindingSpecificity({ kind: "binding", family_id: "f", isco_submajor_code: "72" })).toBe(20);
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
    c.packs[0]!.items[1]!.ask_if = { op: "answered", args: [{ field: "typo_key" }] };
    expect(fatal(c).join()).toContain("not a question_key in this pack");
  });

  it("catches a question gated on ITSELF", () => {
    const c = valid();
    c.packs[0]!.items[1]!.ask_if = { op: "answered", args: [{ field: "experience_years" }] };
    expect(fatal(c).join()).toContain("could never fire");
  });

  it("accepts a well-formed condition", () => {
    const c = valid();
    c.packs[0]!.items[1]!.ask_if = { op: "answered", args: [{ field: "welding_type" }] };
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
    expect(checkPromptPersona("Kya aap welder ho? Kitne saal?", "p").join()).toContain("2 question mark");
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
    c.packs[0]!.items[0]!.prompt_text = "Bahut badhiya! Gas welding karte ho ya arc? Aur kitne saal?";
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
