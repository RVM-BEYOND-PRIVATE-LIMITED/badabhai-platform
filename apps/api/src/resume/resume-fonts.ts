import type { FontContract } from "../common/pdf/font-resolution";

/**
 * The font stack `bb_trade.v1.html` declares on `body`, character for character.
 *
 * This is the SINGLE definition; the template is asserted against it in
 * `resume-fonts.test.ts`. A probe that renders through a different stack from the
 * sheet would be measuring something else and reporting it as the sheet — which is
 * the exact shape of every silent-verification failure this repo has collected.
 */
export const RESUME_FONT_STACK = '"Noto Sans", "DejaVu Sans", Arial, sans-serif';

/**
 * The probe document. Fixed strings only — no worker data ever reaches it, so its
 * output is safe to keep as a checked-in fixture and safe to render on any request.
 *
 * It prints one Latin run and one Devanagari run because those are the two scripts
 * the sheet prints (`h1` and `.deva`), and a face that resolves for one says nothing
 * about the other: the shipped image once had Latin and no Devanagari at all.
 */
export const RESUME_FONT_PROBE_HTML = [
  '<!doctype html><meta charset="utf-8"><style>',
  "@page { size: 120mm 60mm; margin: 4mm }",
  `body { font-family: ${RESUME_FONT_STACK}; font-size: 10.5pt }`,
  "</style>",
  "<div>BadaBhai</div>",
  "<div>नमस्ते</div>",
].join("\n");

/**
 * What the trade sheet requires of the image it renders in.
 *
 * TWO required faces, and each one is here because a MEASURED failure produced a
 * wrong artifact at exit 0 — not because more assertions felt safer:
 *
 * - `Noto-Sans` — with `fonts-noto-core` gone the Latin body silently becomes
 *   DejaVu Sans, and with the DejaVu sans faces gone too it becomes DejaVu **Serif**:
 *   a serif sheet, different metrics, five of the 28 content shapes spilling onto a
 *   second page. Nothing fails.
 * - `Noto-Sans-Devanagari` — the worker's own name line, `.deva`. Without the face
 *   every glyph becomes .notdef and the worker's name is a row of empty boxes on the
 *   document he forwards on WhatsApp.
 *
 * Bold is NOT required. `Noto-Sans-Bold` is present in the shipped image and appears
 * in the probe fixtures, but a synthesised bold is a small visual regression, not a
 * wrong artifact, and every extra required face is one more way for a font *upgrade*
 * to refuse to render a résumé that would have been fine.
 */
export const RESUME_FONT_CONTRACT: FontContract = {
  what: "bb_trade trade sheet",
  probeHtml: RESUME_FONT_PROBE_HTML,
  requiredFaces: ["Noto-Sans", "Noto-Sans-Devanagari"],
  // Allowlist: the family the sheet asks for, and nothing else. The alternative —
  // listing DejaVu Sans and DejaVu Serif as forbidden — only ever excludes the
  // substitutions someone already thought of, and DejaVu Serif is precisely the one
  // nobody did.
  allowedFamilyPrefixes: ["Noto-Sans"],
};
