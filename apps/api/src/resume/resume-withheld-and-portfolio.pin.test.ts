import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ROAD_FALLBACK_DATED, roadContext, roadPersona } from "./__fixtures__/general-road";
import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";
import { maskInitials } from "./mask-initials";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * FILL-GAP PHASE 4 — the three rulings that are about what the sheet must NOT show.
 *
 * Each was a decision made earlier in the programme (ADR-0042 D9 and its neighbours); this file
 * is the pin that keeps each one true without a human remembering it.
 */

beforeAll(async () => {
  await primeSheetQr();
});

describe("portfolio stays UNPRINTED (ruling held)", () => {
  it("no resume module names portfolio anywhere", () => {
    // A SOURCE SCAN, deliberately: the ruling is "there is no portfolio slot", and the moment one
    // is added this fails and forces the conversation rather than a quiet section appearing on a
    // worker's sheet. In particular a bucket URL is not stable content and is not one of the
    // three licensed sources.
    const dir = join(__dirname);
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const offenders = files.filter((name) =>
      /portfolio/i.test(readFileSync(join(dir, name), "utf8")),
    );
    expect(
      offenders,
      "a resume module now references portfolio — the print ruling must be revisited on purpose",
    ).toEqual([]);
  });

  it("a portfolio payload in hand never reaches the render input", () => {
    // Injected where a future leak would most plausibly start: alongside the draft the mapper
    // reads. It must be dropped wholesale — no slot, no composed line, no passthrough.
    const shape = SHEET_SHAPES[0]!;
    const snapshot = {
      ...structuredClone(shape.snapshot),
      portfolio: "PORTFOLIO-SENTINEL-DO-NOT-PRINT",
    };

    const input = buildResumeRenderInput(
      snapshot as never,
      shape.displayName,
      "bb_trade",
      null,
      false,
      "worker",
      withSheetQr(shape.tradeSheet),
    );

    expect(JSON.stringify(input)).not.toContain("PORTFOLIO-SENTINEL");
  });
});

describe("withheld vs missing stays INDISTINGUISHABLE on the employer copy", () => {
  const shape = SHEET_SHAPES.find(
    (candidate) =>
      (candidate.snapshot.resume_profile as Record<string, unknown> | undefined)
        ?.expected_salary === 32000,
  )!;

  const build = (snapshot: unknown, audience: "worker" | "employer") =>
    buildResumeRenderInput(
      snapshot as never,
      shape.displayName,
      "bb_trade",
      null,
      false,
      audience,
      withSheetQr(shape.tradeSheet),
    );

  it("a withheld salary produces the same employer artifact as no salary at all", () => {
    // TWO EMPLOYER BUILDS, one whose draft carries an asking price and one whose draft has none.
    // The employer render must be BYTE-IDENTICAL: a payer able to tell "hidden" from "never
    // given" has an oracle for what the worker withheld, which is the disclosure itself.
    const withSalary = structuredClone(shape.snapshot);
    const withoutSalary = structuredClone(shape.snapshot);
    delete (withoutSalary.resume_profile as Record<string, unknown>).expected_salary;

    const withheld = build(withSalary, "employer");
    const neverGiven = build(withoutSalary, "employer");

    expect(JSON.stringify(withheld)).toBe(JSON.stringify(neverGiven));
    expect(withheld.expectedSalary).toBeNull();
  });

  it("...and the difference IS visible on the worker's own copy — the gate bites", () => {
    // The failure mode this pair exists to catch: a gate that is accidentally always-off would
    // pass the test above while leaking everywhere. On the worker's copy the figure prints.
    const withSalary = structuredClone(shape.snapshot);
    const worker = build(withSalary, "worker");
    expect(worker.expectedSalary).not.toBeNull();
  });
});

/**
 * ADR-0045 PHASE 5 — THE SAME PIN ON THE GENERAL ROAD, which the pair above cannot see.
 *
 * They build as `bb_trade` from a container's `expected_salary`; the road renders `bb_general`
 * from a pack-less profile whose band lives in the general form's attributes
 * (`salary_expected_min` / `_max`) — a source the pair above never touches. So the road gets its
 * own pair, and one more: its brief is the worker's own words on the payer copy, so a line that
 * talks money must not become the salary row in prose, and a payer must not be able to tell a
 * line the render refused from one the worker declined to write.
 */
describe("withheld vs missing stays INDISTINGUISHABLE on the general road's employer copy", () => {
  const persona = roadPersona("road-answered");
  const BAND = { salary_expected_min: 18000, salary_expected_max: 22000 } as const;
  const NO_BAND: Record<string, unknown> = { ...persona.attributes };
  delete NO_BAND.salary_expected_min;
  delete NO_BAND.salary_expected_max;

  const build = (
    attributes: Record<string, unknown>,
    audience: "worker" | "employer",
    generalRoad?: { ownBriefUsable: boolean },
  ) =>
    buildResumeRenderInput(
      persona.snapshot,
      audience === "employer" ? maskInitials(persona.displayName) : persona.displayName,
      "bb_general",
      null,
      false,
      audience,
      withSheetQr(
        roadContext(persona, {
          attributes: { ...attributes, profile_brief: persona.storedBrief },
          ...(generalRoad ? { generalRoad } : {}),
        }),
      ),
    );

  it("a withheld band produces the same employer artifact as no band at all — every shape of it", () => {
    const neverGiven = JSON.stringify(build(NO_BAND, "employer"));
    for (const band of [BAND, { salary_expected_min: 18000 }, { salary_expected_max: 22000 }]) {
      const withheld = build({ ...NO_BAND, ...band }, "employer");
      expect(JSON.stringify(withheld), JSON.stringify(band)).toBe(neverGiven);
      expect(withheld.expectedSalary).toBeNull();
    }
  });

  it("...and the difference IS visible on the worker's own copy — the gate bites", () => {
    const worker = build({ ...NO_BAND, ...BAND }, "worker");
    expect(worker.expectedSalary).toBe(18000);
    expect(worker.availFactRows?.find((r) => r.label === "Salary expected")?.value).toBe(
      "₹18,000 – ₹22,000 / month",
    );
    expect(JSON.stringify(build(NO_BAND, "worker"))).not.toBe(
      JSON.stringify(build({ ...NO_BAND, ...BAND }, "worker")),
    );
  });

  it("a stored brief that talks money prints the fixed line — no employer field carries a figure", () => {
    const money = { status: "answered", text: "Wiring karta hoon, 15000 rupaye chahiye" };
    // Whether the caller caught it (`false`) or passed it through unvetted (`true`), the mapper's
    // own re-check holds: the payer reads the fixed line, never the figure.
    for (const ownBriefUsable of [false, true]) {
      const input = buildResumeRenderInput(
        persona.snapshot,
        maskInitials(persona.displayName),
        "bb_general",
        null,
        false,
        "employer",
        withSheetQr(
          roadContext(persona, {
            attributes: { ...persona.attributes, profile_brief: money },
            generalRoad: { ownBriefUsable },
          }),
        ),
      );
      expect(input.profileBrief).toBe(ROAD_FALLBACK_DATED);
      expect(JSON.stringify(input)).not.toMatch(/15,?000|18,?000|22,?000|rupaye|₹/);
    }
  });

  it("a payer cannot tell a refused own line from a declined one", () => {
    const refused = build(persona.attributes, "employer", { ownBriefUsable: false });
    const declinedInput = buildResumeRenderInput(
      persona.snapshot,
      maskInitials(persona.displayName),
      "bb_general",
      null,
      false,
      "employer",
      withSheetQr(
        roadContext(persona, {
          attributes: { ...persona.attributes, profile_brief: { status: "declined" } },
        }),
      ),
    );
    expect(JSON.stringify(refused)).toBe(JSON.stringify(declinedInput));
  });
});
