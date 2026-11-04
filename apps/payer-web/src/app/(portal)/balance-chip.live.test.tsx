import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * The shell's credits chip, LIVE (#2585). The layout reads the balance once and a page navigation
 * never re-renders it, so after an unlock the chip takes the balance the screen PUBLISHED — the
 * server's read-back — with no reload, and counts down to it with a one-shot tint. Figures are
 * ordered by when the SERVER read them (`asOf`), never by when the chip rendered.
 *
 * Env is node (no DOM): the chip is called as a function under a minimal hooks model — `useState`
 * keeps its cells across renders, the tooltip's ref/effect are inert, and `useSyncExternalStore`
 * does what React does: it subscribes ONCE per mount with the `subscribe` the chip hands it (the
 * real store, components/live-balance.ts) and re-renders the chip when that subscription fires.
 * After a publish no test re-renders the chip by hand — only the store's notification can.
 */
let cells: unknown[] = [];
let cursor = 0;
const useState = (init: unknown): [unknown, (v: unknown) => void] => {
  const i = cursor++;
  if (i >= cells.length) cells[i] = typeof init === "function" ? (init as () => unknown)() : init;
  const set = (v: unknown) => {
    cells[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(cells[i]) : v;
  };
  return [cells[i], set];
};
/** The `subscribe` the chip handed `useSyncExternalStore`, and the live subscription (per mount). */
let handedSubscribe: unknown = null;
let unsubscribe: (() => void) | null = null;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => useState(init),
    useSyncExternalStore: (
      subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      if (unsubscribe === null) {
        handedSubscribe = subscribe;
        unsubscribe = subscribe(() => render());
      }
      return getSnapshot();
    },
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
  };
});
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/nav-pending", () => ({ NavPendingCue: () => null }));

const { BalanceChip } = await import("./balance-chip");
const { CountUp } = await import("../../components/ds/count-up");
const { publishBalance, publishedBalance, resetPublishedBalanceForTests, subscribeBalance } =
  await import("../../components/live-balance");

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
interface ChipProps {
  balance: number;
  balanceAsOf: number;
  linkToCredits: boolean;
}

let props: ChipProps = { balance: 0, balanceAsOf: 0, linkToCredits: true };
let tree: El | null = null;
/**
 * One render of the chip — with new props when the LAYOUT re-rendered (fresh reads), with the
 * current ones when the store's subscription fired. A setState during it re-runs it, as React does.
 */
function render(next: Partial<ChipProps> = {}): void {
  props = { ...props, ...next };
  for (let pass = 0; pass < 5; pass++) {
    const before = JSON.stringify(cells);
    cursor = 0;
    tree = BalanceChip(props) as El;
    if (JSON.stringify(cells) === before) return;
  }
}
/** The layout's first render: `balance` read at `balanceAsOf`. */
function mount(balance: number, balanceAsOf: number, linkToCredits = true): void {
  unsubscribe?.();
  unsubscribe = null;
  cells = [];
  render({ balance, balanceAsOf, linkToCredits });
}

function elements(node: ReactNode = tree, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  const el = node as El;
  out.push(el);
  if (el.props && "children" in el.props) elements(el.props.children, out);
  return out;
}
const counts = () => elements().filter((el) => el.type === CountUp);
const tints = () => elements().filter((el) => el.props?.className === "pshell__balancetint");
/** The printed figure when the chip is not counting. */
const printed = () => {
  const num = elements().find((el) => el.props?.className === "ui-num pshell__balancenum")!;
  return num.props.children;
};
const name = () => (tree!.props as { "aria-label"?: string })["aria-label"];

beforeEach(() => {
  resetPublishedBalanceForTests();
  unsubscribe = null;
  handedSubscribe = null;
});

describe("BalanceChip — the balance after an unlock, with NO reload (#2585)", () => {
  it("an unchanged chip prints its figure as before: no count, no tint", () => {
    mount(5, 100);
    render();
    expect(printed()).toBe(5);
    expect(counts()).toEqual([]);
    expect(tints()).toEqual([]);
    expect(name()).toBe("5 credits — open Credits");
  });

  it("subscribes to the live-balance store itself", () => {
    mount(5, 100);
    expect(handedSubscribe).toBe(subscribeBalance);
  });

  it("an unlock's read-back reaches the chip through the store alone — the layout never re-renders — and it counts down", () => {
    mount(5, 100);
    publishBalance({ balance: 4, asOf: 200 }); // the unlock screen published the server's figure
    // No render() here: the store's notification re-rendered the chip; its prop is still 5.
    expect(name()).toBe("4 credits — open Credits");
    expect(counts()).toHaveLength(1);
    expect(counts()[0]!.props).toMatchObject({ from: 5, to: 4 });
    expect(tints()).toHaveLength(1);
    expect(tints()[0]!.props["aria-hidden"]).toBe("true");
  });

  it("each change re-keys the count and the tint, so each plays once; the next starts where the last ended", () => {
    mount(5, 100);
    publishBalance({ balance: 4, asOf: 200 });
    const first = { count: counts()[0]!.key, tint: tints()[0]!.key };
    publishBalance({ balance: 3, asOf: 300 });
    expect(counts()[0]!.props).toMatchObject({ from: 4, to: 3 });
    expect(counts()[0]!.key).not.toBe(first.count);
    expect(tints()[0]!.key).not.toBe(first.tint);
    // Re-rendering with nothing new keeps the same run (no replay).
    const key = counts()[0]!.key;
    render();
    expect(counts()[0]!.key).toBe(key);
  });

  it("a figure the layout re-reads LATER outranks an older publish — even the SAME number; a publish read after it wins again", () => {
    mount(5, 100);
    publishBalance({ balance: 4, asOf: 200 });
    expect(name()).toBe("4 credits — open Credits");
    // A purchase refreshed the layout: re-read at 300, and the figure is the one it first read.
    render({ balance: 5, balanceAsOf: 300 });
    expect(name()).toBe("5 credits — open Credits");
    publishBalance({ balance: 3, asOf: 400 });
    expect(name()).toBe("3 credits — open Credits");
  });

  it("a publish the server read BEFORE the chip's figure is older than it — at mount and after", () => {
    publishBalance({ balance: 2, asOf: 50 });
    mount(5, 100);
    expect(name()).toBe("5 credits — open Credits");
    expect(counts()).toEqual([]);
    // A late answer to an older read lands after a newer figure: it is not news.
    publishBalance({ balance: 1, asOf: 70 });
    expect(name()).toBe("5 credits — open Credits");
  });

  it("the static chip follows too (its text is the new figure)", () => {
    mount(5, 100, false);
    publishBalance({ balance: 1, asOf: 200 });
    expect(counts()[0]!.props).toMatchObject({ from: 5, to: 1 });
    expect(
      elements().some(
        (el) => el.props?.className === "pshell__balancelabel" && el.props.children === "credit",
      ),
    ).toBe(true);
  });
});

describe("live-balance — the store the chip and the unlock lists read", () => {
  it("a publish notifies each subscriber once; an unsubscribed one hears nothing more", () => {
    const listener = vi.fn();
    const off = subscribeBalance(listener);
    publishBalance({ balance: 4, asOf: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    publishBalance({ balance: 3, asOf: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(publishedBalance()).toEqual({ balance: 3, asOf: 2 });
  });

  it("keeps the reading the server made LAST: an older one landing late is dropped, unannounced", () => {
    const listener = vi.fn();
    subscribeBalance(listener);
    publishBalance({ balance: 0, asOf: 20 });
    publishBalance({ balance: 1, asOf: 10 });
    expect(publishedBalance()).toEqual({ balance: 0, asOf: 20 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops anything that is not a whole number ≥ 0 read at a real time", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      publishBalance({ balance: bad, asOf: 1 });
    }
    publishBalance({ balance: 3, asOf: Number.NaN });
    expect(publishedBalance()).toBeNull();
    publishBalance({ balance: 0, asOf: 1 });
    expect(publishedBalance()).toEqual({ balance: 0, asOf: 1 });
  });
});
