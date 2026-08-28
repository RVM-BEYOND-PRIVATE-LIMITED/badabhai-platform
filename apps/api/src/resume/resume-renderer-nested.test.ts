/**
 * NESTED OBJECT REGIONS in the resume slot engine.
 *
 * The engine grew object regions for `experiences[]` (one level: role / duration / work). The
 * locked BadaBhai trade sheet needs TWO — an employment carrying its own role stints — because a
 * worker promoted inside one company must read as a promotion rather than as two unrelated jobs.
 *
 * The subtle case, and the reason these tests exist rather than a single happy-path one: an
 * employment and a role stint BOTH carry `when`. If scalar substitution ran before the nested
 * region, the employment's dates would be stamped into every role line before the roles region
 * ever saw the block, and both stints would show the company's tenure. That failure renders
 * perfectly and is wrong, which is the kind this file has to catch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";

/** The renderer only needs `PdfRenderer` for `renderPdf`; `buildResumeHtml` is pure. */
const renderer = new ResumeRenderer(null as unknown as PdfRenderer);

/** Minimal valid input; each test overrides only what it asserts on. */
function input(over: Partial<ResumeRenderInput> = {}): ResumeRenderInput {
  return {
    templateId: "bb_trade",
    displayName: "Ramesh Kumar Yadav",
    canonicalRole: null,
    location: null,
    experienceYears: null,
    availability: null,
    summary: null,
    skills: [],
    machines: [],
    controllers: [],
    educationLevel: null,
    educationField: null,
    education: [],
    certifications: [],
    responsibilities: [],
    trade: null,
    experiences: [],
    preferredLocations: [],
    expectedSalary: null,
    ...over,
  } as ResumeRenderInput;
}

describe("resume slot engine — nested object regions", () => {
  it("renders a role stint's OWN dates, not the employment's (the `when` collision)", () => {
    const html = renderer.buildResumeHtml(
      input({
        employments: [
          {
            employer: "Sandhar Technologies Ltd",
            location_suffix: " · Gurugram, Haryana",
            when: "Jan 2023 – Present · 3 yrs 6 mo",
            work: "VMC 3 & 4-axis, Fanuc",
            roles: [
              { role: "VMC Setter-cum-Operator", when: "Jul 2024 – Present · 2 yrs" },
              { role: "VMC Operator", when: "Jan 2023 – Jun 2024 · 1 yr 6 mo" },
            ],
          },
        ],
      } as Partial<ResumeRenderInput>),
    );

    expect(html).toContain("Jul 2024 – Present · 2 yrs");
    expect(html).toContain("Jan 2023 – Jun 2024 · 1 yr 6 mo");
    // The employment's own tenure appears EXACTLY ONCE. Twice would mean it leaked into a role.
    const employmentWhen = html.split("Jan 2023 – Present · 3 yrs 6 mo").length - 1;
    expect(employmentWhen).toBe(1);
  });

  it("repeats the employment block once per employer, in order", () => {
    const html = renderer.buildResumeHtml(
      input({
        employments: [
          { employer: "Sandhar Technologies Ltd", when: "A", roles: [], work: "" },
          { employer: "Amtek Auto Components Ltd", when: "B", roles: [], work: "" },
          { employer: "Nirmal Engineering Works", when: "C", roles: [], work: "" },
        ],
      } as Partial<ResumeRenderInput>),
    );
    expect(html.indexOf("Sandhar")).toBeLessThan(html.indexOf("Amtek"));
    expect(html.indexOf("Amtek")).toBeLessThan(html.indexOf("Nirmal"));
  });

  it("an employment with no role stints renders without leaving a stray region tag", () => {
    const html = renderer.buildResumeHtml(
      input({
        employments: [{ employer: "Nirmal Engineering Works", when: "X", work: "", roles: [] }],
      } as Partial<ResumeRenderInput>),
    );
    expect(html).toContain("Nirmal Engineering Works");
    expect(html).not.toMatch(/\{\{[#/]?roles\}\}/);
  });

  it("escapes every nested value — employer names are worker-typed and untrusted", () => {
    const html = renderer.buildResumeHtml(
      input({
        employments: [
          {
            employer: "<script>alert(1)</script>",
            when: "",
            work: "",
            roles: [{ role: '"><img src=x onerror=y>', when: "" }],
          },
        ],
      } as Partial<ResumeRenderInput>),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("a string list nested inside a row region still renders as list items", () => {
    const html = renderer.buildResumeHtml(
      input({
        capChipRows: [{ label: "Controllers", values: ["Fanuc", "Siemens", "Mitsubishi"] }],
      } as Partial<ResumeRenderInput>),
    );
    expect(html).toContain("<li>Fanuc</li>");
    expect(html).toContain("<li>Siemens</li>");
    expect(html).toContain("Controllers");
  });

  it("NO unresolved mustache survives anywhere in the rendered page", () => {
    // The property that matters most: an unbound token or a dangling region tag would print
    // literal braces onto a sheet a worker hands to an employer.
    const html = renderer.buildResumeHtml(
      input({
        employments: [{ employer: "X", when: "Y", work: "Z", roles: [{ role: "R", when: "W" }] }],
        capChipRows: [{ label: "Machines", values: ["CNC lathe"] }],
      } as Partial<ResumeRenderInput>),
    );
    expect(html).not.toMatch(/\{\{/);
    expect(html).not.toMatch(/\}\}/);
  });

  it("the single-level engine still behaves — experiences[] is unchanged", () => {
    const html = renderer.buildResumeHtml(
      input({
        templateId: "classic",
        experiences: [{ role: "VMC Operator", duration: "3.5 saal", work: "EN8, EN31" }],
      }),
    );
    expect(html).toContain("VMC Operator");
    expect(html).toContain("3.5 saal");
    expect(html).not.toMatch(/\{\{/);
  });
});

describe("the region matcher is a literal, not a composed pattern", () => {
  /**
   * A STRUCTURAL GUARD, and it is labelled that way because it cannot be a behavioural one.
   *
   * Every region used to be matched by `new RegExp("{{#" + name + "}}…")`. Semgrep's
   * `detect-non-literal-regexp` calls that ReDoS; the sharper problem is that a slot name
   * carrying regex metacharacters stops being a name and becomes a pattern — `a.*b` compiles to
   * a wildcard, matches a region it does not own, and splices one worker's list into another
   * section of the sheet. That renders perfectly and is wrong.
   *
   * WHY NOT ASSERT THE BEHAVIOUR INSTEAD. There is no seam to inject a slot name through:
   * `fillSlots`, `fillObjectRegion` and `fillStringRegion` are all `private static`, the list
   * names are a fixed object literal inside the service, and `buildResumeHtml` chooses its
   * skeleton from the registry. Nothing a caller controls reaches the composition site, so a
   * test that "proves" the fix through the public API would be asserting on a path that cannot
   * be exercised — which is precisely the shape of check this repo keeps getting caught by.
   * The honest version is to assert the construct is absent from the file.
   *
   * The behavioural half is carried by the rest of this file and by the 14-shape matrix: they
   * are what proves the literal still matches everything the composed regexes used to.
   */
  const source = readFileSync(join(__dirname, "resume-renderer.service.ts"), "utf8");
  /**
   * COMMENTS STRIPPED FIRST. The claim is about the CODE, and the doc comment on `REGION_RE`
   * quotes the very construct it replaced in order to explain why it is gone. Asserting over
   * the raw file would make that explanation fail the test that depends on it.
   */
  const code = source.replace(/\/\*[^]*?\*\//g, " ").replace(/\/\/.*/g, " ");

  it("never composes a regex at all", () => {
    expect(code).not.toContain("new RegExp");
  });

  it("requires the closing tag to repeat the opening name", () => {
    // `\1` is why `{{#a}}…{{/b}}` is not a region. Pinned because dropping the backreference
    // leaves a regex that still passes every happy-path test in this file.
    expect(code).toContain(String.raw`/{{#([a-z_]+)}}([\s\S]*?){{\/\1}}/g`);
  });
});
