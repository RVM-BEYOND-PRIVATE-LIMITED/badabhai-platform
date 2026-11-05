import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE AVATAR MENU (A6, #2576): Account (ADR-0060 A5) and Sign out, in the topbar's top-right
 * corner, for every role, whatever the filtered nav holds. They were in the sidebar's foot, which
 * 19 nav items pushed below the fold on a 1080p screen; the topbar is always on screen.
 *
 * A disclosure: the button says whether it is open and which panel it controls; the panel stays
 * mounted and is `hidden` while closed (Account's pending cue must outlive the click that closes
 * the menu). The node env cannot click, so `useState` is a recorder here: a test chooses the open
 * state, and reads what the handlers set.
 */
const state = vi.hoisted(() => ({
  pathname: "/jobs",
  open: false,
  setOpen: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  /** Every ref the menu takes — the trigger's included, which focus returns to. */
  ref: { current: { focus: (() => {}) as () => void } },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: () => [state.open, state.setOpen],
    useId: () => ":r0:",
    useRef: () => state.ref,
    useEffect: (run: () => void | (() => void)) => {
      state.effects.push(run);
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));

const { AvatarMenu, ACCOUNT_HREF } = await import("./avatar-menu");
const { ACCOUNT_HREF: SHELL_ACCOUNT_HREF } = await import("./shell");

const ADMIN = "a1b2c3d4-0000-4000-8000-000000000001";
const props = {
  roleLabel: "Analyst",
  adminId: ADMIN,
  signOut: <button type="button">Sign out</button>,
};
const render = () => renderToStaticMarkup(<AvatarMenu {...props} />);
/** The trigger's opening tag. */
const trigger = (out: string) =>
  /<button[^>]*class="avatar-menu__trigger"[^>]*>/.exec(out)?.[0] ?? "";
/** The panel, its opening tag to the end. */
const panel = (out: string) => out.slice(out.indexOf('class="avatar-menu__panel"') - 5);

beforeEach(() => {
  state.pathname = "/jobs";
  state.open = false;
  state.setOpen.mockReset();
  state.effects = [];
  state.ref.current = { focus: vi.fn() };
});

describe("the trigger", () => {
  it("is a disclosure button naming the menu and who is signed in", () => {
    const tag = trigger(render());
    expect(tag).toContain('type="button"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toMatch(/aria-controls="[^"]+-account"/);
    expect(tag).toContain('aria-label="Account menu, signed in as Analyst"');
    expect(tag).not.toContain("aria-haspopup");
  });

  it("draws the avatar and the role, both hidden from assistive tech (the label says them)", () => {
    const out = render();
    expect(out).toContain(
      '<span class="avatar-menu__avatar" aria-hidden="true"><i class="ph-fill ph-user" aria-hidden="true"></i></span>',
    );
    expect(out).toContain('<span class="avatar-menu__role" aria-hidden="true">Analyst</span>');
  });

  it("controls the panel it names", () => {
    const out = render();
    const controls = /aria-controls="([^"]+)"/.exec(trigger(out))![1];
    expect(out).toContain(`id="${controls}"`);
  });

  it("says when it is open", () => {
    state.open = true;
    expect(trigger(render())).toContain('aria-expanded="true"');
  });
});

describe("the panel", () => {
  it("stays mounted while closed — hidden, so Account's pending cue outlives the click", () => {
    expect(panel(render())).toMatch(/^<div class="avatar-menu__panel" id="[^"]+" hidden="">/);
    state.open = true;
    expect(panel(render())).not.toMatch(/^<div[^>]* hidden/);
  });

  it("says who is signed in: the role and the opaque admin id — never a name or email", () => {
    const out = panel(render());
    expect(out).toContain('<span class="avatar-menu__eyebrow">Signed in as</span>');
    expect(out).toContain('<span class="avatar-menu__role-name">Analyst</span>');
    expect(out).toContain(`<span class="avatar-menu__id mono" title="${ADMIN}">a1b2c3d4…</span>`);
  });

  it("holds Account, then Sign out", () => {
    const out = panel(render());
    expect(ACCOUNT_HREF).toBe("/account");
    expect(SHELL_ACCOUNT_HREF).toBe(ACCOUNT_HREF);
    const account = out.indexOf('href="/account"');
    const signOut = out.indexOf(">Sign out</button>");
    expect(account).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(account);
    expect(out).toContain('<i class="ph-fill ph-gear" aria-hidden="true"></i><span>Account</span>');
  });

  it("marks Account as the current page on /account, and only there", () => {
    expect(panel(render())).not.toContain('aria-current="page"');
    state.pathname = "/account";
    const link = /<a[^>]*href="\/account"[^>]*>/.exec(panel(render()))?.[0] ?? "";
    expect(link).toContain('aria-current="page"');
  });
});

/**
 * Closing is heard on the DOCUMENT while the menu is open (Safari and Firefox on macOS leave a
 * mouse-opened menu holding no focus), so `document` is a recorder of the listeners the open
 * menu's effect adds. Both refs are the one stand-in: the trigger focus returns to, and the root
 * whose `contains` says what is inside the menu.
 */
describe("closing", () => {
  const INSIDE = { node: "the admin id's text, inside the panel" };
  const OUTSIDE = { node: "the page" };
  /** The root `<div class="avatar-menu">`, from the function form. */
  const root = () => AvatarMenu(props) as ReactElement<{ onBlur?: (e: unknown) => void }>;

  /** Open the menu and run its listening effect; what it added, by event type. */
  function listen() {
    const added = new Map<string, (e: unknown) => void>();
    const removed: string[] = [];
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: (e: unknown) => void) => added.set(type, fn),
      removeEventListener: (type: string) => removed.push(type),
    });
    state.open = true;
    state.effects = [];
    AvatarMenu(props);
    // The second effect, after the pathname one.
    const stop = state.effects[1]!() as () => void;
    return { on: (type: string) => added.get(type)!, stop, removed, added };
  }
  const escape = (over: Record<string, unknown> = {}) => ({
    key: "Escape",
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...over,
  });

  beforeEach(() => {
    state.ref.current = {
      focus: vi.fn(),
      contains: (n: unknown) => n === INSIDE || n === state.ref.current,
    } as typeof state.ref.current;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Escape closes it and hands focus back to the button — wherever focus was", () => {
    // Heard on the document: after a mouse opens it in Safari, focus is on the page, not in it.
    const e = escape();
    listen().on("keydown")(e);
    expect(state.setOpen).toHaveBeenCalledWith(false);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(state.ref.current.focus).toHaveBeenCalledTimes(1);
  });

  it("an Escape something else already answered is left to it; another key does nothing", () => {
    const { on } = listen();
    on("keydown")(escape({ defaultPrevented: true }));
    on("keydown")(escape({ key: "Enter" }));
    expect(state.setOpen).not.toHaveBeenCalled();
    expect(state.ref.current.focus).not.toHaveBeenCalled();
  });

  it("a click outside closes it; a click inside does not", () => {
    const { on } = listen();
    on("pointerdown")({ target: INSIDE });
    expect(state.setOpen).not.toHaveBeenCalled();
    on("pointerdown")({ target: OUTSIDE });
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });

  it("focus landing outside closes it (Tab past either end); focus moving inside does not", () => {
    const { on } = listen();
    on("focusin")({ target: INSIDE });
    expect(state.setOpen).not.toHaveBeenCalled();
    on("focusin")({ target: OUTSIDE });
    expect(state.setOpen).toHaveBeenCalledWith(false);
    // Focus has already gone where Tab sent it: closing does not pull it back.
    expect(state.ref.current.focus).not.toHaveBeenCalled();
  });

  it("a click on the panel's own text leaves it open — focus dropped to nowhere is not leaving", () => {
    // The A6 review's repro: the press lands inside, then focus leaves the trigger for <body>
    // (a focusout with no relatedTarget), and no focusin follows. A blur on the menu closed it.
    const { on } = listen();
    on("pointerdown")({ target: INSIDE });
    root().props.onBlur?.({ currentTarget: state.ref.current, relatedTarget: null });
    expect(state.setOpen).not.toHaveBeenCalled();
  });

  it("listens only while open, and lets go of all of it when it closes", () => {
    const closed = new Map<string, unknown>();
    vi.stubGlobal("document", { addEventListener: (t: string, f: unknown) => closed.set(t, f) });
    AvatarMenu(props);
    expect(state.effects[1]!()).toBeUndefined();
    expect(closed.size).toBe(0);

    const { stop, removed, added } = listen();
    expect([...added.keys()].sort()).toEqual(["focusin", "keydown", "pointerdown"]);
    stop();
    expect(removed.sort()).toEqual(["focusin", "keydown", "pointerdown"]);
  });

  it("a navigation closes it", () => {
    state.open = true;
    renderToStaticMarkup(<AvatarMenu {...props} />);
    // The first effect is keyed on the pathname: run as a commit would.
    state.effects[0]!();
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });
});
