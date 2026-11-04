import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement } from "react";
import type { OverlayProps } from "./overlay";

/**
 * A7 (#2577) — where focus goes when an overlay closes. `holdFocus` asks `returnFocus` at release
 * (overlay-focus.test.ts); this pins the Overlay's half: the hold is handed the trigger captured
 * at open AND a resolver that asks the LATEST `returnFocus` the overlay was rendered with — a
 * drawer moved down a list names the row it is on now — while a new closure on every render never
 * re-runs the hold (that would re-capture the trigger and refocus the first control). And Dialog,
 * Drawer and ConfirmDialog each hand the prop down to it.
 *
 * The node env has no reconciler: the Overlay is called as a function, `useEffect` is recorded and
 * committed the way React does (re-run only when a dep changes), and `holdFocus` is a stand-in
 * that records what it was given.
 */
type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const h = vi.hoisted(() => ({
  effects: [] as Effect[],
  committed: [] as { deps?: readonly unknown[]; cleanup?: void | (() => void) }[],
  refs: [] as { current: unknown }[],
  refCalls: 0,
  holds: [] as { returnTo?: unknown; returnFocus?: () => unknown }[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
    useId: () => ":r0:",
    useTransition: () => [false, (fn: () => void) => fn()],
    useRef: (initial: unknown) => {
      const at = h.refCalls++;
      h.refs[at] ??= { current: initial };
      return h.refs[at]!;
    },
    useEffect: (run: Effect["run"], deps?: readonly unknown[]) => {
      h.effects.push({ run, deps });
    },
  };
});
vi.mock("./presence", () => ({ usePresence: (open: boolean) => (open ? "open" : "closed") }));
vi.mock("./overlay-focus", () => ({
  holdFocus: (args: { returnTo?: unknown; returnFocus?: () => unknown }) => {
    h.holds.push(args);
    return () => {};
  },
}));

const { Overlay } = await import("./overlay");
const { Dialog, OverlayFrame } = await import("./dialog");
const { Drawer } = await import("./drawer");
const { ConfirmDialog } = await import("./confirm-dialog");

class FakeElement {
  constructor(readonly name: string) {}
}
const trigger = new FakeElement("the row that opened it");
const panel = { focus: () => {} };

beforeEach(() => {
  h.effects = [];
  h.committed = [];
  h.refs = [];
  h.holds = [];
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", { activeElement: trigger, body: {} });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

/** Render the Overlay, point its panel ref at the stand-in, commit the effects whose deps changed. */
function draw(props: Partial<OverlayProps>) {
  h.refCalls = 0;
  h.effects = [];
  Overlay({
    kind: "drawer",
    open: true,
    onClose: () => {},
    labelledBy: "t",
    children: null,
    ...props,
  });
  h.refs[0]!.current = panel; // the panel ref — the Overlay's first
  h.effects.forEach((effect, i) => {
    const prev = h.committed[i];
    const changed =
      !prev ||
      effect.deps === undefined ||
      prev.deps === undefined ||
      effect.deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (!changed) return;
    if (typeof prev?.cleanup === "function") prev.cleanup();
    h.committed[i] = { deps: effect.deps, cleanup: effect.run() };
  });
}

describe("Overlay — where focus goes when it closes", () => {
  it("the hold gets the trigger it opened from, and a resolver that asks the LATEST returnFocus", () => {
    const first = new FakeElement("row 3");
    const later = new FakeElement("row 13");
    draw({ returnFocus: () => first as unknown as HTMLElement });
    expect(h.holds).toHaveLength(1);
    expect(h.holds[0]!.returnTo).toBe(trigger);
    expect(h.holds[0]!.returnFocus!()).toBe(first);
    // ↓ ten times: the drawer re-renders, naming another row. The hold is NOT re-run…
    draw({ returnFocus: () => later as unknown as HTMLElement });
    expect(h.holds).toHaveLength(1);
    // …and asked at release, it names the row the drawer is on now.
    expect(h.holds[0]!.returnFocus!()).toBe(later);
  });

  it("with no returnFocus the resolver names nothing — the trigger keeps it", () => {
    draw({});
    expect(h.holds[0]!.returnFocus!()).toBeNull();
    expect(h.holds[0]!.returnTo).toBe(trigger);
  });

  it("a closed overlay holds nothing", () => {
    draw({ open: false, returnFocus: () => null });
    expect(h.holds).toEqual([]);
  });
});

describe("returnFocus reaches the Overlay from every overlay built on it", () => {
  const resolve = () => null;
  type El = ReactElement<{ returnFocus?: unknown; kind?: string }>;

  it("Drawer → OverlayFrame → Overlay", () => {
    const frame = Drawer({
      open: true,
      onClose: () => {},
      title: "T",
      returnFocus: resolve,
      children: null,
    }) as El;
    expect(frame.type).toBe(OverlayFrame);
    expect(frame.props.returnFocus).toBe(resolve);
    const overlay = OverlayFrame({ ...(frame.props as Parameters<typeof OverlayFrame>[0]) }) as El;
    expect(overlay.type).toBe(Overlay);
    expect(overlay.props.returnFocus).toBe(resolve);
  });

  it("Dialog → OverlayFrame", () => {
    const frame = Dialog({
      open: true,
      onClose: () => {},
      title: "T",
      returnFocus: resolve,
      children: null,
    }) as El;
    expect(frame.props.kind).toBe("dialog");
    expect(frame.props.returnFocus).toBe(resolve);
  });

  it("ConfirmDialog → Dialog — the phone reveal's confirm hands focus to the revealed phone", () => {
    const dialog = ConfirmDialog({
      open: true,
      onClose: () => {},
      title: "Reveal this worker's phone",
      changes: [],
      confirmLabel: "Reveal phone",
      tier: "consequential",
      onConfirm: async () => ({ ok: true, changed: true, message: "" }),
      returnFocus: resolve,
    }) as El;
    expect(dialog.type).toBe(Dialog);
    expect(dialog.props.returnFocus).toBe(resolve);
  });
});
