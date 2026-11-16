import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

/**
 * #2822 — when the server-saved choice is open, the SERVER value wins over `bb_theme` on the
 * first paint; when it is closed, the cookie behaves exactly as today.
 */
vi.mock("./globals.css", () => ({}));

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (n: string) =>
        n === "bb_theme" && cookieValue ? { value: cookieValue } : undefined,
    }),
}));

let prefs: { theme: string; theme_open: boolean } | null = null;
vi.mock("../lib/display-prefs", () => ({
  getDisplayPrefs: () => Promise.resolve(prefs),
  getDisplayPrefsCached: () => Promise.resolve(prefs),
  saveDisplayPrefs: () => Promise.resolve(null),
}));

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
  if (el.props && "children" in el.props && typeof el.type !== "function") {
    walk(el.props.children as ReactNode, out);
  }
}

const html = (out: El[]) => out.find((e) => e.type === "html")!;
const noFouc = (out: El[]): string =>
  out
    .filter((e) => e.type === "script")
    .map(
      (e) =>
        (e.props["dangerouslySetInnerHTML"] as { __html?: string } | undefined)?.__html ?? "",
    )
    .join("");

async function renderRoot(): Promise<El[]> {
  vi.resetModules();
  const { default: RootLayout } = await import("./layout");
  const out: El[] = [];
  walk((await RootLayout({ children: null })) as ReactElement, out);
  return out;
}

beforeEach(() => {
  cookieValue = undefined;
  prefs = null;
  vi.unstubAllEnvs();
});

describe("server value wins over the cache cookie when the switch is open", () => {
  it("open dark overrides a paper cookie on the first paint", async () => {
    cookieValue = "paper";
    prefs = { theme: "dark", theme_open: true };
    expect(html(await renderRoot()).props["data-theme"]).toBe("ink");
  });

  it("open light overrides an ink cookie on the first paint", async () => {
    cookieValue = "ink";
    prefs = { theme: "light", theme_open: true };
    expect(html(await renderRoot()).props["data-theme"]).toBeUndefined();
  });

  it("open system follows the OS even when the cookie is stale/explicit", async () => {
    cookieValue = "ink";
    prefs = { theme: "system", theme_open: true };
    const out = await renderRoot();
    expect(html(out).props["data-theme"]).toBeUndefined();
    expect(noFouc(out)).toContain("prefers-color-scheme: dark");
    expect(noFouc(out)).not.toContain('v!=="paper"&&v!=="ink"');
  });

  it("closed keeps today's cookie behaviour (an ink cookie paints ink)", async () => {
    cookieValue = "ink";
    prefs = { theme: "light", theme_open: false };
    expect(html(await renderRoot()).props["data-theme"]).toBe("ink");
  });
});
