import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV } from "./nav-model";

/**
 * The Server/Client module boundary.
 *
 * REGRESSION GUARD. `NAV` originally lived in `nav.tsx`, which is `"use client"`. The
 * portal layout is a Server Component and imports `NAV` to filter it by capability —
 * and when a Server Component imports a non-component value from a client module, React
 * hands back a client *reference* rather than the value. The result was a 500 on every
 * authenticated page load: `NAV.map is not a function`.
 *
 * Typecheck did NOT catch it (the types are identical either way) and the unit tests did
 * not either (vitest imports the module directly, with no bundler in the way). Only
 * rendering the real app surfaced it, which is precisely why this file asserts the
 * arrangement statically.
 */

const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (f: string) => readFileSync(join(dir, f), "utf8");

describe("nav-model is server-readable data", () => {
  it("has NO 'use client' directive", () => {
    expect(read("nav-model.ts")).not.toMatch(/^\s*["']use client["']/m);
  });

  it("NAV is a real array the server can map over", () => {
    expect(Array.isArray(NAV)).toBe(true);
    expect(NAV.length).toBeGreaterThan(0);
    expect(() => NAV.map((s) => s.title)).not.toThrow();
  });

  it("every section has a title and at least one item", () => {
    for (const section of NAV) {
      expect(section.title).toBeTruthy();
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("every item has an absolute href and a label", () => {
    for (const item of NAV.flatMap((s) => s.items)) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it("hrefs are unique — two nav entries on one route would both highlight", () => {
    const hrefs = NAV.flatMap((s) => s.items).map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

// Phase 2 — the governed-action client components (AdminActionButton and its per-surface
// wrappers). Same two regressions apply: a missing directive fails the build the moment a
// hook is added, and a transport import would pull the admin JWT toward the browser bundle.
const CLIENT_COMPONENTS = [
  "nav.tsx",
  "shell.tsx",
  "sign-out-button.tsx",
  "admin-action-button.tsx",
  "payer-detail-header.tsx",
  "payer-credits-panel.tsx",
  "../app/(portal)/jobs/[id]/job-detail-header.tsx",
  "../app/(portal)/workers/[id]/worker-detail-header.tsx",
  "../app/(portal)/admins/invite-admin-form.tsx",
  "../app/(portal)/admins/admin-row-actions.tsx",
];

describe("interactive components stay on the client", () => {
  // These use hooks (usePathname / useState / useTransition). Without the directive they
  // would be compiled as Server Components and fail at build time.
  it.each(CLIENT_COMPONENTS)("%s declares 'use client'", (f) => {
    expect(read(f)).toMatch(/^\s*["']use client["']/m);
  });
});

describe("no client module imports the server-only transport", () => {
  // A client component importing `admin-http` (or the cookie helpers) would pull the
  // session token toward the browser bundle. `server-only` already fails such a build,
  // but this states the rule where a reviewer will actually see it.
  it.each(CLIENT_COMPONENTS)("%s stays off the transport", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/from\s+["'].*admin-http["']/);
    expect(src).not.toMatch(/from\s+["'].*session-cookie["']/);
  });
});

describe("no client module imports a server-only data-layer type", () => {
  // `lib/entities.ts` / `lib/events.ts` are `import "server-only"` — even a type-only import
  // from a client module is the wrong direction for this boundary to grow in, so the admins
  // row-actions component carries its own narrow, client-safe row shape instead.
  it("admin-row-actions.tsx does not import lib/entities", () => {
    const src = read("../app/(portal)/admins/admin-row-actions.tsx");
    expect(src).not.toMatch(/from\s+["'].*lib\/entities["']/);
  });
});
