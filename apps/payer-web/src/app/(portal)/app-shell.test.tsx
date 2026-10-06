import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NavSection } from "./nav-model";

/**
 * The portal shell's two rail toggles (final sweep C, F05 / F26 / F34).
 *
 * MEASURED BEFORE: at 1280 / 1440px, 80 Tab presses on /dashboard never reached the collapse
 * button (an unconditional tabIndex={-1}); collapsed, it had no accessible name (its only text,
 * the label span, is display:none there), said "pressed" with no name, and drew a raw glyph. The
 * menu button had no tooltip.
 *
 * Real SSR (renderToStaticMarkup). AppShell's two useState calls are seeded by position —
 * (1) drawerOpen, (2) collapsed — so both collapse states render without a click. APPEND a seed
 * for a new useState; never insert one.
 */

const seeds = { drawerOpen: false, collapsed: false };
const cursor = { i: 0 };
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = cursor.i++;
      if (i === 0) return [seeds.drawerOpen, vi.fn()];
      if (i === 1) return [seeds.collapsed, vi.fn()];
      return actual.useState(init);
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
  };
});

const { AppShell } = await import("./app-shell");

const SECTIONS: NavSection[] = [
  {
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: "squares-four",
        match: { exact: ["/dashboard"] },
      },
    ],
  },
];

function render(): string {
  cursor.i = 0;
  return renderToStaticMarkup(
    <AppShell
      sections={SECTIONS}
      brand={<span>brand</span>}
      header={<span>hdr</span>}
      footer={<span>foot</span>}
    >
      <p>page</p>
    </AppShell>,
  );
}

/** The opening tag (attributes) of the first element carrying `cls`, and the element's markup. */
function element(html: string, tag: string, cls: string): { open: string; whole: string } {
  const at = html.indexOf(`class="${cls}"`);
  expect(at, `${cls} must render`).toBeGreaterThan(-1);
  const start = html.lastIndexOf(`<${tag}`, at);
  const open = html.slice(start, html.indexOf(">", at) + 1);
  const whole = html.slice(start, html.indexOf(`</${tag}>`, at) + `</${tag}>`.length);
  return { open, whole };
}
const attr = (open: string, name: string): string | null => {
  const needle = ` ${name}="`;
  const at = open.indexOf(needle);
  if (at < 0) return null;
  const from = at + needle.length;
  return open.slice(from, open.indexOf('"', from));
};

beforeEach(() => {
  seeds.drawerOpen = false;
  seeds.collapsed = false;
});

describe("the rail's collapse toggle (F05)", () => {
  it("is a Tab stop: no tabindex of its own (the CSS display:none hides it where it is not drawn)", () => {
    for (const collapsed of [false, true]) {
      seeds.collapsed = collapsed;
      const { open } = element(render(), "button", "pshell__collapse");
      expect(attr(open, "tabindex"), `collapsed=${collapsed}`).toBeNull();
      expect(attr(open, "type")).toBe("button");
    }
  });

  it("expanded: named 'Collapse navigation' (containing its visible 'Collapse'), aria-expanded=true", () => {
    const { open, whole } = element(render(), "button", "pshell__collapse");
    expect(attr(open, "aria-label")).toBe("Collapse navigation");
    expect(attr(open, "title")).toBe("Collapse navigation");
    expect(attr(open, "aria-expanded")).toBe("true");
    expect(whole).toContain('<span class="pnav__label">Collapse</span>');
    expect(whole).toContain('<i class="ph-fill ph-caret-left" aria-hidden="true"></i>');
  });

  it("collapsed (icon-only): named and titled 'Expand navigation', aria-expanded=false, caret right", () => {
    seeds.collapsed = true;
    const html = render();
    expect(html).toContain('class="pshell pshell--collapsed"');
    const { open, whole } = element(html, "button", "pshell__collapse");
    expect(attr(open, "aria-label")).toBe("Expand navigation");
    expect(attr(open, "title")).toBe("Expand navigation");
    expect(attr(open, "aria-expanded")).toBe("false");
    expect(whole).toContain('<i class="ph-fill ph-caret-right" aria-hidden="true"></i>');
  });

  it("its state is aria-expanded on the rail it controls — never aria-pressed beside a changing name", () => {
    for (const collapsed of [false, true]) {
      seeds.collapsed = collapsed;
      const html = render();
      const { open } = element(html, "button", "pshell__collapse");
      expect(attr(open, "aria-pressed")).toBeNull();
      const controls = attr(open, "aria-controls");
      expect(controls).toBeTruthy();
      expect(attr(element(html, "aside", "pshell__rail").open, "id")).toBe(controls);
    }
  });
});

describe("the header's menu button (F26 / F34)", () => {
  it("is the shared icon-only control: named 'Navigation', with that tooltip and the typed glyph", () => {
    const { open, whole } = element(render(), "button", "pshell__menu");
    expect(attr(open, "type")).toBe("button");
    expect(attr(open, "aria-label")).toBe("Navigation");
    expect(whole).toContain('<i class="ph-fill ph-list" aria-hidden="true"></i>');
    expect(whole).toContain(
      '<span class="bb-icon-tip bb-icon-tip--bottom-start" aria-hidden="true">Navigation</span>',
    );
    // The old visually-hidden name is gone: one name, from the label.
    expect(whole).not.toContain("sr-only");
  });

  it("discloses the same rail as the collapse toggle, and reports the drawer's state", () => {
    for (const drawerOpen of [false, true]) {
      seeds.drawerOpen = drawerOpen;
      const html = render();
      const { open } = element(html, "button", "pshell__menu");
      expect(attr(open, "aria-expanded")).toBe(String(drawerOpen));
      expect(attr(open, "aria-controls")).toBe(
        attr(element(html, "aside", "pshell__rail").open, "id"),
      );
    }
  });
});
