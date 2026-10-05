import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * THE BROWSER FLOOR, ENFORCED (#1927). payer-web imports this package into its client form
 * schemas (`apps/payer-web/src/lib/contracts.ts`) and does not transpile it, and no build step
 * ever rewrites a regular expression. Next's default browser target is Chrome 64, Edge 79,
 * Firefox 67, Opera 51 and Safari 12 (`next/dist/shared/lib/modern-browserslist-target.js`). So a
 * regex feature one of them cannot PARSE, anywhere in this package's shipped source — even in a
 * function payer-web never calls — is a SyntaxError for the whole chunk, and payer-web's forms
 * stop working on those browsers.
 *
 * Banned, with the first browser on the floor that rejects each:
 *  - lookbehind `(?<=` / `(?<!`           Safari < 16.4, Firefox < 78
 *  - named group `(?<name>` and `\k<name>` Firefox < 78
 *  - property escape `\p{..}` / `\P{..}`   Firefox < 78
 *  - flags s (dotAll), d (indices), v      Firefox < 78 / Chrome < 90 / Chrome < 112
 *
 * The scan reads the CODE, not the comments: every regex literal, every string and template
 * piece (a pattern built with `new RegExp(...)` is assembled from those), and the flags argument
 * of every `RegExp(...)` call, which must be a literal so it can be read. Before this test the
 * rule lived only in a comment beside `looksLikeUrl`.
 */

const ALLOWED_FLAGS = /^[gimuy]*$/;

const FORBIDDEN_PATTERNS: readonly { readonly hazard: string; readonly re: RegExp }[] = [
  { hazard: "lookbehind", re: /\(\?<[=!]/ },
  { hazard: "named group", re: /\(\?<[A-Za-z_$]/ },
  { hazard: "named backreference", re: /\\k</ },
  { hazard: "property escape", re: /\\[pP]\{/ },
];

function isRegExpCall(node: ts.Node): node is ts.NewExpression | ts.CallExpression {
  return (
    (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "RegExp"
  );
}

function isPatternText(node: ts.Node): boolean {
  return (
    ts.isRegularExpressionLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** Every browser-floor hazard in one source text, as `hazard: snippet` lines. */
function browserFloorHazards(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hazards: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isPatternText(node)) {
      const raw = node.getText(file);
      for (const { hazard, re } of FORBIDDEN_PATTERNS) {
        if (re.test(raw)) hazards.push(`${hazard}: ${raw.slice(0, 60)}`);
      }
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const flags = node.text.slice(node.text.lastIndexOf("/") + 1);
      if (!ALLOWED_FLAGS.test(flags)) hazards.push(`flag: ${node.text.slice(0, 60)}`);
    }
    if (isRegExpCall(node)) {
      const flags = node.arguments?.[1];
      if (flags !== undefined) {
        if (!ts.isStringLiteral(flags) && !ts.isNoSubstitutionTemplateLiteral(flags)) {
          hazards.push(`unreadable flags: ${flags.getText(file)}`);
        } else if (!ALLOWED_FLAGS.test(flags.text)) {
          hazards.push(`flag: "${flags.text}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hazards;
}

/** Every non-test `.ts` under `dir`, recursively — what `tsconfig.build.json` ships. */
function shippedSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe("browser floor — no regex syntax payer-web's browsers cannot parse", () => {
  const sources = shippedSources(__dirname);

  it("scans the shipped sources, index.ts among them", () => {
    expect(sources.map((f) => relative(__dirname, f))).toContain("index.ts");
  });

  it.each(sources.map((f) => [relative(__dirname, f), f]))("%s has no hazard", (_name, file) => {
    expect(browserFloorHazards(file, readFileSync(file, "utf8"))).toEqual([]);
  });

  it("reaches the patterns built with new RegExp, not only the literals", () => {
    // A scan that read no template piece would pass vacuously: index.ts builds most of its
    // org patterns from String.raw templates.
    const index = readFileSync(join(__dirname, "index.ts"), "utf8");
    const file = ts.createSourceFile("index.ts", index, ts.ScriptTarget.Latest, true);
    let calls = 0;
    let templates = 0;
    const visit = (node: ts.Node): void => {
      if (isRegExpCall(node)) calls++;
      if (ts.isTemplateHead(node) || ts.isNoSubstitutionTemplateLiteral(node)) templates++;
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(templates).toBeGreaterThanOrEqual(5);
  });

  // The scanner itself, seen to fire on each hazard — a test that cannot fail proves nothing.
  it.each([
    ["a lookbehind literal", String.raw`const A = /(?<![a-z])ltd/;`],
    ["a negative lookbehind in a template", "const A = new RegExp(String.raw`(?<!x)ltd`);"],
    ["a positive lookbehind in a string", String.raw`const A = new RegExp("(?<=x)ltd");`],
    ["a named group", String.raw`const A = /(?<name>ltd)/;`],
    ["a named backreference", String.raw`const A = /(a)\k<a>/;`],
    ["a property escape literal", String.raw`const A = /\p{L}/u;`],
    ["a property escape in a string", String.raw`const A = new RegExp("\\P{L}", "u");`],
    ["an s flag", String.raw`const A = /a.b/s;`],
    ["a d flag", String.raw`const A = /a/d;`],
    ["a v flag in a RegExp call", String.raw`const A = new RegExp("a", "v");`],
    ["computed flags", String.raw`const F = "s"; const A = new RegExp("a", F);`],
  ])("flags %s", (_what, source) => {
    expect(browserFloorHazards("probe.ts", source)).not.toEqual([]);
  });

  it.each([
    ["the ordinary flags", String.raw`const A = /a/gimuy; const B = new RegExp("a", "i");`],
    ["a lookahead and a non-capturing group", String.raw`const A = /(?:a)(?!b)(?=c)/;`],
    ["a hazard named only in a comment", "// (?<!x) and \\p{L}\nconst A = /a/;"],
  ])("does not flag %s", (_what, source) => {
    expect(browserFloorHazards("probe.ts", source)).toEqual([]);
  });
});
