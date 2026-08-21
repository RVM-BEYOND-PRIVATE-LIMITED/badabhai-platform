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

  /**
   * The AI-calls entry, and specifically WHICH capability it declares.
   *
   * IT MUST MIRROR THE ROUTE. The API gates both legs of `/admin/ai-traces` on `read_ai_traces`
   * (super_admin only) behind a default-off flag, per the owner ruling — the list included. A
   * nav entry LOOSER than its route puts three of the four roles one click from a 403; a nav
   * entry TIGHTER than its route hides a screen they are entitled to, silently, because a
   * filtered-out nav item leaves no trace on screen. Neither failure announces itself, which is
   * why the pair is pinned rather than reviewed.
   *
   * The earlier build had this on `read_entities` and the API's list on `read_entities` too —
   * consistent, and a widening of the ruling. If an owner reopens the list to ops, this
   * assertion and the controller's decorator change together or the pair is wrong again.
   */
  it("AI calls is gated on the decrypt capability, mirroring the API route", () => {
    const item = NAV.flatMap((s) => s.items).find((i) => i.href === "/ai-calls");
    expect(item, "the AI calls nav entry is missing").toBeDefined();
    expect(item!.capability).toBe("read_ai_traces");
    expect(item!.capability).not.toBe("read_entities");
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
  "../app/(portal)/ai-calls/filter-bar.tsx",
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

  /**
   * `lib/ai-traces.ts` is the seam that DECRYPTS a stored prompt. Its filter bar needs the task
   * -type vocabulary, which is why that list lives in the pure `lib/ai-trace-view.ts` and not
   * beside the fetchers: the obvious shortcut — importing the constant from the data layer —
   * would pull the module that calls `getAiTrace` toward the browser bundle. `server-only`
   * already fails such a build; this states the rule where a reviewer will see it.
   */
  it("ai-calls/filter-bar.tsx does not import lib/ai-traces", () => {
    const src = read("../app/(portal)/ai-calls/filter-bar.tsx");
    expect(src).not.toMatch(/from\s+["'].*lib\/ai-traces["']/);
  });
});
