import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

/**
 * CARDS-1 — the optional whole-card link affordance on the DS `Card` + `StatTile`.
 *
 * When `href` is set, the primitive becomes ONE accessible interactive card via the
 * stretched-link pattern: a single overlay `<a>` (.bb-stretched-link) whose ::after
 * (in CSS) covers the card, the root gets `--link` (→ position:relative + the
 * hover/active/focus-within states), and the link carries the supplied accessible name.
 * When `href` is absent, the primitive renders EXACTLY as before — no `<a>` is added.
 *
 * Env is node; `next/link` is stubbed to a plain `<a>` (the repo pattern) so the SSR
 * markup is deterministic. Focus/keyboard/visible-ring behaviour is the native `<a>`
 * semantics (Enter activates; the parent renders the ring via :focus-within in CSS).
 */
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    href: string;
    className?: string;
    "aria-label"?: string;
  }) => (
    <a href={href} className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

const { Card, StatTile } = await import("./display");

const html = (el: ReactElement): string => renderToStaticMarkup(el);
const anchorCount = (s: string): number => (s.match(/<a\b/g) || []).length;

describe("CARDS-1 · Card link affordance (stretched-link)", () => {
  it("WITH href: renders exactly ONE stretched-link <a> with the supplied aria-label", () => {
    const out = html(
      <Card href="/credits" ariaLabel="Credit balance 247 — open wallet">
        <span>Balance</span>
      </Card>,
    );
    expect(anchorCount(out)).toBe(1);
    expect(out).toContain('href="/credits"');
    expect(out).toContain("bb-stretched-link");
    expect(out).toContain('aria-label="Credit balance 247 — open wallet"');
    // root carries the --link modifier (→ position:relative + interactive states in CSS)
    expect(out).toContain("bb-card--link");
    // the child content still renders
    expect(out).toContain("Balance");
  });

  it("WITHOUT href: renders EXACTLY as before — NO <a> is added, no --link class", () => {
    const out = html(
      <Card>
        <span>Balance</span>
      </Card>,
    );
    expect(anchorCount(out)).toBe(0);
    expect(out).not.toContain("bb-stretched-link");
    expect(out).not.toContain("bb-card--link");
    expect(out).toContain("bb-card");
    expect(out).toContain("Balance");
  });

  it("preserves existing Card props (variant/padding/as) alongside href", () => {
    const out = html(
      <Card href="/x" variant="flat" padding="none" as="section">
        body
      </Card>,
    );
    expect(out.startsWith("<section")).toBe(true);
    expect(out).toContain("bb-card--flat");
    expect(out).toContain("bb-card--pad-none");
    expect(out).toContain("bb-card--link");
    expect(anchorCount(out)).toBe(1);
  });

  it("an inner Badge-as-status (non-interactive) does NOT add a second link", () => {
    const out = html(
      <Card href="/postings" ariaLabel="CNC Operator — view applicants">
        <span className="bb-badge bb-badge--success">open</span>
      </Card>,
    );
    expect(anchorCount(out)).toBe(1); // exactly one interactive link per card
  });
});

describe("CARDS-1 · StatTile link affordance (stretched-link)", () => {
  it("WITH href: renders exactly ONE stretched-link <a> with the supplied aria-label", () => {
    const out = html(
      <StatTile
        label="Open postings"
        value={3}
        icon="briefcase"
        href="/postings"
        ariaLabel="Open postings 3 — manage postings"
      />,
    );
    expect(anchorCount(out)).toBe(1);
    expect(out).toContain('href="/postings"');
    expect(out).toContain("bb-stretched-link");
    expect(out).toContain('aria-label="Open postings 3 — manage postings"');
    expect(out).toContain("bb-stat--link");
    // the value still renders in mono tabular
    expect(out).toContain("bb-stat__value");
    expect(out).toContain("3");
  });

  it("WITHOUT href: renders EXACTLY as before — NO <a> is added, no --link class", () => {
    const out = html(<StatTile label="Balance" value="₹40" icon="wallet" />);
    expect(anchorCount(out)).toBe(0);
    expect(out).not.toContain("bb-stretched-link");
    expect(out).not.toContain("bb-stat--link");
    expect(out).toContain("bb-stat__value");
    expect(out).toContain("₹40");
  });
});
