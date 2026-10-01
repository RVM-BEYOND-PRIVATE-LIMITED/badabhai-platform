import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The sidebar draws each item's glyph from the shared icon font, before its label, decorative
 * (the label names the destination), and inheriting the row's colour — so the active row's
 * glyph is Safety Yellow on the navy band with no icon-specific rule.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/jobs/abc" }));

const { SidebarNav } = await import("./nav");

const out = renderToStaticMarkup(
  <SidebarNav
    sections={[
      {
        title: "Operations",
        items: [
          { href: "/workers", label: "Workers", icon: "users-three" },
          { href: "/jobs", label: "Postings", icon: "briefcase" },
        ],
      },
    ]}
  />,
);

describe("SidebarNav", () => {
  it("draws the glyph before the label, hidden from assistive tech", () => {
    expect(out).toContain(
      '<i class="ph-fill ph-users-three sidebar__icon" aria-hidden="true"></i><span class="sidebar__label">Workers</span>',
    );
  });

  it("marks the section of a detail route active, glyph included", () => {
    const active = out.slice(out.indexOf('href="/jobs"') - 40, out.indexOf("Postings") + 20);
    expect(active).toContain('aria-current="page"');
    expect(active).toContain("is-active");
    expect(active).toContain("ph-briefcase");
  });
});
