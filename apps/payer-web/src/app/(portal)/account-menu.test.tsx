import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * ACCOUNT MENU (PROF-2) — the compact shell identity, rendered to an element tree in the
 * node env and walked. Asserts: the trigger carries the right accessible name +
 * `aria-haspopup="menu"` + `aria-expanded`/`aria-controls`; the OPEN panel renders the
 * payer's OWN org / email / role / status; and NO worker PII (name/phone) reaches the DOM.
 *
 * Env is node (no DOM). The component's open/closed state is injected via a mocked
 * `useState` so the panel can be exercised without a click. The other hooks
 * (`useEffect`/`useRef`/`useId`/`useCallback`) pass through to real React.
 */

let openState = false;
// The component calls useState exactly once (the `open` boolean). Seed it so the panel
// is rendered when we want to assert its contents. The other hooks are replaced with
// inert stand-ins so the component can be invoked as a plain function in the node env
// (real React hooks throw "Invalid hook call" outside a render).
const useState = vi.fn(() => [openState, vi.fn()] as [unknown, (v: unknown) => void]);
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: () => useState(),
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
    useId: () => "test-id",
    useCallback: (fn: unknown) => fn,
  };
});
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));

const { AccountMenu } = await import("./account-menu");

interface Props {
  orgName?: string;
  email?: string;
  phoneLast4?: string | null;
  role?: "employer" | "agent";
  status?: "pending" | "active" | "suspended";
}

function render(over: Props = {}): ReactElement {
  return AccountMenu({
    orgName: over.orgName ?? "Acme",
    email: "email" in over ? over.email : "ops@acme.example",
    phoneLast4: "phoneLast4" in over ? (over.phoneLast4 ?? null) : null,
    role: over.role ?? "employer",
    status: over.status ?? "active",
  }) as ReactElement;
}

/** Collect every element's props (flattened) + all visible text. */
function walk(node: ReactNode, props: Array<Record<string, unknown>>, parts: string[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    parts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((c) => walk(c, props, parts));
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  props.push(el.props as Record<string, unknown>);
  if (typeof el.type === "function") {
    walk((el.type as (p: unknown) => ReactNode)(el.props), props, parts);
    return;
  }
  if (el.props && "children" in el.props) walk(el.props.children as ReactNode, props, parts);
}

function collect(tree: ReactNode): { props: Array<Record<string, unknown>>; text: string } {
  const props: Array<Record<string, unknown>> = [];
  const parts: string[] = [];
  walk(tree, props, parts);
  return { props, text: parts.join(" ") };
}

beforeEach(() => {
  openState = false;
  useState.mockClear();
});

describe("AccountMenu — collapsed trigger (a11y)", () => {
  it("renders the trigger with the accessible name + menu-button ARIA", () => {
    const { props } = collect(render());
    const trigger = props.find((p) => p["aria-haspopup"] === "menu");
    expect(trigger).toBeDefined();
    expect(trigger!["aria-label"]).toBe("Signed in as Acme, ops@acme.example");
    expect(trigger!["aria-expanded"]).toBe(false);
    expect(typeof trigger!["aria-controls"]).toBe("string");
  });

  it("the accessible name omits the email when none is set", () => {
    const { props } = collect(render({ email: undefined }));
    const trigger = props.find((p) => p["aria-haspopup"] === "menu");
    expect(trigger!["aria-label"]).toBe("Signed in as Acme");
  });

  it("does not render the panel when collapsed (default)", () => {
    const { props } = collect(render());
    expect(props.some((p) => p["role"] === "menu")).toBe(false);
  });
});

describe("AccountMenu — open panel shows the payer's OWN identity", () => {
  it("renders org name, email (mono), role + status, and the settings link", () => {
    openState = true;
    const { props, text } = collect(render({ role: "agent", status: "pending" }));

    // panel is present
    expect(props.some((p) => p["role"] === "menu")).toBe(true);
    // org + email visible; email in mono
    expect(text).toContain("Acme");
    expect(text).toContain("ops@acme.example");
    expect(
      props.some(
        (p) =>
          typeof p["className"] === "string" &&
          (p["className"] as string).split(/\s+/).includes("bb-mono"),
      ),
    ).toBe(true);
    // role + status labels
    expect(text).toContain("Agency");
    expect(text).toContain("Pending");
    // settings link
    const link = props.find((p) => p["href"] === "/account");
    expect(link).toBeDefined();
    expect(String(link!["role"])).toBe("menuitem");
  });
});

describe("AccountMenu — no worker PII", () => {
  it("renders ONLY the payer's own data; no phone-like run, no worker identity", () => {
    openState = true;
    const { text } = collect(render({ phoneLast4: "1234" }));
    // phoneLast4 is NOT rendered in the compact menu, and nothing leaks a full phone
    expect(text).not.toMatch(/\b\d{10}\b/);
    expect(text).not.toMatch(/\+91/);
    expect(text).not.toContain("worker");
  });
});
