import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";
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
