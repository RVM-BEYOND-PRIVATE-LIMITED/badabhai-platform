import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_CAPABILITIES, type AdminCapability } from "../lib/auth/capabilities";

/**
 * Page gate ↔ data gate consistency (#1900).
 *
 * Every admin page gates itself with `requireCapability(…)` / `requireCapabilities([…])`, and
 * every read it makes is gated again by the API's `@RequireAdminRole(…)`. When the two disagree
 * the page is reachable but one of its reads 403s, so a role missing that capability lands on an
 * ERROR state instead of a clean refusal. That is what the company/agency timeline (gated
 * `read_events`, reading the account on `read_entities`) and `/roles` (session-only, reading
 * `/admin/capabilities` on `read_entities`) both did.
 *
 * This file derives both sides from SOURCE, so neither can drift without failing CI:
 *
 *   - the API side from `apps/api/src/admin/*.controller.ts` — each GET route's
 *     `@RequireAdminRole("…")` — which is what the guards actually enforce;
 *   - the portal side from every `page.tsx` under `(portal)`, following its relative imports
 *     into the server components it renders, and mapping every `lib/` read it calls to the
 *     route that read requests.
 *
 * The rule: every capability a page's reads need is either one of the page's gates, or the file
 * making the read branches on it explicitly with `can(…, "<capability>")` — the "degrade the
 * extra read with a clean state" pattern the dashboard, `/system` and `/roles` use.
 *
 * Limits, stated so nobody over-reads a pass: the degrade check is FILE-wide (a `can(…)` anywhere
 * in the reading file counts, not only one wrapping the read), and reads made through a server
 * action (`"use server"`) are out of scope — those are user-triggered, not page renders. What the
 * parser cannot see fails loudly instead of passing: an API GET route with no capability outside
 * {@link SESSION_ONLY_ROUTES}, a lib `adminFetch` this file did not map, and a page read no API
 * route serves all fail below.
 *
 * This is a UX consistency check, not the security boundary: the API re-checks every request.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..");
const PORTAL = join(SRC, "app", "(portal)");
const API_ADMIN = resolve(SRC, "..", "..", "api", "src", "admin");

/** Drop comments so a gate or import named in prose is never read as code. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const read = (f: string) => strip(readFileSync(f, "utf8"));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

// ── the API side ────────────────────────────────────────────────────────────────────────────

/** GET routes that are authenticated but deliberately carry no capability (the session itself). */
const SESSION_ONLY_ROUTES = ["admin/me"];

interface ApiRoute {
  segments: string[];
  /** `null` = authenticated but not capability-gated (e.g. `GET /admin/me`). */
  capability: string | null;
}

function apiGetRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [];
  for (const file of readdirSync(API_ADMIN).filter((f) => f.endsWith(".controller.ts"))) {
    const src = read(join(API_ADMIN, file));
    const prefix = /@Controller\(\s*"([^"]*)"\s*\)/.exec(src)?.[1];
    if (prefix === undefined) continue;
    const verbs = [...src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g)];
    verbs.forEach((m, i) => {
      if (m[1] !== "Get") return;
      const until = verbs[i + 1]?.index ?? src.length;
      const window = src.slice(m.index, until);
      const capability = /@RequireAdminRole\(\s*"([a-z_]+)"\s*\)/.exec(window)?.[1] ?? null;
      const path = [prefix, m[2] ?? ""].join("/");
      routes.push({ segments: path.split("/").filter(Boolean), capability });
    });
  }
  return routes;
}

/**
 * The API route a request path hits. Scored per segment — literal = literal beats param = param,
 * which beats a param matched against a literal — so `/admin/events/:param` resolves to
 * `events/:id`, never to whichever of `events/metrics` / `events/export` is declared first.
 */
function routeFor(routes: ApiRoute[], path: string): ApiRoute | undefined {
  const segs = path.split("/").filter(Boolean);
  let best: { route: ApiRoute; score: number } | undefined;
  for (const route of routes) {
    if (route.segments.length !== segs.length) continue;
    let score = 0;
    const ok = route.segments.every((s, i) => {
      const apiParam = s.startsWith(":");
      const webParam = segs[i]!.startsWith(":");
      if (apiParam && webParam) score += 1;
      else if (!apiParam && !webParam) {
        if (s !== segs[i]) return false;
        score += 2;
      }
      return true;
    });
    if (ok && (!best || score > best.score)) best = { route, score };
  }
  return best?.route;
}

// ── the portal's reads ──────────────────────────────────────────────────────────────────────

/**
 * The request path of an `adminFetch` template: `${…}` right after a `/` is a path parameter,
 * any other `${…}` is a query-string suffix, and everything from a literal `?` on is query.
 */
function requestPath(template: string): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "$" && template[i + 1] === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < template.length; j++) {
        if (template[j] === "{") depth++;
        else if (template[j] === "}" && --depth === 0) break;
      }
      if (out.endsWith("/")) out += ":param";
      i = j;
      continue;
    }
    out += template[i];
  }
  return out.split("?")[0]!;
}

interface Read {
  path: string;
  /** `public: true` reads (e.g. `/health`) carry no admin token and need no capability. */
  public: boolean;
}

/** Every exported `lib/*.ts` function that calls `adminFetch`, with the request it makes. */
function libReads(): Map<string, Map<string, Read[]>> {
  const byModule = new Map<string, Map<string, Read[]>>();
  const libDir = join(SRC, "lib");
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const src = read(join(libDir, name));
    const fns = [...src.matchAll(/^export (?:async )?function (\w+)/gm)];
    const reads = new Map<string, Read[]>();
    fns.forEach((m, i) => {
      const body = src.slice(m.index, fns[i + 1]?.index ?? src.length);
      const calls = [...body.matchAll(/adminFetch(?:<[^>]*>)?\(\s*(`[^`]*`|"[^"]*")\s*(,[^)]*)?/g)];
      if (calls.length === 0) return;
      reads.set(
        m[1]!,
        calls.map((c) => ({
          path: requestPath(c[1]!.slice(1, -1)),
          public: /public:\s*true/.test(c[2] ?? ""),
        })),
      );
    });
    byModule.set(join(libDir, name.replace(/\.ts$/, "")), reads);
  }
  return byModule;
}

function resolveImport(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
    (p) => existsSync(p) && statSync(p).isFile(),
  );
}

interface Import {
  names: string[];
  spec: string;
}

function importsOf(src: string): Import[] {
  return [...src.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)]
    .filter((m) => !m[1])
    .map((m) => ({
      spec: m[3]!,
      names: (/\{([\s\S]*)\}/.exec(m[2]!)?.[1] ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith("type "))
        .map((n) => n.split(/\s+as\s+/)[0]!),
    }));
}

/** A server file that renders as part of a page (client components and actions cannot read). */
const isServerRender = (src: string) => !/^\s*["']use (client|server)["']/m.test(src);

interface PageAnalysis {
  gates: Set<string>;
  /** Each read: the request path, and the source file that made the call. */
  reads: { path: string; public: boolean; file: string }[];
  /** Files that call `adminFetch` directly — reads that bypass `lib/`, so this file cannot see them. */
  directFetches: string[];
}

function analysePage(pageFile: string, lib: Map<string, Map<string, Read[]>>): PageAnalysis {
  const out: PageAnalysis = { gates: new Set(), reads: [], directFetches: [] };
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    if (!isServerRender(src)) return;

    for (const m of src.matchAll(/requireCapability\(\s*"([a-z_]+)"\s*\)/g)) out.gates.add(m[1]!);
    for (const m of src.matchAll(/requireCapabilities\(\s*\[([^\]]*)\]/g)) {
      for (const c of m[1]!.matchAll(/"([a-z_]+)"/g)) out.gates.add(c[1]!);
    }
    if (/\badminFetch\(/.test(src)) out.directFetches.push(relative(SRC, file));

    for (const imp of importsOf(src)) {
      const target = resolveImport(file, imp.spec);
      if (!target) continue;
      const libModule = lib.get(target.replace(/\.tsx?$/, ""));
      if (libModule) {
        for (const name of imp.names) {
          for (const r of libModule.get(name) ?? []) {
            if (new RegExp(`\\b${name}\\(`).test(src)) out.reads.push({ ...r, file });
          }
        }
        continue;
      }
      // Follow components and route bodies, never back into lib/ (fetchers are mapped above).
      if (!target.startsWith(join(SRC, "lib"))) visit(target);
    }
  };
  visit(pageFile);
  return out;
}

// ── the rule ────────────────────────────────────────────────────────────────────────────────

const routes = apiGetRoutes();
const lib = libReads();
const pages = walk(PORTAL).filter((f) => f.endsWith("page.tsx"));

describe("the source this test derives from is where it expects", () => {
  it("finds the API's admin GET routes, each with a known capability", () => {
    expect(routes.length).toBeGreaterThan(20);
    for (const r of routes) {
      const path = r.segments.join("/");
      if (r.capability === null) {
        // A decorator above `@Get`, a class-level one, or a missing one all read as null here —
        // so null is allowed only where it is the design, never silently skipped.
        expect(SESSION_ONLY_ROUTES, `${path} has no @RequireAdminRole below its @Get`).toContain(
          path,
        );
      } else {
        expect(ADMIN_CAPABILITIES as readonly string[]).toContain(r.capability);
      }
    }
  });

  it("maps every adminFetch in lib/ — a fetcher it cannot parse fails here, not silently", () => {
    const mapped = [...lib.values()].reduce(
      (n, m) => n + [...m.values()].reduce((k, rs) => k + rs.length, 0),
      0,
    );
    const calls = walk(join(SRC, "lib"))
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.endsWith("admin-http.ts"))
      .filter((f) => !f.endsWith(join("auth", "session.ts"))) // `/admin/me`: the session read
      .reduce((n, f) => n + (read(f).match(/\badminFetch(?:<[^>]*>)?\(/g) ?? []).length, 0);
    expect(mapped).toBe(calls);
  });

  it("resolves a param path to the param route, not a literal sibling", () => {
    expect(routeFor(routes, "/admin/events/:param")?.segments.join("/")).toBe("admin/events/:id");
    expect(routeFor(routes, "/admin/events/metrics")?.capability).toBe("read_events");
    expect(routeFor(routes, "/admin/events/export")?.capability).toBe("export");
  });

  it("finds the portal's pages and the lib reads they make", () => {
    expect(pages.length).toBeGreaterThan(20);
    expect([...lib.values()].reduce((n, m) => n + m.size, 0)).toBeGreaterThan(20);
  });

  it("parses a request path the way adminFetch writes one", () => {
    expect(requestPath("/admin/workers${qs(f)}")).toBe("/admin/workers");
    expect(requestPath('/admin/payers/${encodeURIComponent(id)}${o ? "?faceless=1" : ""}')).toBe(
      "/admin/payers/:param",
    );
    expect(requestPath("/admin/entities/${type}/${encodeURIComponent(id)}/timeline${q}")).toBe(
      "/admin/entities/:param/:param/timeline",
    );
    expect(requestPath("/admin/skills?${params.toString()}")).toBe("/admin/skills");
  });
});

describe("every lib read maps to an API route", () => {
  for (const [module, reads] of lib) {
    for (const [name, rs] of reads) {
      for (const r of rs.filter((x) => !x.public)) {
        it(`${relative(SRC, module)}.${name} → ${r.path}`, () => {
          expect(routeFor(routes, r.path), `no API GET route serves ${r.path}`).toBeDefined();
        });
      }
    }
  }
});

describe("every page is gated on every capability its reads need (or degrades the read)", () => {
  for (const page of pages) {
    const name = "/" + relative(PORTAL, dirname(page)).split("\\").join("/");
    it(name === "/" ? "/ (dashboard)" : name, () => {
      const a = analysePage(page, lib);
      expect(a.directFetches, "reads must go through lib/ so this test can see them").toEqual([]);
      for (const r of a.reads.filter((x) => !x.public)) {
        const route = routeFor(routes, r.path);
        expect(route, `${name} reads ${r.path}, which no API GET route serves`).toBeDefined();
        const cap = route!.capability as AdminCapability | null;
        if (cap === null || a.gates.has(cap)) continue;
        const degraded = new RegExp(`\\bcan\\([^)]*"${cap}"\\s*\\)`).test(read(r.file));
        expect(
          degraded,
          `${name} reads ${r.path} (API gate: ${cap}) from ${relative(SRC, r.file)} but is ` +
            `gated on [${[...a.gates].join(", ") || "session only"}] and never checks ` +
            `can(…, "${cap}") — a role without ${cap} would get an error state, not a refusal`,
        ).toBe(true);
      }
    });
  }
});

describe("the two pages #1900 found", () => {
  it("the company and agency timelines gate on BOTH reads", () => {
    for (const kind of ["companies", "agencies"]) {
      const a = analysePage(join(PORTAL, kind, "[id]", "timeline", "page.tsx"), lib);
      expect([...a.gates].sort()).toEqual(["read_entities", "read_events"]);
    }
  });

  it("/roles degrades the matrix read explicitly rather than gating the page", () => {
    const a = analysePage(join(PORTAL, "roles", "page.tsx"), lib);
    expect(a.gates.size).toBe(0);
    expect(a.reads.map((r) => r.path)).toEqual(["/admin/capabilities"]);
  });
});
