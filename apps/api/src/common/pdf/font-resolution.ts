import { inflateSync } from "node:zlib";

/**
 * FONT RESOLUTION — the guard against a PDF that renders in the WRONG font at exit 0.
 *
 * This pipeline has now failed this way twice, silently, and both times the artifact
 * shipped:
 *
 *   1. The worker's Devanagari name line rendered as a row of empty boxes because no
 *      Devanagari face was installed. WeasyPrint exited 0. (Why `fonts-noto-core` is
 *      in `apps/api/Dockerfile` at all — see the comment there.)
 *   2. With the sans faces gone, `sans-serif` at the end of the stack resolves to
 *      DejaVu Serif: a serif sheet with different metrics, five of the 28 shapes
 *      spilling to a second page. WeasyPrint exited 0 for that too.
 *
 * Neither is detectable from the exit code, the byte count, or the page count of the
 * PDF the caller gets back. WeasyPrint DOES warn on stderr (".notdef glyph rendered
 * for Unicode string unsupported by fonts") — and {@link PdfRenderer} deliberately
 * swallows stderr, because that warning quotes the offending characters, which for a
 * name is a fragment of the worker's real name. That is the right call and it stays.
 * It also would not have caught case 2, where every glyph exists and the FAMILY is
 * simply wrong.
 *
 * What is observable is the set of fonts the PDF actually embeds. WeasyPrint writes a
 * `/BaseFont /XXXXXX+Noto-Sans` entry per face, where `XXXXXX+` is a subset tag. That
 * is measured from the produced bytes, so it reports what the renderer DID rather than
 * what fontconfig says it would do — the two are not the same question, and only the
 * first one matters.
 *
 * Measured on the shipped image (WeasyPrint 69.0, bookworm-slim):
 *
 * | fonts present                     | faces embedded                                       |
 * | --------------------------------- | ---------------------------------------------------- |
 * | noto + dejavu (shipped)           | `Noto-Sans`, `Noto-Sans-Bold`, `Noto-Sans-Devanagari` |
 * | `fonts-noto-core` removed         | `DejaVu-Sans`, `DejaVu-Sans-Bold` — Devanagari tofu   |
 * | ...and the DejaVu *sans* faces too| `DejaVu-Serif`, `DejaVu-Serif-Bold` — a serif sheet   |
 *
 * The three rows are checked in as real fixtures under `__fixtures__/font-probe/`;
 * they are genuine renderer output from those three containers, not hand-written.
 */

/** The font contract a template's rendering is required to satisfy. */
export interface FontContract {
  /** Human name, used in the failure message only. */
  readonly what: string;
  /**
   * A tiny self-contained document exercising every script the template prints.
   * It carries FIXED strings only — never worker data — so the probe is safe to
   * run on any input and its output is safe to keep as a fixture.
   */
  readonly probeHtml: string;
  /**
   * Faces that MUST be embedded, by exact PostScript name with the subset tag
   * stripped. Absence means a script silently fell back or vanished into .notdef.
   */
  readonly requiredFaces: readonly string[];
  /**
   * Every embedded face must begin with one of these. Stated as an ALLOWLIST, not
   * a list of forbidden fallbacks: "we did not think of DejaVu Serif" is how case 2
   * shipped, and a denylist can only ever exclude the substitutions someone already
   * imagined.
   */
  readonly allowedFamilyPrefixes: readonly string[];
}

/** Raised when the renderer resolved fonts the template did not ask for. */
export class FontResolutionError extends Error {
  constructor(
    readonly contract: string,
    readonly missing: readonly string[],
    readonly unexpected: readonly string[],
  ) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
    if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(", ")}`);
    super(`font contract "${contract}" not satisfied: ${parts.join("; ")}`);
    this.name = "FontResolutionError";
  }
}

/** `/BaseFont /HUHQIP+Noto-Sans` → the name. Literal, never built from input. */
const BASE_FONT_RE = /\/BaseFont\s*\/([A-Za-z0-9+._-]+)/g;
/** A PDF subset tag is exactly six capitals and a `+`. */
const SUBSET_TAG_RE = /^[A-Z]{6}\+/;

/** Strip the six-letter subset tag: `HUHQIP+Noto-Sans` → `Noto-Sans`. */
export function stripSubsetTag(baseFont: string): string {
  return baseFont.replace(SUBSET_TAG_RE, "");
}

/**
 * Every font face embedded in a PDF, subset tags stripped, sorted and deduped.
 *
 * Font dictionaries usually sit inside Flate-compressed object streams, so the raw
 * buffer is scanned AND every inflatable stream in it. Doing both means this works
 * on compressed output (the default) without asking WeasyPrint for
 * `--uncompressed-pdf` — i.e. without the probe running a different code path from
 * the render it is vouching for.
 */
export function embeddedFontFaces(pdf: Buffer): string[] {
  const faces = new Set<string>();

  const scan = (text: string): void => {
    for (const match of text.matchAll(BASE_FONT_RE)) {
      faces.add(stripSubsetTag(match[1]!));
    }
  };

  // `latin1` is a byte-preserving decode — it cannot mangle the ASCII keys we match.
  scan(pdf.toString("latin1"));

  let cursor = 0;
  for (;;) {
    const start = pdf.indexOf("stream", cursor);
    if (start < 0) break;
    let from = start + "stream".length;
    if (pdf[from] === 0x0d) from += 1; // CR
    if (pdf[from] === 0x0a) from += 1; // LF
    const end = pdf.indexOf("endstream", from);
    if (end < 0) break;
    try {
      scan(inflateSync(pdf.subarray(from, end)).toString("latin1"));
    } catch {
      // Not a Flate stream (or truncated). Not every stream is one, and a stream we
      // cannot read is not evidence of anything — the required-face check below is
      // what turns "found nothing" into a failure.
    }
    cursor = end + "endstream".length;
  }

  return [...faces].sort();
}

/**
 * Check a rendered PDF against a contract. Returns the two failure sets; empty and
 * empty means the contract holds.
 *
 * An empty `faces` set fails, and that matters: a PDF this function could not read
 * must NOT read as "no violations found". That is the difference between a gate and
 * a gate-shaped thing.
 */
export function checkFontContract(
  pdf: Buffer,
  contract: FontContract,
): { missing: string[]; unexpected: string[] } {
  const faces = embeddedFontFaces(pdf);
  const missing = contract.requiredFaces.filter((face) => !faces.includes(face));
  const unexpected = faces.filter(
    (face) => !contract.allowedFamilyPrefixes.some((prefix) => face.startsWith(prefix)),
  );
  return { missing, unexpected };
}
