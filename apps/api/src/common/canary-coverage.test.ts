import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * THE CANARY'S ROUTE LIST MUST NOT FALL BEHIND THE API.
 *
 * `scripts/prod-canary.mjs` is the release gate that proves the ops API is not answering
 * anonymous callers in production. Its `OPS_ROUTES` list is only as good as its coverage,
 * and coverage is exactly what silently rots: on 2026-07-31 that list held 6 routes while 43
 * sat behind `InternalServiceGuard`, so the canary reported PASS across 37 unprobed routes —
 * including an unauthenticated `PUT /pricing/catalog` and the whole job-posting verify chain.
 *
 * That is the same shape as the incident the canary exists to prevent: not a guard that
 * failed, but a route nothing was watching. A human is not going to remember to update a
 * script in `scripts/` when adding a controller route, so this test remembers for them.
 *
 * IT DISCOVERS CONTROLLERS FROM DISK, deliberately — not from a hand-maintained import list,
 * which would be a second thing to forget and would reintroduce the same rot one level up.
 * A brand-new controller file is picked up with no edit here.
 */

// This file lives at apps/api/src/common/, so `..` is apps/api/src — the tree to scan — and
// the repo root is three levels above that. Both are asserted below rather than assumed,
// because a wrong depth here would silently scan nothing and make the whole test vacuous.
const API_SRC = join(__dirname, "..");
const REPO_ROOT = join(API_SRC, "..", "..", "..");
const CANARY = join(REPO_ROOT, "scripts", "prod-canary.mjs");

/** Nest's RequestMethod enum order. */
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];

/** The uuid the canary substitutes for a path parameter. */
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

function findControllers(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findControllers(full, out);
    } else if (entry.endsWith(".controller.ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function guardNames(target: unknown): string[] {
  const g = Reflect.getMetadata("__guards__", target as object) as
    | Array<{ name?: string }>
    | undefined;
  return (g ?? []).map((x) => x?.name ?? String(x));
}

function joinPath(base: string, sub: string): string {
  const b = (base ?? "").replace(/^\/|\/$/g, "");
  const s = (sub ?? "").replace(/^\/|\/$/g, "");
  return "/" + [b, s].filter(Boolean).join("/");
}

/** `/workers/:id/profile` and `/workers/<uuid>/profile` must compare equal. */
function normalize(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((seg) => (seg.startsWith(":") || seg === ABSENT_ID ? ":P" : seg))
    .join("/");
}

interface GuardedRoute {
  key: string;
  file: string;
  fn: string;
}

async function collectGuardedRoutes(): Promise<{
  routes: GuardedRoute[];
  unimportable: string[];
}> {
  const routes: GuardedRoute[] = [];
  const unimportable: string[] = [];

  for (const file of findControllers(API_SRC)) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      // Reported, never swallowed: a controller we cannot load is a controller whose guards
      // we cannot verify, and quietly skipping it would hand back exactly the false assurance
      // this test exists to remove.
      unimportable.push(
        `${relative(API_SRC, file).split(sep).join("/")} — ${
          err instanceof Error ? err.message.split("\n")[0] : String(err)
        }`,
      );
      continue;
    }

    for (const exported of Object.values(mod)) {
      if (typeof exported !== "function") continue;
      const proto = (exported as { prototype?: object }).prototype;
      if (!proto) continue;
      const base = Reflect.getMetadata("path", exported) as string | undefined;
      if (base === undefined) continue; // not a @Controller

      const classGuards = guardNames(exported);
      for (const fn of Object.getOwnPropertyNames(proto)) {
        if (fn === "constructor") continue;
        const handler = (proto as Record<string, unknown>)[fn];
        if (typeof handler !== "function") continue;
        const sub = Reflect.getMetadata("path", handler) as string | undefined;
        if (sub === undefined) continue; // not a route

        const all = [...classGuards, ...guardNames(handler)];
        if (!all.includes("InternalServiceGuard")) continue;

        const methodIdx = Reflect.getMetadata("method", handler) as number | undefined;
        routes.push({
          key: `${METHODS[methodIdx ?? 0]} ${normalize(joinPath(base, sub))}`,
          file: relative(API_SRC, file).split(sep).join("/"),
          fn,
        });
      }
    }
  }
  return { routes, unimportable };
}

describe("prod-canary covers every InternalServiceGuard route", () => {
  it("resolves the paths it depends on (a wrong depth would make every other assertion vacuous)", () => {
    expect(statSync(join(API_SRC, "common")).isDirectory()).toBe(true);
    expect(statSync(CANARY).isFile()).toBe(true);
    expect(findControllers(API_SRC).length).toBeGreaterThanOrEqual(50);
  });

  it("probes every ops-internal route (a new guarded route must be added to OPS_ROUTES)", async () => {
    const { routes, unimportable } = await collectGuardedRoutes();

    expect(
      unimportable,
      `these controllers could not be imported, so their guards are UNVERIFIED:\n  ${unimportable.join("\n  ")}`,
    ).toEqual([]);

    // Imported for its exported list only — prod-canary.mjs runs main() solely on direct
    // execution, so this import performs no network calls.
    const { OPS_ROUTES } = (await import(pathToFileURL(CANARY).href)) as {
      OPS_ROUTES: Array<[string, string, unknown?]>;
    };
    const probed = new Set(OPS_ROUTES.map(([m, p]) => `${m} ${normalize(p)}`));

    const unprobed = routes
      .filter((r) => !probed.has(r.key))
      .map((r) => `${r.key}   (${r.file} :: ${r.fn})`)
      .sort();

    expect(
      unprobed,
      `${unprobed.length} route(s) sit behind InternalServiceGuard but the production canary ` +
        `never probes them, so it would report PASS while they are open:\n  ${unprobed.join("\n  ")}\n\n` +
        `Add each to OPS_ROUTES in scripts/prod-canary.mjs (path params use the ABSENT_ID uuid, ` +
        `write bodies stay deliberately invalid).`,
    ).toEqual([]);

    // Guard against the list being trivially satisfied by an empty discovery pass — if the
    // metadata walk ever stops finding routes, the assertion above would vacuously succeed.
    expect(routes.length).toBeGreaterThanOrEqual(40);
  });

  it("does not probe routes that no longer exist (the list stays honest in both directions)", async () => {
    const { routes } = await collectGuardedRoutes();
    const live = new Set(routes.map((r) => r.key));
    const { OPS_ROUTES } = (await import(pathToFileURL(CANARY).href)) as {
      OPS_ROUTES: Array<[string, string, unknown?]>;
    };

    const stale = OPS_ROUTES.map(([m, p]) => `${m} ${normalize(p)}`)
      .filter((k) => !live.has(k))
      .sort();

    expect(
      stale,
      `the canary probes route(s) that are no longer behind InternalServiceGuard:\n  ${stale.join("\n  ")}\n` +
        `Either the route moved to a different guard (update OPS_ROUTES) or it lost its guard ` +
        `entirely, which is a security regression.`,
    ).toEqual([]);
  });
});
