import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The portal chrome's drawer toggle. The glyph used to be the `☰` character, which the UI face
 * does not carry: it fell back to a thin, stroke-drawn system glyph. It then became an inline-SVG
 * copy of Phosphor's `list` fill; it is now the shared IconButton drawing `list` from the
 * self-hosted Phosphor FILL font (@badabhai/icons) — and the button's accessible name, expanded
 * state and controlled element must not have moved with it.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/jobs" }));

const { Shell } = await import("./shell");

const render = () =>
  renderToStaticMarkup(
    <Shell
      sections={[{ title: "Operations", items: [{ href: "/jobs", label: "Jobs" }] }]}
      roleLabel="Ops admin"
      adminId="a1b2c3d4-0000-4000-8000-000000000001"
      onSignOut={null}
    >
      <p>content</p>
    </Shell>,
  );

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
