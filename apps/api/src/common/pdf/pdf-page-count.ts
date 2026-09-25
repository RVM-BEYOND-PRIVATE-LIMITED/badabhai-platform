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
 * A STREAM'S BYTES ARE NEVER READ AS PDF SYNTAX. The file is walked with a cursor: object
 * syntax is read, and each stream body is JUMPED by its direct `/Length`. This is the security
 * property, not a tidy-up. A résumé embeds the worker's own photo, and WeasyPrint embeds a JPEG
 * byte for byte, so a photo can carry text that looks exactly like PDF syntax. The first version
 * of this file regex-scanned the whole buffer: a crafted 2 MiB JPEG full of fake object-stream
 * headers made that scan quadratic and blocked the API's event loop for ~28 s per render, and
 * fake `/Type /Page` entries in a photo could set the count. Skipping bodies makes the walk
 * linear and leaves image bytes unread. A stream whose `/Length` is not a direct integer cannot
 * be skipped safely, so it ends the walk with `null` — WeasyPrint writes direct lengths.
 *
 * ONLY OBJECT STREAMS ARE INFLATED. Fonts, page content and images are Flate streams too, and
 * none of them can carry the page tree; inflating the worker's photo would buy nothing but a
 * decompression-bomb surface. What is inflated is BUDGETED IN TOTAL, not per stream: at most
 * {@link MAX_OBJECT_STREAMS} object streams and {@link MAX_INFLATED_BYTES} across all of them.
 * Past either budget, or on any object stream that will not inflate, the answer is `null` — a
 * page tree read in part is a guess.
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
 * The inflate budget across ALL object streams in one file. WeasyPrint's object stream is a few
 * KiB of dictionaries (2.8 KiB for the 3-page fixture; a page dictionary is ~180 bytes), so
 * 4 MiB is thousands of pages of headroom — and the renderer already refuses any PDF over 8 MiB.
 */
export const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/** How many object streams one file may ask us to inflate. WeasyPrint writes one or two. */
export const MAX_OBJECT_STREAMS = 16;

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
/**
 * The start of an indirect object, `12 0 obj` — where a stream's dictionary begins. Its digit
 * runs are BOUNDED, like every quantifier over digits in this file: an unbounded `\d+` goes
 * quadratic on a long run of digits, and this file exists to stay linear on hostile bytes.
 */
const OBJECT_START_RE = /\d{1,10}\s+\d{1,5}\s+obj(?=[\s<]|$)/g;

/**
 * `/Count 2` or `/Length 670` as a DIRECT integer. An indirect `/Length 9 0 R` names another
 * object, not a length, and must not be read as 9. `(?!\d)` stops the regex backtracking to a
 * prefix of the number (`12 0 R` → `1`) to dodge the indirect-reference check.
 */
const DIRECT_COUNT_RE = /\/Count\s+(\d{1,9})(?!\d)(?!\s+\d{1,5}\s+R\b)/;
const DIRECT_LENGTH_RE = /\/Length\s+(\d{1,9})(?!\d)(?!\s+\d{1,5}\s+R\b)/;

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
    // Per call, never module state: its `lastIndex` is the walk's cursor.
    const streamStart = />>\s*stream(?:\r\n|\n|\r)/g;
    const readings: PageTreeReadings[] = [];
    let budget = MAX_INFLATED_BYTES;
    let objectStreams = 0;
    let cursor = 0;

    for (;;) {
      streamStart.lastIndex = cursor;
      const header = streamStart.exec(raw);
      // The object syntax up to (and including) the next stream's dictionary.
      const syntax = raw.slice(cursor, header ? header.index + 2 : raw.length);
      readings.push(readPageTree(syntax));
      if (!header) break;

      const dict = streamDictionary(syntax);
      const length = dict === null ? null : directInteger(dict, DIRECT_LENGTH_RE);
      const start = header.index + header[0].length;
      // A body we cannot measure cannot be skipped, and reading on would parse its bytes.
      if (dict === null || length === null || start + length > pdf.length) return null;

      if (OBJECT_STREAM_TYPE_RE.test(dict) && FLATE_FILTER_RE.test(dict)) {
        objectStreams += 1;
        if (objectStreams > MAX_OBJECT_STREAMS) return null;
        const text = inflateSync(pdf.subarray(start, start + length), {
          maxOutputLength: budget,
        }).toString("latin1");
        budget -= text.length;
        readings.push(readPageTree(text));
      }
      cursor = start + length;
    }
    return reconcile(readings);
  } catch {
    // Any input, however malformed — an object stream that will not inflate, a spent budget —
    // is "unknown". A page tree read in part would be a guess.
    return null;
  }
}

/** The dictionary of the stream whose `>>` ends `syntax`: from its `N G obj` to the end. */
function streamDictionary(syntax: string): string | null {
  let last: number | null = null;
  for (const object of syntax.matchAll(OBJECT_START_RE)) last = object.index;
  return last === null ? null : syntax.slice(last);
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

function directInteger(dict: string, re: RegExp): number | null {
  const match = re.exec(dict);
  return match?.[1] === undefined ? null : Number(match[1]);
}
