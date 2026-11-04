import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A3 (#2573) — NO LITERAL BACKTICKS OR REPO PATHS IN THE UI. An operator reads "the
 * `skill_candidate` table" or "see `docs/operations/….md`" as noise: the backticks are markdown
 * that never renders, and a path into the repo is somewhere they cannot go.
 *
 * Read from source with the TypeScript AST, so comments (which may say anything) are never
 * counted: only JSX text in a .tsx file is checked, because that is what a page renders as
 * written. A string a page renders through a variable is the vocabulary modules' job and is
 * pinned in their own tests.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const REPO_PATH = /\b(?:apps|packages|docs)\/[\w.-]/;
const BACKTICK = /`/;

/** The JSX text runs in a TSX source that carry a backtick or a repo path. */
export function offendingJsxText(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && (BACKTICK.test(node.text) || REPO_PATH.test(node.text))) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push(`${fileName}:${line}: ${node.text.trim().slice(0, 120)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function shippedTsx(): [string, string][] {
  const out: [string, string][] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(ent.name))
        out.push([relative(srcRoot, full).replace(/\\/g, "/"), readFileSync(full, "utf8")]);
    }
  })(srcRoot);
  return out;
}

describe("no literal backticks or repo paths in the UI (#2573)", () => {
  it("the detector reads JSX text and ignores comments", () => {
    expect(offendingJsxText("t.tsx", "const a = <p>the `x` table</p>;")).toHaveLength(1);
    expect(offendingJsxText("t.tsx", "const a = <p>see docs/operations/plan.md</p>;")).toHaveLength(1);
    expect(offendingJsxText("t.tsx", "const a = <p>{/* `x` in packages/db */}plain</p>;")).toEqual([]);
    expect(offendingJsxText("t.tsx", "// `x`\nconst a = <p>plain</p>;")).toEqual([]);
  });

  it("no shipped page or component renders one", () => {
    const offenders = shippedTsx().flatMap(([f, src]) => offendingJsxText(f, src));
    expect(offenders).toEqual([]);
  });
});
