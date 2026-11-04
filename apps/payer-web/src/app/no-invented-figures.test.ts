import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * #2581 (W1) — no invented figures, no dead controls, no internal jargon on any payer-web screen.
 *
 * Owner decision: figures we cannot back (worker/company counts, credit offers, a made-up
 * testimonial, fake engine versions) are removed; real numbers may come back later from a real
 * read. Text styled as a link or button that does nothing is removed rather than left inert.
 *
 * Source-level fence over every non-test `.ts`/`.tsx` under `src/`: if any of these strings
 * returns, this suite fails. A string that comes back legitimately (e.g. "Privacy Policy" as a
 * REAL link to a real page) must update this list in the same PR, on purpose.
 */
const REMOVED: readonly string[] = [
  // Invented figures + testimonial (login, dashboard, agency footers).
  "180,000+",
  "160,000+",
  "3,200+",
  "50 Free Hiring Credits",
  "Rahul Kumar",
  "Match 98%",
  "Recruiter Engine v",
  "Gateway Online",
  "Candidate Database:",
  // Claims the product does not make: contact is routed, the tier is not known here.
  "Direct phone",
  "Free Tier",
  // Dead controls and text styled as links that go nowhere.
  "Save Draft",
  "In Progress",
  "Download GST Invoices",
  "Order PVC Placards",
  "Privacy Policy",
  "Terms of Service",
  "Enterprise Security",
  "Need assistance?",
  "Employer Helpdesk",
  "Pricing Terms",
  "Billing Documentation",
  "Usage Policies",
  "Contact Support",
  "Audit Guidelines",
  "Privacy Floor Documentation",
  // Internal jargon on a payer-facing screen.
  "from the pricing config",
  "come from the pricing config",
  "Earliest First FIFO",
  "routed relay is ready",
  // One label per destination: the create form is "New posting" everywhere.
  "Create role",
  "Create First Posting",
  "Create your first job post",
  "Create Job Posting",
  // Brand spelling.
  "Badabhai",
];

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(full);
  }
  return out;
}

/** Comments are not shown to anyone — only code (JSX text, string literals) is fenced. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("#2581 — removed figures, dead controls and jargon stay removed", () => {
  const files = sourceFiles(srcRoot).map((f) => ({
    path: relative(srcRoot, f),
    code: stripComments(readFileSync(f, "utf8")),
  }));

  it("scans the payer-web source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(REMOVED)("no screen renders %j", (needle) => {
    const hits = files.filter((f) => f.code.includes(needle)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

describe("#2581 — QR poster shows 'Live' only once a QR exists", () => {
  it("every Live marker in the QR invite is gated on the created sheet", () => {
    const src = stripComments(
      readFileSync(join(srcRoot, "app/(portal)/agency/qr/qr-invite.tsx"), "utf8"),
    );
    const lines = src.split("\n");
    const liveLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => />\s*Live\s*<|\/>\s*Live\b/.test(l));
    expect(liveLines.length).toBeGreaterThan(0);
    for (const { l, i } of liveLines) {
      const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n") + l;
      expect(context).toMatch(/\{sheet \? \(?/);
    }
  });
});
