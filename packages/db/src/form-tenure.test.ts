/**
 * #2753 item 2 — the shared read of a trade form's experience band, as both writers of
 * `worker_skill` call it (the live rebuild in apps/api and `db:backfill:worker-skills`).
 *
 * No database here: the statement's real behaviour is gated by `form-onboarding-reach.db.test.ts`
 * in apps/api. What this pins is the RULE (which answer states which years) and the COST (one
 * query for a whole batch, none while the switch is off).
 */
import { describe, expect, it, vi } from "vitest";

import type { Database } from "./client";
import {
  FORM_TENURE_QUESTION_KEYS,
  formTenureSwitchesForRun,
  formTenureYearsOf,
  loadFormTenureAnswers,
  loadFormTenureFills,
  type FormTenureAnswerRow,
} from "./form-tenure";

const ON = { months: true, typed: false } as const;
const ON_TYPED = { months: true, typed: true } as const;

function answer(over: Partial<FormTenureAnswerRow> = {}): FormTenureAnswerRow {
  return {
    workerId: "w1",
    packId: "qp_sheet_metal_fab",
    questionKey: "sheet_metal_experience",
    status: "answered",
    answerNumber: null,
    answerOtherText: null,
    ...over,
  };
}

/** A `Database` stand-in that records every `select` and answers it with `rows`. */
function fakeDb(rows: readonly FormTenureAnswerRow[]): {
  db: Database;
  select: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn(() => ({ from: () => ({ where: async () => [...rows] }) }));
  return { db: { select } as unknown as Database, select };
}

describe("formTenureYearsOf — which stored answer states which years", () => {
  it("a tapped band is its value_number, stored in answer_number", () => {
    for (const years of [0, 2, 4, 7, 12]) {
      expect(formTenureYearsOf(answer({ answerNumber: years }), ON)).toBe(years);
    }
  });

  it("a figure outside the 0–60 bound, or not finite, states nothing", () => {
    for (const bad of [-1, 61, 80, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formTenureYearsOf(answer({ answerNumber: bad }), ON)).toBeNull();
    }
  });

  it("a declined or unanswered row states nothing — 'pata nahi' is not a band", () => {
    expect(formTenureYearsOf(answer({ status: "declined" }), ON_TYPED)).toBeNull();
    expect(formTenureYearsOf(answer({ status: "unanswered" }), ON_TYPED)).toBeNull();
  });

  it("a typed answer counts ONLY with the typed switch on, read by typedTenureYears", () => {
    const typed = answer({ answerOtherText: "  10 saal ho gaye sir… sep 2016 se " });
    expect(formTenureYearsOf(typed, ON)).toBeNull();
    expect(formTenureYearsOf(typed, ON_TYPED)).toBe(10);
  });

  it("an ambiguous or empty typed answer states nothing, switch or no switch", () => {
    for (const text of ["8 saal VMC, 2 saal turning", "pata nahi", "5 saal nahi", "   "]) {
      expect(formTenureYearsOf(answer({ answerOtherText: text }), ON_TYPED)).toBeNull();
    }
  });
});

describe("loadFormTenureAnswers / loadFormTenureFills — the batched read", () => {
  it("is ONE query for N workers, and none for an empty batch", async () => {
    const { db, select } = fakeDb([]);
    await loadFormTenureAnswers(db, ["w1", "w2", "w3", "w4", "w5"]);
    expect(select).toHaveBeenCalledTimes(1);
    await loadFormTenureAnswers(db, []);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps only a form's OWN tenure question (the pack → key pair)", async () => {
    const { db } = fakeDb([
      answer({ workerId: "w1", answerNumber: 4 }),
      // Right key, wrong pack — the two IN lists let it through; the pair check drops it.
      answer({ workerId: "w2", packId: "qp_welding_trade", answerNumber: 7 }),
    ]);
    expect((await loadFormTenureAnswers(db, ["w1", "w2"])).map((r) => r.workerId)).toEqual(["w1"]);
  });

  it("issues NO query at all while FORM_TENURE_MONTHS_ENABLED is off", async () => {
    const { db, select } = fakeDb([answer({ answerNumber: 4 })]);
    const fills = await loadFormTenureFills(db, ["w1"], { months: false, typed: true });
    expect(fills.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("groups the fills by worker, two forms each, from that ONE query", async () => {
    const { db, select } = fakeDb([
      answer({ workerId: "w1", answerNumber: 4 }),
      answer({
        workerId: "w1",
        packId: "qp_welding_trade",
        questionKey: "welding_experience",
        answerNumber: 12,
      }),
      answer({ workerId: "w2", status: "declined" }),
      answer({ workerId: "w3", answerOtherText: "das saal" }),
    ]);
    const fills = await loadFormTenureFills(db, ["w1", "w2", "w3"], ON);
    expect(select).toHaveBeenCalledTimes(1);
    expect(fills.get("w1")).toEqual([
      { packId: "qp_sheet_metal_fab", years: 4 },
      { packId: "qp_welding_trade", years: 12 },
    ]);
    // A decline and (with the typed switch off) a typed answer fill nothing: absent, not [].
    expect(fills.has("w2")).toBe(false);
    expect(fills.has("w3")).toBe(false);
    expect((await loadFormTenureFills(db, ["w3"], ON_TYPED)).get("w3")).toEqual([
      { packId: "qp_sheet_metal_fab", years: 10 },
    ]);
  });
});

describe("formTenureSwitchesForRun — the backfill reads the api's names, and never guesses on --apply", () => {
  const APPLY = { apply: true } as const;
  const DRY = { apply: false } as const;
  const MONTHS = "FORM_TENURE_MONTHS_ENABLED";
  const TYPED = "FORM_TYPED_TENURE_DERIVE_ENABLED";

  it("--apply REFUSES while FORM_TENURE_MONTHS_ENABLED is unset or empty, in one line naming it", () => {
    for (const env of [{}, { [MONTHS]: "" }, { [TYPED]: "true" }]) {
      let message = "";
      try {
        formTenureSwitchesForRun(env, APPLY);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^FORM_TENURE_MONTHS_ENABLED is unset or empty: --apply needs it/);
      expect(message).not.toContain("\n");
    }
  });

  it("--apply with the months switch ON also refuses an unset or empty typed switch", () => {
    for (const env of [{ [MONTHS]: "true" }, { [MONTHS]: "1", [TYPED]: "" }]) {
      expect(() => formTenureSwitchesForRun(env, APPLY)).toThrow(
        /^FORM_TYPED_TENURE_DERIVE_ENABLED is unset or empty: --apply needs it/,
      );
    }
  });

  it("--apply proceeds on explicit values, and does not demand the typed switch when months is off", () => {
    expect(formTenureSwitchesForRun({ [MONTHS]: "false" }, APPLY)).toEqual({
      switches: { months: false, typed: false },
      assumed: [],
    });
    expect(formTenureSwitchesForRun({ [MONTHS]: "0", [TYPED]: "" }, APPLY)).toEqual({
      switches: { months: false, typed: false },
      assumed: [],
    });
    expect(formTenureSwitchesForRun({ [MONTHS]: "true", [TYPED]: "false" }, APPLY)).toEqual({
      switches: { months: true, typed: false },
      assumed: [],
    });
    expect(formTenureSwitchesForRun({ [MONTHS]: "1", [TYPED]: "1" }, APPLY)).toEqual({
      switches: { months: true, typed: true },
      assumed: [],
    });
  });

  it("a DRY RUN proceeds on unset switches, reads them as false and lists what it assumed", () => {
    expect(formTenureSwitchesForRun({}, DRY)).toEqual({
      switches: { months: false, typed: false },
      assumed: [MONTHS],
    });
    expect(formTenureSwitchesForRun({ [MONTHS]: "true" }, DRY)).toEqual({
      switches: { months: true, typed: false },
      assumed: [TYPED],
    });
    expect(formTenureSwitchesForRun({ [MONTHS]: "true", [TYPED]: "true" }, DRY)).toEqual({
      switches: { months: true, typed: true },
      assumed: [],
    });
  });

  it("refuses a malformed value in either mode rather than guessing (TRUE, yes, on)", () => {
    for (const bad of ["TRUE", "yes", "on", " true"]) {
      for (const mode of [APPLY, DRY]) {
        expect(() => formTenureSwitchesForRun({ [MONTHS]: bad }, mode)).toThrow(
          /FORM_TENURE_MONTHS_ENABLED must be exactly/,
        );
        expect(() => formTenureSwitchesForRun({ [MONTHS]: "true", [TYPED]: bad }, mode)).toThrow(
          /FORM_TYPED_TENURE_DERIVE_ENABLED must be exactly/,
        );
      }
    }
  });
});

describe("FORM_TENURE_QUESTION_KEYS", () => {
  it("names one tenure question per pack, every key an `*_experience` slug", () => {
    for (const [packId, key] of Object.entries(FORM_TENURE_QUESTION_KEYS)) {
      expect(packId).toMatch(/^qp_[a-z0-9_]+$/);
      expect(key).toMatch(/^[a-z_]+_experience$/);
    }
  });
});
