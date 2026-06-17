import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { InterviewKitRenderer } from "./interview-kit-renderer.service";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { getInterviewKit } from "./interview-kit-content";

/**
 * Proves the RVM-ratified + CEO-approved interview-kit content (PR #65 record gate)
 * actually RENDERS through the live kit render path, per trade — complementing the
 * presence/shape check in `interview-kit-content.test.ts`. For each approved trade it
 * pulls the LIVE `getInterviewKit(...)` and asserts the approved copy reaches the
 * rendered HTML. Deterministic — `buildHtml` is synchronous (no WeasyPrint).
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

const renderer = new InterviewKitRenderer(
  new PdfRenderer({ RESUME_RENDER_ENABLED: true } as ServerConfig),
);
const esc = (s: string): string => PdfRenderer.escapeHtml(s);
const VERSION = 1;

describe("approved interview-kit content renders per trade (RVM + CEO, #65)", () => {
  for (const key of APPROVED_TRADE_KEYS) {
    it(`renders the approved '${key}' kit`, () => {
      const kit = getInterviewKit(key);
      expect(kit, `approved interview kit missing for ${key}`).toBeDefined();

      const html = renderer.buildHtml(kit!, VERSION);

      // title + trade slug render
      expect(html).toContain(`${esc(kit!.display_name)} — Interview Kit`);
      expect(html).toContain(`Trade: ${esc(kit!.trade_key)}`);
      // approved overview + first item of each question/checklist list render
      expect(html).toContain(esc(kit!.overview));
      expect(html).toContain(`<li>${esc(kit!.common_questions[0]!)}</li>`);
      expect(html).toContain(`<li>${esc(kit!.safety_questions[0]!)}</li>`);
      expect(html).toContain(`<li>${esc(kit!.skill_checklist[0]!)}</li>`);
      // the Hinglish tip (a hallmark of the approved kits) renders
      expect(html).toContain(esc(kit!.hinglish_note));
    });
  }

  it("post-RVM decision: AutoCAD kit headline is 'AutoCAD Draftsman' (American, approved as-is)", () => {
    const kit = getInterviewKit("autocad_draftsman")!;
    expect(kit.display_name).toBe("AutoCAD Draftsman");
    expect(renderer.buildHtml(kit, VERSION)).toContain("AutoCAD Draftsman — Interview Kit");
  });

  it("post-RVM decision: programmer kits reference CAM tools GENERICALLY (no single locked vendor)", () => {
    for (const key of ["cnc_programmer", "vmc_programmer"] as const) {
      const kit = getInterviewKit(key)!;
      const blob = JSON.stringify([
        ...kit.common_questions,
        ...kit.practical_questions,
        ...kit.skill_checklist,
      ]).toLowerCase();
      expect(blob, `${key} kit should name CAM tools generically`).toContain("cam software");
    }
  });
});
