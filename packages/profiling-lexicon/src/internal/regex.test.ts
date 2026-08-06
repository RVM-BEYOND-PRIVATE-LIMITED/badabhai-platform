/**
 * Guards on the lexicon reader itself.
 *
 * The parity corpus proves the two languages AGREE. These tests prove the rules that keep them
 * able to agree — the banned-escape rule and the macro expander — which the corpus cannot,
 * because a pattern can be wrong in both languages identically.
 */

import { describe, expect, it } from "vitest";

import { LEXICON_FILE_STEMS } from "./data.generated.js";
import { compilePattern, expand, fragmentsOf, loadLexicon, skillKeywords } from "./regex.js";

/**
 * Every `{ source, flags }` object anywhere in a lexicon file, found structurally rather than
 * by a hardcoded list — so a NEW file or a NEW pattern is covered the day it is added, without
 * anyone remembering to extend this test.
 */
interface FoundPattern {
  path: string;
  stem: string;
  source: string;
  flags: string;
}

function collectPatterns(): FoundPattern[] {
  const found: FoundPattern[] = [];
  let stem = "";

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (typeof record["source"] === "string") {
      found.push({
        path,
        stem,
        source: record["source"],
        flags: typeof record["flags"] === "string" ? record["flags"] : "",
      });
      return;
    }
    for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`);
  };

  for (const fileStem of LEXICON_FILE_STEMS) {
    stem = fileStem;
    walk(loadLexicon<unknown>(fileStem), fileStem);
    // FRAGMENTS ARE PATTERN SOURCE TOO. They are bare strings rather than {source, flags}
    // objects, so the structural walk above cannot see them — and a `\w` hiding in a fragment
    // would reach every pattern that references it. Collected explicitly for that reason.
    for (const [name, source] of Object.entries(fragmentsOf(fileStem))) {
      found.push({ path: `${fileStem}.fragments.${name}`, stem: fileStem, source, flags: "" });
    }
  }
  return found;
}

const PATTERNS = collectPatterns();

describe("the common-regex-subset rule", () => {
  it("finds patterns to check at all", () => {
    // Without this, a bug in `collectPatterns` would make every assertion below vacuous.
    expect(PATTERNS.length).toBeGreaterThan(5);
  });

  it.each(PATTERNS.map((p) => [p.path, p] as const))(
    "%s uses no banned escape",
    (_path, pattern) => {
      // `\d` and `\w`: Python's are Unicode-aware, JavaScript's are ASCII-only.
      // `\b` is DEFINED in terms of `\w`, so it inherits exactly the same divergence.
      // `{WB}` / `{WE}` are the explicit replacements. See data/README.md.
      //
      // Matched on the RAW source, before expansion — the expansion itself contains none of
      // these, so checking afterwards would test the wrong string.
      expect(pattern.source, `${pattern.path}: \\d is ASCII-only in JS`).not.toMatch(/\\d/);
      expect(pattern.source, `${pattern.path}: \\w is ASCII-only in JS`).not.toMatch(/\\w/);
      expect(pattern.source, `${pattern.path}: \\b is defined on \\w — use {WB}/{WE}`).not.toMatch(
        /\\b/,
      );
    },
  );

  it.each(PATTERNS.map((p) => [p.path, p] as const))("%s compiles", (_path, pattern) => {
    // With that file's own fragments, which is how the real readers compile it.
    expect(() => compilePattern(pattern, fragmentsOf(pattern.stem))).not.toThrow();
  });

  it.each(PATTERNS.map((p) => [p.path, p] as const))(
    "%s declares only supported flags",
    (_path, pattern) => {
      expect([...pattern.flags].filter((f) => f !== "i")).toEqual([]);
    },
  );
});

describe("macro expansion", () => {
  it("expands the boundary macros to lookarounds, not to literal text", () => {
    const expanded = expand("{WB}iti{WE}");
    expect(expanded.startsWith("(?<![")).toBe(true);
    expect(expanded.endsWith("])")).toBe(true);
    expect(expanded).toContain("iti");
  });

  it("treats the Devanagari danda as a boundary, not a word character", () => {
    // The U+0964 danda is Po, so Python's `\w` excludes it. A boundary class that took the
    // whole U+0900-U+097F block made "idk।" stop matching — 15 measured regressions.
    const re = compilePattern({ source: "{WB}idk{WE}", flags: "i" });
    expect(re.test("idk।")).toBe(true);
    expect(re.test("idk")).toBe(true);
    expect(re.test("idk hai")).toBe(true);
    expect(re.test("idkx")).toBe(false);
    expect(re.test("xidk")).toBe(false);
  });

  it("treats Devanagari letters and digits as word characters", () => {
    const re = compilePattern({ source: "{WB}idk{WE}", flags: "i" });
    expect(re.test("idkहै")).toBe(false);
    expect(re.test("idk५")).toBe(false);
  });

  it("splices the skill keywords in file order", () => {
    const expanded = expand("{SKILL_KEYWORDS}");
    const keywords = skillKeywords();
    expect(keywords.length).toBeGreaterThan(0);
    expect(expanded).toBe(keywords.join("|"));
    // "tool offset" must precede "offset" or the generic term shadows the specific one.
    expect(keywords.indexOf("tool offset")).toBeLessThan(keywords.indexOf("offset"));
  });

  it("throws on an unknown macro instead of compiling it as a literal", () => {
    // `{NOPE}` is VALID regex syntax, so an un-expanded macro would compile happily and then
    // never match. A detector that never fires is the silent failure this package exists to
    // prevent, so it has to be loud.
    expect(() => expand("{NOPE}")).toThrow(/unknown lexicon macro/);
  });

  it("leaves regex quantifiers alone", () => {
    // `{0,24}` looks like a macro to a careless expander. The job-prospect pattern depends on it.
    expect(expand("a{0,24}b")).toBe("a{0,24}b");
  });

  it("rejects an unsupported flag rather than dropping it", () => {
    expect(() => compilePattern({ source: "x", flags: "gu" })).toThrow(/unsupported lexicon/);
  });
});

describe("data loading", () => {
  it("throws on an unknown file rather than returning an empty object", () => {
    // Fail closed: a missing gazetteer must not silently turn every detector into a no-op.
    expect(() => loadLexicon("does-not-exist")).toThrow(/unknown profiling-lexicon file/);
  });

  it("exposes every embedded file", () => {
    expect(LEXICON_FILE_STEMS).toContain("predicates");
    expect(LEXICON_FILE_STEMS).toContain("negation");
    expect(LEXICON_FILE_STEMS).toContain("skills");
  });
});
