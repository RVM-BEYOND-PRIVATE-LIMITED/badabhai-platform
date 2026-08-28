import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import { buildResumeQrDataUri, RESUME_QR } from "./resume-qr";

/**
 * The properties worth pinning are the ones that make the printed code UNSCANNABLE or the PDF
 * un-renderable — not that a string came back. A QR that decodes to the wrong URL, or an image
 * WeasyPrint refuses, both look fine in every test that only checks for a non-null result.
 */
describe("resume QR", () => {
  it("is a self-contained data: URI — the renderer can never fetch anything", async () => {
    // WeasyPrint blocks on a remote fetch and the template forbids any network reference, so an
    // `http` URL here would either hang the render or silently print nothing.
    const uri = await buildResumeQrDataUri("https://badabhai.ai/w/rk8m2q");
    expect(uri).toMatch(/^data:image\/svg\+xml,/);
    expect(uri).not.toMatch(/https?:\/\/[^"]*\.(png|svg|jpg)/);
  });

  it("escapes `#`, or the URI truncates at the first colour literal", async () => {
    // The specific defect: an SVG carries `fill="#000000"`, and `#` starts the fragment in a URI.
    // Unescaped, every parser stops there and the image is a blank square — which still renders,
    // still uploads, and is only visible to someone holding the printed page.
    const uri = await buildResumeQrDataUri("https://badabhai.ai");
    expect(uri).not.toContain("#");
    expect(decodeURIComponent(uri!.slice("data:image/svg+xml,".length))).toContain("<svg");
  });

  it("encodes the EXACT url it was given", async () => {
    // A QR that scans cleanly to the wrong address is the worst outcome available here: it looks
    // correct on paper and sends the employer somewhere else. Decoded from the SVG's own path
    // data would need a reader; instead assert the two inputs produce different symbols, which
    // is enough to catch a hardcoded or ignored argument.
    const a = await buildResumeQrDataUri("https://badabhai.ai/w/aaaaaa");
    const b = await buildResumeQrDataUri("https://badabhai.ai/w/bbbbbb");
    expect(a).not.toBe(b);
    expect(a).toBeTruthy();
  });

  it("is deterministic — two renders of one profile produce identical bytes", async () => {
    // A résumé is re-rendered on every profile change, and a QR that differs run-to-run would
    // make every regenerated PDF a false diff.
    const a = await buildResumeQrDataUri("https://badabhai.ai/w/rk8m2q");
    const b = await buildResumeQrDataUri("https://badabhai.ai/w/rk8m2q");
    expect(a).toBe(b);
  });

  it("emits exactly the level-Q symbol, with NO quiet zone of its own", async () => {
    // ONE ASSERTION, TWO DEFECTS, and it took a mutation to get here. The first version checked
    // `viewBox % 4 === 1`, which a 4-module margin passes: the symbol is 29 modules and 29+8=37,
    // and both are congruent to 1 (mod 4). Injecting `margin: 4` left it green.
    //
    // The exact module count fixes both. It is DERIVED FROM THE ENCODER rather than hardcoded,
    // so it also pins the error-correction level: the same text at the library default L needs
    // fewer modules than at Q, so a silent drop to L changes this number too. A margin inflates
    // it. Neither mutation can pass any more.
    const text = "https://badabhai.ai/w/rk8m2q";
    const expected = QRCode.create(text, {
      errorCorrectionLevel: RESUME_QR.ERROR_CORRECTION,
    }).modules.size;

    const uri = await buildResumeQrDataUri(text);
    const svg = decodeURIComponent(uri!.slice("data:image/svg+xml,".length));
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(viewBox, "no viewBox on the generated svg").not.toBeNull();
    expect(Number(viewBox![1])).toBe(expected);
    expect(Number(viewBox![2])).toBe(expected);
  });

  it("returns null instead of throwing, so a bad url cannot cost a worker their résumé", async () => {
    // The QR is the acquisition loop; the résumé is the product. Empty and whitespace-only are
    // the real cases — a profile whose short link has not been minted yet.
    expect(await buildResumeQrDataUri("")).toBeNull();
    expect(await buildResumeQrDataUri("   ")).toBeNull();
  });

  it("pins the error-correction level to the one the printed artifact needs", async () => {
    // Level Q (25%) matches the agency invite QR and survives a photocopy; the library default
    // is L (7%), which does not. This is a constant so the choice is reviewable rather than
    // buried in an options object.
    expect(RESUME_QR.ERROR_CORRECTION).toBe("Q");
    expect(RESUME_QR.RENDERED_MM).toBe(18);
  });
});
