import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { createHookHarness, type HookHarness } from "../../../../test/hook-harness";
import { candidateRecord, RECORD_WORKER_ID } from "../../../../test/candidate-record";
import type { CandidateRecordResult } from "../../../lib/candidate-detail";
import { DRAWER_ENTRY_KEY } from "../../../components/drawer";
import type * as DrawerModel from "./candidate-drawer-model";

/**
 * A7 (#2577) — the candidate drawer, render by render: ↑/↓ move it through the current page by
 * REWRITING the history entry (never a new one, never the router), a move waits the settle window
 * before it reads, a read the drawer moved past is aborted and ignored, a reopen and a Retry read
 * again, and Close pops the entry the row pushed.
 *
 * The node env has no reconciler: the drawer is called as a function on the hook harness (state
 * kept across renders), `useEffect` is recorded with its deps and committed the way React does
 * (re-run when a dep changes, the previous cleanup first), and the window, the history and the
 * record read are stand-ins.
 */
type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const h = vi.hoisted(() => ({
  harness: null as unknown,
  effects: [] as Effect[],
  refs: [] as { current: unknown }[],
  refCalls: 0,
  committed: [] as { deps?: readonly unknown[]; cleanup?: void | (() => void) }[],
  search: "",
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => ":r0:",
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/candidates",
  useSearchParams: () => new URLSearchParams(h.search),
}));

const read = vi.hoisted(() => ({
  calls: [] as { id: string; signal: AbortSignal; resolve: (r: CandidateRecordResult) => void }[],
}));
vi.mock("./candidate-drawer-model", async (importOriginal) => ({
  ...(await importOriginal<typeof DrawerModel>()),
  fetchCandidateRecord: (id: string, signal: AbortSignal) =>
    new Promise<CandidateRecordResult>((resolve, reject) => {
      read.calls.push({ id, signal, resolve });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
}));

const { CandidateDrawer } = await import("./candidate-drawer");
const { RECORD_SETTLE_MS } = await import("./candidate-drawer-model");

const W1 = "a1a1a1a1-0000-4000-8000-000000000001";
const W2 = RECORD_WORKER_ID;
const W3 = "c3c3c3c3-0000-4000-8000-000000000003";
const ROWS = [
  { id: W1, title: "Sunita Devi" },
  { id: W2, title: "Ramesh Kumar" },
  { id: W3, title: "Candidate c3c3…0003" },
];

// ---- the browser, stood in ---------------------------------------------------------------

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(readonly tagName = "BUTTON") {
    super();
  }
}
let listeners: ((e: unknown) => void)[] = [];
let historyCalls: [string, unknown, unknown][] = [];
const history = {
  state: { [DRAWER_ENTRY_KEY]: "c" } as unknown,
  pushState: (data: unknown, _u: string, url?: string | null) => {
    historyCalls.push(["push", data, url]);
    history.state = data;
  },
  replaceState: (data: unknown, _u: string, url?: string | null) => {
    historyCalls.push(["replace", data, url]);
    history.state = data;
  },
  back: () => historyCalls.push(["back", null, null]),
};
/** The drawer's panel: everything pressed "inside" it is a child of it. */
const panel = new FakeElement("DIV");
const inside = new FakeElement("BUTTON");
const layer = { id: "drawer-layer" };
const body = new FakeElement("BODY");

beforeEach(() => {
  vi.useFakeTimers();
  h.harness = createHookHarness();
  h.refs = [];
  h.committed = [];
  h.search = `status=active&c=${W2}`;
  read.calls = [];
  listeners = [];
  historyCalls = [];
  history.state = { [DRAWER_ENTRY_KEY]: "c" };
  Object.assign(panel, {
    contains: (n: unknown) => n === inside || n === panel,
    closest: (s: string) => (s === ".overlay" ? layer : null),
  });
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", { body, querySelectorAll: () => [layer] });
  vi.stubGlobal("window", {
    history,
    addEventListener: (_t: string, fn: (e: unknown) => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: (e: unknown) => void) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type DrawerEl = ReactElement<{
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactElement;
}>;

let initial: { id: string; result: CandidateRecordResult } | null = null;

/** Render, then commit the effects whose deps changed — as React does. */
function draw(): DrawerEl {
  const tree = harness().render(() => {
    h.refCalls = 0;
    h.effects = [];
    return CandidateDrawer({ rows: ROWS, initial, entitled: true, canReveal: false });
  }) as DrawerEl;
  h.effects.forEach((effect, i) => {
    const prev = h.committed[i];
    const changed =
      !prev ||
      effect.deps === undefined ||
      prev.deps === undefined ||
      effect.deps.length !== prev.deps.length ||
      effect.deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (!changed) return;
    if (typeof prev?.cleanup === "function") prev.cleanup();
    h.committed[i] = { deps: effect.deps, cleanup: effect.run() };
  });
  return tree;
}

/** Point the drawer's content ref at the stand-in panel (React would, on mount). */
function mountContent() {
  // CandidateDrawer's refs, in hook order: useCandidateRecord's `settle`, then `contentRef`, then `keys`.
  h.refs[1]!.current = { closest: (s: string) => (s === ".overlay__panel" ? panel : null) };
}

const key = (k: string, over: Record<string, unknown> = {}) => {
  const e = {
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    target: inside,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    ...over,
  };
  for (const l of [...listeners]) l(e);
  return e;
};

/** What the address bar says after the drawer's history calls (Next syncs useSearchParams). */
function follow() {
  const last = historyCalls.at(-1);
  if (last && typeof last[2] === "string") h.search = last[2].split("?")[1] ?? "";
}

const ok = (id: string): CandidateRecordResult => ({
  status: "ok",
  detail: { ...candidateRecord(), worker_id: id },
});

beforeEach(() => {
  initial = { id: W2, result: ok(W2) };
});

describe("↑ / ↓ move through the current page", () => {
  it("↓ rewrites THIS history entry to the next row — the list's filters kept, its mark kept", () => {
    draw();
    mountContent();
    const e = key("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(historyCalls).toEqual([
      ["replace", { [DRAWER_ENTRY_KEY]: "c" }, `/candidates?status=active&c=${W3}`],
    ]);
  });

  it("↑ goes to the previous row", () => {
    draw();
    mountContent();
    key("ArrowUp");
    expect(historyCalls.at(-1)![2]).toBe(`/candidates?status=active&c=${W1}`);
  });

  it("is not a move on auto-repeat, with a modifier, in a field, or pressed outside the drawer", () => {
    draw();
    mountContent();
    for (const over of [
      { repeat: true },
      { shiftKey: true },
      { metaKey: true },
      { target: new FakeElement("INPUT") },
      { target: new FakeElement("BUTTON") }, // a control of a confirm portalled over the drawer
    ]) {
      const e = key("ArrowDown", over);
      expect(e.defaultPrevented, JSON.stringify(Object.keys(over))).toBe(false);
    }
    expect(historyCalls).toEqual([]);
  });

  it("with focus fallen to the body (a control unmounted under a move) the drawer still has the keys", () => {
    draw();
    mountContent();
    key("ArrowDown", { target: body });
    expect(historyCalls).toHaveLength(1);
  });

  it("…but not while another overlay sits on top of it", () => {
    vi.stubGlobal("document", { body, querySelectorAll: () => [layer, { id: "confirm-layer" }] });
    draw();
    mountContent();
    key("ArrowDown", { target: body });
    expect(historyCalls).toEqual([]);
  });

  it("listens only while open, and stops when it closes", () => {
    h.search = "status=active";
    draw();
    expect(listeners).toHaveLength(0);
    h.search = `status=active&c=${W2}`;
    draw();
    expect(listeners).toHaveLength(1);
    h.search = "status=active";
    draw();
    expect(listeners).toHaveLength(0);
  });
});

describe("reading the record", () => {
  it("the page's server read is used as it is — no second read for the same candidate", () => {
    const tree = draw();
    expect(read.calls).toEqual([]);
    expect(tree.props.title).toBe("Ramesh Kumar");
  });

  it("a MOVE waits the settle window before it reads; the title and skeleton change at once", () => {
    draw();
    mountContent();
    key("ArrowDown");
    follow();
    const tree = draw();
    expect(tree.props.title).toBe("Candidate c3c3…0003");
    vi.advanceTimersByTime(RECORD_SETTLE_MS - 1);
    expect(read.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(read.calls.map((c) => c.id)).toEqual([W3]);
  });

  it("a burst of presses reads only the row it stops on", () => {
    h.search = `status=active&c=${W1}`;
    initial = { id: W1, result: ok(W1) };
    draw();
    mountContent();
    key("ArrowDown");
    follow();
    draw();
    vi.advanceTimersByTime(RECORD_SETTLE_MS / 2);
    key("ArrowDown");
    follow();
    draw();
    vi.advanceTimersByTime(RECORD_SETTLE_MS);
    expect(read.calls.map((c) => c.id)).toEqual([W3]);
  });

  it("an OPEN from a row reads at once", () => {
    initial = null;
    draw();
    vi.advanceTimersByTime(0);
    expect(read.calls.map((c) => c.id)).toEqual([W2]);
  });

  it("the answer is shown when it lands; a read the drawer moved past is aborted and ignored", async () => {
    initial = null;
    draw();
    mountContent();
    vi.advanceTimersByTime(0);
    const first = read.calls[0]!;
    key("ArrowDown");
    follow();
    draw();
    expect(first.signal.aborted).toBe(true);
    first.resolve(ok(W2));
    await vi.advanceTimersByTimeAsync(RECORD_SETTLE_MS);
    const second = read.calls[1]!;
    expect(second.id).toBe(W3);
    second.resolve({ status: "not_found" });
    await vi.runAllTimersAsync();
    const tree = draw();
    const view = (tree.props.children.props as { children: ReactElement[] }).children[1]!;
    expect(String(view.key)).toBe(`${W3}:not_found`);
  });

  it("Retry reads again", async () => {
    initial = { id: W2, result: { status: "error" } };
    const tree = draw();
    const view = (tree.props.children.props as { children: ReactElement[] }).children[1]!;
    const problem = (view.props as { children: ReactElement<{ onRetry: () => void }> }).children;
    problem.props.onRetry();
    draw();
    vi.advanceTimersByTime(0);
    expect(read.calls.map((c) => c.id)).toEqual([W2]);
  });

  it("a REOPEN of the same candidate reads again — a new look is a new audited read", () => {
    draw();
    h.search = "status=active";
    draw();
    h.search = `status=active&c=${W2}`;
    draw();
    vi.advanceTimersByTime(0);
    expect(read.calls.map((c) => c.id)).toEqual([W2]);
  });
});

describe("closing", () => {
  it("Close pops the entry the row pushed — Back's own move", () => {
    const tree = draw();
    tree.props.onClose();
    expect(historyCalls).toEqual([["back", null, null]]);
  });

  it("a drawer that came with the page has its param replaced away instead", () => {
    history.state = { __NA: true };
    const tree = draw();
    tree.props.onClose();
    expect(historyCalls).toEqual([["replace", null, "/candidates?status=active"]]);
  });

  it("while it plays its exit, the record that was open stays on screen — no blank flash", () => {
    const open = draw();
    expect(open.props.open).toBe(true);
    h.search = "status=active";
    const closing = draw();
    expect(closing.props.open).toBe(false);
    expect(closing.props.title).toBe("Ramesh Kumar");
  });
});
