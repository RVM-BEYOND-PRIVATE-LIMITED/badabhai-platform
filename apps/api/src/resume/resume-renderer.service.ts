import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { getResumeTemplate } from "./templates/registry";

/**
 * Structured input for a single resume render. ALL fields are derived from the
 * name-free `sourceProfileSnapshot` EXCEPT `displayName`, which is the worker's
 * real full name (decrypted SERVER-SIDE by the caller). The name is placed onto
 * the PDF only — it must NEVER be logged or echoed into an error here. Fields map
 * 1:1 to the template slot contract (templates/README.md).
 */
export interface ResumeRenderInput {
  /** Which layout (templates/registry.ts). Unknown/empty → the generic fallback. */
  templateId: string | null;
  /** The worker's real full name, or null → render a name-less resume. */
  displayName: string | null;
  /** Role title → `{{headline}}` (e.g. "VMC Operator"). */
  canonicalRole: string | null;
  /** `{{location}}` (e.g. the first preferred city). */
  location: string | null;
  /** `{{experience_years}}`. */
  experienceYears: number | null;
  /** `{{availability}}` (human-readable). */
  availability: string | null;
  /** `{{summary}}` — short professional summary. */
  summary: string | null;
  /** Repeat regions `{{#skills}}` / `{{#machines}}` / `{{#controllers}}` / … */
  skills: string[];
  machines: string[];
  controllers: string[];
  education: string[];
  certifications: string[];
  /**
   * Role-typical responsibilities for the worker's chosen trade (TD24a, from
   * `trade-content.ts`). Trade-LEVEL copy (what a recruiter expects for that role),
   * never a fabricated personal claim. Empty when the trade is unknown.
   */
  responsibilities: string[];
}

/**
 * Renders a resume PDF in NODE via the WeasyPrint CLI as a LOCAL subprocess.
 *
 * SECURITY: rendering MUST happen here in Node, NEVER in the AI service — placing
 * the worker's real name on the PDF here keeps the "name never reaches the AI
 * service" guarantee intact (ADR-0007). Every slot value is output-encoded into the
 * HTML (the name is attacker-controlled, R11/R13) to prevent HTML/template
 * injection, and is NEVER written to a log line or an error string.
 *
 * The HTML comes from the versioned layout skeletons (`templates/`, the layer-1
 * registry); this service is the "later layer" that binds data → slots → HTML/PDF.
 *
 * Degrade-to-null mirrors ai.service: any failure (binary missing, timeout,
 * non-zero exit) returns null = "no PDF this run"; the processor decides what to
 * do with that. This lets local dev (no WeasyPrint installed, e.g. Windows) and a
 * disabled kill-switch both run cleanly.
 */
@Injectable()
export class ResumeRenderer {
  // A shipped template file is immutable (registry contract), so cache by filename.
  private static readonly templateCache = new Map<string, string>();

  constructor(private readonly pdf: PdfRenderer) {}

  /**
   * Resolve the template by id (unknown/empty → fallback, never throws) and bind
   * the data into its slots. Every interpolated value is HTML-escaped — the
   * display name is user-controlled, so output encoding here prevents injecting
   * markup into the rendered PDF.
   */
  buildResumeHtml(input: ResumeRenderInput): string {
    const template = getResumeTemplate(input.templateId);
    const skeleton = this.loadTemplate(template.file);
    return ResumeRenderer.fillSlots(skeleton, input);
  }

  /** Load a template skeleton from disk (cached). Copied into dist by nest-cli assets. */
  private loadTemplate(file: string): string {
    const cached = ResumeRenderer.templateCache.get(file);
    if (cached) return cached;
    const html = readFileSync(join(__dirname, "templates", file), "utf8");
    ResumeRenderer.templateCache.set(file, html);
    return html;
  }

  /**
   * Mustache-ish slot fill (the documented subset): single `{{token}}` and repeat
   * regions `{{#list}}…{{.}}…{{/list}}`. EVERY injected value is output-encoded;
   * the template's own markup is left intact. Unknown tokens / empty lists collapse
   * to nothing, so no `{{…}}` leaks into the PDF.
   */
  private static fillSlots(skeleton: string, input: ResumeRenderInput): string {
    const scalars: Record<string, string> = {
      full_name: input.displayName ?? "",
      headline: input.canonicalRole ?? "",
      location: input.location ?? "",
      experience_years: input.experienceYears != null ? String(input.experienceYears) : "",
      availability: input.availability ?? "",
      summary: input.summary ?? "",
    };
    const lists: Record<string, string[]> = {
      machines: input.machines,
      skills: input.skills,
      controllers: input.controllers,
      education: input.education,
      certifications: input.certifications,
      responsibilities: input.responsibilities,
    };

    let out = skeleton;
    // 1) Known repeat regions: repeat the inner block per item, escaping `{{.}}`.
    for (const [name, items] of Object.entries(lists)) {
      const region = new RegExp(`{{#${name}}}([\\s\\S]*?){{/${name}}}`, "g");
      out = out.replace(region, (_m, inner: string) =>
        items.map((it) => inner.replace(/{{\.}}/g, () => ResumeRenderer.escapeHtml(it))).join(""),
      );
    }
    // 2) Any remaining (unknown) repeat region collapses to nothing.
    out = out.replace(/{{#[a-z_]+}}[\s\S]*?{{\/[a-z_]+}}/g, "");
    // 3) Scalar tokens (replacer fn → safe against `$` in values; unknown → "").
    out = out.replace(/{{\s*([a-z_]+)\s*}}/g, (_m, key: string) =>
      ResumeRenderer.escapeHtml(scalars[key] ?? ""),
    );
    return out;
  }

  /**
   * Render the PDF. Returns null (degraded) when the kill-switch is off, the
   * binary is missing, the process times out, the buffer guard trips, or it exits
   * non-zero — the shared {@link PdfRenderer} owns that. NEVER logs the HTML/name.
   */
  async renderPdf(input: ResumeRenderInput): Promise<Buffer | null> {
    return this.pdf.renderHtmlToPdf(this.buildResumeHtml(input), "resume");
  }

  /** Minimal HTML output encoder for user-controlled values. */
  private static escapeHtml(value: string): string {
    return PdfRenderer.escapeHtml(value);
  }
}
