import { describe, expect, it } from "vitest";
import {
  FORM_TENURE_QUESTION_KEYS,
  loadQuestionPackCorpus,
  TENURE_YEARS_RANGE,
  type PackRecord,
} from "@badabhai/db";

import { EXPERIENCE_YEARS_RANGE } from "../profiling/parse-gates";
import { ROLE_FORM_DESCRIPTORS } from "../profiling/roles/role-registry";
import { formTenureSwitches } from "./form-tenure-months.flag";

/**
 * #2753 item 2 — THE TWO RESTATEMENTS `@badabhai/db` HAD TO MAKE, HELD TO THEIR SOURCES.
 *
 * `db:backfill:worker-skills` lives in a package that cannot import `apps/api`, yet it must read a
 * trade form's experience band exactly as the live rebuild does. So `@badabhai/db` carries:
 *   - `FORM_TENURE_QUESTION_KEYS` — each form's tenure question, which the ROLE REGISTRY owns
 *     (`tenureQuestionKey` on every descriptor);
 *   - `TENURE_YEARS_RANGE` — the 0–60 bound, which `parse-gates.ts` owns for every writer of
 *     `experience_years`.
 * A copy nothing compares is how the batch repair and the live path start writing different months
 * for the same man (TD120). This file is the comparison. It also checks the table against the REAL
 * corpus: a key that names no single-select band question would read nothing, silently.
 */
/** The real corpus, read once. Never a fixture: a fixture drifts from the packs one layer down. */
const PACKS: readonly PackRecord[] = loadQuestionPackCorpus().packs;

describe("FORM_TENURE_QUESTION_KEYS mirrors the role registry", () => {
  it("has exactly one entry per declared role: its pack → its tenureQuestionKey", () => {
    const fromRegistry = Object.fromEntries(
      ROLE_FORM_DESCRIPTORS.map((descriptor) => [descriptor.packId, descriptor.tenureQuestionKey]),
    );
    expect(FORM_TENURE_QUESTION_KEYS).toEqual(fromRegistry);
  });

  it("every key names a single-select band question whose options all carry years (0–60)", () => {
    const byPack = new Map<string, PackRecord[]>();
    for (const pack of PACKS) {
      byPack.set(pack.pack_id, [...(byPack.get(pack.pack_id) ?? []), pack]);
    }
    let checked = 0;
    for (const [packId, key] of Object.entries(FORM_TENURE_QUESTION_KEYS)) {
      // A declared role whose pack is not authored yet has nothing to read — and nothing stored.
      for (const pack of byPack.get(packId) ?? []) {
        const item = pack.items.find((candidate) => candidate.question_key === key);
        expect(item, `${packId}@${pack.version} has no ${key}`).toBeDefined();
        expect(item!.answer_type, `${packId}@${pack.version}.${key}`).toBe("single_select");
        const options = item!.options ?? [];
        expect(options.length).toBeGreaterThan(0);
        for (const option of options) {
          // The band's years ARE the stored answer: `value_number`, and nothing beside it (#776).
          expect(option.value_number, `${packId}.${key}.${option.option_key}`).toEqual(
            expect.any(Number),
          );
          expect(option.value_number).toBeGreaterThanOrEqual(TENURE_YEARS_RANGE.min);
          expect(option.value_number).toBeLessThanOrEqual(TENURE_YEARS_RANGE.max);
        }
        checked += 1;
      }
    }
    // Vacuity guard: the launch trades' packs are all authored.
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("the current bands read as the issue states: fresher 0, under one 0, 1–3 → 2 … over 10 → 12", () => {
    const sheetMetal = PACKS.filter((pack) => pack.pack_id === "qp_sheet_metal_fab").sort(
      (a, b) => b.version - a.version,
    )[0]!;
    const item = sheetMetal.items.find((i) => i.question_key === "sheet_metal_experience")!;
    expect(
      Object.fromEntries((item.options ?? []).map((o) => [o.option_key, o.value_number])),
    ).toEqual({
      fresher: 0,
      below_one: 0,
      one_to_three: 2,
      three_to_five: 4,
      five_to_ten: 7,
      above_ten: 12,
    });
  });
});

describe("TENURE_YEARS_RANGE is the experience_years bound", () => {
  it("equals parse-gates' EXPERIENCE_YEARS_RANGE", () => {
    expect(TENURE_YEARS_RANGE).toEqual(EXPERIENCE_YEARS_RANGE);
  });
});

describe("formTenureSwitches — the one read of the switch on the live path", () => {
  it("is off for a missing config, an empty one, and an explicit false", () => {
    for (const config of [undefined, {}, { FORM_TENURE_MONTHS_ENABLED: false }]) {
      expect(formTenureSwitches(config)).toEqual({ months: false, typed: false });
    }
  });

  it("a typed tenure counts only with BOTH switches on", () => {
    expect(formTenureSwitches({ FORM_TYPED_TENURE_DERIVE_ENABLED: true })).toEqual({
      months: false,
      typed: false,
    });
    expect(formTenureSwitches({ FORM_TENURE_MONTHS_ENABLED: true })).toEqual({
      months: true,
      typed: false,
    });
    expect(
      formTenureSwitches({
        FORM_TENURE_MONTHS_ENABLED: true,
        FORM_TYPED_TENURE_DERIVE_ENABLED: true,
      }),
    ).toEqual({ months: true, typed: true });
  });
});
