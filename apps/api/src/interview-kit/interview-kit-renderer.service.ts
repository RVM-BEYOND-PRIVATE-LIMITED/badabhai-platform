import { Injectable } from "@nestjs/common";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import type { InterviewKitContent } from "./interview-kit-content";

/**
 * Builds the per-trade interview-kit HTML and renders it to a PDF via the shared
 * {@link PdfRenderer} (ADR-0007, render in Node). The kit content is STATIC and
 * reviewed, but it is still output-encoded here — defence in depth, and so the
 * renderer can never be a markup-injection vector if content is sourced elsewhere
 * later. No PII (kits are per-trade).
 */
@Injectable()
export class InterviewKitRenderer {
  constructor(private readonly pdf: PdfRenderer) {}

  /** Render the kit PDF, or null when degraded (kill-switch off / binary missing). */
  async renderPdf(kit: InterviewKitContent, contentVersion: number): Promise<Buffer | null> {
    return this.pdf.renderHtmlToPdf(this.buildHtml(kit, contentVersion), "interview-kit");
  }

  /** Build the kit HTML. Every dynamic value is HTML-escaped. */
  buildHtml(kit: InterviewKitContent, contentVersion: number): string {
    const e = PdfRenderer.escapeHtml;
    const list = (items: readonly string[]): string =>
      `<ul>${items.map((i) => `<li>${e(i)}</li>`).join("")}</ul>`;
    const section = (title: string, body: string): string =>
      `<section><h2>${e(title)}</h2>${body}</section>`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${e(kit.display_name)} — Interview Kit</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: "Segoe UI", Arial, sans-serif; color: #1a1a1a; margin: 0; line-height: 1.5; }
      .page { max-width: 800px; margin: 0 auto; padding: 40px 48px; }
      header { border-bottom: 3px solid #0b5; padding-bottom: 12px; margin-bottom: 18px; }
      h1 { font-size: 26px; margin: 0; }
      .sub { color: #0b5; font-weight: 700; margin-top: 4px; }
      .meta { color: #777; font-size: 12px; margin-top: 6px; }
      section { margin-bottom: 16px; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #444;
           border-bottom: 1px solid #ddd; padding-bottom: 4px; margin: 0 0 8px; }
      ul { margin: 0; padding-left: 20px; }
      li { margin-bottom: 3px; }
      .note { background: #f2f9f4; border-left: 4px solid #0b5; padding: 10px 14px; font-size: 14px; }
      .foot { color: #999; font-size: 11px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 8px; }
      @page { size: A4; margin: 14mm; }
    </style>
  </head>
  <body>
    <main class="page">
      <header>
        <h1>${e(kit.display_name)} — Interview Kit</h1>
        <div class="sub">BadaBhai · Interview Preparation</div>
        <div class="meta">Trade: ${e(kit.trade_key)} · Version ${e(String(contentVersion))}</div>
      </header>

      ${section("Trade overview", `<p>${e(kit.overview)}</p>`)}
      ${section("Common interview questions", list(kit.common_questions))}
      ${section("Practical machine / process questions", list(kit.practical_questions))}
      ${section("Safety questions", list(kit.safety_questions))}
      ${section("Drawing & measurement questions", list(kit.drawing_measurement_questions))}
      ${section("Skill checklist", list(kit.skill_checklist))}
      ${section("What to revise before the interview", list(kit.revise_before))}
      ${section("Documents to carry", list(kit.documents_to_carry))}
      ${section("Common mistakes to avoid", list(kit.common_mistakes))}
      ${section("Tip (Hindi / Hinglish)", `<div class="note">${e(kit.hinglish_note)}</div>`)}

      <div class="foot">
        This is a generic preparation kit for the ${e(kit.display_name)} trade. It contains
        no personal information. Prepared by BadaBhai. Template-filled — no AI-written claims.
      </div>
    </main>
  </body>
</html>`;
  }
}
