import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * #3020 — the company trade picker. It lists the server's catalogue by department, filters by the
 * server's labels, loads one trade's form lazily (once per session), and keeps a switched-off
 * stored trade readable without letting it be re-sent.
 */

const loadPostingTradeFormAction = vi.fn();
vi.mock("./trade-form-action", () => ({
  loadPostingTradeFormAction: (roleKind: string) => loadPostingTradeFormAction(roleKind),
}));

let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  return [i < stateQueue.length ? stateQueue[i] : initial, vi.fn()] as const;
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  let ids = 0;
  return {
    ...actual,
    useId: () => `:r${(ids += 1)}:`,
    useState: (initial: unknown) => useState(initial),
    useEffect: () => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
  };
});
vi.mock("../../../components/retry-button", () => ({
  RetryButton: () => ({ type: "button", props: { type: "button", children: "Retry" } }),
}));

const { PostingTradePicker, clearPostingTradeFormCache, loadPostingTradeFormCached } = await import(
  "./trade-picker"
);
const { tradeDepartmentGroups } = await import("../../../lib/trade-catalogue");

const DEPARTMENTS = Array.from({ length: 11 }, (_, i) => ({
  department: `dept_${i}`,
  department_label: `Department ${i}`,
}));
const CATALOGUE = Array.from({ length: 60 }, (_, i) => {
  const department = DEPARTMENTS[i % DEPARTMENTS.length]!;
  const welder = i === 0 || i === 12;
  return {
    role_kind: `trade_${i}`,
    role_label: welder ? (i === 0 ? "Arc Welder" : "MIG Welder") : `Trade ${i}`,
    ...department,
    kind: i < 55 ? ("shop_floor" as const) : ("desk" as const),
  };
});

const DETAIL = {
  role_kind: "trade_0",
  role_label: "Arc Welder",
  department: "dept_0",
  pack_id: "qp_trade_0",
  match_skill_id: "mskill_trade_0",
  ladder: [],
  questions: [],
};

/** Every DOM-level element (function components expanded), depth-first. */
function hosts(node: ReactNode, out: Array<ReactElement<Record<string, unknown>>> = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) hosts(c, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "function") {
    return hosts((el.type as (p: unknown) => ReactNode)(el.props), out);
  }
  out.push(el);
  if ("children" in el.props) hosts(el.props.children, out);
  return out;
}
function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") return text((el.type as (p: unknown) => ReactNode)(el.props));
  return "children" in el.props ? text(el.props.children) : "";
}

const pick = (over: Partial<Parameters<typeof PostingTradePicker>[0]> = {}) => {
  stateCursor = 0;
  return PostingTradePicker({
    id: "roleKind",
    label: "Role",
    trades: CATALOGUE,
    problem: null,
    value: "",
    onChange: () => undefined,
    ...over,
  }) as ReactElement;
};

beforeEach(() => {
  loadPostingTradeFormAction.mockReset();
  clearPostingTradeFormCache();
  stateQueue = [];
});

describe("PostingTradePicker — the server's catalogue, grouped by department", () => {
  it("offers 60 trades under 11 department headings, in server order", () => {
    const groups = tradeDepartmentGroups(CATALOGUE);
    expect(groups).toHaveLength(11);
    expect(groups.map((g) => g.label)).toEqual(DEPARTMENTS.map((d) => d.department_label));
    expect(groups.flatMap((g) => g.trades)).toHaveLength(60);

    const rendered = hosts(pick()).filter((el) => el.type === "optgroup");
    expect(rendered.map((el) => el.props.label)).toEqual(
      DEPARTMENTS.map((d) => d.department_label),
    );
  });

  it("search 'weld' keeps only the server labels that contain it, under their headings", () => {
    stateQueue = ["weld"];
    const els = hosts(pick());
    const options = els.filter((el) => el.type === "option" && el.props.value !== "");
    expect(options.map((o) => text(o)).sort()).toEqual(["Arc Welder", "MIG Welder"]);
    for (const option of options) expect(text(option).toLowerCase()).toContain("weld");
    const headings = els.filter((el) => el.type === "optgroup").map((el) => el.props.label);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((heading) => String(heading).startsWith("Department"))).toBe(true);
  });

  it("has a labelled search box and a visible selected state", () => {
    const els = hosts(pick({ value: "trade_0" }));
    const search = els.find((el) => el.type === "input" && el.props.id === "roleKind-search")!;
    expect(search).toBeDefined();
    expect(text(els.find((el) => el.props.id === "roleKind-selection"))).toBe("Selected: Arc Welder");
  });
});

describe("PostingTradePicker — one form per trade, cached for the session", () => {
  it("loads a picked trade once, then reuses it", async () => {
    loadPostingTradeFormAction.mockResolvedValue({ ok: true, trade: DETAIL });
    await loadPostingTradeFormCached("trade_0");
    await loadPostingTradeFormCached("trade_0");
    expect(loadPostingTradeFormAction).toHaveBeenCalledTimes(1);
    expect(loadPostingTradeFormAction).toHaveBeenCalledWith("trade_0");
  });

  it("coalesces concurrent requests for the same trade", async () => {
    loadPostingTradeFormAction.mockResolvedValue({ ok: true, trade: DETAIL });
    await Promise.all([
      loadPostingTradeFormCached("trade_0"),
      loadPostingTradeFormCached("trade_0"),
    ]);
    expect(loadPostingTradeFormAction).toHaveBeenCalledTimes(1);
  });
});

describe("PostingTradePicker — a stored trade that is no longer offered", () => {
  it("shows the stored label and level read-only, with no list or search", () => {
    const els = hosts(
      pick({ trades: [], value: "retired_trade", lockedLabel: "Old Trade", lockedLevel: "setter" }),
    );
    expect(els.some((el) => el.type === "select" || el.type === "option")).toBe(false);
    expect(els.some((el) => el.type === "input")).toBe(false);
    const stored = els.find((el) => el.props.id === "roleKind")!;
    expect(stored.type).toBe("p");
    expect(text(stored)).toBe("Old Trade");
    expect(text(els.find((el) => el.props.className === "bb-field__hint"))).toBe(
      "Level: Setter — kept from the saved posting.",
    );
  });
});

describe("PostingTradePicker — the catalogue did not load", () => {
  it("no select: the real cause and Retry, under the picker's id", () => {
    const els = hosts(pick({ trades: [], problem: { kind: "rate-limited" } }));
    expect(els.some((el) => el.type === "select" || el.type === "option")).toBe(false);
    const spot = els.find((el) => el.props.id === "roleKind")!;
    expect(spot.type).toBe("div");
    expect(spot.props.tabIndex).toBe(-1);
    expect(spot.props.role).toBe("group");
    expect(text(els.find((el) => el.props.id === "roleKind-cause"))).toBe(
      "The 16 trades did not load: too many requests just now. Wait a minute, then retry.",
    );
    expect(els.filter((el) => el.type === "button").map((b) => text(b))).toEqual(["Retry"]);
  });

  it("an empty answer says so; the refusal still shows under it", () => {
    const els = hosts(
      pick({
        trades: [],
        problem: { kind: "empty" },
        error: "Pick one of the 16 trades",
      }),
    );
    expect(text(els.find((el) => el.props.id === "roleKind-cause"))).toBe(
      "No trades are open for posting right now. Try again in a moment.",
    );
    expect(text(els.find((el) => el.props.id === "roleKind-msg"))).toBe(
      "Pick one of the 16 trades",
    );
  });
});
