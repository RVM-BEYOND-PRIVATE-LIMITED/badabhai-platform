import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { ALL_ICON_NAMES } from "@badabhai/icons";

/**
 * ICON FENCE — every glyph goes through @badabhai/icons (`<Icon>` / the DS primitives).
 *
 * A raw `<i className="ph-fill ph-…">` takes an untyped string, so a typo renders an empty box
 * and nothing notices. New code renders `<Icon name="…">` (typed `IconName`). The raw call sites
 * that predate the shared package are listed below WITH THEIR COUNT, and the list only shrinks:
 *   - a count going UP fails (a new raw glyph in an allow-listed file),
 *   - a file not on the list with any raw glyph fails,
 *   - a count going DOWN fails until the entry is lowered (or deleted at zero) in the same PR,
 *     so a converted call site can never be silently re-added later.
 * The page-by-page icon PRs convert these files and delete their rows.
 *
 * Counted in CODE only (comments stripped), as the bare `ph-fill` class token — every raw fill
 * glyph needs it, whatever way the class string is assembled.
 */
const RAW_ICON_ALLOWLIST: Readonly<Record<string, number>> = {
  "app/(portal)/account-menu.tsx": 3,
  "app/(portal)/account/account-form.tsx": 1,
  "app/(portal)/account/page.tsx": 3,
  "app/(portal)/agency/bulk-upload/page.tsx": 2,
  "app/(portal)/agency/dashboard/agency-job-form.tsx": 1,
  "app/(portal)/agency/dashboard/parked-modules.tsx": 1,
  "app/(portal)/agency/referrals/earnings-panel.tsx": 1,
  "app/(portal)/agency/referrals/kyc-panel.tsx": 5,
  "app/(portal)/agency/referrals/page.tsx": 2,
  "app/(portal)/agency/referrals/payout-panel.tsx": 3,
  "app/(portal)/agency/workers/page.tsx": 2,
  "app/(portal)/agency/workers/worker-activity-list.tsx": 1,
  "app/(portal)/app-shell.tsx": 2,
  "app/(portal)/capacity/capacity-panel.tsx": 1,
  "app/(portal)/capacity/page.tsx": 4,
  "app/(portal)/credits/credits-panel.tsx": 1,
  "app/(portal)/credits/page.tsx": 7,
  "app/(portal)/dashboard/agent-sections.tsx": 4,
  "app/(portal)/dashboard/page.tsx": 12,
  "app/(portal)/error.tsx": 1,
  "app/(portal)/layout.tsx": 2,
  "app/(portal)/plans/page.tsx": 8,
  "app/(portal)/portal-breadcrumb.tsx": 2,
  "app/(portal)/postings/[id]/applicants/applicant-actions.tsx": 4,
  "app/(portal)/postings/[id]/applicants/page.tsx": 6,
  "app/(portal)/postings/[id]/edit/edit-posting-form.tsx": 2,
  "app/(portal)/postings/[id]/page.tsx": 4,
  "app/(portal)/postings/new/match-skill-picker.tsx": 2,
  "app/(portal)/postings/new/page.tsx": 5,
  "app/(portal)/postings/new/posting-form.tsx": 2,
  "app/(portal)/postings/page.tsx": 3,
  "app/(portal)/postings/postings-manager.tsx": 3,
  "app/(portal)/sidebar-nav.tsx": 2,
  "app/(portal)/team/accept/accept-invite.tsx": 4,
  "app/(portal)/team/team-manager.tsx": 2,
  "app/error.tsx": 1,
  "app/login/login-form.tsx": 1,
  "app/not-found.tsx": 1,
  "components/ds/masked-candidate.tsx": 1,
  "components/job-card-preview.tsx": 3,
};

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Code only — a comment may name the class. (`https://` survives: the `:` guard.) */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Raw fill-glyph class tokens in a source's code. */
const countRawIcons = (code: string): number => (code.match(/\bph-fill\b/g) ?? []).length;

/** Static glyph names written after `ph-fill ph-` (a `${…}` template tail is dynamic: skipped). */
const staticRawNames = (code: string): string[] =>
  [...code.matchAll(/\bph-fill ph-([a-z0-9-]+)(\$\{)?/g)].filter((m) => !m[2]).map((m) => m[1]!);

function shippedSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(ent.name) && !/\.(test|spec)\.(tsx|ts)$/.test(ent.name))
        out.push(full);
    }
  })(srcRoot);
  return out;
}

const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");
const CODE = new Map(shippedSources().map((f) => [rel(f), stripComments(readFileSync(f, "utf8"))]));

describe("icon fence — the counter catches what it must (so a pass below means something)", () => {
  it("counts every raw form and ignores the typed element", () => {
    expect(countRawIcons('<i className="ph-fill ph-gear" aria-hidden="true" />')).toBe(1);
    expect(countRawIcons("<i className={`ph-fill ph-${icon}`} />")).toBe(1);
    expect(countRawIcons('className={["ph-fill", `ph-${n}`].join(" ")}')).toBe(1);
    expect(countRawIcons('<Icon name="gear" />')).toBe(0);
    expect(countRawIcons('<Icon name="gear" className="pnav__icon" />')).toBe(0);
  });

  it("walks the shipped sources", () => {
    expect(CODE.size).toBeGreaterThan(100);
  });
});

describe("icon fence — no NEW raw `ph-fill` glyph outside @badabhai/icons", () => {
  const actual = new Map(
    [...CODE].map(([f, code]) => [f, countRawIcons(code)] as const).filter(([, n]) => n > 0),
  );
  const total = [...actual.values()].reduce((a, b) => a + b, 0);
  console.info(
    `[icon-fence] payer-web: ${total} raw ph-fill class strings in ${actual.size} allow-listed ` +
      "files — convert them to <Icon> and lower RAW_ICON_ALLOWLIST.",
  );

  it("no file outside the allow-list renders a raw glyph", () => {
    const unlisted = [...actual.keys()].filter((f) => !(f in RAW_ICON_ALLOWLIST));
    expect(unlisted, "render <Icon name=…> from @badabhai/icons instead").toEqual([]);
  });

  it("no allow-listed file GAINED a raw glyph", () => {
    const grown = Object.entries(RAW_ICON_ALLOWLIST)
      .filter(([f, budget]) => (actual.get(f) ?? 0) > budget)
      .map(([f, budget]) => `${f}: ${actual.get(f)} > ${budget}`);
    expect(grown, "render <Icon name=…> from @badabhai/icons instead").toEqual([]);
  });

  it("the allow-list is exact — a converted call site lowers its count in the same PR", () => {
    const stale = Object.entries(RAW_ICON_ALLOWLIST)
      .filter(([f, budget]) => (actual.get(f) ?? 0) < budget)
      .map(
        ([f, budget]) => `${f}: ${actual.get(f) ?? 0} < ${budget} — lower (or delete) the entry`,
      );
    expect(stale).toEqual([]);
  });

  it("every static glyph name at the remaining raw sites is a valid IconName", () => {
    const known = new Set<string>(ALL_ICON_NAMES);
    const unknown = [...CODE].flatMap(([f, code]) =>
      staticRawNames(code)
        .filter((n) => !known.has(n))
        .map((n) => `${f} → ${n}`),
    );
    expect(unknown, "misspelt glyph, or add it to @badabhai/icons ICON_NAMES").toEqual([]);
  });
});
