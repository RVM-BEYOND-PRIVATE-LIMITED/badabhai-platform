import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * DS4.2 — INK dark-theme PARITY guard (source-level audit).
 *
 * The whole payer portal is built token-driven (DS0.2→DS4.1): every screen styles from the
 * SEMANTIC tokens (--surface-* / --text-* / --brand / --success / …) + the `.bb-*` / token
 * classes, and `src/styles/tokens.css` defines a full `[data-theme="ink"]` block that FLIPS
 * those semantic tokens. So a single `data-theme="ink"` on the shell re-themes the entire app.
 *
 * The ONLY way that parity silently regresses is if a screen reintroduces a value that does NOT
 * flip: a raw hex/rgb/hsl COLOR literal, or one of the pre-DS LEGACY light-palette vars
 * (--bg / --panel / --panel-2 / --border / --text / --muted / --accent / --ok / --warn) or the
 * legacy non-flipping component classes that consume them (.btn / .card / .badge / .note / .input
 * / .empty / .form / .field / .page-title / .page-sub / .footer / …). This test is the regression
 * fence: env is node (no jsdom/axe), so it audits the SOURCE, not a rendered DOM.
 *
 * It asserts three things:
 *  1. No screen/component source carries a raw hex/rgb/hsl COLOR literal.
 *  2. No screen/component source uses a legacy non-flip palette var or component class.
 *  3. tokens.css still defines the `[data-theme="ink"]` parity block, and that block flips the
 *     load-bearing surface/text tokens (--surface-page / --surface-card / --text-primary).
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, ".."); // .../payer-web/src

/** Recursively collect the *screen* sources we audit (app screens + shared DS/unlock components). */
function collectSources(): string[] {
  const out: string[] = [];
  const roots = [join(srcRoot, "app"), join(srcRoot, "components")];
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "test") continue;
        walk(full);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(ent.name)) continue;
      if (/\.(test|spec)\.(tsx|ts)$/.test(ent.name)) continue; // audit production sources only
      out.push(full);
    }
  }
  for (const r of roots) walk(r);
  return out;
}

/** Strip /* … *\/ and // … so a hex/var inside a comment is not a false positive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SOURCES = collectSources();
const rel = (p: string) => relative(srcRoot, p).replace(/\\/g, "/");

// A raw COLOR literal that would NOT flip under [data-theme="ink"]:
//   #rgb / #rrggbb / #rrggbbaa, or rgb()/rgba()/hsl()/hsla(.
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/;

// The pre-DS legacy LIGHT palette vars (defined in globals.css :root — they do NOT flip).
const LEGACY_VARS = /var\(\s*--(?:bg|panel|panel-2|border|text|muted|accent|accent-soft|ok|ok-soft|warn|warn-soft)\s*\)/;

// The legacy non-flipping COMPONENT classes (consume the legacy vars above). Matched only as a
// WHOLE className token so DS classes that merely contain the substring (.bb-card, .dash-section,
// .agency-section, .posting-form, …) are never false positives.
const LEGACY_CLASS_WORDS = [
  "btn",
  "card",
  "cards",
  "badge",
  "badge-ok",
  "badge-warn",
  "badge-hot",
  "badge-contacted",
  "note",
  "input",
  "field",
  "req",
  "empty",
  "form",
  "page-title",
  "page-sub",
  "section",
  "footer",
  "topbar",
  "topnav",
  "session-chip",
  "shell",
  "skills",
  "skill",
  "error-text",
];

/** Does a className string token-match a legacy non-flip class? (split on whitespace, exact word). */
function usesLegacyClass(src: string): string | null {
  // className="…" | className='…' | className={`…`}  — capture the literal class strings.
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const literal = m[1] ?? m[2] ?? m[3] ?? "";
    // Keep only the static (non-interpolated) tokens.
    const tokens = literal.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (LEGACY_CLASS_WORDS.includes(t)) return t;
    }
  }
  return null;
}

describe("DS4.2 · ink parity — no hardcoded light leaks in screen sources", () => {
  it("collects the payer-web screen + component sources to audit", () => {
    // Sanity: the walk found a representative slice (login, dashboard, applicants, unlock, ds).
    expect(SOURCES.length).toBeGreaterThan(20);
    const names = SOURCES.map(rel);
    expect(names).toContain("app/login/login-form.tsx");
    expect(names).toContain("app/(portal)/dashboard/page.tsx");
    expect(names).toContain("app/(portal)/postings/[id]/applicants/applicant-actions.tsx");
    expect(names).toContain("components/unlock/routed-contact-card.tsx");
  });

  it("no screen/component source carries a raw hex/rgb/hsl COLOR literal", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const code = stripComments(readFileSync(f, "utf8"));
      const hit = code.match(RAW_COLOR);
      if (hit) offenders.push(`${rel(f)} → ${hit[0]}`);
    }
    expect(offenders, `raw color literals (won't flip under ink):\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("no screen/component source uses a legacy NON-FLIP palette var", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const code = stripComments(readFileSync(f, "utf8"));
      const hit = code.match(LEGACY_VARS);
      if (hit) offenders.push(`${rel(f)} → ${hit[0]}`);
    }
    expect(
      offenders,
      `legacy light-palette vars (won't flip under ink):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no screen/component source uses a legacy NON-FLIP component class", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const code = stripComments(readFileSync(f, "utf8"));
      const cls = usesLegacyClass(code);
      if (cls) offenders.push(`${rel(f)} → .${cls}`);
    }
    expect(
      offenders,
      `legacy non-flip component classes (migrate to the token/DS equivalent):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("DS4.2 · tokens.css still defines the [data-theme=\"ink\"] parity block", () => {
  const tokens = readFileSync(join(srcRoot, "styles", "tokens.css"), "utf8");

  it("declares the [data-theme=\"ink\"] selector", () => {
    expect(tokens).toMatch(/\[data-theme="ink"\]\s*\{/);
  });

  it("flips the load-bearing surface + text tokens inside the ink block", () => {
    // Isolate the ink block body so we assert the OVERRIDES live under [data-theme="ink"].
    const block = tokens.match(/\[data-theme="ink"\]\s*\{([\s\S]*?)\}/);
    expect(block, "the [data-theme=\"ink\"] block must exist").not.toBeNull();
    const body = block![1]!;
    // These three are what every screen's page/card/heading resolve from — they MUST flip.
    expect(body).toMatch(/--surface-page:/);
    expect(body).toMatch(/--surface-card:/);
    expect(body).toMatch(/--text-primary:/);
    // And the flip is to the dark ramp (ink-950 page, paper text), not the paper defaults.
    expect(body).toMatch(/--surface-page:\s*var\(--ink-950\)/);
    expect(body).toMatch(/--text-primary:\s*var\(--paper-1\)/);
  });
});
