import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { getRedirectStatus, modifyRouteRegex } from "next/dist/lib/redirect-status";
import nextConfig from "../../next.config.mjs";

/**
 * OLD ADDRESSES STILL OPEN (A6, #2576). Workers became Candidates, Agencies merged into Companies,
 * Agency match skills became a tab on the agency posting, and `/postings` is an alias for `/jobs`.
 * A bookmark, an incident-report link or a browser's history must land where it meant to.
 *
 * The config is CALLED, and each rule is resolved with Next's OWN matcher and destination
 * builder — the functions `router-utils/filesystem.js` and `resolve-routes.js` use for
 * `redirects()` — so `:path*` matching the bare section, the query passing through, and the
 * destination's own query merging in are Next's answers, not this file's guess. (Internal
 * modules: a Next upgrade that moves them fails this file loudly; re-point the imports.)
 */
interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
}

const config = nextConfig as { redirects: () => Promise<Redirect[]> };
const RULES = await config.redirects();

/** What Next answers for `url`: the FIRST matching rule's location and status, or null. */
function resolve(url: string): { location: string; status: number } | null {
  const parsed = new URL(url, "http://admin.test");
  const query: Record<string, string> = Object.fromEntries(parsed.searchParams);
  for (const rule of RULES) {
    const match = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex) => modifyRouteRegex(regex, ["/_next"]),
    });
    const params = match(parsed.pathname);
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query,
    });
    const search = new URLSearchParams(parsedDestination.query as Record<string, string>);
    const q = search.toString();
    return {
      location: `${parsedDestination.pathname}${q ? `?${q}` : ""}`,
      status: getRedirectStatus(rule),
    };
  }
  return null;
}

const ID = "5eeded00-0001-4a00-8000-000000000001";
const SESSION = "c0ffee00-0002-4b00-8000-000000000002";

describe("the redirect rules", () => {
  it("are the six A6 rules, in order", () => {
    expect(RULES.map((r) => `${r.source} → ${r.destination}`)).toEqual([
      "/workers/:path* → /candidates/:path*",
      "/agencies → /companies?kind=agency",
      "/agencies/:path+ → /companies/:path+",
      "/agency-jobs → /jobs/agency",
      "/agency-jobs/:jobId → /jobs/agency/:jobId/match-skills",
      "/postings/:path* → /jobs/:path*",
    ]);
  });

  it("retired names are permanent; the /postings alias is not", () => {
    for (const r of RULES) expect(r.permanent, r.source).toBe(!r.source.startsWith("/postings"));
  });
});

describe("Workers → Candidates: the whole tree, the query kept", () => {
  it.each([
    ["/workers", "/candidates"],
    ["/workers?status=active&cursor=c2", "/candidates?status=active&cursor=c2"],
    [`/workers/${ID}`, `/candidates/${ID}`],
    [`/workers/${ID}/timeline?cursor=c`, `/candidates/${ID}/timeline?cursor=c`],
    [`/workers/${ID}/journey`, `/candidates/${ID}/journey`],
    [`/workers/${ID}/journey/${SESSION}`, `/candidates/${ID}/journey/${SESSION}`],
  ])("%s → %s (308)", (from, to) => {
    expect(resolve(from)).toEqual({ location: to, status: 308 });
  });
});

describe("Agencies → Companies, with the Kind filter set", () => {
  it.each([
    ["/agencies", "/companies?kind=agency"],
    ["/agencies?status=suspended", "/companies?status=suspended&kind=agency"],
    ["/agencies?cursor=c2", "/companies?cursor=c2&kind=agency"],
    [`/agencies/${ID}`, `/companies/${ID}`],
    [`/agencies/${ID}/timeline?cursor=c`, `/companies/${ID}/timeline?cursor=c`],
  ])("%s → %s (308)", (from, to) => {
    expect(resolve(from)).toEqual({ location: to, status: 308 });
  });
});

describe("Agency match skills → the agency posting under Postings", () => {
  it.each([
    ["/agency-jobs", "/jobs/agency"],
    [`/agency-jobs/${ID}`, `/jobs/agency/${ID}/match-skills`],
  ])("%s → %s (308)", (from, to) => {
    expect(resolve(from)).toEqual({ location: to, status: 308 });
  });
});

describe("/postings is an alias for /jobs", () => {
  it.each([
    ["/postings", "/jobs"],
    [
      "/postings?status=open&verificationStatus=verified",
      "/jobs?status=open&verificationStatus=verified",
    ],
    [`/postings/${ID}`, `/jobs/${ID}`],
    [`/postings/${ID}/timeline`, `/jobs/${ID}/timeline`],
  ])("%s → %s (307)", (from, to) => {
    expect(resolve(from)).toEqual({ location: to, status: 307 });
  });
});

describe("nothing else moves", () => {
  it.each([
    "/",
    "/candidates",
    `/candidates/${ID}`,
    "/companies",
    "/companies?kind=agency",
    `/companies/${ID}`,
    "/jobs",
    "/jobs/agency",
    `/jobs/agency/${ID}`,
    `/jobs/agency/${ID}/match-skills`,
    "/workersx",
    "/agenciesx",
    "/agency-jobsx",
    "/postingsx",
    "/_next/static/chunks/main.js",
  ])("%s is served where it is", (url) => {
    expect(resolve(url)).toBeNull();
  });
});

/**
 * Every destination is a page in this app — read off the `(portal)` folder tree, where a
 * `[param]` folder matches any one segment — and is not itself redirected (no chains).
 */
describe("every redirect lands on a page", () => {
  const portal = join(dirname(fileURLToPath(import.meta.url)), "(portal)");

  function pageExists(pathname: string): boolean {
    let dir = portal;
    for (const segment of pathname.split("/").filter(Boolean)) {
      const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const next =
        entries.find((e) => e.name === segment) ?? entries.find((e) => /^\[[^\]]+\]$/.test(e.name));
      if (!next) return false;
      dir = join(dir, next.name);
    }
    return existsSync(join(dir, "page.tsx"));
  }

  it("reads the tree the way the router does", () => {
    expect(pageExists("/companies")).toBe(true);
    expect(pageExists(`/candidates/${ID}/journey/${SESSION}`)).toBe(true);
    expect(pageExists("/workers")).toBe(false);
    expect(pageExists("/agencies")).toBe(false);
  });

  it.each([
    "/workers",
    `/workers/${ID}/journey/${SESSION}`,
    "/agencies",
    `/agencies/${ID}/timeline`,
    "/agency-jobs",
    `/agency-jobs/${ID}`,
    "/postings",
    `/postings/${ID}/timeline`,
  ])("%s", (from) => {
    const to = resolve(from);
    expect(to, from).not.toBeNull();
    expect(pageExists(new URL(to!.location, "http://admin.test").pathname), to!.location).toBe(
      true,
    );
    expect(resolve(to!.location), `${to!.location} redirects again`).toBeNull();
  });
});
