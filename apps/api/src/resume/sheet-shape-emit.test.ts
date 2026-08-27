import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SHEET_SHAPES } from "./__fixtures__/sheet-shapes";
import { buildResumeRenderInput } from "./resume-render-input";
import { ResumeRenderer } from "./resume-renderer.service";

/**
 * EMITS each content shape's HTML to disk so WeasyPrint can render it and the ONE-PAGE contract
 * can be MEASURED rather than argued about.
 *
 * WHY IT IS A TEST FILE AND NOT A SCRIPT. It needs the real mapper and the real template
 * registry, which resolve through the API's module graph and its vitest aliases; a standalone
 * script would need a second, parallel wiring — and a second wiring is a second thing that can
 * disagree with production about what a sheet contains.
 *
 * SKIPPED UNLESS ASKED. It writes files, so it must never run as part of the ordinary suite:
 *
 *   EMIT_SHEETS=<dir> pnpm --filter @badabhai/api run test sheet-shape-emit
 *
 * Page counting itself is Docker-only — WeasyPrint does not run on this Windows host. The recipe
 * and the measured result are in docs/resume-engine-r1-journal.md.
 */
const OUT_DIR = process.env.EMIT_SHEETS;

describe.skipIf(!OUT_DIR)("emit the content-shape sheets for a real PDF render", () => {
  it("writes one HTML file per shape, per audience", () => {
    const renderer = new ResumeRenderer({} as never);
    mkdirSync(OUT_DIR!, { recursive: true });
    let written = 0;
    for (const shape of SHEET_SHAPES) {
      for (const audience of ["worker", "employer"] as const) {
        const html = renderer.buildResumeHtml(
          buildResumeRenderInput(
            shape.snapshot,
            shape.displayName,
            "bb_trade",
            null,
            false,
            audience,
            shape.tradeSheet,
          ),
        );
        const tag = `${String(shape.n).padStart(2, "0")}-${audience}`;
        writeFileSync(`${OUT_DIR}/shape-${tag}.html`, html, "utf8");
        written += 1;
      }
    }
    expect(written).toBe(SHEET_SHAPES.length * 2);
  });
});
