import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * TERMINOLOGY FENCE — the names the owner retired on 2026-10-01 stay retired in what the console
 * SHOWS. Labels only: routes, API paths and capability keys keep their old words (`/jobs`,
 * `/transactions`, `suspend_payer`), and so do code identifiers and comments, which this fence
 * does not read. It reads the visible-text candidates in shipped code: string literals (double,
 * single and template) and JSX text.
 *
 *   - one spelling, "Resume" (never "Résumé");
 *   - "MFA", never "second factor" (the button, the column and the stat already said MFA);
 *   - the umbrella for Company + Agency is "Customers" / "Customer", never "Payer" on screen;
 *   - "Skill discovery" / "Skill candidate" in sentence case; "Roles and capabilities";
 *   - "View events" for the log, never "Open the event timeline" / "View in event timeline";
 *   - "Show every worker" did two different things and is gone;
 *   - and from the final acceptance sweep: "MFA", never "Two-factor"; a worker's apply or skip is
 *     a "posting decision", never a "job decision"; the payer is a "Customer", never an "Owner
 *     account"; the way to page one is "Back to the first page", never "Back to the newest".
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
    what: "Payer as a visible name (say Customer)",
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
  // ── the final acceptance sweep (2026-10-06): one name per concept ───────────────────────
  {
    what: "Two-factor (say MFA)",
    found: (v) => all(v).some((t) => /two[\s-]factor/i.test(t)),
  },
  {
    what: "Job decision(s) (a worker's apply or skip on a Posting is a posting decision)",
    found: (v) => all(v).some((t) => /\bjob[\s-]decisions?\b/i.test(t)),
  },
  {
    what: "Owner account (the payer is a Customer; Account is their own settings page)",
    found: (v) => all(v).some((t) => /owner account/i.test(t)),
  },
  {
    what: "Back to the newest (it is Back to the first page, like every other way to page one)",
    found: (v) => all(v).some((t) => /back to the newest/i.test(t)),
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
    expect(hits('const a = "Two-factor code";')).toHaveLength(1);
    expect(hits("<h1>two factor code</h1>")).toHaveLength(1);
    expect(hits('const a = "MFA code";')).toHaveLength(0);
    expect(hits("<h2>Recent job decisions</h2>")).toHaveLength(1);
    expect(hits('const a = "the job-decisions read failed";')).toHaveLength(1);
    expect(hits("<h2>Recent posting decisions</h2>")).toHaveLength(0);
    expect(hits('<th scope="col">Owner account</th>')).toHaveLength(1);
    expect(hits('<th scope="col">Customer</th>')).toHaveLength(0);
    expect(hits("<a>Back to the newest</a>")).toHaveLength(1);
    expect(hits("<a>Back to the first page</a>")).toHaveLength(0);
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

/**
 * "View events" opens the WHOLE log (docs/design/NAVIGATION.md). A link into a filtered slice of
 * it is named for that slice ("View these breaches", "View submission events", "View AI cost
 * events", "View all admin actions") — the same name for two different targets is how an
 * operator stops trusting either. Read from the AST of every shipped TSX file: each element
 * whose visible text is exactly "View events" must carry the literal `href="/events"`.
 */
function viewEventsHrefs(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const text = node.children
        .filter(ts.isJsxText)
        .map((c) => c.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text === "View events") {
        const href = node.openingElement.attributes.properties.find(
          (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "href",
        )?.initializer;
        out.push(href && ts.isStringLiteral(href) ? href.text : `<${href?.getText(sf) ?? "none"}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("View events is the whole log", () => {
  it("the reader finds the label's href, literal or not", () => {
    expect(
      viewEventsHrefs("t.tsx", '<Link href="/events"><Icon name="x" />View events</Link>'),
    ).toEqual(["/events"]);
    // JSX text across lines, the way the pages write it.
    const multiLine = `<Link href="/events?eventName=a.b">
      <Icon name="x" />
      View events
    </Link>`;
    expect(viewEventsHrefs("t.tsx", multiLine)).toEqual(["/events?eventName=a.b"]);
    expect(viewEventsHrefs("t.tsx", "<Link href={h}>View events</Link>")).toEqual(["<{h}>"]);
    expect(viewEventsHrefs("t.tsx", '<Link href="/x">View these breaches</Link>')).toEqual([]);
  });

  it("every 'View events' in the console links the bare /events", () => {
    const wrong: string[] = [];
    let seen = 0;
    (function walk(dir: string): void {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(ent.name)) {
          for (const href of viewEventsHrefs(ent.name, readFileSync(full, "utf8"))) {
            seen++;
            if (href !== "/events") wrong.push(`${relative(srcRoot, full)}: ${href}`);
          }
        }
      }
    })(srcRoot);
    expect(wrong).toEqual([]);
    // …and it really read the ones that are there (workers, postings, the dashboard).
    expect(seen).toBeGreaterThanOrEqual(3);
  });
});
