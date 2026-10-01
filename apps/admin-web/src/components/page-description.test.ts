import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * ONE SENTENCE under every page title (owner ruling 4, 2026-10-01): the description says what
 * the page is; mechanics and privacy notes go in a notice below the header.
 *
 * Read from source with the TypeScript AST, because a description is often JSX with branches
 * (`posture === "faceless" ? "…" : "…"`) and only one branch renders. Every text a description
 * can render is enumerated — each ternary branch, each `&&`, each template — with any other
 * expression (a date, a name) standing in as a placeholder word, and each must hold one
 * sentence. Descriptions are found in two shapes: a `description` prop on `<PageHeader>`, and a
 * `description` property of a header object (`{ title, description }`) that a page hands to a
 * client header.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ALTERNATIVES = 256;

/** JSX whitespace rules: lines trimmed at their joins, blank lines dropped, joined by a space. */
function jsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  return lines
    .map((line, i) => {
      let l = line.replace(/\t/g, " ");
      if (i !== 0) l = l.replace(/^ +/, "");
      if (i !== lines.length - 1) l = l.replace(/ +$/, "");
      return l;
    })
    .filter((l, _i, all) => l !== "" || all.length === 1)
    .join(" ");
}

const ENTITIES: Record<string, string> = {
  "&apos;": "'",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&amp;": "&",
};
const decode = (s: string) => s.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e);

/**
 * Every combination of the parts. Past MAX_ALTERNATIVES it THROWS rather than keep the first
 * few: a guard that silently stopped enumerating would pass a description whose 257th branch
 * is two sentences.
 */
function product(parts: string[][]): string[] {
  let out = [""];
  for (const alts of parts) {
    if (out.length * alts.length > MAX_ALTERNATIVES) throw tooMany(out.length * alts.length);
    const next: string[] = [];
    for (const a of out) for (const b of alts) next.push(a + b);
    out = next;
  }
  return out;
}

const tooMany = (n: number) =>
  new Error(
    `a description can render ${n} texts, more than the ${MAX_ALTERNATIVES} this guard reads — ` +
      "split it, so every branch can still be checked",
  );

/** Alternatives from branches (a ternary, `||`), held to the same ceiling as a product. */
function either(...branches: string[][]): string[] {
  const all = branches.flat();
  if (all.length > MAX_ALTERNATIVES) throw tooMany(all.length);
  return all;
}

/** Every text `node` can render. Anything that is not text-producing is the word "x". */
export function renderedTexts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [node.head.text + node.templateSpans.map((s) => "x" + s.literal.text).join("")];
  if (ts.isParenthesizedExpression(node)) return renderedTexts(node.expression);
  if (ts.isJsxExpression(node)) return node.expression ? renderedTexts(node.expression) : [""];
  if (ts.isConditionalExpression(node))
    return either(renderedTexts(node.whenTrue), renderedTexts(node.whenFalse));
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return either([""], renderedTexts(node.right));
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
      return either(renderedTexts(node.left), renderedTexts(node.right));
    if (op === ts.SyntaxKind.PlusToken)
      return product([renderedTexts(node.left), renderedTexts(node.right)]);
    return ["x"];
  }
  if (ts.isJsxFragment(node) || ts.isJsxElement(node))
    return product(
      node.children.map((child) =>
        ts.isJsxText(child) ? [decode(jsxText(child.text))] : renderedTexts(child),
      ),
    );
  if (ts.isJsxSelfClosingElement(node)) return [""];
  return ["x"];
}

/**
 * Dots that do not end a sentence: abbreviations ("e.g.", "i.e.", "etc.", "vs.", "approx.",
 * "incl.", "a.m.", "p.m."), "Rs." and "No." before a figure, and an ellipsis inside a sentence.
 * Their dots are dropped before counting. (A sentence that really ends on "etc." then counts
 * as no end at all — a guard that errs toward passing one sentence, never toward failing one.)
 */
function withoutFalseEnds(text: string): string {
  return text
    .replace(/\b(?:e\.g|i\.e|etc|vs|approx|incl|a\.m|p\.m)\./gi, (m) => m.replace(/\./g, ""))
    .replace(/\b(?:Rs|No)\.(?=\s*\d)/gi, (m) => m.replace(/\./g, ""))
    .replace(/\.{3}(?=\s)/g, "…");
}

/** Sentence ends: `.`, `!` or `?` followed by a space or the end (closing quotes allowed). */
export const sentenceCount = (text: string): number =>
  (withoutFalseEnds(text.trim()).match(/[.!?](?=["'”’)\]]*(\s|$))/g) ?? []).length;

interface Found {
  where: string;
  texts: string[];
}

/** The descriptions a TSX source declares. */
export function descriptionsIn(fileName: string, source: string): Found[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Found[] = [];
  const at = (n: ts.Node) =>
    `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    // <PageHeader description="…" /> or description={…}
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sf) === "description" &&
      ts.isJsxAttributes(node.parent) &&
      node.parent.parent.tagName.getText(sf) === "PageHeader" &&
      node.initializer
    ) {
      found.push({ where: at(node), texts: renderedTexts(node.initializer) });
    }
    // const header = { back, title, description: … }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sf) === "description" &&
      ts.isObjectLiteralExpression(node.parent) &&
      node.parent.properties.some((p) => p.name?.getText(sf) === "title")
    ) {
      found.push({ where: at(node), texts: renderedTexts(node.initializer) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function shippedTsx(): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(ent.name))
        out.set(relative(srcRoot, full).replace(/\\/g, "/"), readFileSync(full, "utf8"));
    }
  })(srcRoot);
  return out;
}

const ALL = [...shippedTsx()].flatMap(([file, src]) => descriptionsIn(file, src));

describe("the detector", () => {
  const one = (src: string) => descriptionsIn("t.tsx", src).flatMap((d) => d.texts);

  it("counts sentences, not dots inside a word or a figure", () => {
    expect(sentenceCount("Every posting on the platform.")).toBe(1);
    expect(sentenceCount("One thing. Another thing.")).toBe(2);
    expect(sentenceCount("Version v1.2 of the pack, 3.5 days")).toBe(0);
    expect(sentenceCount("Says “stop.” Then more.")).toBe(2);
  });

  it("does not end a sentence on an abbreviation, a currency or number sign, or an ellipsis", () => {
    expect(sentenceCount("Trades, e.g. welding, and i.e. fitting, etc. all count.")).toBe(1);
    expect(sentenceCount("Pay from Rs. 500 to Rs.900 a month.")).toBe(1);
    expect(sentenceCount("Shift No. 5 runs from 6 a.m. to 2 p.m. daily.")).toBe(1);
    expect(sentenceCount("Approx. ten postings, incl. paused ones, vs. last week.")).toBe(1);
    expect(sentenceCount("Loading... then the list.")).toBe(1);
    // …and a real second sentence is still caught after one of them.
    expect(sentenceCount("Pay from Rs. 500. Paid monthly.")).toBe(2);
    expect(sentenceCount("Say no. Then stop.")).toBe(2);
  });

  it("throws past its ceiling instead of silently reading only the first few branches", () => {
    const choices = (n: number) =>
      `const a = <PageHeader title="T" description={<>${Array.from(
        { length: n },
        (_, i) => `{c${i} ? "a" : "b"}`,
      ).join("")}</>} />;`;
    // Nine binary choices in one fragment: 512 texts.
    expect(() => descriptionsIn("t.tsx", choices(9))).toThrow(/more than the 256/);
    // Eight are fine: 256 texts, each one read.
    const texts = descriptionsIn("t.tsx", choices(8))[0]!.texts;
    expect(texts).toHaveLength(256);
    expect(new Set(texts).size).toBe(256);
  });

  it("enumerates every branch a description can render", () => {
    const texts = one(
      'const a = <PageHeader title="T" description={<>{ok ? "A one." : "B one."}{" "}Then two.</>} />;',
    );
    expect(texts).toEqual(["A one. Then two.", "B one. Then two."]);
  });

  it("joins JSX text the way React renders it, and stands a placeholder in for values", () => {
    const texts = one(
      "const a = <PageHeader title=\"T\" description={<>\n  Registered {when}\n  , today.\n</>} />;",
    );
    expect(texts).toEqual(["Registered x, today."]);
  });

  it("finds a header object's description as well as the PageHeader prop", () => {
    expect(one('const header = { title: "T", description: "One. Two." };')).toEqual(["One. Two."]);
    // An object without a title is not a header.
    expect(one('const other = { description: "One. Two." };')).toEqual([]);
  });

  it("walks every page header in the portal", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(22);
    const files = new Set(ALL.map((d) => d.where.split(":")[0]));
    for (const f of [
      "components/payer-detail.tsx",
      "app/(portal)/workers/[id]/page.tsx",
      "app/(portal)/jobs/[id]/page.tsx",
      "app/(portal)/events/[id]/page.tsx",
      "components/entity-timeline.tsx",
    ]) {
      expect(files.has(f), f).toBe(true);
    }
  });
});

describe("every page description is one sentence", () => {
  it("in every branch it can render", () => {
    const offenders = ALL.flatMap((d) =>
      d.texts.filter((t) => sentenceCount(t) > 1).map((t) => `${d.where}: ${t}`),
    );
    expect(offenders).toEqual([]);
  });
});
