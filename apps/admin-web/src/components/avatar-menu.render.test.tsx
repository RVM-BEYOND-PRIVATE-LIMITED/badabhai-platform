import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("closing", () => {
  /** The root `<div class="avatar-menu">`, from the function form. */
  const root = () =>
    AvatarMenu(props) as ReactElement<{
      onKeyDown: (e: unknown) => void;
      onBlur: (e: unknown) => void;
    }>;

  it("Escape closes it and hands focus back to the button", () => {
    state.open = true;
    const preventDefault = vi.fn();
    root().props.onKeyDown({ key: "Escape", preventDefault });
    expect(state.setOpen).toHaveBeenCalledWith(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(state.ref.current.focus).toHaveBeenCalledTimes(1);
  });

  it("Escape on a closed menu does nothing", () => {
    root().props.onKeyDown({ key: "Escape", preventDefault: vi.fn() });
    expect(state.setOpen).not.toHaveBeenCalled();
  });

  it("focus leaving it closes it; focus moving inside it does not", () => {
    state.open = true;
    const inside = {};
    const currentTarget = { contains: (n: unknown) => n === inside };
    root().props.onBlur({ currentTarget, relatedTarget: inside });
    expect(state.setOpen).not.toHaveBeenCalled();
    root().props.onBlur({ currentTarget, relatedTarget: null });
    expect(state.setOpen).toHaveBeenCalledWith(false);
    // Focus has already gone where Tab sent it: closing does not pull it back.
    expect(state.ref.current.focus).not.toHaveBeenCalled();
  });

  it("a navigation closes it", () => {
    state.open = true;
    renderToStaticMarkup(<AvatarMenu {...props} />);
    // The first effect is keyed on the pathname: run as a commit would.
    state.effects[0]!();
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });
});
