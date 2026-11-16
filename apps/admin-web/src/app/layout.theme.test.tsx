import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

/**
 * #2821 — admin-web's root `<html>` while the theme switch is closed must carry NO `data-theme`
 * and emit no theme script, whatever the cookie says. When open, the server value drives it.
 */
vi.mock("./globals.css", () => ({}));

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
const scripts = (out: El[]): string =>
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
  prefs = null;
});

describe("admin root layout — closed means Light, cookie ignored", () => {
  it("sets no data-theme and emits no theme script when the switch is closed", async () => {
    prefs = { theme: "dark", theme_open: false };
    const out = await renderRoot();
    expect(html(out).props["data-theme"]).toBeUndefined();
    expect(scripts(out)).toBe("");
  });

  it("sets no data-theme when there is no prefs read at all", async () => {
    const out = await renderRoot();
    expect(html(out).props["data-theme"]).toBeUndefined();
    expect(scripts(out)).toBe("");
  });

  it("uses the server value when open: dark → ink, light → none", async () => {
    prefs = { theme: "dark", theme_open: true };
    expect(html(await renderRoot()).props["data-theme"]).toBe("ink");
    prefs = { theme: "light", theme_open: true };
    expect(html(await renderRoot()).props["data-theme"]).toBeUndefined();
  });

  it("an open `system` follows the OS and names the admin cookie", async () => {
    prefs = { theme: "system", theme_open: true };
    const out = await renderRoot();
    expect(html(out).props["data-theme"]).toBeUndefined();
    expect(scripts(out)).toContain("bb_admin_theme");
    expect(scripts(out)).toContain("prefers-color-scheme: dark");
  });
});
