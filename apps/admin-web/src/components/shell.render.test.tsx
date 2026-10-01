import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The portal chrome's drawer toggle. The glyph used to be the `☰` character, which the UI face
 * does not carry: it fell back to a thin, stroke-drawn system glyph. It is now the solid Phosphor
 * `list` fill (`PhIcon`) — and the button's accessible name, expanded state and controlled
 * element must not have moved with it.
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
  const start = out.indexOf('<button class="topbar__menu"');
  expect(start).toBeGreaterThanOrEqual(0);
  return out.slice(start, out.indexOf("</button>", start) + "</button>".length);
}

describe("the drawer toggle", () => {
  it("draws the solid Phosphor list glyph, not the ☰ fallback character", () => {
    const button = toggle(render());
    expect(button).toContain('<svg class="ph-icon" viewBox="0 0 256 256" aria-hidden="true"');
    expect(button).not.toContain("☰");
  });

  it("keeps its accessible name: the sr-only label, with the glyph hidden from AT", () => {
    const button = toggle(render());
    // What a screen reader names it: everything but the aria-hidden glyph.
    const name = button
      .replace(/<svg[\s\S]*?<\/svg>/, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    expect(name).toBe("Navigation");
    expect(button).toContain('<span class="sr-only">Navigation</span>');
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
