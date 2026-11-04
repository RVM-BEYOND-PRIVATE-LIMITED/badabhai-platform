import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * #2645 — THE COMPANY TRADE PICKER (New posting, Edit posting, the AI chat's publish step).
 *
 *  - It lists ONLY the trades the API served — never the declared role list.
 *  - When the 16 trades are not there it names the REAL cause and offers Retry, under the same
 *    id a refused publish focuses, and the role's inline refusal still shows.
 *
 * Node env: the component is called as a function and its tree walked; the DS field's `useId`
 * answers from a counter, and Retry (a `router.refresh()` control with its own suite) is a stub.
 */

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  let ids = 0;
  return { ...actual, useId: () => `:r${(ids += 1)}:` };
});
vi.mock("../../../components/retry-button", () => ({
  RetryButton: () => ({ type: "button", props: { type: "button", children: "Retry" } }),
}));

const { PostingTradePicker } = await import("./trade-picker");

const tradeRow = (roleKind: string, roleLabel: string) => ({
  role_kind: roleKind,
  role_label: roleLabel,
  pack_id: `qp_${roleKind}`,
  match_skill_id: `mskill_${roleKind}`,
  ladder: [],
  questions: [],
});
const TRADES = [tradeRow("cnc_turner", "CNC Turner"), tradeRow("fitter", "Fitter")];

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

const pick = (over: Partial<Parameters<typeof PostingTradePicker>[0]> = {}) =>
  PostingTradePicker({
    id: "roleKind",
    label: "Role",
    trades: TRADES,
    problem: null,
    value: "",
    onChange: () => undefined,
    ...over,
  }) as ReactElement;

describe("PostingTradePicker — the 16 trades from the API", () => {
  it("offers exactly the served trades (labels by kind), after a 'pick one' placeholder", () => {
    const options = hosts(pick()).filter((el) => el.type === "option");
    expect(options.map((o) => o.props.value)).toEqual(["", "cnc_turner", "fitter"]);
    expect(text(options[0])).toBe("— pick one of the 16 trades —");
    expect(options.slice(1).map((o) => text(o))).toEqual(["CNC Turner", "Fitter"]);
  });

  it("is a native select under the given id; a pick hands back the role kind", () => {
    const onChange = vi.fn();
    const select = hosts(pick({ onChange })).find((el) => el.type === "select")!;
    expect(select.props.id).toBe("roleKind");
    (select.props.onChange as (e: unknown) => void)({ target: { value: "fitter" } });
    expect(onChange).toHaveBeenCalledWith("fitter");
  });

  it("a refusal is the select's own error: aria-invalid + the feedback line it is described by", () => {
    const els = hosts(pick({ error: "Pick one of the 16 trades" }));
    const select = els.find((el) => el.type === "select")!;
    expect(select.props["aria-invalid"]).toBe(true);
    expect(select.props["aria-describedby"]).toBe("roleKind-msg");
    expect(text(els.find((el) => el.props.id === "roleKind-msg"))).toBe("Pick one of the 16 trades");
  });
});

describe("PostingTradePicker — the 16 trades did not load", () => {
  it("no select and no role list: the real cause and Retry, under the picker's id", () => {
    const els = hosts(pick({ trades: [], problem: { kind: "rate-limited" } }));
    expect(els.some((el) => el.type === "select" || el.type === "option")).toBe(false);
    const spot = els.find((el) => el.props.id === "roleKind")!;
    expect(spot.type).toBe("div");
    expect(spot.props.tabIndex).toBe(-1); // a refused publish can still move focus here
    expect(spot.props.role).toBe("group");
    expect(spot.props["aria-labelledby"]).toBe("roleKind-label");
    expect(text(els.find((el) => el.props.id === "roleKind-label"))).toBe("Role");
    expect(text(els.find((el) => el.props.id === "roleKind-cause"))).toBe(
      "The 16 trades did not load: too many requests just now. Wait a minute, then retry.",
    );
    expect(els.filter((el) => el.type === "button").map((b) => text(b))).toEqual(["Retry"]);
  });

  it("an empty answer says so; no cause given reads the same", () => {
    for (const problem of [{ kind: "empty" } as const, null]) {
      const els = hosts(pick({ trades: [], problem }));
      expect(text(els.find((el) => el.props.id === "roleKind-cause"))).toBe(
        "No trades are open for posting right now. Try again in a moment.",
      );
    }
  });

  it("the role's refusal still shows under it, and describes the spot with the cause", () => {
    const els = hosts(
      pick({ trades: [], problem: { kind: "unreachable" }, error: "Pick one of the 16 trades" }),
    );
    const spot = els.find((el) => el.props.id === "roleKind")!;
    expect(spot.props["aria-describedby"]).toBe("roleKind-cause roleKind-msg");
    const line = els.find((el) => el.props.id === "roleKind-msg")!;
    expect(line.props.className).toBe("bb-field__error");
    expect(text(line)).toBe("Pick one of the 16 trades");
  });
});
