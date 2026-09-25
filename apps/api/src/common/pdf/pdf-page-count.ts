import { inflateSync } from "node:zlib";

/**
 * PAGE COUNT of a rendered PDF — how many pages the résumé the worker holds actually has
 * (#1714). PURE, and degrade-to-null like {@link PdfRenderer}: an unknown count is `null`,
 * never a guess, never 0, never a throw.
 *
 * THE PAGE TREE IS NOT IN THE BYTES. Measured on WeasyPrint 69.0 (the version the API image
 * ships): the output is PDF 1.7 with a cross-reference stream and OBJECT STREAMS, and
 * `/Type /Pages` / `/Type /Page` occur ZERO times in the raw file. Both live inside a Flate
 * `/Type /ObjStm` stream, which inflates to plain dictionaries such as
 * `<</Type /Pages/Kids [6 0 R 8 0 R]/Count 2>>` and `<</Type /Page/Parent 1 0 R ...>>`.
 * So the raw buffer is read AND every Flate object stream in it; a scan of the raw bytes
 * alone answers "no pages" for every résumé we have ever rendered.
 *
 * ONLY OBJECT STREAMS ARE INFLATED. Fonts, page content and images are Flate streams too, and
 * none of them can carry the page tree. A real résumé embeds the worker's own photo, so
 * inflating every stream would decompress a user-supplied image for nothing — needless memory,
 * and a decompression-bomb surface that buys no information. Each inflate is also capped at
 * {@link MAX_OBJECT_STREAM_BYTES}; a stream past the cap is skipped, not thrown.
 *
 * TWO INDEPENDENT READINGS, AND THEY MUST AGREE:
 *   - DECLARED: the largest `/Count` on a `/Type /Pages` dictionary. The root of the page
 *     tree carries the total and intermediate nodes carry less, so the max is the root.
 *     Only a `/Pages` dictionary's `/Count` is read. Outline entries carry `/Count` too — it
 *     means "visible outline items", not pages — and a heading-rich sheet outlines to MORE
 *     entries than it has pages: the checked-in 3-page fixture has an outline root of
 *     `/Count 6`, which is exactly what a naive "largest /Count" parser reports.
 *   - LEAVES: the number of `/Type /Page` objects, one per page.
 * If both exist and agree, that is the answer. If only one exists, it is. If they DISAGREE,
 * the answer is `null`: either this reader has misparsed something or the file carries
 * incremental updates (old page objects left behind a newer tree), and in both cases
 * "unknown" is honest where either number would be a guess printed as a fact.
 *
 * NOT A PDF PARSER. It reads dictionaries with no nested `<<`/`>>` — every dictionary it needs
 * is one in WeasyPrint's output — and it ignores the xref entirely. A shape it cannot read
 * yields fewer readings, and fewer readings yield `null`, never a wrong number.
 */

/**
 * The inflate cap per object stream. WeasyPrint's object stream is a few KiB of dictionaries
 * (2.8 KiB for the 3-page fixture; a page dictionary is ~180 bytes), so 4 MiB is thousands of
 * pages of headroom — and the renderer already refuses any PDF over 8 MiB, compressed.
 */
export const MAX_OBJECT_STREAM_BYTES = 4 * 1024 * 1024;

/*
 * `/Key /Value` as whole names, with the optional whitespace PDF allows between them.
 *
 * Each ends in the same lookahead: a PDF name ends at whitespace, a delimiter, or the end of
 * the text. That is what keeps `/Page` from matching `/Pages` while still matching
 * `/Page/Parent` (no space, as written).
 *
 * FOUR LITERALS, NOT ONE HELPER. A `new RegExp` built from arguments is what semgrep's
 * `detect-non-literal-regexp` blocks, and a literal is also what a reader can check at a glance.
 */
const PAGES_TYPE_RE = /\/Type\s*\/Pages(?=[\s()<>[\]{}/%]|$)/;
const PAGE_LEAF_RE = /\/Type\s*\/Page(?=[\s()<>[\]{}/%]|$)/g;
const OBJECT_STREAM_TYPE_RE = /\/Type\s*\/ObjStm(?=[\s()<>[\]{}/%]|$)/;
const FLATE_FILTER_RE = /\/Filter\s*\/FlateDecode(?=[\s()<>[\]{}/%]|$)/;

/** A dictionary with no nested `<<`/`>>`. Its body is group 1. */
const FLAT_DICT_RE = /<<([^<>]*)>>/g;
/** A flat dictionary immediately followed by the `stream` keyword and its end-of-line. */
const STREAM_HEADER_RE = /<<([^<>]*)>>\s*stream(?:\r\n|\n|\r)/g;

/**
 * `/Count 2` or `/Length 670` as a DIRECT integer. An indirect `/Length 9 0 R` names another
 * object, not a length, and must not be read as 9. `(?!\d)` stops the regex backtracking to a
 * prefix of the number (`12 0 R` → `1`) to dodge the indirect-reference check.
 */
const DIRECT_COUNT_RE = /\/Count\s+(\d+)(?!\d)(?!\s+\d+\s+R\b)/;
const DIRECT_LENGTH_RE = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R\b)/;

const LF = 0x0a;
const CR = 0x0d;

interface PageTreeReadings {
  /** Largest `/Count` on a `/Type /Pages` dictionary, or null when none was found. */
  declared: number | null;
  /** How many `/Type /Page` leaves were found. */
  leaves: number;
}

/** The number of pages in `pdf`, or null when it cannot be read with confidence. */
export function countPdfPages(pdf: Buffer): number | null {
  try {
    // `latin1` is a byte-preserving decode: string offsets ARE buffer offsets.
    const raw = pdf.toString("latin1");
    const readings: PageTreeReadings[] = [readPageTree(raw)];
    for (const body of flateObjectStreamBodies(pdf, raw)) {
      const text = inflateObjectStream(body);
      if (text !== null) readings.push(readPageTree(text));
    }
    return reconcile(readings);
  } catch {
    return null; // Any input, however malformed, degrades to "unknown".
  }
}

/** Both readings from one decoded text source. */
function readPageTree(text: string): PageTreeReadings {
  let declared: number | null = null;
  for (const dict of text.matchAll(FLAT_DICT_RE)) {
    const body = dict[1] ?? "";
    if (!PAGES_TYPE_RE.test(body)) continue;
    const count = directInteger(body, DIRECT_COUNT_RE);
    if (count !== null) declared = Math.max(declared ?? 0, count);
  }
  return { declared, leaves: [...text.matchAll(PAGE_LEAF_RE)].length };
}

/**
 * Combine the readings from every source: the declared total is the largest seen (the root),
 * the leaves are summed (each object lives in exactly one source).
 */
function reconcile(readings: readonly PageTreeReadings[]): number | null {
  let declared: number | null = null;
  let leaves = 0;
  for (const reading of readings) {
    if (reading.declared !== null) declared = Math.max(declared ?? 0, reading.declared);
    leaves += reading.leaves;
  }
  const leafCount = leaves > 0 ? leaves : null;

  if (declared !== null && leafCount !== null) {
    // Disagreement is a misparse or an incrementally updated file. Unknown, not a guess.
    return declared === leafCount ? leafCount : null;
  }
  const only = declared ?? leafCount;
  return only !== null && only >= 1 && Number.isSafeInteger(only) ? only : null;
}

/** The encoded bodies of every stream whose dictionary is a Flate `/Type /ObjStm`. */
function flateObjectStreamBodies(pdf: Buffer, raw: string): Buffer[] {
  const bodies: Buffer[] = [];
  for (const header of raw.matchAll(STREAM_HEADER_RE)) {
    const dict = header[1] ?? "";
    if (!OBJECT_STREAM_TYPE_RE.test(dict) || !FLATE_FILTER_RE.test(dict)) continue;
    const body = streamBody(pdf, header.index + header[0].length, dict);
    if (body !== null) bodies.push(body);
  }
  return bodies;
}

/**
 * A stream's encoded bytes: exactly `/Length` of them when the length is direct, otherwise
 * everything up to `endstream` less the end-of-line that precedes it. A declared length that
 * overruns the buffer is truncated by `subarray`, and the inflate then fails and is skipped.
 */
function streamBody(pdf: Buffer, start: number, dict: string): Buffer | null {
  const length = directInteger(dict, DIRECT_LENGTH_RE);
  if (length !== null) return pdf.subarray(start, start + length);

  const end = pdf.indexOf("endstream", start);
  if (end < 0) return null;
  let stop = end;
  if (stop > start && pdf[stop - 1] === LF) stop -= 1;
  if (stop > start && pdf[stop - 1] === CR) stop -= 1;
  return pdf.subarray(start, stop);
}

/** Inflate one object stream under the cap, or null when it is not readable Flate data. */
function inflateObjectStream(body: Buffer): string | null {
  try {
    return inflateSync(body, { maxOutputLength: MAX_OBJECT_STREAM_BYTES }).toString("latin1");
  } catch {
    // Corrupt, truncated, or past the cap. A stream we cannot read is not evidence of
    // anything; it contributes no reading, and no reading ends in null, not in a guess.
    return null;
  }
}

function directInteger(dict: string, re: RegExp): number | null {
  const match = re.exec(dict);
  return match?.[1] === undefined ? null : Number(match[1]);
}
