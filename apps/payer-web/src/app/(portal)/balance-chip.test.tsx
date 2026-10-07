import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The shell's credit balance chip: "credits" (the billing unit), the wallet icon, a link to
 * Credits (the shell links it for every member — ruling 2026-10-07; the static variant stays for
 * a context with no Credits door), and — because below 540px the unit word is hidden visually — an
 * accessible name and the shared tooltip (`.bb-icon-tip`, hidden by default, shown by the shared
 * hover / focus rules) carrying the same words.
 */

vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    // The pending cue inside the link reads its status (components/nav-pending.tsx): idle.
    useLinkStatus: () => ({ pending: false }),
    default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
  };
});

const { BalanceChip } = await import("./balance-chip");

const html = (balance: number, linkToCredits: boolean) =>
  renderToStaticMarkup(<BalanceChip balance={balance} linkToCredits={linkToCredits} />);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("BalanceChip", () => {
  it("the linked chip opens Credits and is named '<n> credits — open Credits'", () => {
    const out = html(1234, true);
    expect(out).toMatch(
      /^<a href="\/credits" class="pshell__balance" aria-label="1234 credits — open Credits"/,
    );
    expect(out).toContain('<i class="ph-fill ph-wallet" aria-hidden="true"></i>');
  });

  it("the static variant is plain text (no link)", () => {
    const out = html(1234, false);
    expect(out).toMatch(/^<span class="pshell__balance pshell__balance--static">/);
    expect(out).not.toContain("href=");
    // Its text (the hidden unit included) reads "1234 credits" to a screen reader.
    expect(text(out.slice(0, out.indexOf('<span class="bb-icon-tip')))).toBe("1234 credits");
  });

  it("carries the shared tooltip with the same words (hidden from the accessibility tree)", () => {
    for (const link of [true, false]) {
      const out = html(1234, link);
      expect(out).toContain(
        '<span class="bb-icon-tip bb-icon-tip--bottom-end" aria-hidden="true">1234 credits</span>',
      );
    }
  });

  it("says '1 credit', not '1 credits'", () => {
    const out = html(1, true);
    expect(out).toContain('aria-label="1 credit — open Credits"');
    expect(out).toContain('<span class="pshell__balancelabel">credit</span>');
    expect(out).not.toContain(">credits<");
  });

  it("the number and the unit are two words in the text (not '1234credits')", () => {
    const out = html(1234, false);
    expect(out).toContain(
      '<span class="ui-num pshell__balancenum">1234</span> <span class="pshell__balancelabel">',
    );
  });
});

describe("the linked chip carries the navigation pending cue (components/nav-pending.tsx)", () => {
  it("the link ends in its cue — idle, hidden from assistive tech; the static chip has none", () => {
    expect(html(1234, true)).toMatch(/<span class="nav-pending" aria-hidden="true"><\/span><\/a>$/);
    expect(html(1234, false)).not.toContain("nav-pending");
  });

  it("the cue adds no words: the chip is still named and read as before", () => {
    const out = html(1234, true);
    expect(out).toContain('aria-label="1234 credits — open Credits"');
    expect(text(out.slice(0, out.indexOf('<span class="bb-icon-tip')))).toBe("1234 credits");
  });
});
