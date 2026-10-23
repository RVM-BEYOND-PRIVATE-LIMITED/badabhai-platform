import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OPEN_TOP_SALARY_CHIP_FLOOR,
  OPEN_TOP_SALARY_CHIP_MAX,
} from "../profiles/worker-field-precedence";
import { roadContext, roadPersona } from "./__fixtures__/general-road";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * ═══ #2400 — "₹50 HAZAAR SE UPAR" PRINTS AS ₹50,000+, NOT ₹1,00,000 ═══
 *
 * The form's top salary chip is stored as `salary_expected_max = 100000` with no min. The sheet
 * printed that key as the worker's figure, so the Resume card, the "Salary expected" row and the
 * "expects …" subhead all said ₹1,00,000 / month. The worker never said 1 lakh.
 *
 * Asserted on the mapper's output for both sheets that read the form's band: the trade sheet
 * (the container path) and the general road.
 */

const CONTAINER = {
  role_label: "CNC Turner",
  skills: ["CNC lathe operation"],
  location_preference: { current_city: "Faridabad", preferred_cities: ["Faridabad"] },
  resume_profile: {
    role_label: "CNC Turner",
    skills: ["CNC lathe operation"],
    current_city: "Faridabad",
    availability: "immediate",
    experiences: [],
    preferred_locations: ["Faridabad"],
    expected_salary: null,
  },
};

function tradeSheet(
  band: { salary_expected_min?: number; salary_expected_max?: number },
  audience: "worker" | "employer" = "worker",
) {
  return buildResumeRenderInput(CONTAINER, "Ramesh Kumar", "bb_trade", null, false, audience, {
    packId: "qp_cnc_turning",
    attributes: { turning_machine: ["cnc_lathe"], ...band },
  });
}

const salaryRow = (input: ReturnType<typeof tradeSheet>) =>
  input.availFactRows?.find((r) => r.label === "Salary expected")?.value ?? null;

describe("the trade sheet", () => {
  it("prints the top chip as ₹50,000+ on the row the app's card shows, and in the subhead", () => {
    const input = tradeSheet({ salary_expected_max: 100000 });
    expect(salaryRow(input)).toBe("₹50,000+ / month");
    expect(input.subheadLine).toContain("expects ₹50,000+ / month");
    expect(JSON.stringify(input)).not.toContain("1,00,000");
  });

  it("keeps a chat edit's exact ₹1,00,000 (min == max): never below his own figure (R10 R-2)", () => {
    const input = tradeSheet({ salary_expected_min: 100000, salary_expected_max: 100000 });
    expect(salaryRow(input)).toBe("₹1,00,000 / month");
  });

  it("leaves every other chip as it was — '₹35–50 hazaar' still prints its top figure", () => {
    expect(salaryRow(tradeSheet({ salary_expected_max: 50000 }))).toBe("₹50,000 / month");
    expect(salaryRow(tradeSheet({ salary_expected_max: 25000 }))).toBe("₹25,000 / month");
  });

  it("still withholds it from the employer copy", () => {
    const input = tradeSheet({ salary_expected_max: 100000 }, "employer");
    expect(salaryRow(input)).toBeNull();
    expect(input.subheadLine ?? "").not.toMatch(/expects/i);
  });
});

describe("the general road", () => {
  const persona = roadPersona("road-band-max-only");
  const road = (attributes: Record<string, unknown>) => {
    const context = roadContext(persona);
    return buildResumeRenderInput(
      persona.snapshot,
      persona.displayName,
      "bb_general",
      null,
      false,
      "worker",
      { ...context, attributes: { ...context.attributes, ...attributes } },
    );
  };

  it("prints the top chip as ₹50,000+, and its figure is the chip's floor", () => {
    const input = road({ salary_expected_max: 100000 });
    expect(salaryRow(input)).toBe("₹50,000+ / month");
    expect(input.expectedSalary).toBe(50000);
  });

  it("keeps a chat edit's exact ₹1,00,000", () => {
    const input = road({ salary_expected_min: 100000, salary_expected_max: 100000 });
    expect(salaryRow(input)).toBe("₹1,00,000 / month");
    expect(input.expectedSalary).toBe(100000);
  });
});

describe("the app's chip map, read from the Dart source", () => {
  // The server reads the chip's stored key; the app owns the chip. If either page changes the
  // top chip's key or its floor, this fails here instead of a worker's sheet printing a new wrong
  // number. Read from source, like `finishing-form-contract.test.ts`, because a mock of the
  // client cannot disagree with the server.
  const PAGES = [
    "apps/worker-app/lib/features/trade_form/presentation/widgets/trade_form_preferences_page.dart",
    "apps/worker-app/lib/features/finishing/presentation/finishing_screen.dart",
  ];

  it.each(PAGES)("%s still stores '₹50 hazaar se upar' at the key the sheet reads", (page) => {
    const source = readFileSync(join(__dirname, "../../../..", page), "utf8");
    const chips = /_kSalaryBands = <int, String>\{([\s\S]*?)\};/.exec(source)?.[1];
    expect(chips, `no _kSalaryBands in ${page}`).toBeDefined();
    const entries = [...chips!.matchAll(/(\d+):\s*'([^']*)'/g)].map(([, key, label]) => ({
      key: Number(key),
      label,
    }));
    const top = entries.at(-1)!;
    expect(top).toEqual({ key: OPEN_TOP_SALARY_CHIP_MAX, label: "₹50 hazaar se upar" });
    // The chip below the top one ends where the top one starts.
    expect(entries.at(-2)?.key).toBe(OPEN_TOP_SALARY_CHIP_FLOOR);
  });
});
