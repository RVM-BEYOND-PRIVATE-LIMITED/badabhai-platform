import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";

import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { buildResumeRenderInput } from "./resume-render-input";
import { ResumeRenderer } from "./resume-renderer.service";

/**
 * `buildResumeHtml` never touches the PDF subprocess — it composes the slot engine's output and
 * returns a string. The renderer still takes a `PdfRenderer`, so one is constructed and never
 * used; nothing here can spawn WeasyPrint.
 */
const RENDERER = new ResumeRenderer(
  new PdfRenderer({ RESUME_RENDER_ENABLED: true } as ServerConfig),
);

/**
 * WHAT THE SHEET SAYS ABOUT AN ASKING PRICE — verified on the RENDERED PAGE (R12 §1.4).
 *
 * WHY THIS IS ITS OWN FILE AND NOT A LINE IN THE MAPPER TESTS. R10 R-1 ruled "until the band
 * ships, print nothing rather than the wrong number", and the mapper appears to honour it by
 * handing `salary: null` to `buildVerdictLine`. That is where every previous check stopped — and
 * reading `facts.salary ? … : null` is reading the INTENT. §6.2's rule is about the page: a
 * missing segment must take its separator with it, never leave a dangling middot or the bare word
 * "expects" with nothing after it. Between the mapper and the page sit `joinSegments`, the slot
 * engine, the degradation ladder and the template's own literals, and any one of them could put a
 * separator back.
 *
 * WHAT ASKING THE QUESTION PROPERLY TURNED UP. The absent case was fine on both branches. The
 * PRESENT case was not: the legacy path passed a literal `null` for the Verdict Line's salary
 * while handing the same figure to its Zone 3 row, so `expects ₹24,000` never rendered for any
 * worker on the branch the mapper itself calls "the path most existing profiles still take".
 * Proving a segment collapses when empty is only half a test; the other half is that it appears
 * when full, and that is the half that was failing.
 *
 * `EMIT_SALARY_ABSENT=<dir>` writes the four pages out, because "render it and look" was the
 * instruction and a human has to be able to.
 */

/**
 * BOTH BRANCHES, because `buildResumeRenderInput` has two and they were not in agreement.
 * `resumeProfileCarriesValues(draft.resume_profile)` picks the container path; everything else
 * takes the legacy answer-map path. A check that exercised one of them would have proved nothing
 * about the other — and the legacy one is where the defect was.
 */
const LEGACY = {
  role_label: "CNC Turner",
  experience_years: 6,
  location_preference: { current_city: "Faridabad", preferred_cities: ["Faridabad", "Gurugram"] },
  availability: { status: "immediate" },
  skills: ["CNC lathe operation"],
  experiences: [],
};

const CONTAINER_PROFILE = {
  role_label: "CNC Turner",
  skills: ["CNC lathe operation"],
  current_city: "Faridabad",
  availability: "immediate",
  experiences: [],
  preferred_locations: ["Faridabad"],
};

type Branch = "legacy" | "container";
const BRANCHES: Branch[] = ["legacy", "container"];

function snapshotFor(branch: Branch, salary: number | null) {
  const base = { ...LEGACY, salary_expectation: { amount_min: salary, amount_max: null } };
  return branch === "legacy"
    ? base
    : { ...base, resume_profile: { ...CONTAINER_PROFILE, expected_salary: salary } };
}

function render(branch: Branch, salary: number | null, audience: "worker" | "employer" = "worker") {
  const input = buildResumeRenderInput(
    snapshotFor(branch, salary),
    "Ramesh Kumar",
    "bb_trade",
    null,
    false,
    audience,
    {
      packId: "qp_cnc_turning",
      attributes: { turning_machine: ["cnc_lathe"], controller_brand: ["fanuc"] },
    },
  );
  return { input, html: RENDERER.buildResumeHtml(input) };
}

describe.each(BRANCHES)("R12 §1.4 — the salary segment [%s branch]", (branch) => {
  it("drops the segment AND its separator when there is no figure", () => {
    const { input } = render(branch, null);
    expect(input.subheadLine).not.toMatch(/expects/i);
    // The rule §6.2 actually states. A dangling separator is the failure mode, not the word.
    expect(input.subheadLine).not.toMatch(/·\s*$/);
    expect(input.subheadLine).not.toMatch(/^\s*·/);
    expect(input.subheadLine).not.toMatch(/·\s*·/);
    // …and the segments that DO exist are still there, so this is not passing by rendering
    // nothing at all — the vacuous way to satisfy every assertion above.
    expect(input.subheadLine).toContain("Faridabad");
  });

  it("PRINTS the figure in the Verdict Line when there is one", () => {
    // THE ASSERTION THAT FOUND THE DEFECT, and the reason a collapse test is only half a test.
    const { input } = render(branch, 24000);
    expect(input.subheadLine).toMatch(/expects/i);
    expect(input.subheadLine).toContain("24,000");
  });

  it("moves the Zone 3 row with it, in both directions", () => {
    // Two independent surfaces print the same fact, and a fix applied to only one of them is
    // exactly what shipped here. Asserted together so they cannot drift apart again.
    expect((render(branch, null).input.availFactRows ?? []).map((r) => r.label)).not.toContain(
      "Salary expected",
    );
    expect((render(branch, 24000).input.availFactRows ?? []).map((r) => r.label)).toContain(
      "Salary expected",
    );
  });

  it("suppresses the figure entirely on the EMPLOYER copy, both surfaces", () => {
    // The audience gate the Verdict Line fix rides on. `legacySalary` and `salaryText` are
    // already `null` for a payer, which is why the fix reads those variables and never
    // `draft.salary_expectation` directly — but "already gated" is a claim, so assert it.
    const { input } = render(branch, 24000, "employer");
    expect(input.subheadLine ?? "").not.toMatch(/expects/i);
    expect((input.availFactRows ?? []).map((r) => r.label)).not.toContain("Salary expected");
  });

  it("THE ARTIFACT: the rendered HTML agrees with the mapper, in both states", () => {
    // The assertion the others are proxies for. Everything above reads the mapper's output;
    // this reads the page a worker is handed.
    const { html } = render(branch, null);
    expect(html).not.toMatch(/expects/i);
    expect(html).not.toMatch(/Salary expected/i);
    expect(html).not.toMatch(/₹/);

    const withSalary = render(branch, 24000).html;
    expect(withSalary).toMatch(/expects/i);
    expect(withSalary).toMatch(/Salary expected/i);
    expect(withSalary).toMatch(/₹/);

    const outDir = process.env.EMIT_SALARY_ABSENT;
    if (outDir) {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `salary-absent-${branch}.html`), html, "utf8");
      writeFileSync(join(outDir, `salary-present-${branch}.html`), withSalary, "utf8");
    }
  });

  it("leaves no dangling separator in the raw HTML, where a template literal would show", () => {
    // The mapper can be perfectly correct and the TEMPLATE still print "· expects" as a literal
    // around an empty slot. Checked on the rendered bytes, with tags stripped so an attribute
    // value cannot mask a visible dot.
    const text = render(branch, null)
      .html.replace(/<[^>]*>/g, " ")
      .replace(/&middot;|&#183;/g, "·");
    expect(text).not.toMatch(/·\s*·/);
    expect(text).not.toMatch(/·\s*(?:<|$)/);
  });
});
