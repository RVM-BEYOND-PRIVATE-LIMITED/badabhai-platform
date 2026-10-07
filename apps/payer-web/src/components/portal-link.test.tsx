import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type * as LinkModule from "next/link";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * PortalLink — the portal's only in-app link (follow-up to #2115): next/link's REAL `Link`, with
 * the navigation pending cue as its last direct child. Every in-app link is one
 * (app/every-link-shows-the-cue.test.ts), so what is pinned here is what every link does.
 *
 * The node env cannot mount React, so `useLinkStatus` is a switch and `useEffect` a recorder (as
 * in nav-pending.render.test.tsx); `Link` itself is next's own, rendered to markup.
 */
type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };
const hooks = vi.hoisted(() => ({ pending: false, effects: [] as Effect[] }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect: (run: Effect["run"], deps?: readonly unknown[]) => {
    hooks.effects.push({ run, deps });
  },
}));
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<typeof LinkModule>()),
  useLinkStatus: () => ({ pending: hooks.pending }),
}));

const { PortalLink } = await import("./portal-link");
const { resetNavigationForTests, shownNavigation, NAV_PENDING_DELAY_MS } =
  await import("./nav-pending-store");

const CUE_IDLE = '<span class="nav-pending" aria-hidden="true"></span>';
const CUE_ON = '<span class="nav-pending nav-pending--on" aria-hidden="true"></span>';

beforeEach(() => {
  hooks.pending = false;
  hooks.effects = [];
  resetNavigationForTests();
});

describe("PortalLink", () => {
  it("is next/link's <a>: its children, then the cue as the LAST direct child", () => {
    expect(
      renderToStaticMarkup(
        <PortalLink
          className="postings-link"
          href="/postings/p1/applicants"
          pendingLabel="Applicants"
        >
          <span>Applicants</span>
        </PortalLink>,
      ),
    ).toBe(
      `<a class="postings-link" href="/postings/p1/applicants"><span>Applicants</span>${CUE_IDLE}</a>`,
    );
  });

  it("an EMPTY link (a card's overlay) holds only the cue", () => {
    expect(
      renderToStaticMarkup(
        <PortalLink
          className="bb-stretched-link"
          href="/postings/p1"
          aria-label="Open"
          pendingLabel="CNC Turner"
        />,
      ),
    ).toBe(`<a class="bb-stretched-link" aria-label="Open" href="/postings/p1">${CUE_IDLE}</a>`);
  });

  it("passes every link prop through — the cue adds no text, so the accessible name is unchanged", () => {
    const out = renderToStaticMarkup(
      <PortalLink
        href="/account"
        pendingLabel="Account"
        role="menuitem"
        title="Your account"
        aria-current="page"
        aria-label="Account settings"
      >
        Account
      </PortalLink>,
    );
    for (const attr of [
      'href="/account"',
      'role="menuitem"',
      'title="Your account"',
      'aria-current="page"',
      'aria-label="Account settings"',
    ]) {
      expect(out, attr).toContain(attr);
    }
    // The only text in the link is its own.
    expect(out.replace(/<[^>]*>/g, "")).toBe("Account");
    // `pendingLabel` is the cue's, never an attribute on the <a>.
    expect(out).not.toContain("pendingLabel");
    expect(out).not.toContain("pendinglabel");
  });

  it("while its navigation is pending, the dot is on and the shell is told WHERE it goes", () => {
    vi.useFakeTimers();
    try {
      hooks.pending = true;
      const out = renderToStaticMarkup(
        <PortalLink href="/credits" pendingLabel="Credits">
          Buy credits
        </PortalLink>,
      );
      expect(out).toBe(`<a href="/credits">Buy credits${CUE_ON}</a>`);
      // The announcement names `pendingLabel` — not the link's text.
      const effect = hooks.effects.find((e) => e.deps?.includes("Credits"));
      expect(effect?.deps).toEqual([true, "Credits"]);
      effect!.run();
      vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
      expect(shownNavigation()).toBe("Credits");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a link with no pendingLabel does not compile", () => {
    // @ts-expect-error — every in-app link names its destination for the pending cue
    const uncued = <PortalLink href="/postings">Postings</PortalLink>;
    expect(uncued).toBeTruthy();
  });
});
