import { describe, expect, it } from "vitest";
import {
  ALL_NUMBERS_REVEALED,
  cardFieldErrors,
  cardFieldsFromValues,
  cardIssueMessage,
  gapInputFromValues,
  liveCardFieldError,
  numberPairOf,
  parseWholeNumber,
  readCardForm,
  revealNumberPair,
  withChipDraft,
  type CardFormChips,
  type CardFormFields,
} from "./job-card-form";
import { toJobCardView } from "./job-card-view";
import { jobRoleLabel, TRADE_FORM_KINDS_ALL } from "./job-roles";
import { workerCardGap } from "./worker-card-gap";

/**
 * THE ONE FORM → CARD READER. These pin the three liveness bugs the audit measured, at the seam
 * every form now reads through:
 *   1. "21,000" was silently "not stated" (→ "Up to ₹30,000/mah"); "1.5" likewise (→ "Up to 4 yrs").
 *      Now: grouped digits are accepted; anything else is an ISSUE, never "empty".
 *   2. max < min drew an inverted band. Now: an issue on the max, the band is never drawn.
 *   3. a chip typed but not added was dropped on submit. Now: it is in `values` (and drawn pending).
 * And the lineage invariant: the preview's `card` is derived from the SAME `values` the submit
 * sends — for every one of the 21 role kinds.
 */

const BLANK: CardFormFields = {
  roleKind: "",
  title: "",
  city: "",
  area: "",
  payMin: "",
  payMax: "",
  payType: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  shift: "",
  neededBy: "",
};
const NO_CHIPS: CardFormChips = { requirements: [], benefits: [], reqDraft: "", benDraft: "" };
const TYPICAL: CardFormFields = {
  roleKind: "cnc_turner",
  title: "  CNC Turner ",
  city: "Pune ",
  area: " Chakan MIDC",
  payMin: "18000",
  payMax: "26000",
  payType: "in_hand",
  minExperienceYears: "2",
  maxExperienceYears: "5",
  shift: "day",
  neededBy: "soon",
};
const read = (f: Partial<CardFormFields>, c: Partial<CardFormChips> = {}) =>
  readCardForm({ ...TYPICAL, ...f }, { ...NO_CHIPS, ...c });

describe("parseWholeNumber — whole or an issue, never a silent 'empty'", () => {
  it.each([
    ["18000", 18000],
    [" 18000 ", 18000],
    ["21,000", 21000],
    ["1,50,000", 150000],
    ["1,00,00,000", 10000000],
    ["150,000", 150000],
    ["1,000,000", 1000000],
    ["0", 0],
    ["007", 7],
  ])("%j → %d", (raw, value) => {
    expect(parseWholeNumber(raw)).toEqual({ kind: "ok", value });
  });

  it.each(["", "   "])("%j → empty", (raw) => {
    expect(parseWholeNumber(raw)).toEqual({ kind: "empty" });
  });

  it.each([
    "1.5",
    "21k",
    "2 saal",
    "1e5",
    "-3",
    "+3",
    "21 000",
    "1,5",
    "2,0",
    ",000",
    "21,",
    "₹21000",
    "0x10",
    "Infinity",
  ])("%j → invalid", (raw) => {
    expect(parseWholeNumber(raw)).toEqual({ kind: "invalid" });
  });
});

describe("readCardForm — values, card and issues", () => {
  it("trims text, drops empty enums to undefined, and derives the card from the values", () => {
    const r = read({});
    expect(r.values).toEqual({
      roleKind: "cnc_turner",
      title: "CNC Turner",
      city: "Pune",
      area: "Chakan MIDC",
      payMin: 18000,
      payMax: 26000,
      payType: "in_hand",
      minExperienceYears: 2,
      maxExperienceYears: 5,
      shift: "day",
      neededBy: "soon",
      requirements: [],
      benefits: [],
    });
    expect(r.card).toEqual(cardFieldsFromValues(r.values));
    expect(r.issues).toEqual({});
    expect(toJobCardView(r.card, r.draft).salary).toEqual({
      band: "₹18,000–26,000/mah",
      issue: null,
      payTypePill: "IN-HAND",
    });
  });

  it("an all-blank form states nothing — every value undefined, no issue, no card rows", () => {
    const r = readCardForm(BLANK, NO_CHIPS);
    expect(Object.values(r.values).filter((v) => v !== undefined && !Array.isArray(v))).toEqual([
      "",
    ]);
    expect(r.issues).toEqual({});
    const view = toJobCardView(r.card, r.draft);
    expect(view).toEqual({ title: "", place: null, salary: null, chips: [] });
  });

  it('"21,000" is ₹21,000 — the band is the one the payer meant (was "Up to ₹30,000/mah")', () => {
    const r = read({ payMin: "21,000", payMax: "30000" });
    expect(r.values.payMin).toBe(21000);
    expect(r.issues).toEqual({});
    expect(toJobCardView(r.card, r.draft).salary?.band).toBe("₹21,000–30,000/mah");
  });

  it('"21k" is an ISSUE: no value is sent, the card names the fix, never "Up to ₹30,000/mah"', () => {
    const r = read({ payMin: "21k", payMax: "30000" });
    expect(r.issues).toEqual({ payMin: "not_whole" });
    expect(r.values.payMin).toBeUndefined();
    const view = toJobCardView(r.card, r.draft);
    expect(view.salary).toEqual({
      band: null,
      issue: "Pay needs a whole number",
      payTypePill: "IN-HAND",
    });
    expect(JSON.stringify(view)).not.toContain("Up to");
  });

  it('"1.5" years is an ISSUE: the experience chip names the fix, never "Up to 4 yrs experience"', () => {
    const r = read({ minExperienceYears: "1.5", maxExperienceYears: "4" });
    expect(r.issues).toEqual({ minExperienceYears: "not_whole" });
    const chips = toJobCardView(r.card, r.draft).chips;
    expect(chips.find((c) => c.kind === "experience")).toEqual({
      kind: "experience",
      label: "Experience needs whole years",
      state: "invalid",
    });
    expect(JSON.stringify(chips)).not.toContain("Up to");
  });

  it("max below min is an issue on the MAX — the inverted band is never drawn", () => {
    const r = read({ payMin: "26000", payMax: "18000" });
    expect(r.issues).toEqual({ payMax: "below_min" });
    expect(toJobCardView(r.card, r.draft).salary?.issue).toBe("Max pay is below min pay");
    expect(JSON.stringify(toJobCardView(r.card, r.draft))).not.toContain("26,000–18,000");

    const e = read({ minExperienceYears: "5", maxExperienceYears: "2" });
    expect(e.issues).toEqual({ maxExperienceYears: "below_min" });
    expect(toJobCardView(e.card, e.draft).chips.find((c) => c.kind === "experience")?.label).toBe(
      "Max experience is below min",
    );
  });

  it("equal bounds are fine; a one-sided band is fine", () => {
    expect(read({ payMin: "20000", payMax: "20000" }).issues).toEqual({});
    const one = read({ payMin: "16000", payMax: "" });
    expect(one.issues).toEqual({});
    expect(toJobCardView(one.card, one.draft).salary?.band).toBe("₹16,000+/mah");
  });

  it("over the ceiling is an issue (₹1,00,00,000 / 60 years) — the ceiling itself is not", () => {
    expect(read({ payMax: "10000000" }).issues).toEqual({});
    expect(read({ payMax: "10000001" }).issues).toEqual({ payMax: "too_large" });
    expect(read({ maxExperienceYears: "61" }).issues).toEqual({ maxExperienceYears: "too_large" });
    expect(read({ maxExperienceYears: "60" }).issues).toEqual({});
  });

  it("an order issue waits for both ends to be valid (a format issue is reported first)", () => {
    expect(read({ payMin: "abc", payMax: "1" }).issues).toEqual({ payMin: "not_whole" });
  });
});

describe("chip drafts are never dropped", () => {
  it("text left in the box is IN the values (and drawn pending on the card)", () => {
    const r = read(
      {},
      { requirements: ["Fanuc control"], reqDraft: "  MIG welding ", benDraft: "Free bus" },
    );
    expect(r.values.requirements).toEqual(["Fanuc control", "MIG welding"]);
    expect(r.values.benefits).toEqual(["Free bus"]);
    expect(r.draft.pendingRequirement).toBe("MIG welding");
    const chips = toJobCardView(r.card, r.draft).chips;
    expect(chips.filter((c) => c.state === "pending").map((c) => c.label)).toEqual([
      "MIG welding",
      "Free bus",
    ]);
  });

  it("a draft that repeats an added chip is not added twice and is not pending", () => {
    const r = read({}, { requirements: ["Fanuc control"], reqDraft: "Fanuc control" });
    expect(r.values.requirements).toEqual(["Fanuc control"]);
    expect(r.draft.pendingRequirement).toBeNull();
    expect(withChipDraft(["a"], " ")).toEqual({ list: ["a"], pending: null });
  });
});

describe("the lineage — for every one of the 21 role kinds, preview == what is saved", () => {
  it.each(TRADE_FORM_KINDS_ALL)("role_kind=%s", (kind) => {
    const r = read({ roleKind: kind });
    expect(r.values.roleKind).toBe(kind); // the submit sends it
    expect(r.card.role_kind).toBe(kind); // the preview's facts list reads it
    expect(jobRoleLabel(r.card.role_kind)).not.toBeNull();
    // …and it is NOT a card row: the view the card draws is identical with or without it.
    expect(toJobCardView(r.card, r.draft)).toEqual(
      toJobCardView({ ...r.card, role_kind: null }, r.draft),
    );
  });

  it("the gap rule reads the same values the submit sends", () => {
    const r = read({}, { requirements: ["Fanuc control"], benDraft: "PF + ESI" });
    expect(workerCardGap(gapInputFromValues(r.values, "Two machines per shift."))).toBeNull();
    // Without the draft committed by the reader, the benefit would be missing.
    const r2 = read({}, { requirements: ["Fanuc control"] });
    expect(workerCardGap(gapInputFromValues(r2.values, "Two machines per shift."))?.title).toBe(
      "Add a benefit",
    );
  });
});

describe("messages + when they show", () => {
  it("keeps the forms' established copy and says 'whole number' for a bad number", () => {
    expect(cardIssueMessage("payMax", "below_min")).toBe(
      "Max pay must be greater than or equal to min pay.",
    );
    expect(cardIssueMessage("maxExperienceYears", "below_min")).toBe(
      "Max experience must be greater than or equal to min experience.",
    );
    expect(cardIssueMessage("payMin", "not_whole")).toContain("needs a whole number");
    expect(cardIssueMessage("minExperienceYears", "not_whole")).toContain("needs a whole number");
    expect(cardIssueMessage("payMax", "too_large")).toBe("Max pay must be at most 1,00,00,000.");
    expect(cardFieldErrors({ payMin: "not_whole", payMax: "below_min" })).toEqual({
      payMin: cardIssueMessage("payMin", "not_whole"),
      payMax: cardIssueMessage("payMax", "below_min"),
    });
  });

  it("a format error shows while typing; 'max below min' only once the payer has left the box", () => {
    const issues = { payMin: "not_whole", payMax: "below_min" } as const;
    expect(liveCardFieldError(issues, "payMin", false)).toBeDefined();
    expect(liveCardFieldError(issues, "payMax", false)).toBeUndefined();
    expect(liveCardFieldError(issues, "payMax", true)).toBe(
      cardIssueMessage("payMax", "below_min"),
    );
    expect(liveCardFieldError({}, "payMax", true)).toBeUndefined();
  });

  it("revealing / concealing works per pair", () => {
    expect(numberPairOf("payMax")).toBe("pay");
    expect(numberPairOf("minExperienceYears")).toBe("experience");
    expect(numberPairOf("city")).toBeNull();
    const shown = revealNumberPair({}, "pay", true);
    expect(shown).toEqual({ payMin: true, payMax: true });
    expect(revealNumberPair(ALL_NUMBERS_REVEALED, "pay", false)).toEqual({
      minExperienceYears: true,
      maxExperienceYears: true,
    });
  });
});
