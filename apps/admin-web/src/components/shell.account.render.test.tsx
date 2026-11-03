import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Account in the user area (ADR-0060 A5). Every signed-in admin has an Account page, so its link
 * is in the sidebar's foot — beside who you are and Sign out — for every role, whatever the
 * filtered nav holds. It wears the nav row's styling, so on /account it reads as the current
 * page the same way a nav item does.
 */
const nav = vi.hoisted(() => ({ pathname: "/jobs" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { Shell, ACCOUNT_HREF } = await import("./shell");

const render = () =>
  renderToStaticMarkup(
    <Shell
      // An analyst-like session whose filtered nav is a single item: Account must still be there.
      sections={[
        { title: "Overview", items: [{ href: "/", label: "Dashboard", icon: "squares-four" }] },
      ]}
      roleLabel="Analyst"
      adminId="a1b2c3d4-0000-4000-8000-000000000001"
      onSignOut={<button type="button">Sign out</button>}
    >
      <p>content</p>
    </Shell>,
  );

/** The sidebar foot's markup. */
const foot = (out: string) => out.slice(out.indexOf('<div class="sidebar__foot">'), out.indexOf("</aside>"));
/** The Account link's opening tag. */
const accountLink = (out: string) => /<a[^>]*href="\/account"[^>]*>/.exec(foot(out))?.[0] ?? "";

beforeEach(() => {
  nav.pathname = "/jobs";
});

describe("the Account link", () => {
  it("is in the user area, between who you are and Sign out", () => {
    const out = foot(render());
    expect(ACCOUNT_HREF).toBe("/account");
    const whoami = out.indexOf('class="whoami"');
    const account = out.indexOf('href="/account"');
    const signOut = out.indexOf("Sign out");
    expect(whoami).toBeGreaterThan(-1);
    expect(account).toBeGreaterThan(whoami);
    expect(signOut).toBeGreaterThan(account);
    expect(out).toContain(">Account</span>");
  });

  it("draws the settings glyph, like payer-web's Account", () => {
    expect(foot(render())).toContain('<i class="ph-fill ph-gear sidebar__icon" aria-hidden="true"></i>');
  });

  it("is not the current page elsewhere", () => {
    const link = accountLink(render());
    expect(link).not.toBe("");
    expect(link).not.toContain("aria-current");
    expect(link).not.toContain("is-active");
  });

  it("on /account it is the current page", () => {
    nav.pathname = "/account";
    const link = accountLink(render());
    expect(link).toContain('aria-current="page"');
    expect(link).toContain("is-active");
  });
});
