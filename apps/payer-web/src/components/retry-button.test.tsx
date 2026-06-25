import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * RETRY button test (B6) — clicking it re-runs the server read via `router.refresh()`.
 *
 * The control is a `"use client"` component using `useRouter` + `useTransition`. In the node
 * test env we mock both hooks so the component function can be invoked directly: we render it
 * to an element tree, find the button's onClick, fire it, and assert `router.refresh()` ran
 * (the only effect this control has — it carries NO data and NO error detail, per its
 * NO-LEAK contract).
 */

const refresh = vi.fn();
const useRouter = vi.fn(() => ({ refresh }));
// useTransition → [pending=false, run-the-callback-immediately]
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);

vi.mock("next/navigation", () => ({ useRouter: () => useRouter() }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useTransition: () => useTransition() };
});

const { RetryButton } = await import("./retry-button");

interface Found {
  text: string[];
  onClicks: Array<() => void>;
}

function walk(node: ReactNode, acc: Found): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.props && typeof el.props.onClick === "function") acc.onClicks.push(el.props.onClick);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Found {
  const acc: Found = { text: [], onClicks: [] };
  walk(tree, acc);
  return acc;
}

beforeEach(() => {
  refresh.mockReset();
  useRouter.mockClear();
  useTransition.mockClear();
});

describe("RetryButton — re-runs the server read on click (B6)", () => {
  it("calls router.refresh() when clicked", () => {
    const { onClicks } = collect(RetryButton({}));
    expect(onClicks.length).toBe(1);
    onClicks[0]!();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders only a neutral label — no data / no error detail (NO-LEAK)", () => {
    const { text } = collect(RetryButton({ label: "Retry" }));
    const joined = text.join(" ");
    expect(joined).toContain("Retry");
    // The control carries no data, no error message, no oracle.
    expect(joined).not.toMatch(/forbidden|consent|payer_id|phone|email/i);
  });
});
