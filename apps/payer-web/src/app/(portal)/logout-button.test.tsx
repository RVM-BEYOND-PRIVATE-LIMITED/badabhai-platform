import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * LOGOUT BUTTON (DS) — the icon-only Sign-out control in the portal header. Env is node (no
 * DOM): the component is invoked as a plain function with `useTransition` mocked to run the
 * transition synchronously, so the click path can be asserted without a real React render.
 *
 * Asserts: it is an ICON-ONLY control that still carries an accessible NAME (aria-label
 * "Sign out") — required since there is no visible label — and that clicking it invokes the
 * server `logoutAction`.
 */

const startTransition = vi.fn((cb: () => void) => cb());
let pending = false;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useTransition: () => [pending, startTransition] as [boolean, (cb: () => void) => void],
  };
});
const logoutAction = vi.fn();
vi.mock("./logout-action", () => ({ logoutAction: () => logoutAction() }));

const { LogoutButton } = await import("./logout-button");

/** Walk the element tree, collecting every element's props + visible text. */
function collect(node: ReactNode): { props: Array<Record<string, unknown>>; text: string } {
  const props: Array<Record<string, unknown>> = [];
  const parts: string[] = [];
  (function w(n: ReactNode): void {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(w);
      return;
    }
    const el = n as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    props.push(el.props as Record<string, unknown>);
    if (typeof el.type === "function") {
      w((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(node);
  return { props, text: parts.join(" ") };
}

beforeEach(() => {
  pending = false;
  startTransition.mockClear();
  logoutAction.mockClear();
});

describe("LogoutButton — icon-only, accessible, danger-tinted", () => {
  it("renders an icon-only button with an accessible name (aria-label 'Sign out')", () => {
    const { props, text } = collect(LogoutButton() as ReactElement);
    const btn = props.find((p) => p["aria-label"] === "Sign out");
    expect(btn).toBeDefined();
    expect(btn!["type"]).toBe("button");
    // No visible text label (icon-only) — the accessible name carries it.
    expect(text.trim()).toBe("");
    // The Phosphor sign-out glyph is present + hidden from a11y (the label names the control).
    const icon = props.find(
      (p) => typeof p["className"] === "string" && (p["className"] as string).includes("ph-sign-out"),
    );
    expect(icon).toBeDefined();
    expect(icon!["aria-hidden"]).toBe("true");
  });

  it("invokes the server logoutAction on click", () => {
    const { props } = collect(LogoutButton() as ReactElement);
    const btn = props.find((p) => p["aria-label"] === "Sign out");
    (btn!["onClick"] as () => void)();
    expect(startTransition).toHaveBeenCalledTimes(1);
    expect(logoutAction).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner + busy/disabled state while pending", () => {
    pending = true;
    const { props } = collect(LogoutButton() as ReactElement);
    const btn = props.find((p) => p["aria-label"] === "Sign out");
    expect(btn!["aria-busy"]).toBe(true);
    expect(btn!["disabled"]).toBe(true);
    const spinner = props.find(
      (p) => typeof p["className"] === "string" && (p["className"] as string).includes("ph-spinner"),
    );
    expect(spinner).toBeDefined();
  });
});
