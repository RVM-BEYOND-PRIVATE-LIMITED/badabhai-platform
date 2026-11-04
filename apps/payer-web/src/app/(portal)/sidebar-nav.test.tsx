import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NavSection } from "./nav-model";

/**
 * #2586 (W6) — the rail's marker moves ON THE PRESS, not after the next page renders.
 *
 * The portal keeps the current page on screen until the next one has rendered (no loading
 * boundary), so a row lit by the PATH lit up seconds after the click. Now the active row is the
 * one a press is taking the payer to. That starts the moment that link's navigation is pending
 * (Next's `useLinkStatus`, the pending cue's own signal). It ends when the path moves on or the
 * link goes idle again, because another navigation took over. One marker glides there
 * (rail-marker.ts). `aria-current` stays on the page actually open.
 *
 * The stylesheet half is app/w6-transitions.css.test.ts. W2's first-paint guarantees are
 * app/w2-brand-tokens.css.test.ts.
 *
 * Node env. The server render is real (the rail inside its press scope, rail-press.tsx, as
 * AppShell renders it), and the rest is stood in:
 *  - `next/link` is an `<a>` that tells `useLinkStatus` which link it is, so one link can be
 *    pending: by its href, and by its class where two links share one (the logo and the
 *    Dashboard row);
 *  - `useEffect` is a recorder that a test runs by hand, one "commit" at a time;
 *  - `useState` is seeded (`hooks.stub`) where a press is already held. With
 *    {@link applyingSetPress} it applies updates as React would;
 *  - `useRef` keeps each call's ref from one render to the next, in render order, as React keeps a
 *    mounted component's ref.
 */
const hooks = vi.hoisted(() => ({
  pathname: "/dashboard",
  pendingHref: null as string | null,
  /** With `pendingHref`: only the link carrying this class is pending (null: any link to it). */
  pendingClass: null as string | null,
  stub: false,
  press: null as unknown,
  setPress: (() => undefined) as (v: unknown) => void,
  effects: [] as Array<{ run: () => unknown; deps: readonly unknown[] | undefined }>,
  refs: [] as Array<{ current: unknown }>,
  refAt: 0,
}));

vi.mock("next/navigation", () => ({ usePathname: () => hooks.pathname }));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  const ThisLink = React.createContext<{ href: string; className: string } | null>(null);
  return {
    useLinkStatus: () => {
      const link = React.useContext(ThisLink);
      return {
        pending:
          link !== null &&
          link.href === hooks.pendingHref &&
          (hooks.pendingClass === null || link.className.split(" ").includes(hooks.pendingClass)),
      };
    },
    default: ({
      children,
      href,
      className = "",
      ...rest
    }: {
      children: ReactNode;
      href: string;
      className?: string;
    }) =>
      React.createElement(
        ThisLink.Provider,
        { value: { href, className } },
        React.createElement("a", { href, className: className || undefined, ...rest }, children),
      ),
  };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (init: unknown) =>
      hooks.stub ? [hooks.press, hooks.setPress] : actual.useState(init),
    useEffect: (run: () => unknown, deps?: readonly unknown[]) =>
      void hooks.effects.push({ run, deps }),
    useRef: (init: unknown) => (hooks.refs[hooks.refAt++] ??= { current: init }),
  };
});

const { SidebarNav } = await import("./sidebar-nav");
const { RailPress, RailPressScope } = await import("./rail-press");
const { PortalLink } = await import("../../components/portal-link");
const {
  boxWithin,
  placeRailMarker,
  plateCover,
  plateTopOf,
  railMarkerRef,
  GLIDING_ATTR,
  ON_PLATE_ATTR,
  RAIL_MARKER_ATTR,
} = await import("./rail-marker");

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
  {
    title: "Hiring",
    items: [
      { href: "/postings", label: "Postings", icon: "briefcase", match: { prefix: ["/postings"] } },
      {
        href: "/candidates",
        label: "Candidates",
        icon: "users",
        match: { prefix: ["/candidates"] },
      },
    ],
  },
];

beforeEach(() => {
  hooks.pathname = "/dashboard";
  hooks.pendingHref = null;
  hooks.pendingClass = null;
  hooks.stub = false;
  hooks.press = null;
  hooks.setPress = () => undefined;
  hooks.effects = [];
  hooks.refs = [];
  hooks.refAt = 0;
});
afterEach(() => vi.unstubAllGlobals());

/** The brand lockup's link to the portal home, as layout.tsx renders it (it reports its press too). */
const LOGO = (
  <PortalLink className="pshell__brandlink" href="/dashboard" pendingLabel="Dashboard">
    <RailPress href="/dashboard" />
  </PortalLink>
);

/** The rail as AppShell renders it: the lockup and the nav, in one press scope. */
function render(): string {
  hooks.effects = [];
  hooks.refAt = 0;
  return renderToStaticMarkup(
    <RailPressScope>
      {LOGO}
      <SidebarNav sections={SECTIONS} />
    </RailPressScope>,
  );
}

/** The nav's own markup, without the lockup in front of it. */
const navOf = (html: string) => html.slice(html.indexOf("<nav"));

/** The held press, with updates applied as React applies them (a value, or an updater). */
function applyingSetPress(): void {
  hooks.stub = true;
  hooks.setPress = (v) => {
    hooks.press = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.press) : v;
  };
}

/**
 * One React commit: render, then run the rail links' status reports (their passive effects) in
 * tree order, or the reverse.
 */
function commit(order: "tree" | "reverse" = "tree"): string {
  const html = render();
  const reports = pressReports();
  for (const e of order === "tree" ? reports : reports.reverse()) e.run();
  return html;
}

/** The opening tag of the rail ROW to `href` (in the nav, not the lockup). */
function row(html: string, href: string): string {
  const nav = navOf(html);
  const at = nav.indexOf(`href="${href}"`);
  expect(at, href).toBeGreaterThan(-1);
  return nav.slice(nav.lastIndexOf("<a", at), nav.indexOf(">", at) + 1);
}
const isActive = (tag: string) => tag.includes('class="pnav__link pnav__link--active"');
const isCurrent = (tag: string) => tag.includes('aria-current="page"');

/**
 * The status reports the rail's links recorded as effects (`[pending, href, by, onPress,
 * onRelease]`), in tree order: the lockup's first, then the rows'.
 */
const pressReports = () => hooks.effects.filter((e) => e.deps?.length === 5);
/** The rows' reports only (the lockup's is the first). */
const rowReports = () => pressReports().slice(1);
/** The id of the link that made a press (its `useId`); the tests that tell links apart pin which. */
const ROW_ID = expect.any(String);

describe("first paint — the server markup, before any script (W2 #2582 kept)", () => {
  it("the PATH's row is active and current; no other row is", () => {
    const html = render();
    expect(isActive(row(html, "/dashboard"))).toBe(true);
    expect(isCurrent(row(html, "/dashboard"))).toBe(true);
    for (const href of ["/postings", "/candidates"]) {
      expect(isActive(row(html, href)), href).toBe(false);
      expect(isCurrent(row(html, href)), href).toBe(false);
    }
  });

  it("the marker is the nav's LAST child, so `.pnav__group:nth-child(k)` is still the k-th group, and is not placed yet", () => {
    // The rail groups' entrance stagger (globals.css, sidebar polish) counts with :nth-child. A
    // marker in front of the groups shifted every delay by one and left the 5th and 6th groups of
    // an agency rail undelayed. It is drawn behind the rows by z-index, not by source order
    // (app/w6-transitions.css.test.ts).
    const html = render();
    expect(
      navOf(html).startsWith('<nav class="pnav" aria-label="Primary"><div class="pnav__group">'),
    ).toBe(true);
    expect(html.endsWith('<span class="pnav__marker" aria-hidden="true"></span></nav>')).toBe(true);
    expect(html.split("pnav__marker")).toHaveLength(2);
    expect(html).not.toContain(RAIL_MARKER_ATTR);
  });

  it("each row still ends in its own pending cue (the press report draws nothing)", () => {
    const html = render();
    const whole = html.slice(
      html.indexOf(row(html, "/postings")),
      html.indexOf("</a>", html.indexOf('href="/postings"')) + 4,
    );
    expect(whole.endsWith('<span class="nav-pending" aria-hidden="true"></span></a>')).toBe(true);
  });
});

describe("a press moves the active row AT ONCE — while its navigation is pending", () => {
  it("the pressed link's pending status reports the press, from the page it was made on", () => {
    hooks.stub = true;
    const setPress = vi.fn();
    hooks.setPress = setPress;
    hooks.pendingHref = "/postings";
    render();
    const pending = pressReports().filter((e) => e.deps![0] === true);
    expect(pending.map((e) => e.deps![1])).toEqual(["/postings"]);
    pending[0]!.run();
    expect(setPress).toHaveBeenCalledTimes(1);
    const update = setPress.mock.calls[0]![0] as (p: unknown) => unknown;
    // Made by THAT link: its own id, never its destination, tells its release apart.
    const by = pending[0]!.deps![2];
    expect(typeof by).toBe("string");
    expect(update(null)).toEqual({ href: "/postings", from: "/dashboard", by });
  });

  it("each link reporting to the rail has its own id — the lockup's and the Dashboard row's too", () => {
    render();
    const ids = pressReports().map((e) => e.deps![2]);
    expect(pressReports().map((e) => e.deps![1])).toEqual([
      "/dashboard",
      "/dashboard",
      "/postings",
      "/candidates",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a link that is not pending reports nothing — a modified click or a new tab never moves it", () => {
    hooks.stub = true;
    const setPress = vi.fn();
    hooks.setPress = setPress;
    render();
    const idle = pressReports();
    expect(idle).toHaveLength(4); // the lockup and the three rows
    for (const e of idle) {
      expect(e.deps![0]).toBe(false);
      e.run();
    }
    expect(setPress).not.toHaveBeenCalled();
  });

  it("while it is pending the PRESSED row is active; `aria-current` stays on the page actually open", () => {
    hooks.stub = true;
    hooks.press = { href: "/postings", from: "/dashboard" };
    const html = render();
    expect(isActive(row(html, "/postings"))).toBe(true);
    expect(isCurrent(row(html, "/postings"))).toBe(false);
    expect(isActive(row(html, "/dashboard"))).toBe(false);
    expect(isCurrent(row(html, "/dashboard"))).toBe(true);
    expect(isActive(row(html, "/candidates"))).toBe(false);
  });

  it("the same press reported again keeps the state as it is (no render loop)", () => {
    hooks.stub = true;
    const setPress = vi.fn();
    hooks.setPress = setPress;
    hooks.pendingHref = "/postings";
    render();
    const report = pressReports().find((e) => e.deps![0] === true)!;
    const held = { href: "/postings", from: "/dashboard", by: report.deps![2] };
    report.run();
    const update = setPress.mock.calls[0]![0] as (p: unknown) => unknown;
    expect(update(held)).toBe(held);
    // A press by another link replaces it.
    expect(update({ href: "/candidates", from: "/dashboard", by: "another link" })).toEqual(held);
  });
});

describe("the press is spent once the path moves on", () => {
  it("landed: dropped during the render; the row is active by its path now, and current", () => {
    hooks.stub = true;
    const setPress = vi.fn();
    hooks.setPress = setPress;
    hooks.press = { href: "/postings", from: "/dashboard" };
    hooks.pathname = "/postings";
    const html = render();
    expect(setPress).toHaveBeenCalledWith(null);
    expect(isActive(row(html, "/postings"))).toBe(true);
    expect(isCurrent(row(html, "/postings"))).toBe(true);
  });

  it("another navigation won (the browser's back, a link in the page): the path's row, not the pressed one", () => {
    hooks.stub = true;
    const setPress = vi.fn();
    hooks.setPress = setPress;
    hooks.press = { href: "/postings", from: "/dashboard" };
    hooks.pathname = "/candidates";
    const html = render();
    expect(setPress).toHaveBeenCalledWith(null);
    expect(isActive(row(html, "/candidates"))).toBe(true);
    expect(isActive(row(html, "/postings"))).toBe(false);
  });
});

/*
 * Next 15.5's own sequencing, which the commits below replay:
 *  - a newer navigation (another link, a button's router.push/replace) sets the superseded link
 *    IDLE (links.js `setLinkForCurrentNavigation`);
 *  - a landing reverts the link's status in the commit that moves the path;
 *  - Back (a popstate RESTORE) commits the restored path outside the transition, so the old link
 *    still reports pending for a commit or more.
 */
describe("…and it ends with its link's navigation: a superseded press lets go, even on the same path", () => {
  it("the link goes idle with the path unchanged (the logo, a pager link, a router.replace after a save): the open page's row is active again", () => {
    applyingSetPress();
    hooks.pathname = "/candidates";
    hooks.pendingHref = "/postings";
    commit(); // the press: Postings' navigation started
    expect(hooks.press).toEqual({ href: "/postings", from: "/candidates", by: ROW_ID });
    expect(isActive(row(render(), "/postings"))).toBe(true);
    hooks.pendingHref = null; // the pager's navigation took over: Next idles the Postings link
    commit();
    expect(hooks.press).toBeNull();
    const html = render(); // …and it lands on /candidates?cursor=…: the same path
    expect(isActive(row(html, "/candidates"))).toBe(true);
    expect(isCurrent(row(html, "/candidates"))).toBe(true);
    expect(isActive(row(html, "/postings"))).toBe(false);
  });

  it("a render while the link still reports pending (Back committed the restored path first) never re-arms the press there", () => {
    applyingSetPress();
    hooks.pathname = "/dashboard";
    hooks.pendingHref = "/postings";
    commit();
    expect(hooks.press).toEqual({ href: "/postings", from: "/dashboard", by: ROW_ID });
    hooks.pathname = "/candidates"; // RESTORE committed; Postings' status is not reverted yet
    commit();
    expect(hooks.press).toBeNull();
    hooks.pendingHref = null; // the transition's commit reverts it
    commit();
    expect(hooks.press).toBeNull();
    const html = render();
    expect(isActive(row(html, "/candidates"))).toBe(true);
    expect(isActive(row(html, "/postings"))).toBe(false);
  });

  it("landed: the path moves and the link goes idle in one commit; the press is dropped in the render, and the release finds nothing (no glide back)", () => {
    applyingSetPress();
    hooks.pendingHref = "/postings";
    commit();
    hooks.pathname = "/postings";
    hooks.pendingHref = null;
    const html = commit();
    expect(hooks.press).toBeNull();
    expect(isActive(row(html, "/postings"))).toBe(true);
    expect(isCurrent(row(html, "/postings"))).toBe(true);
  });

  it("a release clears only its OWN press: one rail row taking over from another, in either effect order", () => {
    for (const order of ["tree", "reverse"] as const) {
      applyingSetPress();
      hooks.press = null;
      hooks.refs = [];
      hooks.pendingHref = "/postings";
      commit(order);
      hooks.pendingHref = "/candidates"; // Postings idle and Candidates pending, in one commit
      commit(order);
      expect(hooks.press, order).toEqual({ href: "/candidates", from: "/dashboard", by: ROW_ID });
      expect(isActive(row(render(), "/candidates")), order).toBe(true);
    }
  });

  it("each link reports an edge once: a re-render that changes nothing reports nothing", () => {
    hooks.stub = true;
    const setPress = vi.fn();
    hooks.setPress = setPress;
    hooks.pendingHref = "/postings";
    commit();
    commit();
    commit();
    expect(setPress).toHaveBeenCalledTimes(1);
    hooks.pendingHref = null;
    commit();
    commit();
    expect(setPress).toHaveBeenCalledTimes(2);
  });
});

describe("the brand lockup reports its press too: a press on the logo is a press on the Dashboard row", () => {
  it("the logo pressed on another page: the Dashboard row is active at once; `aria-current` stays on the page open", () => {
    applyingSetPress();
    hooks.pathname = "/postings";
    hooks.pendingHref = "/dashboard";
    hooks.pendingClass = "pshell__brandlink";
    commit(); // the logo's navigation started
    const logo = pressReports()[0]!.deps![2];
    expect(hooks.press).toEqual({ href: "/dashboard", from: "/postings", by: logo });
    const html = render();
    expect(isActive(row(html, "/dashboard"))).toBe(true);
    expect(isCurrent(row(html, "/dashboard"))).toBe(false);
    expect(isActive(row(html, "/postings"))).toBe(false);
    expect(isCurrent(row(html, "/postings"))).toBe(true);
  });

  it("the logo taking over from a pending Dashboard-row press keeps the row marked (no glide back to the open page), in either effect order", () => {
    // The row and the logo both go to /dashboard, and Next idles the row's link as the logo's
    // starts, in one commit. A release told apart by destination cleared the logo's fresh press
    // too: the marker went back to the open page's row, then on to Dashboard once it rendered.
    for (const order of ["tree", "reverse"] as const) {
      applyingSetPress();
      hooks.press = null;
      hooks.refs = [];
      hooks.pathname = "/postings";
      hooks.pendingHref = "/dashboard";
      hooks.pendingClass = "pnav__link"; // the Dashboard row's navigation started
      commit(order);
      const [logo, dashboardRow] = pressReports().map((e) => e.deps![2]);
      expect(logo, order).not.toBe(dashboardRow);
      expect(hooks.press, order).toEqual({
        href: "/dashboard",
        from: "/postings",
        by: dashboardRow,
      });
      hooks.pendingClass = "pshell__brandlink"; // the logo's takes over
      commit(order);
      expect(hooks.press, order).toEqual({ href: "/dashboard", from: "/postings", by: logo });
      expect(isActive(row(render(), "/dashboard")), order).toBe(true);
    }
  });

  it("a row press taking over from the logo's moves on to that row, in either effect order", () => {
    for (const order of ["tree", "reverse"] as const) {
      applyingSetPress();
      hooks.press = null;
      hooks.refs = [];
      hooks.pathname = "/postings";
      hooks.pendingHref = "/dashboard";
      hooks.pendingClass = "pshell__brandlink";
      commit(order);
      hooks.pendingHref = "/candidates";
      hooks.pendingClass = null;
      commit(order);
      const candidates = rowReports().find((e) => e.deps![1] === "/candidates")!.deps![2];
      expect(hooks.press, order).toEqual({
        href: "/candidates",
        from: "/postings",
        by: candidates,
      });
      const html = render();
      expect(isActive(row(html, "/candidates")), order).toBe(true);
      expect(isActive(row(html, "/dashboard")), order).toBe(false);
    }
  });

  it("outside a rail's press scope, a press report draws nothing and reports nothing", () => {
    hooks.pendingHref = "/dashboard";
    hooks.effects = [];
    hooks.refAt = 0;
    const html = renderToStaticMarkup(
      <PortalLink href="/dashboard" pendingLabel="Dashboard">
        <RailPress href="/dashboard" />
      </PortalLink>,
    );
    expect(html).toBe(
      '<a href="/dashboard"><span class="nav-pending nav-pending--on" aria-hidden="true"></span></a>',
    );
    const report = pressReports()[0]!;
    expect(report.deps![3]).toBeUndefined(); // no scope to report to
    expect(() => report.run()).not.toThrow();
  });
});

/* ---- rail-marker.ts: the stand-in DOM it reads and writes ---- */

function standIn() {
  const log: string[] = [];
  const attrs = new Map<string, string>();
  const vars = new Map<string, string>();
  let transition = "";
  const marker = {
    style: {
      get transition() {
        return transition;
      },
      set transition(v: string) {
        transition = v;
        log.push(`transition=${v}`);
      },
      setProperty(k: string, v: string) {
        vars.set(k, v);
        log.push(`${k}=${v}`);
      },
      removeProperty(k: string) {
        if (k === "transition") transition = "";
        log.push(`removed ${k}`);
      },
    },
    get offsetWidth() {
      log.push("flush");
      return 0;
    },
  };
  const lists = [{ list: 1 }, { list: 2 }];
  /** Every row rowAt made, in the nav's order (made in it). */
  const rows: Array<{ name: string; inked: boolean }> = [];
  const nav = {
    active: null as unknown,
    isConnected: true,
    /** The Web Animations API, when a test gives the stand-in one. */
    getAnimations: undefined as undefined | ((options?: { subtree?: boolean }) => unknown[]),
    querySelector(sel: string) {
      if (sel === ".pnav__marker") return marker;
      if (sel === ".pnav__link--active") return this.active;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel === ".pnav__list") return lists;
      if (sel === ".pnav__link") return rows;
      if (sel === `[${ON_PLATE_ATTR}]`) return rows.filter((r) => r.inked);
      return [];
    },
    setAttribute(k: string, v: string) {
      attrs.set(k, v);
      log.push(`set ${k}`);
    },
    removeAttribute(k: string) {
      attrs.delete(k);
      log.push(`dropped ${k}`);
    },
    hasAttribute: (k: string) => attrs.has(k),
  };
  // The row's offset parent is its group (a transformed group can be one), whose is the nav. A
  // row's ink (its ON_PLATE_ATTR) is the only attribute set on it; each change is logged.
  const group = { offsetLeft: 0, offsetTop: 120, offsetParent: nav };
  function rowAt(top: number, width = 216) {
    const name = `row@${top}`;
    const ink = (on: boolean) => {
      if (on === r.inked) return;
      r.inked = on;
      log.push(`${on ? "ink" : "unink"} ${name}`);
    };
    const r = {
      name,
      offsetLeft: 12,
      offsetTop: top,
      offsetWidth: width,
      offsetHeight: 36,
      offsetParent: group,
      inked: false,
      setAttribute: (k: string) => k === ON_PLATE_ATTR && ink(true),
      removeAttribute: (k: string) => k === ON_PLATE_ATTR && ink(false),
      hasAttribute: (k: string) => k === ON_PLATE_ATTR && r.inked,
      toggleAttribute: (k: string, on: boolean) => k === ON_PLATE_ATTR && ink(on),
    };
    rows.push(r);
    return r;
  }
  const el = nav as unknown as HTMLElement;
  /** Which rows are inked right now, by name. */
  const inked = () => rows.filter((r) => r.inked).map((r) => r.name);
  return { log, attrs, vars, nav, el, lists, rowAt, inked, marker };
}

describe("placeRailMarker — the plate goes onto the active row", () => {
  it("first placement: on the row at once, its transition held for one flush — nothing slides in; the row is inked before that flush", () => {
    const s = standIn();
    s.nav.active = s.rowAt(40);
    placeRailMarker(s.el);
    expect(s.log).toEqual([
      "transition=none",
      // Inked first: in the flush, `[data-marker]` without it would read "plate on its way".
      "ink row@40",
      "--pnav-marker-x=12px",
      "--pnav-marker-y=160px",
      "--pnav-marker-w=216px",
      "--pnav-marker-h=36px",
      `set ${RAIL_MARKER_ATTR}`,
      "flush",
      "removed transition",
    ]);
  });

  it("a move to ANOTHER row (a press) glides: the stylesheet's transition is left on", () => {
    const s = standIn();
    s.nav.active = s.rowAt(40);
    placeRailMarker(s.el);
    s.log.length = 0;
    s.nav.active = s.rowAt(84);
    placeRailMarker(s.el);
    expect(s.log).toEqual([
      "--pnav-marker-x=12px",
      "--pnav-marker-y=204px",
      "--pnav-marker-w=216px",
      "--pnav-marker-h=36px",
      `set ${RAIL_MARKER_ATTR}`,
      // Not a browser (no frames to follow the plate with): the ink goes over at once.
      "unink row@40",
      "ink row@84",
    ]);
  });

  it("the same row at a new box (the rail collapsed) re-places in place; at the same box it is left alone", () => {
    const s = standIn();
    const r = s.rowAt(40);
    s.nav.active = r;
    placeRailMarker(s.el);
    s.log.length = 0;
    r.offsetWidth = 56;
    placeRailMarker(s.el);
    expect(s.log[0]).toBe("transition=none");
    expect(s.log).toContain("--pnav-marker-w=56px");
    expect(s.log.slice(-2)).toEqual(["flush", "removed transition"]);
    // A size watch that fires mid-glide (same row, same box) never touches it — so never cuts it short.
    s.log.length = 0;
    placeRailMarker(s.el);
    expect(s.log).toEqual([]);
  });

  it("no active row: the attribute goes, with every row's ink, and the static plate is all there is", () => {
    const s = standIn();
    s.nav.active = s.rowAt(40);
    placeRailMarker(s.el);
    s.nav.active = null;
    s.log.length = 0;
    placeRailMarker(s.el);
    expect(s.log).toEqual(["unink row@40", `dropped ${RAIL_MARKER_ATTR}`]);
    expect(s.attrs.has(RAIL_MARKER_ATTR)).toBe(false);
    expect(s.inked()).toEqual([]);
  });

  it("a row not laid out inside the nav is never marked — the plate stays the row's own", () => {
    const s = standIn();
    s.nav.active = {
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      offsetParent: null,
    };
    placeRailMarker(s.el);
    expect(s.log).toEqual([`dropped ${RAIL_MARKER_ATTR}`]);
  });
});

describe("boxWithin — the row's layout box inside the nav", () => {
  it("sums the offset chain up to the nav, through any offset parent between", () => {
    const s = standIn();
    expect(boxWithin(s.rowAt(40) as unknown as HTMLElement, s.el)).toEqual({
      x: 12,
      y: 160,
      w: 216,
      h: 36,
    });
    const direct = {
      offsetLeft: 8,
      offsetTop: 300,
      offsetWidth: 200,
      offsetHeight: 44,
      offsetParent: s.nav,
    };
    expect(boxWithin(direct as unknown as HTMLElement, s.el)).toEqual({
      x: 8,
      y: 300,
      w: 200,
      h: 44,
    });
  });

  it("null when the chain never reaches the nav", () => {
    const s = standIn();
    const elsewhere = {
      offsetLeft: 1,
      offsetTop: 2,
      offsetWidth: 3,
      offsetHeight: 4,
      offsetParent: { offsetLeft: 0, offsetTop: 0, offsetParent: null },
    };
    expect(boxWithin(elsewhere as unknown as HTMLElement, s.el)).toBeNull();
  });
});

/** Let every settled promise's callbacks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A stand-in ResizeObserver that records what it watches; `fire` reports a size change. */
function stubResizeObserver() {
  const watches: Array<{ observed: unknown[]; disconnected: boolean; fire: () => void }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observed: unknown[] = [];
      disconnected = false;
      fire: () => void;
      constructor(cb: () => void) {
        this.fire = cb;
        watches.push(this);
      }
      observe(target: unknown) {
        this.observed.push(target);
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  return watches;
}

const placements = (log: string[]) => log.filter((l) => l === `set ${RAIL_MARKER_ATTR}`).length;

describe("railMarkerRef — the nav's callback ref", () => {
  it("places the marker on attach and re-places it whenever the rail's layout moves; cleanup stops watching", async () => {
    const watches = stubResizeObserver();
    const s = standIn();
    const r = s.rowAt(40);
    s.nav.active = r;
    const cleanup = railMarkerRef(s.el);
    await flush(); // no entrance to wait out here (no Web Animations API)
    expect(s.attrs.has(RAIL_MARKER_ATTR)).toBe(true);
    expect(watches).toHaveLength(1);
    expect(watches[0]!.observed).toEqual([s.nav, ...s.lists]);
    r.offsetTop = 60; // a breakpoint moved the row
    watches[0]!.fire();
    expect(s.vars.get("--pnav-marker-y")).toBe("180px");
    expect(typeof cleanup).toBe("function");
    cleanup!();
    expect(watches[0]!.disconnected).toBe(true);
  });

  it("detached (null): nothing to do; no ResizeObserver: it still places", async () => {
    expect(railMarkerRef(null)).toBeUndefined();
    vi.stubGlobal("ResizeObserver", undefined);
    const s = standIn();
    s.nav.active = s.rowAt(40);
    expect(typeof railMarkerRef(s.el)).toBe("function");
    await flush();
    expect(s.attrs.has(RAIL_MARKER_ATTR)).toBe(true);
  });
});

describe("railMarkerRef — the first placement waits out the rail groups' own entrance", () => {
  // The marker sits outside the groups, and its geometry ignores their transform. If it were
  // placed while they fade and slide in (mw-nav-in, ≤320ms from first paint), the Safety Yellow
  // plate would pop in at full strength, ahead of its row and up to 6px out of line with it.
  it("not placed, by a commit or by the size watch, until mw-nav-in has played; other animations are never waited for", async () => {
    const watches = stubResizeObserver();
    const s = standIn();
    s.nav.active = s.rowAt(40);
    const entrance = deferred();
    const asked: unknown[] = [];
    s.nav.getAnimations = (options) => {
      asked.push(options);
      return [
        { animationName: "mw-nav-in", finished: entrance.promise },
        // The pending dot pulses forever on a pressed row: waiting for it would never place.
        { animationName: "nav-pending-pulse", finished: new Promise(() => undefined) },
      ];
    };
    railMarkerRef(s.el);
    expect(asked).toEqual([{ subtree: true }]); // the groups are in the nav's subtree
    await flush();
    watches[0]!.fire(); // a size watch reports once as soon as it starts
    expect(s.attrs.has(RAIL_MARKER_ATTR)).toBe(false); // the row's own plate is still the one shown
    entrance.resolve();
    await flush();
    expect(s.attrs.has(RAIL_MARKER_ATTR)).toBe(true);
    // …and it lands without a glide: it is still a first placement.
    expect(s.log[0]).toBe("transition=none");
  });

  it("a commit during the entrance hands the wait on: the superseded call never places, the next one does, once", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const s = standIn();
    s.nav.active = s.rowAt(40);
    const entrance = deferred();
    s.nav.getAnimations = () => [{ animationName: "mw-nav-in", finished: entrance.promise }];
    const first = railMarkerRef(s.el)!;
    first(); // React: the old ref's cleanup, then the new ref
    railMarkerRef(s.el);
    entrance.resolve();
    await flush();
    expect(placements(s.log)).toBe(1);
  });

  it("cleaned up before the entrance ends (the rail left): it is never placed", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const s = standIn();
    s.nav.active = s.rowAt(40);
    const entrance = deferred();
    s.nav.getAnimations = () => [{ animationName: "mw-nav-in", finished: entrance.promise }];
    railMarkerRef(s.el)!();
    entrance.resolve();
    await flush();
    expect(placements(s.log)).toBe(0);
  });

  it("once the groups have entered, every later commit places at once: a press glides without waiting", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const s = standIn();
    s.nav.active = s.rowAt(40);
    s.nav.getAnimations = () => []; // reduced motion, or a hydration after the entrance
    railMarkerRef(s.el);
    await flush();
    expect(placements(s.log)).toBe(1);
    s.log.length = 0;
    s.nav.active = s.rowAt(84); // the press moved the active row
    railMarkerRef(s.el);
    expect(s.log).toEqual([
      "--pnav-marker-x=12px",
      "--pnav-marker-y=204px",
      "--pnav-marker-w=216px",
      "--pnav-marker-h=36px",
      `set ${RAIL_MARKER_ATTR}`,
      "unink row@40",
      "ink row@84",
    ]);
  });
});

/* ---- the ink follows the plate (rail-marker.ts followPlate) ---- */

/**
 * Frames and the plate's computed transform, stood in. `frame()` runs the frame the tracker asked
 * for; `plate.y` is where the plate's transition has got to.
 */
function stubFrames(marker: object) {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  const plate = { y: 0 };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.set(next, cb);
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void queue.delete(id));
  vi.stubGlobal("getComputedStyle", (el: unknown) => ({
    transform: el === marker ? `matrix(1, 0, 0, 1, 12, ${plate.y})` : "none",
  }));
  const frame = () => {
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) cb(0);
  };
  return { plate, frame, asked: () => queue.size };
}

/** Three rows 38px apart (36px rows, 2px gaps): their boxes in the nav are at y 160, 198, 236. */
function threeRows() {
  const s = standIn();
  const f = stubFrames(s.marker);
  const rows = { a: s.rowAt(40), m: s.rowAt(78), b: s.rowAt(116) };
  s.nav.active = rows.a;
  placeRailMarker(s.el); // the plate at rest on A
  f.plate.y = 160;
  return { s, f, ...rows };
}

describe("the ink follows the plate — a label is navy exactly while the plate is under it", () => {
  // The class moves on the press, but the plate takes 320ms, landing on a long ease-out tail. A
  // label inked on the press was navy on the navy rail until the plate got there (~100–115ms on a
  // long hop); the row left behind was navy on the rail as soon as the plate slid off it.
  it("while it travels, each frame inks the rows it covers by half or more: the pressed row only once the plate is there, the row left once it has gone", () => {
    const { s, f, b } = threeRows();
    expect(s.inked()).toEqual(["row@40"]);
    s.nav.active = b; // the press
    placeRailMarker(s.el);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(true);
    // Still under A: A keeps the navy, the pressed row the rail's on-ink text.
    expect(s.inked()).toEqual(["row@40"]);
    expect(f.asked()).toBe(1);
    f.plate.y = 182.8; // A 37% covered, the row between 58%, B not at all
    f.frame();
    expect(s.inked()).toEqual(["row@78"]);
    f.plate.y = 226; // the row between 22%, B 72%
    f.frame();
    expect(s.inked()).toEqual(["row@116"]);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(true);
    f.plate.y = 235.8; // there (within half a pixel): following ends
    f.frame();
    expect(s.attrs.has(GLIDING_ATTR)).toBe(false);
    expect(s.inked()).toEqual(["row@116"]);
    expect(f.asked()).toBe(0);
  });

  it("a plate that is already there when the glide starts (reduced motion: no transition): the ink goes over at once, and no frame is asked for", () => {
    const { s, f, b } = threeRows();
    s.log.length = 0;
    f.plate.y = 236; // its computed transform is the new one already
    s.nav.active = b;
    placeRailMarker(s.el);
    expect(s.log.slice(-4)).toEqual([
      `set ${GLIDING_ATTR}`,
      `dropped ${GLIDING_ATTR}`,
      "unink row@40",
      "ink row@116",
    ]);
    expect(f.asked()).toBe(0);
  });

  it("a press that takes over mid-glide follows on from where the plate is; the old glide stops", () => {
    const { s, f, b } = threeRows();
    const c = s.rowAt(154); // y 274
    s.nav.active = c;
    placeRailMarker(s.el);
    f.plate.y = 200;
    f.frame();
    expect(s.inked()).toEqual(["row@78"]);
    s.nav.active = b; // B's press took over
    placeRailMarker(s.el);
    expect(f.asked()).toBe(1); // the old glide's frame is gone; the new glide asked for one
    expect(s.inked()).toEqual(["row@78"]);
    f.plate.y = 236;
    f.frame();
    expect(s.inked()).toEqual(["row@116"]);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(false);
  });

  it("a commit or a size notice mid-glide (same row, same box) leaves the glide and its ink alone", () => {
    const { s, f, b } = threeRows();
    s.nav.active = b;
    placeRailMarker(s.el);
    f.plate.y = 190;
    f.frame();
    expect(s.inked()).toEqual(["row@78"]);
    placeRailMarker(s.el);
    expect(f.asked()).toBe(1);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(true);
    expect(s.inked()).toEqual(["row@78"]);
  });

  it("a resize mid-glide (same row, new box) lands the plate at once, and the ink with it", () => {
    const { s, f, b } = threeRows();
    s.nav.active = b;
    placeRailMarker(s.el);
    f.plate.y = 190;
    f.frame();
    b.offsetWidth = 56; // the rail collapsed
    placeRailMarker(s.el);
    expect(f.asked()).toBe(0);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(false);
    expect(s.inked()).toEqual(["row@116"]);
  });

  it("the rail leaves the document mid-glide: following stops", () => {
    const { s, f, b } = threeRows();
    s.nav.active = b;
    placeRailMarker(s.el);
    s.nav.isConnected = false;
    f.frame();
    expect(f.asked()).toBe(0);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(false);
  });

  it("the marker dropped mid-glide (no active row): following stops and no row keeps the ink", () => {
    const { s, f, b } = threeRows();
    s.nav.active = b;
    placeRailMarker(s.el);
    f.plate.y = 190;
    f.frame();
    s.nav.active = null;
    placeRailMarker(s.el);
    expect(f.asked()).toBe(0);
    expect(s.attrs.has(GLIDING_ATTR)).toBe(false);
    expect(s.inked()).toEqual([]);
  });
});

describe("plateCover and plateTopOf — where the plate is, and how much of a row it covers", () => {
  it("plateCover is the share of the row's height under the plate", () => {
    const row = { x: 12, y: 160, w: 216, h: 36 };
    expect(plateCover(160, 36, row)).toBe(1);
    expect(plateCover(178, 36, row)).toBe(0.5);
    expect(plateCover(142, 36, row)).toBe(0.5);
    expect(plateCover(196, 36, row)).toBe(0);
    expect(plateCover(100, 36, row)).toBe(0);
    expect(plateCover(160, 36, { ...row, h: 0 })).toBe(0);
  });

  it("plateTopOf reads y off a computed 2D or 3D matrix, and nothing else", () => {
    expect(plateTopOf("matrix(1, 0, 0, 1, 12, 160)")).toBe(160);
    expect(plateTopOf("matrix(1, 0, 0, 1, 12, -3.5)")).toBe(-3.5);
    expect(plateTopOf("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 236.25, 0, 1)")).toBe(
      236.25,
    );
    for (const other of ["none", "translate(12px, 160px)", "matrix(1, 0, 0)", ""]) {
      expect(plateTopOf(other), other).toBeNull();
    }
  });
});

describe("the nav is wired to its marker — the callback ref React calls after every commit", () => {
  it("the rendered <nav>'s ref, handed the nav, places the marker and inks its row, and hands back its cleanup", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    let nav: ReactElement<{ ref?: (el: HTMLElement | null) => unknown }> | null = null;
    // SidebarNav's own render, inside the rail's scope as AppShell renders it; the element it
    // returns keeps the ref React would attach (React 19: `ref` is a prop).
    function Probe() {
      nav = SidebarNav({ sections: SECTIONS }) as ReactElement<{
        ref?: (el: HTMLElement | null) => unknown;
      }>;
      return nav;
    }
    renderToStaticMarkup(
      <RailPressScope>
        <Probe />
      </RailPressScope>,
    );
    expect(nav!.type).toBe("nav");
    const ref = nav!.props.ref;
    expect(typeof ref).toBe("function");
    const s = standIn();
    s.nav.active = s.rowAt(40);
    const cleanup = ref!(s.el);
    await flush(); // no entrance to wait out (no Web Animations API)
    expect(s.attrs.has(RAIL_MARKER_ATTR)).toBe(true);
    expect(s.inked()).toEqual(["row@40"]);
    expect(typeof cleanup).toBe("function");
    expect(ref!(null)).toBeUndefined();
  });
});
