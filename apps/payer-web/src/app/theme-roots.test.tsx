import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

// GlobalError is a client component (useState/useEffect). Stub the hooks so it can be invoked
// as a plain function in the node env (real hooks throw "Invalid hook call" outside a render).
// The root layout uses no hooks, so this mock is transparent to it.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => [init, vi.fn()],
    useEffect: () => undefined,
  };
});

/**
 * THEME-1 — both <html> roots are themed.
 *
 * The ROOT layout (app/layout.tsx) reads the bb_theme cookie, resolves data-theme, and emits
 * the no-FOUC inline script + the theme-color meta. The GLOBAL error boundary
 * (app/global-error.tsx) renders its OWN <html> and must theme it the same way (so the error
 * screen never flips to light in dark mode). Both are walked here.
 *
 * `globals.css` is stubbed (a side-effect import the node env can't parse); `next/headers`
 * cookies() is mocked so the SSR cookie path is exercised.
 */

vi.mock("./globals.css", () => ({}));

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: (n: string) => (n === "bb_theme" && cookieValue ? { value: cookieValue } : undefined) }),
}));

// next/font/config isn't used here; the layout only imports config + theme (pure modules).

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}

function walk(node: ReactNode, out: El[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    node.forEach((c) => walk(c, out));
    return;
  }
  const el = node as El;
  out.push(el);
  // Do NOT expand function components here — we only need the host elements (html/head/meta/
  // script) that the layout itself renders; expanding children (the page) isn't needed.
  if (el.props && "children" in el.props && typeof el.type !== "function") {
    walk(el.props.children as ReactNode, out);
  }
}

function findHtml(els: El[]): El {
  return els.find((e) => e.type === "html")!;
}
function hasMetaThemeColor(els: El[]): boolean {
  return els.some((e) => e.type === "meta" && e.props["name"] === "theme-color");
}
function hasNoFoucScript(els: El[]): boolean {
  return els.some(
    (e) =>
      e.type === "script" &&
      typeof (e.props["dangerouslySetInnerHTML"] as { __html?: string } | undefined)?.__html === "string" &&
      (e.props["dangerouslySetInnerHTML"] as { __html: string }).__html.includes("prefers-color-scheme"),
  );
}

beforeEach(() => {
  cookieValue = undefined;
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("root layout — SSR theme + no-FOUC plumbing", () => {
  it("an ink cookie resolves data-theme='ink' on the root <html>", async () => {
    cookieValue = "ink";
    const { default: RootLayout } = await import("./layout");
    const out: El[] = [];
    walk((await RootLayout({ children: null })) as ReactElement, out);
    expect(findHtml(out).props["data-theme"]).toBe("ink");
  });

  it("no cookie + no env default → data-theme is undefined (paper = attribute-less default)", async () => {
    const { default: RootLayout } = await import("./layout");
    const out: El[] = [];
    walk((await RootLayout({ children: null })) as ReactElement, out);
    expect(findHtml(out).props["data-theme"]).toBeUndefined();
  });

  it("no cookie + PAYER_THEME=ink (back-compat) still resolves to ink", async () => {
    vi.stubEnv("PAYER_THEME", "ink");
    vi.resetModules();
    const { default: RootLayout } = await import("./layout");
    const out: El[] = [];
    walk((await RootLayout({ children: null })) as ReactElement, out);
    expect(findHtml(out).props["data-theme"]).toBe("ink");
  });

  it("renders the no-FOUC inline script + a theme-color meta in <head>", async () => {
    const { default: RootLayout } = await import("./layout");
    const out: El[] = [];
    walk((await RootLayout({ children: null })) as ReactElement, out);
    expect(hasNoFoucScript(out)).toBe(true);
    expect(hasMetaThemeColor(out)).toBe(true);
  });
});

describe("global-error boundary — themes its own <html>", () => {
  it("renders an <html> + the no-FOUC script + a theme-color meta", async () => {
    const { default: GlobalError } = await import("./global-error");
    const out: El[] = [];
    // GlobalError is a client component (uses hooks). Mock the hooks it calls so it runs as a
    // plain function in node — useState seeds the env-default theme; useEffect is inert.
    walk(
      GlobalError({ error: new Error("boom"), reset: () => {} }) as ReactElement,
      out,
    );
    expect(findHtml(out)).toBeDefined();
    expect(hasNoFoucScript(out)).toBe(true);
    expect(hasMetaThemeColor(out)).toBe(true);
  });
});
