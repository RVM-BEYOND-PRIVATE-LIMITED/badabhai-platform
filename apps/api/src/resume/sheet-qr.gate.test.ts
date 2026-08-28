import { readFileSync } from "node:fs";
import { join } from "node:path";

import QRCode from "qrcode";
import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";
import { buildResumeRenderInput } from "./resume-render-input";
import { RESUME_QR } from "./resume-qr";
import { ResumeRenderer } from "./resume-renderer.service";
import { RESUME_PROFILE_ORIGIN } from "./resume-sheet-footer";

/**
 * THE QR, ON ALL 28 SHEETS, MEASURED RATHER THAN LOOKED AT.
 *
 * WHY THIS GATE EXISTS. Part 12.2 of the guideline makes QR-attributed signups the number that
 * decides whether the free résumé is an acquisition channel or a cost centre — it names the
 * ninety-day threshold under which the seven-skin investment stops. A metric that load-bearing
 * cannot be verified by looking at a PDF and agreeing it has a square on it.
 *
 * AND BECAUSE THE FOOTER IS WHAT OVERFLOWED. The one-page fixes pushed content UP rather than
 * shrinking the footer, which was the right call and left nothing pinning it. `.qr` reserves
 * 18 mm x 18 mm inside a flex row; anything that shrinks that box to buy space would take the
 * modules below the size a photocopier can reproduce, and the sheet would still look fine.
 *
 * WHAT "SCANS" DECOMPOSES INTO, and each half is asserted separately below:
 *   * the PHYSICAL SIZE the layout reserves (18 mm), and
 *   * the MODULE SIZE — the printed edge of one black square, 18 mm divided by the module count.
 * The second is the one that fails silently: the box stays 18 mm while a longer URL pushes the
 * symbol to a higher version, and the modules shrink underneath it with nothing to notice.
 */

/**
 * THE FLOOR: 0.5 mm per module.
 *
 * SOURCE, STATED HONESTLY. This is the general-distribution X-dimension floor from the QR
 * printing literature (ISO/IEC 18004 and the GS1 print specifications both land here for codes
 * scanned off paper by a consumer device), NOT a number from the BadaBhai guideline — §6.3's
 * photocopy clause governs fills and hairlines and says nothing about a symbol. It is therefore
 * an engineering floor and is flagged for redline in NEEDS_PRAKASH alongside the drop order.
 *
 * It is the right ORDER of number for this artifact: §6.3 refuses hairline rules below 0.5 pt
 * (0.176 mm) because a photocopier loses them, and a QR module has to survive the same copier
 * plus a phone camera at an arm's length in a factory gatehouse.
 */
const MIN_MODULE_MM = 0.5;

/**
 * The largest symbol that can hold the floor inside the reserved box: floor(18 / 0.5).
 * Version 4 (33 modules) fits; version 5 (37) does not. Derived, never typed in twice.
 */
const MAX_MODULES = Math.floor(RESUME_QR.RENDERED_MM / MIN_MODULE_MM);

const renderer = new ResumeRenderer({} as never);
const template = readFileSync(join(__dirname, "templates", "bb_trade.v1.html"), "utf8");

beforeAll(primeSheetQr);

/** Every `<img class="qr">` on the page, as decoded SVG source. */
function qrImages(html: string): string[] {
  return [...html.matchAll(/<img class="qr" src="([^"]+)"/g)].map((m) => {
    const uri = m[1]!;
    expect(uri, "the QR must be an inline SVG data URI, never a raster or a remote fetch").toMatch(
      /^data:image\/svg\+xml,/,
    );
    return decodeURIComponent(uri.slice("data:image/svg+xml,".length));
  });
}

/**
 * The module count, read off the SVG's own viewBox.
 *
 * `margin: 0` at the generator means the viewBox is EXACTLY the symbol, so its width is the
 * module count. Asserting the count is a legal QR size (17 + 4v) is therefore also what proves
 * no quiet zone was baked in: with the spec's 4-module margin the viewBox would be N + 8, which
 * is never a legal size. The quiet zone is supplied by the footer's white space at full module
 * size, which is the point of generating it flush.
 */
function moduleCount(svg: string): number {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  expect(
    viewBox,
    "the QR SVG carries no viewBox, so its printed module size is unknowable",
  ).toBeTruthy();
  const [, , w, h] = viewBox!.split(/\s+/).map(Number);
  expect(w, "a QR symbol is square").toBe(h);
  const version = (w! - 17) / 4;
  expect(
    Number.isInteger(version) && version >= 1 && version <= 40,
    `viewBox width ${w} is not a legal QR size (17 + 4v) — a quiet zone was baked into the symbol, ` +
      `which shrinks the modules INSIDE the 18 mm the layout reserves instead of adding space around them`,
  ).toBe(true);
  return w!;
}

/**
 * SHAPE 14 CARRIES NO TRADE-SHEET CONTEXT AT ALL, so it has no footer to put a QR in. That is a
 * real state and not a fixture oversight — the disclosure surface passes null when both of its
 * loads fail — and it is asserted on its own terms below rather than skipped quietly.
 */
const WITH_CONTEXT = SHEET_SHAPES.filter((s) => s.tradeSheet !== null);

describe.each(WITH_CONTEXT)("shape $n — $name", (shape) => {
  it.each(["worker", "employer"] as const)("prints one scannable QR (%s copy)", (audience) => {
    const html = renderer.buildResumeHtml(
      buildResumeRenderInput(
        shape.snapshot,
        shape.displayName,
        "bb_trade",
        null,
        false,
        audience,
        withSheetQr(shape.tradeSheet),
      ),
    );

    const svgs = qrImages(html);
    // EXACTLY ONE. Zero means the acquisition loop is silently absent from a whole content
    // shape; two would mean a region repeated and the footer is twice as tall as measured.
    expect(svgs, `shape ${shape.n}/${audience} does not carry exactly one QR`).toHaveLength(1);

    const modules = moduleCount(svgs[0]!);
    const moduleMm = RESUME_QR.RENDERED_MM / modules;
    expect(
      moduleMm,
      `shape ${shape.n}/${audience}: ${modules} modules in ${RESUME_QR.RENDERED_MM} mm is ` +
        `${moduleMm.toFixed(3)} mm per module, below the ${MIN_MODULE_MM} mm photocopy floor`,
    ).toBeGreaterThanOrEqual(MIN_MODULE_MM);
  });
});

describe("the QR contract the layout and the generator have to keep together", () => {
  it("still reserves the ratified 18 mm — the physical dimension, pinned on its own", () => {
    // THE MODULE FLOOR ALONE WOULD NOT CATCH THIS CLEANLY. Shrinking the box to buy page space
    // is the obvious move the next time a sheet overflows, and `RENDERED_MM` and the CSS would
    // be changed together, so the drift test below stays green. The module floor does catch it
    // eventually — 25 modules x 0.5 mm means anything under 12.5 mm fails — but "the design
    // ratified an 18 mm square" is the actual constraint, and a rule should fail for its own
    // reason rather than as a side effect of arithmetic that a shorter URL could change.
    expect(RESUME_QR.RENDERED_MM).toBe(18);
  });

  it("reserves in CSS exactly the size the generator is documented to print at", () => {
    // THE DRIFT THIS STOPS. `RENDERED_MM` is the number every margin above is computed from, and
    // it lives in resume-qr.ts while the box that actually prints lives in the template. Shrink
    // the CSS to buy a millimetre of page and every assertion in this file keeps passing against
    // a constant that no longer describes the sheet.
    const box = /\.qr\s*\{[^}]*width:\s*([\d.]+)mm;\s*height:\s*([\d.]+)mm/.exec(template);
    expect(box, ".qr no longer declares an explicit mm box").toBeTruthy();
    expect(Number(box![1])).toBe(RESUME_QR.RENDERED_MM);
    expect(Number(box![2])).toBe(RESUME_QR.RENDERED_MM);
  });

  it("is the level-Q encoding, proven against the alternatives rather than read off a constant", async () => {
    // `RESUME_QR.ERROR_CORRECTION === "Q"` would assert that a constant says Q, which is true of
    // a constant that is no longer passed to anything. This compares the bytes the sheet carries
    // against the bytes each level actually produces.
    const shipped = qrImages(
      renderer.buildResumeHtml(
        buildResumeRenderInput(
          SHEET_SHAPES[0]!.snapshot,
          SHEET_SHAPES[0]!.displayName,
          "bb_trade",
          null,
          false,
          "worker",
          withSheetQr(SHEET_SHAPES[0]!.tradeSheet),
        ),
      ),
    )[0]!;

    const at = async (level: "L" | "M" | "Q" | "H") =>
      QRCode.toString(RESUME_PROFILE_ORIGIN, {
        type: "svg",
        errorCorrectionLevel: level,
        margin: 0,
      });

    expect(shipped).toBe(await at("Q"));
    // Q and L happen to land on the same VERSION for today's short URL (25 modules each), so the
    // size alone cannot tell them apart — only the error-correction codewords differ. Asserting
    // both directions is what makes the equality above mean "level Q" rather than "some level".
    expect(shipped).not.toBe(await at("L"));
    expect(shipped).not.toBe(await at("H"));
  });

  it("keeps the deep link above the floor — the change ruling 14 has already scheduled", async () => {
    // NOT HYPOTHETICAL. Ruling 14 points the QR at the bare origin now and says the deep link
    // lands later; Phase 3 adds `/w/<code>`. A longer payload raises the version and shrinks the
    // modules inside a box whose size never changes, so the sheet keeps rendering perfectly and
    // stops scanning off a photocopy. Measuring it here means that lands as a red test in the PR
    // that introduces it rather than as a metric that quietly reads zero.
    for (const url of [
      `${RESUME_PROFILE_ORIGIN}/w/rk8m2q`,
      `${RESUME_PROFILE_ORIGIN}/w/rk8m2q?s=resume`,
    ]) {
      const svg = await QRCode.toString(url, {
        type: "svg",
        errorCorrectionLevel: RESUME_QR.ERROR_CORRECTION,
        margin: 0,
      });
      const modules = moduleCount(svg);
      expect(
        modules,
        `${url} needs ${modules} modules; more than ${MAX_MODULES} takes the printed module ` +
          `below ${MIN_MODULE_MM} mm inside the ${RESUME_QR.RENDERED_MM} mm box`,
      ).toBeLessThanOrEqual(MAX_MODULES);
    }
  });
});

describe("the sheet with no context at all", () => {
  it("collapses the whole footer rather than printing a broken image", () => {
    // The `{{#qr}}` region is 0-or-1, so a null URI must leave NO `<img>` behind — an `<img>`
    // with an empty `src` re-requests the page in most engines and prints a broken-image glyph
    // in the middle of the footer of a sheet a worker hands to a supervisor.
    const bare = SHEET_SHAPES.find((s) => s.n === 14)!;
    const html = renderer.buildResumeHtml(
      buildResumeRenderInput(
        bare.snapshot,
        bare.displayName,
        "bb_trade",
        null,
        false,
        "worker",
        null,
      ),
    );
    expect(html).not.toContain('<img class="qr"');
    expect(html).not.toMatch(/src="\s*"/);
    expect(html).not.toMatch(/\{\{/);
  });

  it("is the ONLY shape without one, so a missing QR can never be normal", () => {
    // The count is pinned. If a future shape loses its context the arithmetic here changes and
    // this fails, rather than the shape quietly dropping out of `WITH_CONTEXT` and taking its
    // QR assertions with it — which is exactly how a filtered matrix rots.
    expect(SHEET_SHAPES.length - WITH_CONTEXT.length).toBe(1);
    expect(SHEET_SHAPES.filter((s) => s.tradeSheet === null).map((s) => s.n)).toEqual([14]);
  });
});
