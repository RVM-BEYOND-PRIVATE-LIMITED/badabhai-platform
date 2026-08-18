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
/**
 * One job on the résumé, already humanised for print.
 *
 * `duration` is the worker's OWN words ("3.5 saal") rather than a computed month count —
 * `duration_months` is nullable precisely because "kuch saal" is a real answer, and printing a
 * number the worker never said is the fabrication the parse gates exist to stop.
 */
export interface ResumeExperienceLine {
  role: string;
  duration: string;
  work: string;
}

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
  /**
   * `{{availability}}` (human-readable) — the ONE line carrying every "when, and which shift"
   * answer the résumé has: the availability status, the model's extracted shift, and the
   * worker's own night-shift toggle (#947), composed into clauses joined with " · ".
   *
   * THEY SHARE A SLOT BECAUSE A SHIPPED LAYOUT IS IMMUTABLE (registry contract). Twelve
   * `<id>.v<n>.html` files carry `{{availability}}`; none carries a shift or night-shift token,
   * and an unknown token collapses to nothing — so this is the only slot a shift statement can
   * reach without four new layouts. `buildResumeRenderInput` owns the composition; the renderer
   * prints whatever string arrives.
   */
  availability: string | null;
  /** `{{summary}}` — short professional summary. */
  summary: string | null;
  /** Repeat regions `{{#skills}}` / `{{#machines}}` / `{{#controllers}}` / … */
  skills: string[];
  machines: string[];
  controllers: string[];
  /**
   * Highest academic level (e.g. "12th") and stream. NEITHER IS A TEMPLATE TOKEN — this
   * comment named `{{education_level}}` for a long time and no such token has ever existed in
   * any layout; both values are joined into the `{{#education_headline}}` region below. Left
   * corrected rather than copied onward, because a v4 layout written on the strength of the
   * old wording would render an empty slot and never error.
   * (`{{education_field}}`, e.g. "Electronics"). Rendered as a single leading
   * line in the Education section when present. DISTINCT from the `education`
   * list (ITI/diploma mentions) + `certifications`. Null → the slot collapses
   * to empty and its wrapper region is dropped. PII-free qualification labels.
   */
  educationLevel: string | null;
  educationField: string | null;
  education: string[];
  certifications: string[];
  /**
   * Role-typical responsibilities for the worker's chosen trade (TD24a, from
   * `trade-content.ts`). Trade-LEVEL copy (what a recruiter expects for that role),
   * never a fabricated personal claim. Empty when the trade is unknown.
   */
  responsibilities: string[];
  /**
   * The worker's trade in plain language (`{{trade}}`), e.g. "CNC Machining".
   *
   * Distinct from {@link canonicalRole}, which is the job title. The LLM-led interview names
   * both and they answer different questions — "VMC Operator" is what they do, "CNC Machining"
   * is the industry it sits in. Null on every deterministic-only profile, where no such label
   * exists and nothing may invent one.
   */
  trade: string | null;
  /**
   * THE WORK HISTORY — the one thing no pack question can produce.
   *
   * A pack asks its fixed question once, so a worker with three jobs has three answers to
   * "what did you do" and the answer map has room for one. This list exists only because the
   * LLM-led interview reads the whole conversation.
   *
   * STRUCTURED, NOT PRE-JOINED PROSE. The renderer's slot engine grew object regions for this
   * — `{{#experiences}}…{{role}}…{{duration}}…{{work}}…{{/experiences}}` — so a layout decides
   * how a job entry looks. Flattening to one string here would hard-code that choice into the
   * mapper and put presentation in the wrong layer.
   *
   * NEVER AN EMPLOYER NAME. `ExperienceEntrySchema.strict()` refuses one at the contract
   * boundary (§2), so there is no field here to render even if a model tried.
   */
  experiences: ResumeExperienceLine[];
  /**
   * Where the worker WANTS to work (`{{#preferred_locations}}`), as distinct from
   * {@link location}, which is where they are. #423 split these because conflating them turned
   * "I live in Pune" into "I want to work in Pune"; printing them as one line would undo that.
   */
  preferredLocations: string[];
  /**
   * `{{expected_salary}}` — rupees per month, or null to omit the line.
   *
   * NULL ON THE EMPLOYER DISCLOSURE, STRUCTURALLY, exactly as {@link photoDataUri} is. This is
   * the worker's asking price: showing it on their own résumé is useful, and showing it to a
   * payer before any conversation hands away their negotiating position. The caller's
   * `audience` decides, so the restriction cannot be forgotten at a call site.
   */
  expectedSalary: number | null;
  /**
   * ADR-0032 — the worker's profile photo as a self-contained `data:` URI, or
   * null/absent → render photo-less (the `{{#photo}}` region collapses).
   * CALLER-SUPPLIED like {@link displayName} and under the same rule: only the
   * worker's OWN render (resume-render.processor.ts) ever passes it; the masked
   * disclosure passes null STRUCTURALLY. Never derived from the snapshot; never
   * logged or echoed into an error.
   */
  photoDataUri?: string | null;
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
      trade: input.trade ?? "",
      // Grouped with the rupee sign in the template, not here — a bare number is what a layout
      // wants to format. Empty string collapses the line, which is what null must mean.
      expected_salary: input.expectedSalary != null ? String(input.expectedSalary) : "",
    };
    // OBJECT REGIONS — `{{#name}}…{{field}}…{{/name}}`, one repeat per item, each inner token
    // resolved from THAT item. The engine only had string regions (`{{.}}`), which is why
    // `experiences[]` could not be rendered at all: a job entry is four fields, and flattening
    // it to one string would have put the layout decision in the mapper.
    //
    // A MISSING KEY RESOLVES TO EMPTY, never to the scalar of the same name — the per-item
    // lookup below is total, so an inner `{{location}}` inside `{{#experiences}}` yields "" and
    // cannot silently pick up the worker's city from the outer scope.
    const objectLists: Record<string, ReadonlyArray<Record<string, string>>> = {
      experiences: input.experiences.map((e) => ({
        role: e.role,
        duration: e.duration,
        work: e.work,
      })),
    };
    // Level + field as ONE leading line ("12th — Electronics"), rendered as a
    // 0-or-1-item region so it collapses cleanly when both are null and never
    // prints an empty/"null" line. Distinct from the `education` list below.
    const educationHeadline = [input.educationLevel, input.educationField]
      .map((v) => v?.trim())
      .filter((v): v is string => Boolean(v))
      .join(" — ");
    const lists: Record<string, string[]> = {
      machines: input.machines,
      skills: input.skills,
      controllers: input.controllers,
      education_headline: educationHeadline ? [educationHeadline] : [],
      education: input.education,
      certifications: input.certifications,
      responsibilities: input.responsibilities,
      preferred_locations: input.preferredLocations,
      // ADR-0032: 0-or-1-item region — the documented conditional mechanism. A
      // data: URI survives escapeHtml intact (base64 + the mime prefix contain no
      // escapable characters), and templates without {{#photo}} are unaffected.
      photo: input.photoDataUri ? [input.photoDataUri] : [],
    };

    let out = skeleton;
    // 0) OBJECT REGIONS FIRST, before anything else touches a `{{token}}`. The inner tokens are
    //    resolved and escaped here; if step 3 ran first it would consume them as scalars and
    //    every job entry would render the same worker-level value.
    for (const [name, items] of Object.entries(objectLists)) {
      const region = new RegExp(`{{#${name}}}([\\s\\S]*?){{/${name}}}`, "g");
      out = out.replace(region, (_m, inner: string) =>
        items
          .map((item) =>
            inner.replace(/{{\s*([a-z_]+)\s*}}/g, (_t, key: string) =>
              ResumeRenderer.escapeHtml(item[key] ?? ""),
            ),
          )
          .join(""),
      );
    }
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
