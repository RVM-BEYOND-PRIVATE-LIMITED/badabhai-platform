import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * for a new useState; never insert one. Their setters are kept (by the same position), and
 * `useEffect` RECORDS each effect with its dependencies instead of running it (on the server it
 * never runs), so a test can run one by what it is keyed on.
 */

const seeds = { drawerOpen: false, collapsed: false };
const cursor = { i: 0 };
const setters: Array<ReturnType<typeof vi.fn>> = [];
const effects: Array<{ effect: () => unknown; deps: readonly unknown[] | undefined }> = [];
// AppShell's own refs, by position — (1) the rail, (2) the scrim — handed stand-in elements (a
// server render attaches none). Later useRef calls (children's) get their initial value.
const refSeeds: unknown[] = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = cursor.i++;
      setters[i] = vi.fn();
      if (i === 0) return [seeds.drawerOpen, setters[i]];
      if (i === 1) return [seeds.collapsed, setters[i]];
      return actual.useState(init);
    },
    useRef: (init: unknown) => ({ current: refSeeds.length > 0 ? refSeeds.shift() : init }),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) =>
      void effects.push({ effect, deps }),
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
const disarm = vi.fn();
const openDrawer = vi.fn((_parts: unknown) => disarm);
vi.mock("./drawer-focus", () => ({ openDrawer: (p: unknown) => openDrawer(p) }));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    // The pending cue inside each link reads its status (components/nav-pending.tsx): idle.
    useLinkStatus: () => ({ pending: false }),
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
  effects.length = 0;
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

describe("the drawer closes on a route change (review of final sweep C)", () => {
  it("keyed on the PATH — `children` keeps its identity across navigations in a persistent layout", () => {
    // MEASURED BEFORE: keyed on `children`, the drawer stayed open after /dashboard → a drawer
    // link → /postings/new (375px) — with Tab contained in it, the keyboard would stay trapped.
    seeds.drawerOpen = true;
    render();
    const onPath = effects.filter((e) => e.deps?.length === 1 && e.deps[0] === "/dashboard");
    expect(onPath).toHaveLength(1);
    onPath[0]!.effect();
    expect(setters[0]).toHaveBeenCalledWith(false);
  });
});

describe("the open drawer arms its keyboard model (review of final sweep C)", () => {
  const rail = { el: "rail" };
  const scrim = { el: "scrim" };
  const menuEl = { el: "menu" };
  afterEach(() => vi.unstubAllGlobals());

  function run(drawerOpen: boolean) {
    seeds.drawerOpen = drawerOpen;
    openDrawer.mockClear();
    refSeeds.splice(0, refSeeds.length, rail, scrim);
    const html = render();
    const menuId = attr(element(html, "button", "pshell__menu").open, "id");
    // The effect runs in a browser: the document it hands over finds the menu button by its id.
    const doc = { getElementById: (id: string) => (id === menuId ? menuEl : null) };
    const view = { el: "window" };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", view);
    // The drawer effect by its own dependencies, [drawerOpen, menuId] — a rail link's pending cue
    // also records a two-dependency effect, [pending, label].
    const armed = effects.filter(
      (e) => e.deps?.length === 2 && e.deps[0] === drawerOpen && e.deps[1] === menuId,
    );
    expect(armed).toHaveLength(1);
    return { doc, view, menuId, cleanup: armed[0]!.effect() };
  }

  it("open: arms it with the rail, the scrim, the menu button (by its id) and a close; disarms on close", () => {
    const { doc, view, menuId, cleanup } = run(true);
    expect(menuId).toBeTruthy();
    expect(openDrawer).toHaveBeenCalledTimes(1);
    const parts = openDrawer.mock.calls[0]![0] as {
      doc: unknown;
      view: unknown;
      rail: unknown;
      scrim: unknown;
      menu: () => unknown;
      isModal: () => boolean;
      close: () => void;
    };
    expect(parts.doc).toBe(doc);
    // Resizes are heard on the window (leaving drawer mode closes it).
    expect(parts.view).toBe(view);
    expect(parts.rail).toBe(rail);
    expect(parts.scrim).toBe(scrim);
    expect(parts.menu()).toBe(menuEl);
    // The effect's cleanup IS the disarm (focus back to the menu button on close).
    expect(cleanup).toBe(disarm);
    parts.close();
    expect(setters[0]).toHaveBeenCalledWith(false);
    // "Modal" is whether the scrim is drawn — the breakpoint stays in the stylesheet.
    vi.stubGlobal("getComputedStyle", (n: unknown) => ({
      display: n === scrim ? "block" : "none",
    }));
    expect(parts.isModal()).toBe(true);
    vi.stubGlobal("getComputedStyle", () => ({ display: "none" }));
    expect(parts.isModal()).toBe(false);
  });

  it("closed: nothing is armed", () => {
    const { cleanup } = run(false);
    expect(cleanup).toBeUndefined();
    expect(openDrawer).not.toHaveBeenCalled();
  });
});

describe("the open drawer is a MODAL for assistive tech (review of final sweep C)", () => {
  it("open: the rail is a labelled role=dialog with aria-modal, and the page behind it is inert", () => {
    seeds.drawerOpen = true;
    const html = render();
    const aside = element(html, "aside", "pshell__rail").open;
    expect(attr(aside, "role")).toBe("dialog");
    expect(attr(aside, "aria-modal")).toBe("true");
    expect(attr(aside, "aria-label")).toBe("Navigation");
    expect(attr(element(html, "div", "pshell__main").open, "inert")).toBe("");
  });

  it("closed (and at ≥1024px, where it never opens): the plain rail landmark, the page live", () => {
    seeds.drawerOpen = false;
    const html = render();
    const aside = element(html, "aside", "pshell__rail").open;
    expect(attr(aside, "role")).toBeNull();
    expect(attr(aside, "aria-modal")).toBeNull();
    expect(attr(aside, "aria-label")).toBeNull();
    expect(attr(element(html, "div", "pshell__main").open, "inert")).toBeNull();
  });

  it("the scrim is never a Tab stop (it covers the viewport; its ring would be off-screen)", () => {
    for (const drawerOpen of [false, true]) {
      seeds.drawerOpen = drawerOpen;
      const scrim = element(render(), "button", "pshell__scrim").open;
      expect(attr(scrim, "tabindex"), `open=${drawerOpen}`).toBe("-1");
      expect(attr(scrim, "aria-hidden")).toBe(String(!drawerOpen));
    }
  });
});

describe("the navigation pending cue (components/nav-pending.tsx)", () => {
  it("each rail row ends in its own pending cue (idle: no `--on`, hidden from assistive tech)", () => {
    const row = element(render(), "a", "pnav__link pnav__link--active").whole;
    expect(row.endsWith('<span class="nav-pending" aria-hidden="true"></span></a>')).toBe(true);
  });

  it("the bar and the one status line sit in the shell, OUTSIDE the page that goes inert behind the drawer", () => {
    seeds.drawerOpen = true;
    const html = render();
    const main = element(html, "div", "pshell__main");
    expect(attr(main.open, "inert")).toBe("");
    const status = html.indexOf('<p class="sr-only" role="status" aria-live="polite">');
    const bar = html.indexOf('<div class="nav-progress" aria-hidden="true">');
    expect(status).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(-1);
    expect(main.whole).not.toContain('role="status"');
    expect(main.whole).not.toContain("nav-progress");
    // Exactly one status line in the whole shell.
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });
});
