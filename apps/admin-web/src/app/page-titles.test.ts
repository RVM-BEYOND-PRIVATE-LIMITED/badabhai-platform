import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tab titles. The root layout's template is "%s · BadaBhai Admin", so a page's own title must
 * NOT carry the suffix: /login and /invite/accept did, and their tabs read
 * "Sign in · BadaBhai Admin · BadaBhai Admin" (owner brief 2026-10-01, bug 5). And every page
 * names itself — /events/[id] had no title and fell back to the bare default.
 *
 * Read from source: the pages import server-only seams this node env cannot load whole.
 */
const appRoot = dirname(fileURLToPath(import.meta.url));
const SUFFIX = "BadaBhai Admin";

function pages(): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "page.tsx") {
        out.set(relative(appRoot, full).replace(/\\/g, "/"), readFileSync(full, "utf8"));
      }
    }
  })(appRoot);
  return out;
}

/** The static `title` in a page's `metadata` export, or null when it declares none. */
function pageTitle(src: string): string | null {
  const at = src.indexOf("export const metadata");
  if (at < 0) return null;
  const title = /title:\s*"([^"]*)"/.exec(src.slice(at));
  return title ? title[1]! : null;
}

const PAGES = pages();

describe("the title detector", () => {
  it("reads a page's own title, across lines and comments", () => {
    expect(pageTitle('export const metadata = { title: "Events" };')).toBe("Events");
    expect(pageTitle('export const metadata = {\n  // why\n  title: "Sign in",\n};')).toBe(
      "Sign in",
    );
    expect(pageTitle("export default function P() {}")).toBeNull();
  });

  it("walks every page in the app", () => {
    expect(PAGES.size).toBeGreaterThan(28);
    expect(PAGES.has("login/page.tsx")).toBe(true);
    expect(PAGES.has("invite/accept/page.tsx")).toBe(true);
  });
});

describe("tab titles", () => {
  it("no page repeats the suffix the root template already appends", () => {
    const doubled = [...PAGES]
      .filter(([, src]) => (pageTitle(src) ?? "").includes(SUFFIX))
      .map(([f]) => f);
    expect(doubled).toEqual([]);
  });

  it("every page names itself", () => {
    const untitled = [...PAGES].filter(([, src]) => !pageTitle(src)).map(([f]) => f);
    expect(untitled).toEqual([]);
  });

  it("the root template is the one place the suffix lives", () => {
    const layout = readFileSync(join(appRoot, "layout.tsx"), "utf8");
    expect(layout).toContain(`template: "%s · ${SUFFIX}"`);
  });
});
