import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { getTradeContent, type TradeContent } from "./trade-content";

/**
 * Proves the RVM-ratified + CEO-approved resume content (PR #65 record gate) actually
 * RENDERS through the live resume render path, per trade — not just that the rows exist
 * (that is `trade-content.test.ts`). For each approved trade it pulls the LIVE
 * `getTradeContent(...)`, binds it exactly as `ResumeRenderProcessor` does
 * (canonicalRole = display_name, responsibilities = trade.responsibilities), and asserts
 * the approved copy reaches the rendered HTML. Deterministic — `buildResumeHtml` is
 * synchronous and needs no WeasyPrint binary.
 */

/** The 9 RVM-ratified + CEO-approved trades (ratification packet §4 / PR #65). */
const APPROVED_TRADE_KEYS = [
  "cnc_vmc_setter",
  "cnc_programmer",
  "vmc_programmer",
  "solidworks_designer",
  "autocad_draftsman",
  "tool_room_technician",
  "machine_operator",
  "assembly_technician",
  "fitter",
] as const;

const renderer = new ResumeRenderer(
  new PdfRenderer({ RESUME_RENDER_ENABLED: true } as ServerConfig),
);
const esc = (s: string): string => PdfRenderer.escapeHtml(s);

/** Bind a trade row into a render input exactly the way the processor does. */
function inputFor(content: TradeContent): ResumeRenderInput {
  return {
    templateId: "classic",
    displayName: "Worker Name",
    canonicalRole: content.display_name, // approved headline
    location: "Pune",
    experienceYears: 5,
    availability: "Available immediately",
    summary: null,
    skills: [...content.core_skills],
    machines: [...content.machine_tools],
    controllers: [],
    education: [],
    certifications: [],
    responsibilities: [...content.responsibilities], // approved trade-level copy
  };
}

describe("approved resume content renders per trade (RVM + CEO, #65)", () => {
  for (const key of APPROVED_TRADE_KEYS) {
    it(`renders the approved '${key}' content`, () => {
      const content = getTradeContent(key);
      expect(content, `approved trade content missing for ${key}`).toBeDefined();

      const html = renderer.buildResumeHtml(inputFor(content!));

      // the approved role title (headline) renders
      expect(html).toContain(esc(content!.display_name));
      // every approved trade responsibility renders as a list item
      for (const r of content!.responsibilities) {
        expect(html).toContain(`<li>${esc(r)}</li>`);
      }
      // no unresolved template tokens leak into the PDF
      expect(html).not.toContain("{{");
    });
  }

  it("post-RVM decision: AutoCAD role headline is 'AutoCAD Draftsman' (American, approved as-is)", () => {
    const content = getTradeContent("autocad_draftsman")!;
    // The decision was on the recruiter-facing ROLE TITLE (display_name). Note the ITI
    // qualification 'Draughtsman (Mechanical)' may still appear in cert phrases — that is
    // the official course name, NOT the role title, so we scope the assertion to display_name.
    expect(content.display_name).toBe("AutoCAD Draftsman");
    expect(renderer.buildResumeHtml(inputFor(content))).toContain("AutoCAD Draftsman");
  });

  it("post-RVM decision: programmer trades reference CAM tools GENERICALLY (no single locked vendor)", () => {
    for (const key of ["cnc_programmer", "vmc_programmer"] as const) {
      const content = getTradeContent(key)!;
      const blob = JSON.stringify([
        ...content.core_skills,
        ...content.responsibilities,
        ...content.keywords,
      ]).toLowerCase();
      expect(blob, `${key} should name CAM tools generically`).toContain("cam software");
    }
  });

  it("post-RVM decision: machine_operator stays machine-agnostic (generic catch-all) and renders", () => {
    const content = getTradeContent("machine_operator")!;
    expect(content.display_name).toBe("Machine Operator");
    const html = renderer.buildResumeHtml(inputFor(content));
    expect(html).toContain("Machine Operator");
    // generic by design — it must still render at least one trade responsibility
    expect(content.responsibilities.length).toBeGreaterThan(0);
    expect(html).toContain(`<li>${esc(content.responsibilities[0]!)}</li>`);
  });
});
