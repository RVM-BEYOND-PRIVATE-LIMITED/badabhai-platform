import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The portal chrome's drawer toggle. The glyph used to be the `☰` character, which the UI face
 * does not carry: it fell back to a thin, stroke-drawn system glyph. It then became an inline-SVG
 * copy of Phosphor's `list` fill; it is now the shared IconButton drawing `list` from the
 * self-hosted Phosphor FILL font (@badabhai/icons) — and the button's accessible name, expanded
 * state and controlled element must not have moved with it.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));

const { Shell } = await import("./shell");

const render = (environment: string | null = "staging") =>
  renderToStaticMarkup(
    <Shell
      sections={[
        { title: "Directory", items: [{ href: "/jobs", label: "Postings", icon: "briefcase" }] },
      ]}
      roleLabel="Ops admin"
      adminId="a1b2c3d4-0000-4000-8000-000000000001"
      environment={environment}
      jumpKinds={["candidate", "company", "posting"]}
      onSignOut={<button type="button">Sign out</button>}
    >
      <p>content</p>
    </Shell>,
  );

/** The topbar's markup, `<header class="topbar">` to its close. */
const topbar = (out: string) =>
  out.slice(out.indexOf('<header class="topbar">'), out.indexOf("</header>", out.indexOf('<header class="topbar">')));

/** The toggle's markup, from its opening tag to its closing `</button>`. */
function toggle(out: string): string {
  const cls = out.indexOf('class="iconbtn iconbtn--outline topbar__menu"');
  expect(cls).toBeGreaterThanOrEqual(0);
  const start = out.lastIndexOf("<button", cls);
  expect(start).toBeGreaterThanOrEqual(0);
  return out.slice(start, out.indexOf("</button>", start) + "</button>".length);
}

describe("the drawer toggle", () => {
  it("draws the solid Phosphor list glyph from the icon font — no SVG copy, no ☰ character", () => {
    const button = toggle(render());
    expect(button).toContain('<i class="ph-fill ph-list" aria-hidden="true"></i>');
    expect(button).not.toContain("<svg");
    expect(button).not.toContain("☰");
  });

  it('keeps its accessible name, "Navigation" — the aria-label, with glyph and tooltip hidden from AT', () => {
    const button = toggle(render());
    expect(button).toContain('aria-label="Navigation"');
    // Everything inside the button is aria-hidden, so the aria-label is the ONLY name.
    const exposed = button
      .replace(/<i [^>]*aria-hidden="true"[^>]*><\/i>/, "")
      .replace(/<span [^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    expect(exposed).toBe("");
  });

  it("shows that name as a visible tooltip, opening below from the left-edge toggle — not a title", () => {
    const button = toggle(render());
    expect(button).toContain(
      '<span class="bb-icon-tip bb-icon-tip--bottom-start" aria-hidden="true">Navigation</span>',
    );
    expect(button).not.toContain("title=");
  });

  it("keeps its disclosure state and the element it controls", () => {
    const out = render();
    const button = toggle(out);
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-controls="portal-sidebar"');
    expect(button).toContain('type="button"');
    expect(out).toContain('<aside class="sidebar" id="portal-sidebar">');
  });
});

/**
 * The navigation status line and page-wide bar (review of #2095), rendered ONCE by the shell —
 * outside the page, which is `inert` behind an open drawer (an inert live region says nothing),
 * and outside the drawer that closes as its link is followed.
 */
describe("the navigation status", () => {
  it("is one polite status region, outside both the sidebar and the page", () => {
    const out = render();
    expect(out.split('role="status" aria-live="polite"')).toHaveLength(2);
    const status = out.indexOf('role="status" aria-live="polite"');
    const sidebar = out.indexOf('<aside class="sidebar"');
    const sidebarEnd = out.indexOf("</aside>");
    const main = out.indexOf('<div class="shell__main"');
    expect(status).toBeGreaterThan(-1);
    expect(status > sidebar && status < sidebarEnd).toBe(false);
    expect(status).toBeLessThan(main);
    expect(out).toContain('<div class="nav-progress" aria-hidden="true"></div>');
  });
});

/**
 * THE TOPBAR (A6, #2576): after the crumb, on the right — the quick jump, the environment the API
 * reports, and the avatar menu holding Account and Sign out. The sidebar keeps only the brand and
 * the nav: its foot is gone, so Sign out is never below the fold.
 */
describe("the topbar's right-hand side (A6)", () => {
  it("is the quick jump, then the environment badge, then the avatar menu — in that order", () => {
    const bar = topbar(render());
    const jump = bar.indexOf("topbar__jump");
    const env = bar.indexOf('class="topbar__env');
    const avatar = bar.indexOf('class="avatar-menu"');
    expect(bar.indexOf('class="crumbs"')).toBeLessThan(jump);
    expect(jump).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(jump);
    expect(avatar).toBeGreaterThan(env);
  });

  it("the badge names the API's environment, not the role (it used to be the role pill)", () => {
    const bar = topbar(render("staging"));
    expect(bar).toContain('<span class="sr-only">Environment: </span>Staging</span>');
    expect(bar).not.toContain('<span class="topbar__env">Ops admin</span>');
  });

  it("production is the navy badge; an unreadable probe says unknown", () => {
    expect(topbar(render("production"))).toContain('class="topbar__env topbar__env--production"');
    expect(topbar(render(null))).toContain(">Environment unknown</span>");
  });

  it("Sign out and Account live in the avatar menu, in the always-visible topbar", () => {
    const bar = topbar(render());
    expect(bar).toContain(">Sign out</button>");
    expect(bar).toContain('href="/account"');
  });

  it("the sidebar is the brand and the nav, nothing else", () => {
    const out = render();
    const aside = out.slice(out.indexOf('<aside class="sidebar"'), out.indexOf("</aside>"));
    expect(aside).not.toContain("sidebar__foot");
    expect(aside).not.toContain("Sign out");
    expect(aside).not.toContain('href="/account"');
    expect(aside).toContain('class="sidebar__brand"');
    expect(aside).toContain('aria-label="Portal sections"');
  });

  it("the palette's dialog is in the page, closed, until the shortcut or the button opens it", () => {
    const out = render();
    expect(out).toContain('<dialog class="jump"');
    expect(out).not.toMatch(/<dialog class="jump"[^>]* open/);
  });
});
