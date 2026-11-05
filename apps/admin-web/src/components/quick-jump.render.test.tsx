import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement, ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";

/**
 * THE QUICK JUMP (Ctrl/⌘K, A6 #2576), rendered and wired. The node env has no DOM and cannot
 * mount React, so the palette runs through the one-instance hook harness (its reducer state kept
 * across re-renders), its refs are kept per call position, its effects are collected and run by
 * hand, and the `<dialog>` is a stand-in with `showModal` / `close`. What it renders is read off
 * the element tree; the server markup is checked with the real renderer at the end.
 */
type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };

const h = vi.hoisted(() => ({
  harness: null as HookHarness | null,
  effects: [] as Effect[],
  refs: [] as { current: unknown }[],
  refAt: 0,
  push: (() => {}) as (href: string) => void,
  /** Function form (true): the recorders below. Rendering for real (false): React's own hooks. */
  recorders: true,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  // The recorders in function form; React's own hooks while React renders (the markup test).
  const pick = <T,>(real: T, recorder: T): T => (h.recorders ? recorder : real);
  return {
    ...actual,
    useReducer: (...args: Parameters<typeof actual.useReducer>) =>
      pick(actual.useReducer, ((reducer: (s: unknown, a: unknown) => unknown, init: unknown) => {
        const [state, set] = h.harness!.useState(init);
        return [state, (action: unknown) => set((current: unknown) => reducer(current, action))];
      }) as unknown as typeof actual.useReducer)(...args),
    useId: (...args: []) => pick(actual.useId, () => ":r1:")(...args),
    useRef: (initial: unknown) =>
      pick(actual.useRef, ((init: unknown) => {
        const at = h.refAt++;
        h.refs[at] ??= { current: init };
        return h.refs[at];
      }) as typeof actual.useRef)(initial),
    useCallback: (fn: unknown, deps: unknown) =>
      pick(actual.useCallback, ((f: unknown) => f) as typeof actual.useCallback)(
        fn as () => void,
        deps as [],
      ),
    useEffect: (run: Effect["run"], deps?: readonly unknown[]) =>
      pick(actual.useEffect, ((r: Effect["run"], d?: readonly unknown[]) => {
        h.effects.push({ run: r, deps: d });
      }) as typeof actual.useEffect)(run, deps as []),
    useSyncExternalStore: <T,>(sub: () => () => void, client: () => T, server?: () => T) =>
      pick(actual.useSyncExternalStore, ((_s: unknown, _c: unknown, srv: () => T) =>
        srv()) as typeof actual.useSyncExternalStore)(sub, client, server),
    useTransition: () =>
      pick(actual.useTransition, (() => [
        false,
        (fn: () => void) => fn(),
      ]) as unknown as typeof actual.useTransition)(),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => h.push(href) }),
}));

const { QuickJump, isJumpShortcut } = await import("./quick-jump");

const ID = "5eeded00-0001-4a00-8000-000000000001";
const KINDS = ["candidate", "company", "posting"] as const;

type Props = { className?: string; children?: ReactNode; [key: string]: unknown };
function walk(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n as ReactNode, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<Props>;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}
const find = (tree: ReactElement<Props>, test: (el: ReactElement<Props>) => boolean) =>
  walk(tree).filter(test);

/** The dialog stand-in: `showModal` / `close` flip `open`; `close` fires the dialog's onClose. */
function standInDialog() {
  return {
    open: false,
    showModal: vi.fn(function (this: { open: boolean }) {
      this.open = true;
    }),
    close: vi.fn(function (this: { open: boolean }) {
      this.open = false;
      onClose?.();
    }),
  };
}
let onClose: (() => void) | undefined;
let dialog: ReturnType<typeof standInDialog>;
let trigger: { closest: (s: string) => unknown };
let pushed: string[];

/** Render (re-render) the one palette; refs keep their positions, effects are collected afresh. */
function render(): ReactElement<Props> {
  h.effects = [];
  h.refAt = 0;
  const tree = h.harness!.render(() => QuickJump({ kinds: KINDS })) as ReactElement<Props>;
  // Refs, in hook order: the dialog, the trigger, where focus returns to, the record opening.
  h.refs[0]!.current = dialog;
  h.refs[1]!.current = trigger;
  const el = find(tree, (e) => e.props.className === "jump")[0]!;
  onClose = el.props.onClose as () => void;
  return tree;
}
const input = (tree: ReactElement<Props>) => find(tree, (e) => e.props.role === "combobox")[0]!;
const options = (tree: ReactElement<Props>) => find(tree, (e) => e.props.role === "option");
const triggerButton = (tree: ReactElement<Props>) =>
  find(tree, (e) => (e.props.className ?? "").includes("topbar__jump"))[0]!;
const type = (text: string) =>
  (input(render()).props.onChange as (e: unknown) => void)({ target: { value: text } });
const key = (k: string) => {
  const preventDefault = vi.fn();
  (input(render()).props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault });
  return preventDefault;
};

beforeEach(() => {
  h.recorders = true;
  h.harness = createHookHarness();
  h.refs = [];
  pushed = [];
  h.push = (href) => pushed.push(href);
  dialog = standInDialog();
  trigger = { closest: () => null };
  vi.stubGlobal("document", { activeElement: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shortcut", () => {
  const ev = (over: Partial<Parameters<typeof isJumpShortcut>[0]>) => ({
    key: "k",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("is Ctrl+K or ⌘K, in either case", () => {
    expect(isJumpShortcut(ev({ ctrlKey: true }))).toBe(true);
    expect(isJumpShortcut(ev({ metaKey: true }))).toBe(true);
    expect(isJumpShortcut(ev({ ctrlKey: true, key: "K" }))).toBe(true);
  });

  it("is nothing else: a bare K, a chord with Alt or Shift, another key, an IME in progress", () => {
    expect(isJumpShortcut(ev({}))).toBe(false);
    expect(isJumpShortcut(ev({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isJumpShortcut(ev({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isJumpShortcut(ev({ ctrlKey: true, key: "j" }))).toBe(false);
    expect(isJumpShortcut(ev({ ctrlKey: true, isComposing: true }))).toBe(false);
  });

  it("opens the palette from anywhere, and closes it again", () => {
    const keys = new EventTarget();
    vi.stubGlobal("window", keys);
    render();
    const listen = h.effects.find((e) => e.deps?.length === 2)!;
    const stop = listen.run() as () => void;
    const press = () => {
      const e = Object.assign(new Event("keydown", { cancelable: true }), {
        key: "k",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      });
      keys.dispatchEvent(e);
      return e;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    press();
    expect(dialog.close).toHaveBeenCalledTimes(1);
    stop();
    press();
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
  });

  it("does nothing behind the open drawer, where the topbar is inert", () => {
    trigger = { closest: (s: string) => (s === "[inert]" ? {} : null) };
    (triggerButton(render()).props.onClick as () => void)();
    expect(dialog.showModal).not.toHaveBeenCalled();
  });
});

describe("the palette", () => {
  it("the button opens it as a modal dialog, empty", () => {
    type("leftover");
    (triggerButton(render()).props.onClick as () => void)();
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(input(render()).props.value).toBe("");
  });

  it("an empty field lists nothing and says what to paste", () => {
    const tree = render();
    expect(options(tree)).toEqual([]);
    expect(input(tree).props["aria-expanded"]).toBe(false);
    expect(input(tree).props["aria-activedescendant"]).toBeUndefined();
  });

  it("a pasted id lists the records it can be, the first highlighted", () => {
    type(ID);
    const tree = render();
    const opts = options(tree);
    expect(opts.map((o) => o.props["aria-selected"])).toEqual([true, false, false]);
    expect(input(tree).props["aria-expanded"]).toBe(true);
    expect(input(tree).props["aria-activedescendant"]).toBe(opts[0]!.props.id);
    expect(input(tree).props["aria-controls"]).toBe(
      find(tree, (e) => e.props.role === "listbox")[0]!.props.id,
    );
  });

  it("the arrow keys move the highlight at once — wrapping, Home and End included", () => {
    type(ID);
    expect(key("ArrowDown")).toHaveBeenCalled();
    expect(options(render()).map((o) => o.props["aria-selected"])).toEqual([false, true, false]);
    key("ArrowUp");
    key("ArrowUp");
    expect(options(render()).map((o) => o.props["aria-selected"])).toEqual([false, false, true]);
    key("Home");
    expect(options(render())[0]!.props["aria-selected"]).toBe(true);
  });

  it("Enter opens the highlighted record's page and closes the palette", () => {
    type(ID);
    key("ArrowDown");
    expect(key("Enter")).toHaveBeenCalled();
    expect(dialog.close).toHaveBeenCalled();
    expect(pushed).toEqual([`/companies/${ID}`]);
  });

  it("a click opens that record; pointing at one highlights it", () => {
    type(ID);
    (options(render())[2]!.props.onMouseMove as () => void)();
    expect(options(render())[2]!.props["aria-selected"]).toBe(true);
    (options(render())[0]!.props.onClick as () => void)();
    expect(pushed).toEqual([`/candidates/${ID}`]);
  });

  it("Enter with nothing to open does nothing — a phone number is explained, not searched", () => {
    type("+91 98765 43210");
    key("Enter");
    expect(pushed).toEqual([]);
    expect(dialog.close).not.toHaveBeenCalled();
    const hint = find(render(), (e) => e.props.className === "jump__hint")[0]!;
    expect(hint.props.children).toMatch(/by phone is not available yet/);
  });

  it("closing it clears the field and puts focus back where it was", () => {
    const back = { isConnected: true, focus: vi.fn() };
    vi.stubGlobal("document", { activeElement: back });
    (triggerButton(render()).props.onClick as () => void)();
    type(ID);
    render();
    dialog.close();
    expect(back.focus).toHaveBeenCalledTimes(1);
    expect(input(render()).props.value).toBe("");
  });

  it("opening a record does not pull focus back over the page it opens", () => {
    const back = { isConnected: true, focus: vi.fn() };
    vi.stubGlobal("document", { activeElement: back });
    (triggerButton(render()).props.onClick as () => void)();
    type(ID);
    key("Enter");
    expect(back.focus).not.toHaveBeenCalled();
  });

  /** A press on `pressed`, then the click the browser sends to `clicked`, on the dialog. */
  const pressThenClick = (pressed: string, clicked: string) => {
    const el = find(render(), (e) => e.props.className === "jump")[0]!;
    (el.props.onPointerDown as ((e: unknown) => void) | undefined)?.({ target: pressed });
    (el.props.onClick as (e: unknown) => void)({ target: clicked, currentTarget: "dialog" });
  };

  it("a click on the backdrop (the dialog itself) closes it; one inside does not", () => {
    pressThenClick("panel", "panel");
    expect(dialog.close).not.toHaveBeenCalled();
    pressThenClick("dialog", "dialog");
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });

  it("a drag that began in the field and was let go on the backdrop keeps it open, id and all", () => {
    // Selecting the pasted id to fix a character, the mouse ending below the panel: the click goes
    // to what the press (the field) and the release (the backdrop) share — the dialog itself,
    // which read alone looks just like a backdrop click.
    type(ID);
    pressThenClick("input", "dialog");
    expect(dialog.close).not.toHaveBeenCalled();
    expect(input(render()).props.value).toBe(ID);
    // The press is spent on its click: a later backdrop click still needs a press of its own.
    pressThenClick("dialog", "dialog");
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });
});

describe("the server markup", () => {
  it("a named button with its shortcut, and a closed, labelled dialog with a combobox", async () => {
    h.recorders = false;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const out = renderToStaticMarkup(<QuickJump kinds={KINDS} />);
    expect(out).toMatch(
      /<button type="button" class="btn btn--ghost topbar__jump" aria-label="Jump to a record" aria-haspopup="dialog" aria-keyshortcuts="Control\+K Meta\+K">/,
    );
    expect(out).toContain('<kbd class="topbar__kbd" aria-hidden="true">Ctrl K</kbd>');
    expect(out).toMatch(/<dialog class="jump" aria-labelledby="([^"]+)">/);
    expect(out).not.toMatch(/<dialog[^>]* open/);
    const labelledBy = /<dialog class="jump" aria-labelledby="([^"]+)">/.exec(out)![1];
    expect(out).toContain(`<h2 class="sr-only" id="${labelledBy}">Jump to a record</h2>`);
    expect(out).toContain('role="combobox"');
    expect(out).toContain('role="listbox"');
    expect(out).toContain('aria-live="polite"');
    // One polite region per screen is the shell's job; this one is the palette's own hint.
    expect(out).not.toContain('role="status"');
  });
});
