import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { RESUME_TEMPLATES } from "./templates/registry";

// Mock the subprocess module so the real WeasyPrint binary is NEVER spawned and
// we can assert on calls. vi.mock is hoisted; the factory must not close over
// out-of-scope vars, so we read the mock back via the imported reference below.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function makeRenderer(over: Partial<ServerConfig> = {}): ResumeRenderer {
  const config = { RESUME_RENDER_ENABLED: true, ...over } as ServerConfig;
  return new ResumeRenderer(new PdfRenderer(config));
}

const BASE_INPUT: ResumeRenderInput = {
  templateId: "classic",
  displayName: "Asha Kumari",
  canonicalRole: "VMC Operator",
  location: "Pune",
  experienceYears: 5,
  availability: "Available immediately",
  summary: "5 years on Fanuc controls",
  skills: ["fanuc", "vmc"],
  machines: ["VMC"],
  controllers: [],
  educationLevel: null,
  educationField: null,
  education: [],
  certifications: [],
  responsibilities: ["Operate VMC to drawing", "First-piece inspection"],
  trade: null,
  experiences: [],
  preferredLocations: [],
  expectedSalary: null,
};

describe("ResumeRenderer.buildResumeHtml — template binding + output encoding (TD5 security)", () => {
  it("binds the chosen template's slots (name, role, list items)", () => {
    const html = makeRenderer().buildResumeHtml({
      ...BASE_INPUT,
      machines: ["VMC", "Lathe"],
    });
    expect(html.toLowerCase()).toContain("<!doctype html>"); // real skeleton, not hand-rolled
    expect(html).toContain("Asha Kumari");
    expect(html).toContain("VMC Operator");
    expect(html).toContain("<li>VMC</li>");
    expect(html).toContain("<li>Lathe</li>");
  });

  it("binds the trade responsibilities region (TD24a)", () => {
    const html = makeRenderer().buildResumeHtml({
      ...BASE_INPUT,
      responsibilities: ["Set up and operate VMC machines", "Prove out the first piece"],
    });
    expect(html).toContain("<li>Set up and operate VMC machines</li>");
    expect(html).toContain("<li>Prove out the first piece</li>");
  });

  it("ADR-0032: embeds the photo data URI in the {{#photo}} region when supplied", () => {
    const dataUri = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";
    const html = makeRenderer().buildResumeHtml({
      ...BASE_INPUT,
      photoDataUri: dataUri,
    });
    // the data URI survives output-encoding intact (base64 has no escapable chars)
    expect(html).toContain(`src="${dataUri}"`);
    expect(html).not.toContain("{{#photo}}"); // region consumed, no token leak
  });

  it("ADR-0032: renders photo-LESS when photoDataUri is null/absent — the region collapses to nothing", () => {
    for (const input of [{ ...BASE_INPUT, photoDataUri: null }, { ...BASE_INPUT }]) {
      const html = makeRenderer().buildResumeHtml(input);
      expect(html).not.toContain("<img"); // no photo element at all
      expect(html).not.toContain("{{#photo}}"); // and no unresolved token
      expect(html).not.toContain("data:image");
    }
  });

  it("HTML-escapes a hostile displayName so no raw <script> reaches the PDF", () => {
    const html = makeRenderer().buildResumeHtml({
      ...BASE_INPUT,
      displayName: `<script>alert(1)</script>"&'`,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
  });

  it("escapes user-controlled list/text values too (skills, machines, summary)", () => {
    const html = makeRenderer().buildResumeHtml({
      ...BASE_INPUT,
      displayName: null,
      skills: ["<b>vmc</b>"],
      machines: ["<i>cnc</i>"],
      summary: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<b>vmc</b>");
    expect(html).not.toContain("<i>cnc</i>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;b&gt;vmc&lt;/b&gt;");
  });

  it("renders name-less (empty name slot) when displayName is null", () => {
    const html = makeRenderer().buildResumeHtml({ ...BASE_INPUT, displayName: null });
    expect(html).not.toContain("Asha");
    expect(html).toContain("<h1></h1>"); // {{full_name}} collapses to empty
  });

  it("collapses empty list regions and leaves NO unresolved {{...}} tokens", () => {
    const html = makeRenderer().buildResumeHtml({
      ...BASE_INPUT,
      skills: [], // empty region must disappear
    });
    expect(html).not.toContain("{{"); // every slot/region resolved
    expect(html).not.toContain("}}");
  });

  it("resolves an unknown/empty templateId to the generic fallback (never throws)", () => {
    const renderer = makeRenderer();
    expect(() => renderer.buildResumeHtml({ ...BASE_INPUT, templateId: "does-not-exist" })).not.toThrow();
    const html = renderer.buildResumeHtml({ ...BASE_INPUT, templateId: null });
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("Asha Kumari");
    expect(html).not.toContain("{{");
  });
});

describe("ResumeRenderer.renderPdf — kill-switch", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("returns null and spawns NO subprocess when RESUME_RENDER_ENABLED=false", async () => {
    const renderer = makeRenderer({ RESUME_RENDER_ENABLED: false });
    const out = await renderer.renderPdf(BASE_INPUT);
    expect(out).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

/**
 * OBJECT REGIONS — `{{#experiences}}…{{role}}…{{duration}}…{{work}}…{{/experiences}}`.
 *
 * The slot engine only had STRING regions (`{{.}}`) until v3, which is the structural reason
 * `experiences[]` could not be rendered at all: a job entry is three printable fields, and
 * flattening it to one string in the mapper would have hard-coded the layout there.
 */
describe("ResumeRenderer.fillSlots — object regions (work history)", () => {
  const ENTRIES = [
    { role: "VMC Operator", duration: "3.5 saal", work: "Read drawings, machine setup" },
    { role: "Helper", duration: "1 saal", work: "Loading, deburring" },
  ];
  const bind = (skeleton: string, over: Partial<ResumeRenderInput> = {}): string => {
    const renderer = makeRenderer();
    (renderer as unknown as { loadTemplate: (f: string) => string }).loadTemplate = () => skeleton;
    return renderer.buildResumeHtml({ ...BASE_INPUT, ...over });
  };

  it("repeats the block once per job, resolving each token from THAT entry", () => {
    const html = bind("<x>{{#experiences}}<li>{{role}}|{{duration}}|{{work}}</li>{{/experiences}}</x>", {
      experiences: ENTRIES,
    });
    expect(html).toContain("<li>VMC Operator|3.5 saal|Read drawings, machine setup</li>");
    expect(html).toContain("<li>Helper|1 saal|Loading, deburring</li>");
  });

  it("collapses to nothing when there is no work history", () => {
    // Every pre-v3 profile and every deterministic-only extraction is in this state, so an
    // empty region must vanish rather than leave an empty bullet behind.
    const html = bind("<x>{{#experiences}}<li>{{role}}</li>{{/experiences}}</x>", { experiences: [] });
    expect(html).toBe("<x></x>");
  });

  it("does NOT leak an outer scalar into an inner token", () => {
    // The per-item lookup is total: an inner `{{location}}` resolves to "" rather than picking up
    // the worker's city from the outer scope, which would print the same wrong value under every
    // job and look authoritative doing it.
    const html = bind("<x>{{#experiences}}[{{location}}]{{/experiences}}</x>", {
      experiences: [ENTRIES[0]!],
      location: "Pune",
    });
    expect(html).toBe("<x>[]</x>");
  });

  it("escapes every field — the model wrote these and they are untrusted (§11)", () => {
    const html = bind("<x>{{#experiences}}{{work}}{{/experiences}}</x>", {
      experiences: [{ role: "R", duration: "d", work: "<script>alert(1)</script>" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the salary cleanly when the value is absent", () => {
    // ALWAYS absent on the payer disclosure, so this is the production case, not an edge one.
    expect(bind("<x>{{expected_salary}}</x>", { expectedSalary: null })).toBe("<x></x>");
    expect(bind("<x>{{expected_salary}}</x>", { expectedSalary: 40000 })).toBe("<x>40000</x>");
  });
});

/**
 * EVERY SHIPPED TEMPLATE, RENDERED FOR REAL — the regression guard for v3.
 *
 * The v3 layouts were authored to a slot contract, and the failure modes they can hit are all
 * SILENT: the renderer deletes a region name it does not know, and a heading placed inside a
 * repeat region prints once per item. Both produce a plausible-looking PDF, so only an
 * assertion catches them. Two of the four templates had no render coverage at all before this.
 */
describe("every registered template renders cleanly (v3 contract)", () => {
  const RICH: ResumeRenderInput = {
    ...BASE_INPUT,
    trade: "CNC Machining",
    expectedSalary: 40000,
    preferredLocations: ["Pune", "Nashik"],
    skills: ["VMC operation", "G-code reading", "Machine setup"],
    experiences: [
      { role: "VMC Operator", duration: "3.5 saal", work: "Read drawings, machine setup" },
      { role: "Helper", duration: "1 saal", work: "Loading, deburring" },
    ],
  };

  for (const t of RESUME_TEMPLATES) {
    it(`${t.id} v${t.version}: leaves no unresolved token, with data or without`, () => {
      for (const input of [{ ...RICH, templateId: t.id }, { ...BASE_INPUT, templateId: t.id }]) {
        const html = makeRenderer().buildResumeHtml(input);
        // An unknown region name is DELETED silently; an unresolved scalar leaks braces. Either
        // way the worker gets a broken PDF and nothing else would tell us.
        expect(html).not.toContain("{{");
        expect(html).not.toContain("}}");
      }
    });

    it(`${t.id} v${t.version}: prints each section heading exactly once`, () => {
      // THE DEFECT THIS CATCHES: a heading inside `{{#skills}}` repeats per item — three skills
      // printed "Skills" three times. The correct idiom puts the heading on the container's
      // ::before, where `:empty` can take it away with the section.
      const html = makeRenderer().buildResumeHtml({ ...RICH, templateId: t.id });
      const headings = html.match(/<h[1-6][^>]*>[^<]+<\/h[1-6]>/g) ?? [];
      const seen = headings.map((h) => h.replace(/<[^>]+>/g, "").trim().toLowerCase());
      expect(new Set(seen).size).toBe(seen.length);
    });

    it(`${t.id} v${t.version}: renders both jobs of the work history`, () => {
      const html = makeRenderer().buildResumeHtml({ ...RICH, templateId: t.id });
      expect(html).toContain("VMC Operator");
      expect(html).toContain("3.5 saal");
      expect(html).toContain("Helper");
      expect(html).toContain("Loading, deburring");
    });

    it(`${t.id} v${t.version}: shows no salary and no stray currency mark when it is absent`, () => {
      // The payer-facing disclosure ALWAYS passes expectedSalary null, so this is the common
      // production case. A "₹" written into the markup rather than into CSS would survive the
      // empty value and print alone.
      const html = makeRenderer().buildResumeHtml({ ...RICH, templateId: t.id, expectedSalary: null });
      expect(html).not.toContain("40000");
      expect(html).not.toMatch(/₹\s*<\//);
    });
  }
});
