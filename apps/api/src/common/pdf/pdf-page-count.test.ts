import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { countPdfPages, MAX_OBJECT_STREAM_BYTES } from "./pdf-page-count";

/**
 * The page counter is tested against REAL WeasyPrint 69.0 output first, hand-built bytes second.
 *
 * `__fixtures__/page-count/*.pdf` were rendered by the repo's `bb-weasy:local` image (the API
 * image's runtime stage) and checked with pypdf: `two-pages.pdf` is 2 pages, and
 * `three-pages-outlined.pdf` is 3 pages with a heading outline whose root says `/Count 6`. The
 * 1-page case reuses the committed font-probe render rather than copying it.
 */
const PAGE_COUNT_FIXTURES = join(__dirname, "__fixtures__", "page-count");
const FONT_PROBE_FIXTURES = join(__dirname, "..", "..", "resume", "__fixtures__", "font-probe");

const ONE_PAGE = readFileSync(join(FONT_PROBE_FIXTURES, "full-fonts.pdf"));
const TWO_PAGES = readFileSync(join(PAGE_COUNT_FIXTURES, "two-pages.pdf"));
const THREE_PAGES_OUTLINED = readFileSync(join(PAGE_COUNT_FIXTURES, "three-pages-outlined.pdf"));
const REAL_RENDERS = { ONE_PAGE, TWO_PAGES, THREE_PAGES_OUTLINED };

/**
 * Every stream in the file, inflated where it inflates. Deliberately NOT the code under test:
 * the vacuity guards below must hold whatever the implementation does.
 */
function inflateEveryStream(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const texts: string[] = [];
  for (const header of raw.matchAll(/>>\r?\nstream\r?\n/g)) {
    const start = header.index + header[0].length;
    try {
      texts.push(inflateSync(pdf.subarray(start, raw.indexOf("endstream", start))).toString());
    } catch {
      // Not Flate. Irrelevant here.
    }
  }
  return texts.join("\n");
}

/** A PDF-shaped buffer: numbered objects, no xref (the reader never consults one). */
function buildPdf(...objects: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  objects.forEach((body, i) => {
    parts.push(
      Buffer.from(`${i + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n"),
    );
  });
  parts.push(Buffer.from("trailer\n<</Root 1 0 R>>\n%%EOF\n"));
  return Buffer.concat(parts);
}

/** A Flate stream object. `length` is a direct integer by default, or an indirect reference. */
function flateStream(dictEntries: string, content: string, length = "direct"): Buffer {
  const data = deflateSync(Buffer.from(content, "latin1"));
  const declared = length === "direct" ? String(data.length) : length;
  return Buffer.concat([
    Buffer.from(`<<${dictEntries}/Filter /FlateDecode/Length ${declared}>>\nstream\n`),
    data,
    Buffer.from("\nendstream"),
  ]);
}

const CATALOG = "<</Type /Catalog/Pages 2 0 R>>";
const LEAF = "<</Type /Page/Parent 2 0 R/MediaBox [0 0 595 842]>>";
const pagesNode = (count: number | string, kids: string): string =>
  `<</Type /Pages/Kids [${kids}]/Count ${count}>>`;

const OBJECT_STREAM = "/Type /ObjStm/N 2/First 0";
const IMAGE_STREAM = "/Type /XObject/Subtype /Image/Width 1/Height 1";
/** What an object stream holding a one-page tree inflates to. */
const ONE_PAGE_TREE = `${pagesNode(1, "3 0 R")}\n<</Type /Page/Parent 1 0 R>>`;

describe("countPdfPages on real WeasyPrint 69.0 renders", () => {
  it("reads the 1-page font-probe render as 1", () => {
    expect(countPdfPages(ONE_PAGE)).toBe(1);
  });

  it("reads a 2-page render as 2", () => {
    expect(countPdfPages(TWO_PAGES)).toBe(2);
  });

  it("reads 3 pages from a render whose outline says /Count 6", () => {
    expect(countPdfPages(THREE_PAGES_OUTLINED)).toBe(3);
  });

  it("VACUITY: the page tree is not in the raw bytes, so the object-stream path is exercised", () => {
    for (const [name, pdf] of Object.entries(REAL_RENDERS)) {
      expect(pdf.toString("latin1"), name).not.toContain("/Type /Page");
      expect(inflateEveryStream(pdf), name).toContain("/Type /Pages");
    }
  });

  it("VACUITY: the outlined render really carries the /Count 6 trap", () => {
    const text = inflateEveryStream(THREE_PAGES_OUTLINED);
    const naiveMaxCount = Math.max(
      ...[...text.matchAll(/\/Count (\d+)/g)].map((m) => Number(m[1])),
    );
    expect(naiveMaxCount).toBe(6);
    expect(text).toContain("<</Count 6/First");
  });
});

describe("countPdfPages on hand-built PDFs", () => {
  it("counts an uncompressed two-page PDF", () => {
    expect(countPdfPages(buildPdf(CATALOG, pagesNode(2, "3 0 R 4 0 R"), LEAF, LEAF))).toBe(2);
  });

  it("takes the ROOT /Count across an intermediate page-tree node, not the sum", () => {
    const pdf = buildPdf(
      CATALOG,
      pagesNode(3, "3 0 R 4 0 R"),
      "<</Type /Pages/Parent 2 0 R/Kids [5 0 R 6 0 R]/Count 2>>",
      LEAF,
      LEAF,
      LEAF,
    );
    expect(countPdfPages(pdf)).toBe(3);
  });

  it("returns null when the declared total and the leaves disagree", () => {
    expect(countPdfPages(buildPdf(CATALOG, pagesNode(3, "3 0 R 4 0 R"), LEAF, LEAF))).toBeNull();
  });

  it("uses the one reading that exists when the other is absent", () => {
    expect(countPdfPages(buildPdf(CATALOG, pagesNode(2, "3 0 R 4 0 R")))).toBe(2);
    expect(countPdfPages(buildPdf(CATALOG, LEAF, LEAF))).toBe(2);
  });

  it("never answers 0 or an unrepresentable count", () => {
    expect(countPdfPages(buildPdf(CATALOG, pagesNode(0, "")))).toBeNull();
    expect(countPdfPages(buildPdf(CATALOG, pagesNode("99999999999999999999", "")))).toBeNull();
  });

  it("reads an object stream whose /Length is an indirect reference, up to endstream", () => {
    // `12 0 R` names object 12. Read as a length it is 12 (or 1, if the regex backtracks),
    // either of which cuts the Flate data short and loses the tree.
    expect(countPdfPages(buildPdf(flateStream(OBJECT_STREAM, ONE_PAGE_TREE, "12 0 R")))).toBe(1);
  });

  it("never inflates a Flate stream that is not an object stream — the photo case", () => {
    // Control first: the same bytes as an object stream ARE read, so the null is the type.
    expect(countPdfPages(buildPdf(flateStream(OBJECT_STREAM, ONE_PAGE_TREE)))).toBe(1);
    expect(countPdfPages(buildPdf(flateStream(IMAGE_STREAM, ONE_PAGE_TREE)))).toBeNull();
  });

  it("skips an object stream that inflates past the cap, instead of throwing", () => {
    const within = buildPdf(flateStream(OBJECT_STREAM, ONE_PAGE_TREE + " ".repeat(1024)));
    const past = buildPdf(
      flateStream(OBJECT_STREAM, ONE_PAGE_TREE + " ".repeat(MAX_OBJECT_STREAM_BYTES)),
    );
    // Control: the same tree under the cap is read, so the null below is the cap.
    expect(countPdfPages(within)).toBe(1);
    expect(countPdfPages(past)).toBeNull();
  });
});

describe("countPdfPages never throws", () => {
  it("returns null for empty, non-PDF and arbitrary bytes", () => {
    const arbitrary = Buffer.from(
      Array.from({ length: 64 * 1024 }, (_, i) => (i * 2654435761) % 256),
    );
    expect(countPdfPages(Buffer.alloc(0))).toBeNull();
    expect(countPdfPages(Buffer.from("not a pdf at all"))).toBeNull();
    expect(countPdfPages(arbitrary)).toBeNull();
  });

  it("returns null for an object stream that is not Flate data", () => {
    const pdf = `%PDF-1.7\n1 0 obj\n<<${OBJECT_STREAM}/Filter /FlateDecode/Length 10>>\nstream\nnot-flate!\nendstream`;
    expect(countPdfPages(Buffer.from(pdf))).toBeNull();
  });

  it("returns null for a render truncated inside its object stream", () => {
    const body = TWO_PAGES.indexOf("/Type /ObjStm");
    expect(body).toBeGreaterThan(0);
    expect(countPdfPages(TWO_PAGES.subarray(0, body + 200))).toBeNull();
  });

  it("answers 2 or null — never another number — at every truncation point of a 2-page render", () => {
    const outcomes = new Set<number | null>();
    for (let end = 0; end <= TWO_PAGES.length; end += 1) {
      outcomes.add(countPdfPages(TWO_PAGES.subarray(0, end)));
    }
    // Both outcomes observed: the loop reached the readable tail and the unreadable prefix.
    expect(outcomes).toEqual(new Set([2, null]));
  });
});
