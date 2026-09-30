import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

/**
 * CARDS-1 — the optional whole-card link affordance on the DS `Card` + `StatTile`.
 *
 * When `href` is set, the primitive becomes ONE accessible interactive card via the
 * stretched-link pattern: a single overlay `<a>` (.bb-stretched-link) that itself (in CSS,
 * `position:absolute; inset:0`) covers the card, the root gets `--link` (→ position:relative +
 * the hover/active/focus-within states), and the link carries the supplied accessible name.
 * When `href` is absent, the primitive renders EXACTLY as before — no `<a>` is added.
 *
 * Env is node; `next/link` is stubbed to a plain `<a>` (the repo pattern) so the SSR
 * markup is deterministic. Focus/keyboard/visible-ring behaviour is the native `<a>`
 * semantics (Enter activates; the parent renders the keyboard-only ring in CSS via
 * `:has(> .bb-stretched-link:focus-visible)`).
 *
 * The overlay `<a>` is EMPTY, so `ariaLabel` is its only name: `href` without `ariaLabel` is a
 * TYPE error (see the compile-time block at the foot — enforced by `pnpm typecheck`, which
 * includes this file), not a runtime case to render.
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
      <Card href="/x" ariaLabel="Open x" variant="flat" padding="none" as="section">
        body
      </Card>,
    );
    expect(out.startsWith("<section")).toBe(true);
    expect(out).toContain("bb-card--flat");
    expect(out).toContain("bb-card--pad-none");
    expect(out).toContain("bb-card--link");
    expect(anchorCount(out)).toBe(1);
  });

  it("the overlay is a DIRECT child of the root (the CSS ring keys on `:has(> .bb-stretched-link…)`)", () => {
    const card = html(
      <Card href="/credits" ariaLabel="Open wallet">
        <div>
          <span>nested</span>
        </div>
      </Card>,
    );
    expect(card).toMatch(/^<div class="bb-card bb-card--link"><a [^>]*class="bb-stretched-link"/);
    const stat = html(
      <StatTile label="Balance" value={1} href="/credits" ariaLabel="Open wallet" />,
    );
    expect(stat).toMatch(/^<div class="bb-stat bb-stat--link"><a [^>]*class="bb-stretched-link"/);
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

/**
 * Compile-time contract: a link surface is never unnamed. Each `@ts-expect-error` below FAILS
 * `pnpm typecheck` ("unused directive") the moment its line compiles — i.e. if `ariaLabel` ever
 * becomes optional beside `href` again, or an orphan `ariaLabel` is accepted without one. The
 * elements are only constructed (never rendered); the runtime assertion is incidental.
 */
describe("CARDS-1 · href without an accessible name does not compile", () => {
  it("Card and StatTile demand ariaLabel with href, and refuse it without one", () => {
    const rejected = [
      // @ts-expect-error — href without ariaLabel would ship an unnamed overlay link
      <Card key="card" href="/credits">
        Balance
      </Card>,
      // @ts-expect-error — href without ariaLabel would ship an unnamed overlay link
      <StatTile key="stat" label="Open postings" value={3} href="/postings" />,
      // @ts-expect-error — ariaLabel without href names nothing (it would be silently dropped)
      <Card key="orphan" ariaLabel="Open wallet">
        Balance
      </Card>,
    ];
    expect(rejected).toHaveLength(3);
  });
});
