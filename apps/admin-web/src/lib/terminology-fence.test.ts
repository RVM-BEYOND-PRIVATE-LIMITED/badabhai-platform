import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TERMINOLOGY FENCE — the names the owner retired on 2026-10-01 stay retired in what the console
 * SHOWS. Labels only: routes, API paths and capability keys keep their old words (`/jobs`,
 * `/transactions`, `suspend_payer`), and so do code identifiers and comments, which this fence
 * does not read. It reads the visible-text candidates in shipped code: string literals (double,
 * single and template) and JSX text.
 *
 *   - one spelling, "Resume" (never "Résumé");
 *   - "MFA", never "second factor" (the button, the column and the stat already said MFA);
 *   - the umbrella for Company + Agency is "Customers" / "account", never "Payer" on screen;
 *   - "Skill discovery" / "Skill candidate" in sentence case; "Roles and capabilities";
 *   - "View events" for the log, never "Open the event timeline" / "View in event timeline";
 *   - "Show every worker" did two different things and is gone.
 *
 * CASE. Each retired phrase is matched in any case — except "Skill Discovery" (whose sentence-case
 * replacement differs only in case) and the lower-case word "payer", which is also a key and a
 * path (`type="payer"`, `/admin/payers`). That one is matched only where it can only be prose:
 * in JSX text, and in a string literal with a space in it.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

interface Visible {
  /** String literals: "…", '…' and `…` (a template's TEXT — its `${…}` holes are code). */
  strings: string[];
  /** JSX text between tags. */
  jsx: string[];
}

function visibleText(code: string): Visible {
  const literals = code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  return {
    // A template's holes are expressions (`${payer.id}`), not text anyone reads.
    strings: literals.map((s) => (s.startsWith("`") ? s.replace(/\$\{[^}]*\}/g, "x") : s)),
    jsx: code.match(/>[^<>{}]*</g) ?? [],
  };
}

const all = (v: Visible) => [...v.strings, ...v.jsx];
/** Text that can only be prose: JSX text, and string literals with a space in them. */
const prose = (v: Visible) => [...v.strings.filter((s) => /\s/.test(s)), ...v.jsx];

const RETIRED: readonly { what: string; found: (v: Visible) => boolean }[] = [
  {
    what: "Résumé (one spelling: Resume)",
    found: (v) => all(v).some((t) => /résumé/i.test(t)),
  },
  {
    what: "second factor (say MFA)",
    found: (v) => all(v).some((t) => /second\s+factor/i.test(t)),
  },
  {
    what: "Payer as a visible name (say Customer / account)",
    found: (v) =>
      all(v).some((t) => /(^|[\s"'`>])Payers?\b/.test(t)) ||
      prose(v).some((t) => /\bpayers?\b/i.test(t)),
  },
  {
    what: "Skill Discovery / Skill Candidate (sentence case)",
    found: (v) => all(v).some((t) => /Skill (Discovery|Candidate)/.test(t)),
  },
  {
    what: "Roles & capabilities",
    found: (v) => all(v).some((t) => /roles &(amp;)? capabilities/i.test(t)),
  },
  {
    what: "Open the event timeline / View in event timeline",
    found: (v) => all(v).some((t) => /open the event timeline|view in event timeline/i.test(t)),
  },
  {
    what: "Show every worker",
    found: (v) => all(v).some((t) => /show every worker/i.test(t)),
  },
];

function shipped(): Map<string, Visible> {
  const out = new Map<string, Visible>();
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
  const v = (src: string) => visibleText(stripComments(src));
  const hits = (src: string) => RETIRED.filter((r) => r.found(v(src))).map((r) => r.what);

  it("reads double-, single- and back-quoted strings and JSX text — not identifiers or comments", () => {
    expect(all(v('const a = "Payer suspended.";'))).toContain('"Payer suspended."');
    expect(all(v("const a = 'Payer suspended.';"))).toContain("'Payer suspended.'");
    expect(all(v("const a = `Payer ${x}`;")).join()).toContain("Payer");
    // A template's holes are code: `${payer.id}` is a variable, not a word on screen.
    expect(all(v("const h = `/companies/${payer.id} and ${payer.role}`;")).join()).not.toMatch(
      /payer/,
    );
    expect(all(v("<p>Résumé generated</p>")).join()).toContain("Résumé generated");
    expect(all(v("const payerId = getPayer(id); // Payer")).join()).not.toMatch(/payer/i);
    expect(all(v("/* second factor */ const x = 1;")).join()).not.toMatch(/second factor/);
  });

  it("each retired name is caught in a sample, in any case, and its replacement is not", () => {
    expect(hits('const a = "Résumé generated";')).toHaveLength(1);
    expect(hits('const a = "résumés";')).toHaveLength(1);
    expect(hits('const a = "Resume generated";')).toHaveLength(0);
    expect(hits('const a = "No second factor was enrolled";')).toHaveLength(1);
    expect(hits("const a = 'reset your Second Factor';")).toHaveLength(1);
    expect(hits('const a = "No MFA was enrolled";')).toHaveLength(0);
    expect(hits("const a = 'Payer reinstated.';")).toHaveLength(1);
    expect(hits('const a = "Customers holding credits";')).toHaveLength(0);
    expect(hits("<h3>Skill Discovery</h3>")).toHaveLength(1);
    expect(hits("<h3>Skill discovery</h3>")).toHaveLength(0);
    expect(hits("<a>show every worker</a>")).toHaveLength(1);
    expect(hits('const a = "open the event timeline";')).toHaveLength(1);
  });

  it("catches a lower-case payer where it can only be prose, and not in a key or a path", () => {
    expect(hits('const a = "This payer is suspended.";')).toHaveLength(1);
    expect(hits("<p>the payer account</p>")).toHaveLength(1);
    expect(hits('<EntityTimeline type="payer" />')).toHaveLength(0);
    expect(hits('fetch("/admin/payers?role=agent");')).toHaveLength(0);
    expect(hits("const k = 'payer';")).toHaveLength(0);
  });

  it("walks the shipped sources", () => {
    expect(TEXT.size).toBeGreaterThan(50);
  });
});

describe("terminology fence — the console", () => {
  for (const { what, found } of RETIRED) {
    it(`never shows: ${what}`, () => {
      const offenders = [...TEXT].filter(([, text]) => found(text)).map(([f]) => f);
      expect(offenders).toEqual([]);
    });
  }
});
