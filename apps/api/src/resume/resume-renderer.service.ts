import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
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
  private readonly logger = new Logger(ResumeRenderer.name);
  private static readonly RENDER_TIMEOUT_MS = 20_000;
  private static readonly MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MiB guard
  // A shipped template file is immutable (registry contract), so cache by filename.
  private static readonly templateCache = new Map<string, string>();

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

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
   * binary is missing (ENOENT — e.g. local Windows dev), the process times out,
   * the buffer guard trips, or it exits non-zero. NEVER logs the HTML or the name.
   */
  async renderPdf(input: ResumeRenderInput): Promise<Buffer | null> {
    if (!this.config.RESUME_RENDER_ENABLED) {
      return null; // kill-switch off: no PDF this run.
    }

    const html = this.buildResumeHtml(input);
    return new Promise<Buffer | null>((resolve) => {
      // `weasyprint - -`: read HTML from stdin, write PDF to stdout.
      const child = spawn("weasyprint", ["-", "-"], { stdio: ["pipe", "pipe", "pipe"] });

      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const finish = (value: Buffer | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        this.logger.warn("weasyprint render timed out; degrading to no-PDF");
        child.kill("SIGKILL");
        finish(null);
      }, ResumeRenderer.RENDER_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > ResumeRenderer.MAX_PDF_BYTES) {
          this.logger.warn("weasyprint output exceeded the size guard; degrading to no-PDF");
          child.kill("SIGKILL");
          finish(null);
          return;
        }
        chunks.push(chunk);
      });

      // Consume stderr but NEVER log it (it can echo the HTML / the name).
      child.stderr.on("data", () => {
        /* intentionally swallowed: stderr may contain rendered name/markup */
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        // ENOENT = binary not installed (expected in local dev). Log a generic
        // warning ONLY — never the HTML, the name, or the full error object.
        if (err.code === "ENOENT") {
          this.logger.warn("weasyprint binary not found; degrading to no-PDF (install to enable)");
        } else {
          this.logger.warn(`weasyprint failed to spawn (${err.code ?? "unknown"}); degrading to no-PDF`);
        }
        finish(null);
      });

      child.on("close", (code) => {
        if (code === 0 && total > 0) {
          finish(Buffer.concat(chunks, total));
        } else {
          this.logger.warn(`weasyprint exited with code ${code ?? "null"}; degrading to no-PDF`);
          finish(null);
        }
      });

      // Feed the HTML and close stdin.
      child.stdin.on("error", () => {
        /* swallowed: a broken pipe is handled by the close/error handlers */
      });
      child.stdin.end(html);
    });
  }

  /** Minimal HTML output encoder for user-controlled values. */
  private static escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
