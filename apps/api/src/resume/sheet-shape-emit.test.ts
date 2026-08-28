import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import {
  primeSheetQr,
  SHEET_SHAPES,
  withFutureContent,
  withSheetQr,
} from "./__fixtures__/sheet-shapes";

// The emitted HTML is what gets rendered to PDF and measured; without this the footer it
// measures is 18 mm shorter than the one production prints.
beforeAll(primeSheetQr);
import { buildResumeRenderInput } from "./resume-render-input";
import { sheetContentLines } from "./resume-degradation";
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
    // THE MANIFEST IS PART OF THE EVIDENCE, not a convenience. It records which degradation stage
    // each sheet was produced at and what that stage removed, so the millimetre measurement can be
    // read against the decision that produced it — "shape 9 fits" and "shape 9 fits because it
    // dropped two rows" are different claims, and only the second is checkable.
    const manifest: Record<string, unknown>[] = [];
    // TWO VARIANTS PER SHAPE, and the second is the one that matters. `shape-*` is the content
    // that exists today; `future-*` is the same worker once work-history capture and Phase C have
    // landed, at the length real records actually run to. The degradation ladder is verified
    // against both, because a ladder tuned only to today's seeded lengths would pass here and
    // fail on the first real certificate string.
    const variants = [
      { prefix: "shape", ctx: (s: (typeof SHEET_SHAPES)[number]) => withSheetQr(s.tradeSheet) },
      {
        prefix: "future",
        ctx: (s: (typeof SHEET_SHAPES)[number]) => withFutureContent(withSheetQr(s.tradeSheet)),
      },
    ];
    for (const variant of variants) {
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
              variant.ctx(shape),
            ),
          );
          const tag = `${String(shape.n).padStart(2, "0")}-${audience}`;
          const file = `${variant.prefix}-${tag}.html`;
          writeFileSync(`${OUT_DIR}/${file}`, html, "utf8");
          const input = buildResumeRenderInput(
            shape.snapshot,
            shape.displayName,
            "bb_trade",
            null,
            false,
            audience,
            variant.ctx(shape),
          );
          manifest.push({
            file,
            shape: shape.n,
            name: shape.name,
            audience,
            variant: variant.prefix,
            stage: input.degradationStage ?? 0,
            dropped: input.degradationDropped ?? [],
            // `over` and `gain` per step: what the sheet needed, and what the step actually took.
            // Without them "stage 3" says a sheet degraded three times and nothing about whether
            // any of the three was proportionate.
            trace: input.degradationTrace ?? [],
            lines: Number(sheetContentLines(input).toFixed(2)),
          });
          written += 1;
        }
      }
    }
    writeFileSync(
      `${OUT_DIR}/manifest.json`,
      `${JSON.stringify(manifest, null, 2)}
`,
      "utf8",
    );
    expect(written).toBe(SHEET_SHAPES.length * 2 * variants.length);
  });
});
