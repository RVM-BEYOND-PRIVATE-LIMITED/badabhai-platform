import { spawn } from "node:child_process";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../config/config.module";

/**
 * The shared WeasyPrint HTML→PDF core (ADR-0007: render in NODE, never the AI
 * service). Used by BOTH the resume renderer and the interview-kit renderer so the
 * security-critical subprocess handling lives in ONE place.
 *
 * Degrade-to-null: any failure (kill-switch off, binary missing, timeout, oversize,
 * non-zero exit) returns null = "no PDF this run" — the caller decides what to do.
 * This lets local dev (no WeasyPrint, e.g. Windows) and a disabled kill-switch both
 * run cleanly. stderr is swallowed (it can echo input markup); the HTML is NEVER
 * logged. Callers MUST output-encode any user-controlled value before it reaches the
 * HTML — this layer renders bytes, it does not sanitise.
 */
@Injectable()
export class PdfRenderer {
  private readonly logger = new Logger(PdfRenderer.name);
  private static readonly RENDER_TIMEOUT_MS = 20_000;
  private static readonly MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MiB guard

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  /**
   * Render the given HTML to a PDF Buffer, or null when degraded. `label` is a
   * short, PII-free tag used only in warning logs (e.g. "resume" / "interview-kit").
   */
  async renderHtmlToPdf(html: string, label = "pdf"): Promise<Buffer | null> {
    if (!this.config.RESUME_RENDER_ENABLED) {
      return null; // master kill-switch off: no PDF this run.
    }

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
        this.logger.warn(`weasyprint render (${label}) timed out; degrading to no-PDF`);
        child.kill("SIGKILL");
        finish(null);
      }, PdfRenderer.RENDER_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > PdfRenderer.MAX_PDF_BYTES) {
          this.logger.warn(`weasyprint output (${label}) exceeded the size guard; degrading to no-PDF`);
          child.kill("SIGKILL");
          finish(null);
          return;
        }
        chunks.push(chunk);
      });

      // Consume stderr but NEVER log it (it can echo the input markup/name).
      child.stderr.on("data", () => {
        /* intentionally swallowed */
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          this.logger.warn(
            `weasyprint binary not found (${label}); degrading to no-PDF (install to enable)`,
          );
        } else {
          this.logger.warn(
            `weasyprint failed to spawn (${label}, ${err.code ?? "unknown"}); degrading to no-PDF`,
          );
        }
        finish(null);
      });

      child.on("close", (code) => {
        if (code === 0 && total > 0) {
          finish(Buffer.concat(chunks, total));
        } else {
          this.logger.warn(`weasyprint exited (${label}) with code ${code ?? "null"}; degrading to no-PDF`);
          finish(null);
        }
      });

      child.stdin.on("error", () => {
        /* swallowed: a broken pipe is handled by the close/error handlers */
      });
      child.stdin.end(html);
    });
  }

  /** Minimal HTML output encoder for user-controlled values (shared helper). */
  static escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
