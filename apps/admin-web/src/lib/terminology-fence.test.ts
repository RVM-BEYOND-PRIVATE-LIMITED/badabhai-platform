import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TERMINOLOGY FENCE — the names the owner retired on 2026-10-01 stay retired in what the console
 * SHOWS. Labels only: routes, API paths and capability keys keep their old words (`/jobs`,
 * `/transactions`, `suspend_payer`), and so do code identifiers and comments, which this fence
 * does not read. It reads string literals and JSX text in shipped code.
 *
 *   - one spelling, "Resume" (never "Résumé");
 *   - "MFA", never "second factor" (the button, the column and the stat already said MFA);
 *   - the umbrella for Company + Agency is "Customers" / "account", never "Payer" on screen;
 *   - "Skill discovery" / "Skill candidate" in sentence case; "Roles and capabilities";
 *   - "View events" for the log, never "Open the event timeline" / "View in event timeline";
 *   - "Show every worker" did two different things and is gone.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** The visible-text candidates in code: string literals, template text, and JSX text. */
function visibleText(code: string): string {
  const strings = code.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  const jsxText = code.match(/>[^<>{}]*</g) ?? [];
  return [...strings, ...jsxText].join("\n");
}

const RETIRED: readonly { what: string; re: RegExp }[] = [
  { what: "Résumé (one spelling: Resume)", re: /[Rr]ésumé/ },
  { what: "second factor (say MFA)", re: /second\s+factor/i },
  { what: "Payer as a visible name (say Customer / account)", re: /(^|[\s"`>])Payers?\b/ },
  { what: "Skill Discovery / Skill Candidate (sentence case)", re: /Skill (Discovery|Candidate)/ },
  { what: "Roles & capabilities", re: /Roles &(amp;)? capabilities/ },
  {
    what: "Open the event timeline / View in event timeline",
    re: /Open the event timeline|View in event timeline/,
  },
  { what: "Show every worker", re: /Show every worker/ },
];

function shipped(): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name))
        out.set(
          relative(srcRoot, full).replace(/\\/g, "/"),
          visibleText(stripComments(readFileSync(full, "utf8"))),
        );
    }
  })(srcRoot);
  return out;
}

const TEXT = shipped();

describe("terminology fence — the detectors", () => {
  it("reads strings and JSX text, not identifiers or comments", () => {
    const t = (src: string) => visibleText(stripComments(src));
    expect(t('const a = "Payer suspended.";')).toContain("Payer suspended.");
    expect(t("<p>Résumé generated</p>")).toContain("Résumé generated");
    expect(t("const payerId = getPayer(id); // Payer")).not.toMatch(/Payer\b/);
    expect(t("/* second factor */ const x = 1;")).not.toMatch(/second factor/);
  });

  it("each retired name is caught in a sample, and its replacement is not", () => {
    const hits = (sample: string) => RETIRED.filter((r) => r.re.test(sample)).map((r) => r.what);
    expect(hits('"Résumé generated"')).toHaveLength(1);
    expect(hits('"Resume generated"')).toHaveLength(0);
    expect(hits('"No second factor was enrolled"')).toHaveLength(1);
    expect(hits('"No MFA was enrolled"')).toHaveLength(0);
    expect(hits('"Payer reinstated."')).toHaveLength(1);
    expect(hits('"Customers holding credits"')).toHaveLength(0);
    expect(hits(">Skill Discovery<")).toHaveLength(1);
    expect(hits(">Skill discovery<")).toHaveLength(0);
  });

  it("walks the shipped sources", () => {
    expect(TEXT.size).toBeGreaterThan(50);
  });
});

describe("terminology fence — the console", () => {
  for (const { what, re } of RETIRED) {
    it(`never shows: ${what}`, () => {
      const offenders = [...TEXT].filter(([, text]) => re.test(text)).map(([f]) => f);
      expect(offenders).toEqual([]);
    });
  }
});
