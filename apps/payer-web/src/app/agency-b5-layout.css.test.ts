import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * B5 AGENCY SURFACES — LAYOUT REGRESSION FENCE (source-level, measured where possible).
 *
 * The vitest env is `node`: there is no layout engine, so a rendered-box assertion is not
 * available. What IS available — and what the three bugs this file pins were made of — is the
 * DECLARED geometry: a fixed 17rem code inside a fit-content frame inside a phone rail, a print
 * block armed by an element that always exists, a sticky header under an opaque sticky bar.
 * So this suite parses `globals.css` + `tokens.css` and:
 *   · ARITHMETIC: resolves the QR's declared width at real phone widths against the real token
 *     values of the chrome around it, and asserts it fits.
 *   · STRUCTURE: asserts the specific declarations the fit depends on (a zero-minimum grid track,
 *     a clamped frame), because the arithmetic alone is not sufficient without them.
 *   · SCOPING: asserts every print rule is conditioned on a MINTED sheet, and that no unnamed
 *     `@page` rewrites the paper margins of unrelated routes.
 * It also reads the shipped markup so the "does the selector match?" checks measure the real
 * component rather than an assumption about it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS_RAW = readFileSync(join(here, "globals.css"), "utf8");
const TOKENS_RAW = readFileSync(join(here, "..", "styles", "tokens.css"), "utf8");
const WORKER_LIST_TSX = readFileSync(
  join(here, "(portal)", "agency", "workers", "worker-activity-list.tsx"),
  "utf8",
);

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const CSS = stripComments(CSS_RAW);
const TOKENS = stripComments(TOKENS_RAW);

interface Rule {
  /** The selector list, whitespace-normalised. */
  selector: string;
  /** The declaration block. */
  body: string;
  /** The enclosing at-rule prelude ("" at top level). */
  at: string;
}

/** Flatten a stylesheet into rules, descending through @media/@supports and keeping the prelude. */
function parseRules(css: string, at = ""): Rule[] {
  const out: Rule[] = [];
  let prelude = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      const body = css.slice(i + 1, j - 1);
      const selector = prelude.trim().replace(/\s+/g, " ");
      if (/^@(media|supports)\b/.test(selector)) out.push(...parseRules(body, selector));
      else out.push({ selector, body, at });
      prelude = "";
      i = j;
      continue;
    }
    if (ch === "}") {
      prelude = "";
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return out;
}

const RULES = parseRules(CSS);

/** `atNeedle === ""` means TOP LEVEL (not inside any at-rule), not "anywhere". */
const inContext = (r: Rule, atNeedle: string) =>
  atNeedle === "" ? r.at === "" : r.at.includes(atNeedle);

/** Every rule whose selector list contains `needle` (substring match on the normalised list). */
const rulesMatching = (needle: string, atNeedle = "") =>
  RULES.filter((r) => r.selector.includes(needle) && inContext(r, atNeedle));

/** The rule whose selector list is EXACTLY `selector` (top level unless an at-rule is named). */
function rule(selector: string, atNeedle = ""): Rule {
  const hits = RULES.filter(
    (r) => r.selector.replace(/,\s*/g, ",") === selector.replace(/,\s*/g, ",") && inContext(r, atNeedle),
  );
  expect(hits, `expected exactly one rule for \`${selector}\`${atNeedle ? ` in ${atNeedle}` : ""}`).toHaveLength(1);
  return hits[0]!;
}

/** The last declared value of `prop` in a block, or null. */
function decl(r: Rule, prop: string): string | null {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern is built from repo-controlled values (a UUID, a reviewed lexicon pattern, or a literal in this file) and never from worker or request text.
  const re = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;]+)`, "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r.body)) !== null) last = m[1]!.trim();
  return last;
}

/** A custom property's value as declared in tokens.css `:root` (light ramp). */
function token(name: string): string {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern is built from repo-controlled values (a UUID, a reviewed lexicon pattern, or a literal in this file) and never from worker or request text.
  const m = TOKENS.match(new RegExp(`${name}\\s*:\\s*([^;]+)`));
  expect(m, `token ${name} must be declared in tokens.css`).not.toBeNull();
  return m![1]!.trim();
}

/** A token that resolves to a bare px length. */
function tokenPx(name: string): number {
  const v = token(name);
  const m = v.match(/^(-?[\d.]+)px$/);
  expect(m, `token ${name} was expected to be a px length, got "${v}"`).not.toBeNull();
  return Number(m![1]);
}

/* ------------------------------------------------------------------ *
 * A tiny CSS length evaluator: enough for clamp()/min()/max()/calc() over rem/px/vw.
 * ------------------------------------------------------------------ */
const ROOT_FONT_PX = 16;

function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function evalLength(expr: string, viewportPx: number): number {
  const e = expr.trim();
  const fn = e.match(/^(clamp|min|max|calc)\(([\s\S]*)\)$/);
  if (fn) {
    const name = fn[1]!;
    const inner = fn[2]!;
    if (name === "clamp") {
      const [lo, val, hi] = splitTopLevel(inner).map((p) => evalLength(p, viewportPx));
      return Math.min(Math.max(lo!, val!), hi!);
    }
    if (name === "min") return Math.min(...splitTopLevel(inner).map((p) => evalLength(p, viewportPx)));
    if (name === "max") return Math.max(...splitTopLevel(inner).map((p) => evalLength(p, viewportPx)));
    // calc(): a single top-level +/- between two terms is all this file uses.
    const op = inner.match(/^([\s\S]+?)\s([+-])\s([\s\S]+)$/);
    expect(op, `calc() form not supported by this evaluator: ${inner}`).not.toBeNull();
    const left = evalLength(op![1]!, viewportPx);
    const right = evalLength(op![3]!, viewportPx);
    return op![2] === "+" ? left + right : left - right;
  }
  const unit = e.match(/^(-?[\d.]+)(px|rem|vw)$/);
  expect(unit, `not a plain length: "${e}"`).not.toBeNull();
  const n = Number(unit![1]);
  if (unit![2] === "px") return n;
  if (unit![2] === "rem") return n * ROOT_FONT_PX;
  return (n * viewportPx) / 100; // vw
}

describe("evalLength — the measuring instrument itself", () => {
  it("resolves rem/px/vw and clamp()/calc() the way a browser would", () => {
    expect(evalLength("17rem", 360)).toBe(272);
    expect(evalLength("calc(100vw - 8.25rem)", 360)).toBe(228);
    expect(evalLength("clamp(9rem, calc(100vw - 8.25rem), 17rem)", 360)).toBe(228);
    expect(evalLength("clamp(9rem, calc(100vw - 8.25rem), 17rem)", 1280)).toBe(272);
    expect(evalLength("clamp(9rem, calc(100vw - 8.25rem), 17rem)", 300)).toBe(168);
    expect(evalLength("clamp(9rem, calc(100vw - 8.25rem), 17rem)", 200)).toBe(144); // floor
  });
});

/* ================================================================== *
 * FINDING 1 — the printable QR must fit a phone, not break out of it.
 * ================================================================== */
describe("B5 · /agency/qr — the code fits the viewport it is previewed on", () => {
  const qrBlock = rule(".agency-qr");
  const sheet = rule(".agency-qr__sheet");
  const frame = rule(".agency-qr__frame");
  const layout = rule(".agency-qr__layout");

  it("the chrome around the code is still built from the tokens this test measures", () => {
    // The arithmetic below is only honest if the structure is still the one it models:
    // portal rail → sheet padding → frame padding (the quiet zone) → the code.
    expect(decl(rule(".pshell__content", "max-width: 1023px"), "padding")).toContain("var(--gutter)");
    expect(decl(sheet, "padding")).toContain("var(--space-6)");
    expect(decl(frame, "padding")).toBe("var(--qr-quiet-screen)");
    expect(decl(qrBlock, "--qr-quiet-screen")).toBe("var(--space-5)");
    expect(decl(sheet, "border")).toContain("var(--border-hairline)");
    expect(decl(frame, "border")).toContain("var(--border-hairline)");
  });

  it("MEASURED: the declared code width + its chrome never exceeds a common phone width", () => {
    // Horizontal chrome between the viewport edge and the code, straight from the tokens:
    //   shell content gutter ×2 + sheet padding ×2 + sheet border ×2 + frame quiet zone ×2 + frame border ×2
    const hairline = tokenPx("--border-hairline");
    const chrome =
      2 * tokenPx("--gutter") + 2 * tokenPx("--space-6") + 2 * tokenPx("--space-5") + 4 * hairline;

    const declared = decl(qrBlock, "--qr-size-screen");
    expect(declared, "--qr-size-screen must be declared on .agency-qr").not.toBeNull();

    // 320 = iPhone SE 1st-gen / small Android, 360 = the modal Android width, 412 = Pixel.
    for (const viewport of [320, 360, 390, 412]) {
      const codePx = evalLength(declared!, viewport);
      expect(
        codePx + chrome,
        `at ${viewport}px the QR (${codePx}px) + chrome (${chrome}px) must fit the viewport`,
      ).toBeLessThanOrEqual(viewport);
      // …and it must stay big enough that the on-screen preview is still a QR, not a stamp.
      expect(codePx, `the QR must not collapse at ${viewport}px`).toBeGreaterThanOrEqual(140);
    }
  });

  it("keeps the full optical size on a desktop rail", () => {
    expect(evalLength(decl(qrBlock, "--qr-size-screen")!, 1280)).toBe(17 * ROOT_FONT_PX);
  });

  it("the stack track has a ZERO minimum, so it cannot be inflated by the frame's min-content", () => {
    // A default `auto` track takes its base size from the widest item's MIN-CONTENT width and
    // never shrinks below it — which is how a fixed-width code dragged the sheet off screen.
    expect(decl(layout, "grid-template-columns")).toMatch(/minmax\(\s*0\s*,\s*1fr\s*\)/);
  });

  it("the frame is clamped to that track (a fit-content item still needs a hard stop)", () => {
    expect(decl(frame, "max-width")).toBe("100%");
    // …and the code inside it can shrink within the frame.
    const code = rulesMatching(".agency-qr__code,", "").find((r) => decl(r, "max-width") !== null);
    expect(code, "the code rule must still declare a max-width").toBeDefined();
    expect(decl(code!, "max-width")).toBe("100%");
  });
});

/* ================================================================== *
 * FINDING 2 + 7 — printing is armed by a MINTED SHEET, and only the poster's margins move.
 * ================================================================== */
describe("B5 · /agency/qr — print rules are gated on a sheet that exists", () => {
  const printRules = RULES.filter((r) => r.at.includes("print"));

  it("has a print block at all", () => {
    expect(printRules.length).toBeGreaterThan(3);
  });

  it("never keys a print rule on `.agency-qr` (which renders on EVERY visit, sheet or not)", () => {
    // `body:has(.agency-qr)` matched before the agency had minted anything, so the chrome-hiding
    // rules armed with no sheet present and Ctrl-P produced a blank page.
    expect(CSS).not.toMatch(/:has\(\s*\.agency-qr\s*\)/);
  });

  it("every print selector that hides or neutralises the page requires .agency-qr__sheet", () => {
    const offenders: string[] = [];
    for (const r of printRules) {
      for (const part of r.selector.split(",").map((p) => p.trim())) {
        if (!part) continue;
        // Selectors that reach OUT of the sheet (the body/shell/chrome) or that target the
        // section itself must be conditioned on a minted sheet.
        const reachesOut = /(^|[\s>+~(])(body|\.portal-|\.chrome-footer|\.dash-)/.test(part);
        const targetsSection = /\.agency-qr(?![\w-])/.test(part);
        if (!reachesOut && !targetsSection) continue;
        if (!part.includes(".agency-qr__sheet")) offenders.push(`${part}  {${r.body.trim().slice(0, 40)}…}`);
      }
    }
    expect(offenders, `print selectors armed without a sheet:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("hides the non-sheet children only when a sheet is present", () => {
    const hider = printRules.find((r) => r.selector.includes(":not(.agency-qr__sheet)"));
    expect(hider, "the QR print block must still strip the on-screen furniture").toBeDefined();
    expect(hider!.selector).toContain(".agency-qr:has(.agency-qr__sheet) >");
    expect(decl(hider!, "display")).toContain("none");
  });

  it("declares NO unnamed @page rule (it would rewrite margins for every printable route)", () => {
    expect(CSS).not.toMatch(/@page\s*\{/);
    // The poster's paper margin lives on the sheet instead, where it can be scoped.
    const printSheet = RULES.find((r) => r.at.includes("print") && r.selector === ".agency-qr__sheet");
    expect(printSheet).toBeDefined();
    expect(decl(printSheet!, "padding")).toContain("var(--qr-paper-margin-print)");
    expect(decl(rule(".agency-qr"), "--qr-paper-margin-print")).toBeTruthy();
  });
});

/* ================================================================== *
 * FINDING 8 — no literal duplicates a value the local rail already exposes.
 * ================================================================== */
describe("B5 · /agency/qr — print sizes come from the local rail, not from literals", () => {
  it("no raw mm literal inside @media print", () => {
    const offenders = RULES.filter((r) => r.at.includes("print"))
      .flatMap((r) =>
        (r.body.match(/[\d.]+\s*mm/g) ?? []).map((hit) => `${r.selector} → ${hit}`),
      );
    expect(offenders, `mm literals in the print block:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the printed stack gap resolves from --qr-quiet-print", () => {
    const layout = RULES.find((r) => r.at.includes("print") && r.selector === ".agency-qr__layout");
    expect(layout).toBeDefined();
    expect(decl(layout!, "gap")).toContain("var(--qr-quiet-print)");
  });
});

/* ================================================================== *
 * FINDING 3 — the column headers must be visible, i.e. not pinned under the portal bar.
 * ================================================================== */
describe("B5 · /agency/workers — the table header is not stuck behind the shell header", () => {
  it("the shell header is still the opaque sticky element this trades against", () => {
    const top = rule(".pshell__header");
    expect(decl(top, "position")).toBe("sticky");
    expect(decl(top, "z-index")).toBe("var(--z-sticky)");
    expect(decl(top, "background")).toBe("var(--surface-card)");
    // --z-sticky sits far above --z-raised, so a raised sticky header can never win.
    expect(Number(token("--z-sticky"))).toBeGreaterThan(Number(token("--z-raised")));
  });

  it("no rule makes the worker table's column headers sticky", () => {
    const offenders = rulesMatching("agency-workers__table")
      .filter((r) => decl(r, "position") === "sticky")
      .map((r) => r.selector);
    expect(offenders, `sticky (and therefore invisible) table headers:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the header still reads as a header (sunken, muted, uppercase)", () => {
    const head = rule(".agency-workers__table thead th");
    expect(decl(head, "background")).toBe("var(--surface-sunken)");
    expect(decl(head, "text-transform")).toBe("uppercase");
  });
});

/* ================================================================== *
 * FINDING 4 — on a phone only the table scrolls; the prose stays on the rail.
 * ================================================================== */
describe("B5 · /agency/workers — the scroll container is the TABLE, not the section", () => {
  const MOBILE = "max-width: 900px";

  it("the section itself never becomes a horizontal scroll region", () => {
    const section = rule(".agency-workers", MOBILE);
    expect(decl(section, "overflow-x")).toBeNull();
    expect(decl(section, "overflow")).toBeNull();
  });

  it("the section track has a zero minimum, so a max-content table cannot inflate the prose", () => {
    // `.agency-workers__table { min-width: max-content }` (~660px) was widening the section's
    // grid track, and the intro paragraph was being laid out at that width inside a 360px phone.
    expect(decl(rule(".agency-workers", MOBILE), "grid-template-columns")).toMatch(
      /minmax\(\s*0\s*,\s*1fr\s*\)/,
    );
    expect(decl(rule(".agency-workers"), "display")).toBe("grid");
    expect(decl(rule(".agency-workers__intro"), "max-width")).toBe("var(--reading-max)");
  });

  it("the table becomes its own scroll box, with the max-content minimum released", () => {
    // Without the min-width reset the scroll BOX itself would be 660px wide and nothing scrolls.
    expect(decl(rule(".agency-workers__table"), "min-width")).toBe("max-content");
    const mobileTable = rule(".agency-workers__table", MOBILE);
    expect(decl(mobileTable, "display")).toBe("block");
    expect(decl(mobileTable, "overflow-x")).toBe("auto");
    expect(decl(mobileTable, "min-width")).toBe("0");
  });
});

/* ================================================================== *
 * FINDING 5 — the empty state is the shipping state: quiet, like every other portal empty.
 * ================================================================== */
describe("B5 · /agency/workers — the empty state matches the portal's other empties", () => {
  const empty = rule(".agency-workers__empty");

  it("carries no second-language hero frame", () => {
    expect(decl(empty, "border")).toBeNull();
    expect(decl(empty, "border-radius")).toBeNull();
    expect(decl(empty, "background")).toBeNull();
    expect(CSS, "--border-festive was this rule's only consumer").not.toContain("--border-festive");
  });

  it("reads in the same register as .postings-empty / .agency-jobs__empty", () => {
    const quiet = rule(".postings-empty");
    const note = rule(".agency-workers__empty-note");
    expect(decl(note, "font-size")).toBe(decl(quiet, "font-size"));
    expect(decl(note, "color")).toBe(decl(quiet, "color"));
    expect(decl(note, "line-height")).toBe(decl(quiet, "line-height"));
  });

  it("keeps a modest title, not a display-scale banner", () => {
    const title = rule(".agency-workers__empty-title");
    expect(["var(--text-base)", "var(--text-md)"]).toContain(decl(title, "font-size"));
    expect(decl(title, "font-weight")).not.toBe("var(--weight-bold)");
  });

  it("lets the design system own the surface (the markup renders the shared state primitive)", () => {
    // UI-1 MIGRATION: the empty state was a DS <Card className="agency-workers__empty"> whose
    // point was that the CARD — not a bespoke frame — owned the surface. It is now the shared
    // `.state` primitive, which owns it for the same reason. The intent is unchanged: this
    // component must not grow a surface of its own. (The `.agency-workers__empty*` rules above
    // are now unreferenced by this component — see the migration report.)
    expect(WORKER_LIST_TSX).toMatch(/className="state"/);
    expect(WORKER_LIST_TSX).toMatch(/className="state__title"/);
    expect(WORKER_LIST_TSX).not.toMatch(/agency-workers__empty/);
  });
});

/* ================================================================== *
 * FINDING 6 — the ref treatment must target the element the component actually renders.
 * ================================================================== */
describe("B5 · /agency/workers — the ref selector matches the shipped markup", () => {
  it("the handle is rendered on the cell itself, with no inner <code>", () => {
    // UI-1 MIGRATION: the handle cell moved from `<th scope="row" className="agency-workers__ref
    // bb-mono">` onto the shared `.table` primitive's `mono` DATA cell. `.table th` is that
    // primitive's COLUMN-header treatment (sticky/uppercase/sunken), which a row header would
    // wrongly inherit, so the handle is a <td>. The invariant this test exists for is unchanged:
    // the treatment lands on the CELL, never on a nested wrapper element.
    expect(WORKER_LIST_TSX).toMatch(/<td className="mono">\{w\.ref\}<\/td>/);
    expect(WORKER_LIST_TSX).not.toMatch(/<code/);
  });

  it("no rule is scoped to a <code> that is never rendered", () => {
    const dead = RULES.filter(
      (r) => /code\.agency-workers__ref|\.agency-workers__ref code/.test(r.selector),
    ).map((r) => r.selector);
    expect(dead, `dead selectors (no <code> in the markup):\n${dead.join("\n")}`).toEqual([]);
  });

  it("the handle treatment lands on the cell itself: sunken, mono-tabular, one-gesture select", () => {
    const ref = rulesMatching(".agency-workers__ref").find((r) => decl(r, "font-family") !== null);
    expect(ref, "the ref rule must exist").toBeDefined();
    expect(decl(ref!, "font-family")).toBe("var(--font-mono)");
    expect(decl(ref!, "font-variant-numeric")).toBe("tabular-nums");
    expect(decl(ref!, "user-select")).toBe("all");
    // A sunken surface it does not share with the row-hover tint (--surface-sunken).
    expect(decl(ref!, "background")).toBe("var(--surface-inset)");
    expect(decl(rule(".agency-workers__table tbody tr:hover"), "background")).toBe(
      "var(--surface-sunken)",
    );
  });
});

/* ================================================================== *
 * FINDING 9 — one owner for the vertical rhythm inside the B5 grids.
 * ================================================================== */
describe("B5 · agency grids — the grid gap is the only vertical rhythm", () => {
  it(".agency-invite__note still ships its own margin (that is why the reset exists)", () => {
    expect(decl(rule(".agency-invite__note"), "margin")).toBe("var(--space-3) 0");
  });

  it("the note's margin is reset inside every B5 grid that renders it", () => {
    const reset = RULES.find(
      (r) => r.selector.includes(".agency-qr > .agency-invite__note") && decl(r, "margin") === "0",
    );
    expect(reset, "the margin reset must cover .agency-invite__note").toBeDefined();
    expect(reset!.selector).toContain(".agency-batch > .agency-invite__note");
    // The reset only makes sense because these blocks own the rhythm via the grid gap.
    expect(decl(rule(".agency-qr"), "gap")).toBe("var(--block-gap)");
    expect(decl(rule(".agency-batch"), "gap")).toBe("var(--block-gap)");
  });
});
