import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

// global-error.tsx is a client component (THEME-1 added useState/useEffect so the error screen
// re-applies the saved theme on its own <html>). Stub the hooks so it can be invoked as a plain
// function in the node env. The neutral copy under test renders regardless of theme state.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => [init, vi.fn()],
    useEffect: () => undefined,
  };
});

/**
 * ERROR-BOUNDARY render tests (B5 — CAUSE-FREE / NO-LEAK).
 *
 * The three boundaries (`app/error.tsx`, `app/global-error.tsx`, `app/(portal)/error.tsx`)
 * must each render the SAME neutral copy + a `reset()` control, and must NEVER surface the
 * error `message`, `cause`, `digest`, or `stack`. Each test passes an Error carrying a SECRET
 * message (+ cause + digest) and asserts none of it appears in the rendered output, that the
 * neutral copy + a clickable "Try again" (wired to reset) is present, and — as a guardrail —
 * that no role-named / "forbidden" oracle string leaks.
 *
 * `global-error.tsx` imports `./globals.css`; alias it to a no-op so the node test can import
 * the module (vitest does not process CSS).
 *
 * UI-1 adds a SECOND fence below: all three boundaries must render the shared DS `.state
 * state--error` block (they used to each carry a private chrome-title/chrome-sub/chrome-actions
 * copy of the pattern), and `global-error.tsx` must render NO `ph ph-*` glyph — it replaces the
 * root layout, which is the only thing that loads the Phosphor sheet, so an icon there would
 * paint as tofu.
 */

vi.mock("./globals.css", () => ({}));

const { default: RootError } = await import("./error");
const { default: GlobalError } = await import("./global-error");
const { default: PortalError } = await import("./(portal)/error");

interface Collected {
  types: string[];
  text: string[];
  onClicks: Array<() => void>;
  classNames: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{
    children?: ReactNode;
    onClick?: () => void;
    className?: string;
  }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  if (el.props && typeof el.props.className === "string") acc.classNames.push(el.props.className);
  if (el.props && typeof el.props.onClick === "function") acc.onClicks.push(el.props.onClick);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], text: [], onClicks: [], classNames: [] };
  walk(tree, acc);
  return acc;
}

const SECRET = "DB constraint violation: worker +919876543210 consent=denied";

function secretError(): Error {
  const e = new Error(SECRET);
  e.cause = "internal cause: tenant aaaa-bbbb forbidden";
  e.stack = "Error: " + SECRET + "\n  at secretFrame (secret.ts:1:1)";
  (e as Error & { digest?: string }).digest = "DIGEST_abc123_secret";
  return e;
}

const BOUNDARIES: Array<[string, (p: { error: Error; reset: () => void }) => ReactNode]> = [
  ["RootError (app/error.tsx)", RootError],
  ["GlobalError (app/global-error.tsx)", GlobalError],
  ["PortalError (app/(portal)/error.tsx)", PortalError],
];

describe.each(BOUNDARIES)("%s — CAUSE-FREE neutral boundary (B5)", (_name, Boundary) => {
  it("renders the NEUTRAL copy and a reset() control, and NEVER surfaces the error detail", () => {
    const reset = vi.fn();
    const { text, onClicks } = collect(Boundary({ error: secretError(), reset }));
    const joined = text.join(" ");

    // Neutral copy + a "Try again" control.
    expect(joined).toContain("Something went wrong");
    expect(joined).toContain("Try again");

    // CAUSE-FREE: none of message / cause / digest / stack reaches the screen.
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain("+919876543210");
    expect(joined).not.toContain("internal cause");
    expect(joined).not.toContain("DIGEST_abc123_secret");
    expect(joined).not.toContain("secret.ts");
    // No-oracle guardrail: no role name / "forbidden" / consent leak.
    expect(joined).not.toMatch(/forbidden|consent|employer|agent/i);

    // The control is wired to reset() (the only side effect a boundary offers).
    expect(onClicks.length).toBeGreaterThan(0);
    onClicks.forEach((fn) => fn());
    expect(reset).toHaveBeenCalled();
  });

  it("renders the shared DS error STATE block (not a private chrome-* copy of it)", () => {
    const { classNames } = collect(Boundary({ error: secretError(), reset: vi.fn() }));
    const tokens = new Set(classNames.flatMap((c) => c.split(/\s+/)).filter(Boolean));

    // The one error language every payer surface uses, plus a real recovery slot.
    expect(tokens).toContain("state");
    expect(tokens).toContain("state--error");
    expect(tokens).toContain("state__title");
    expect(tokens).toContain("state__body");
    expect(tokens).toContain("state__actions");

    // The retired per-boundary chrome classes must not come back.
    expect(tokens).not.toContain("chrome-title");
    expect(tokens).not.toContain("chrome-sub");
    expect(tokens).not.toContain("chrome-actions");
  });
});

describe("global-error.tsx — no icon font is loaded on that surface", () => {
  it("renders NO `ph ph-*` glyph (the root layout that loads Phosphor is exactly what failed)", () => {
    const { classNames } = collect(
      GlobalError({ error: secretError(), reset: vi.fn() }),
    );
    const tokens = classNames.flatMap((c) => c.split(/\s+/)).filter(Boolean);
    expect(tokens.filter((t) => t === "ph" || t.startsWith("ph-"))).toEqual([]);
  });

  it("the in-layout boundaries DO carry the icon (the sheet is loaded there)", () => {
    for (const Boundary of [RootError, PortalError]) {
      const { classNames } = collect(Boundary({ error: secretError(), reset: vi.fn() }));
      const tokens = classNames.flatMap((c) => c.split(/\s+/)).filter(Boolean);
      expect(tokens).toContain("ph");
    }
  });
});
