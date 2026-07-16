import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";

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
  education: [],
  certifications: [],
  responsibilities: ["Operate VMC to drawing", "First-piece inspection"],
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
