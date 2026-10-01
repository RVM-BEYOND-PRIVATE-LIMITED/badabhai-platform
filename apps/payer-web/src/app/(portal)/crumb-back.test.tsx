import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { PayerSession } from "../../lib/auth/types";
import type * as ConfigModule from "../../lib/config";
import type * as OrgMembersModule from "../../lib/org-members";

/**
 * ONE DOOR PER DESTINATION, across the shell and the page (header model 2026-10-01, D5).
 *
 * A child page's back link (`.page-back`, PageHeader) and the shell header's section trail
 * (`.pcrumb`, PortalBreadcrumb) used to open the SAME page side by side: /postings/<id> offered
 * "‹ Postings" twice, one above the other. The trail now names the immediate parent as TEXT on a
 * page whose back link goes there, and keeps it a LINK only where the back link goes somewhere
 * nearer (a posting's applicants → the posting; the trail → Postings).
 *
 * This renders the REAL portal layout (rail, header, trail, balance chip) around the REAL page,
 * for every portal route and both personas, to static HTML — and checks, on the markup a payer
 * gets, that no href is both a trail link and the page's back link. It also pins the trail's
 * landmark rule (a `<nav>` only when it holds a link) and that the scan is not vacuous: the
 * table covers every portal page, real back links are found, and real trail links are found.
 *
 * Seams (session, API reads, catalog) are mocked with live-shaped data; reads a route does not
 * need fail, as they can in production, and the page renders its degraded state (whose head is
 * the same PageHeader). A few heavy children unrelated to the head are inert stubs.
 */

const here = dirname(fileURLToPath(import.meta.url));

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({
      children,
      href,
      prefetch: _prefetch,
      ...rest
    }: {
      children?: ReactNode;
      href: string;
      prefetch?: unknown;
    }) => React.createElement("a", { href, ...rest }, children),
  };
});

const COMPANY: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools",
  role: "employer",
  status: "active",
  email: "ops@acme.example",
  phoneLast4: "1234",
};
const AGENCY: PayerSession = { ...COMPANY, displayLabel: "Acme Staffing", role: "agent" };
let session: PayerSession = COMPANY;

vi.mock("../../lib/auth", () => ({ requirePayer: async () => session }));
vi.mock("../../lib/auth/roles", () => ({
  requireAgent: async () => {
    if (session.role !== "agent") throw new Error("NEXT_NOT_FOUND");
    return session;
  },
  requireEmployer: async () => {
    if (session.role !== "employer") throw new Error("NEXT_NOT_FOUND");
    return session;
  },
}));
vi.mock("../../lib/auth/org-roles", () => ({
  getOrgRole: () => "owner",
  requireOwner: async () => session,
  requireRecruiter: async () => session,
}));
vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, agencyFlags: () => ({ ...actual.agencyFlags(), agencyPortalEnabled: true }) };
});
vi.mock("../../lib/live-catalog", () => ({
  getLiveCatalog: async () => ({ products: DEFAULT_CATALOG.products, live: true }),
}));
vi.mock("../../lib/org-members", async (importOriginal) => {
  const actual = await importOriginal<typeof OrgMembersModule>();
  return { ...actual, listOrgMembers: async () => [] };
});

/** The API reads, by seam name; any read not listed here fails (the page degrades). */
const SEAMS: Record<string, (...args: unknown[]) => unknown> = {};
vi.mock("../../lib/payer-api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== "function" || value.constructor.name !== "AsyncFunction") continue;
    out[name] = (...args: unknown[]) =>
      SEAMS[name] ? SEAMS[name]!(...args) : Promise.reject(new Error(`read failed: ${name}`));
  }
  return out;
});

// Heavy children unrelated to the head (a full card renderer, two posting forms), and the
// agency dashboard's modules — an async server component, which the static renderer cannot
// await (its own suite renders it).
vi.mock("../../components/job-card-preview", () => ({ JobCardPreview: () => null }));
vi.mock("./dashboard/agent-sections", () => ({ AgentSections: () => null }));
vi.mock("./postings/[id]/edit/edit-posting-form", () => ({ EditPostingForm: () => null }));
vi.mock("./postings/new/posting-form", () => ({ PostingForm: () => null }));

const { default: PortalLayout } = await import("./layout");

const POSTING = "33333333-3333-4333-8333-333333333333";
const JOB = "00000001-0000-4000-8000-000000000001";
const SUMMARY = {
  id: POSTING,
  roleTitle: "CNC Turner",
  locationLabel: "Pune",
  vacancyBand: "2-5",
  status: "open",
  applicantCount: 1,
  applicantQuota: 10,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const AGENCY_JOB = {
  id: JOB,
  status: "open",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: null,
  payMin: 20000,
  payMax: 35000,
  minExperienceYears: 1,
  maxExperienceYears: 5,
  neededBy: "soon",
  applicantsReceived: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  for (const k of Object.keys(SEAMS)) delete SEAMS[k];
  Object.assign(SEAMS, {
    getCredits: async () => ({ payerId: COMPANY.payerId, balance: 1234 }),
    getDashboard: async () => ({
      credits: { payerId: COMPANY.payerId, balance: 1234 },
      unlocks: [],
      postings: [SUMMARY],
    }),
    getPostings: async () => [SUMMARY],
    getPostingDetail: async (id: unknown) =>
      id === POSTING
        ? {
            summary: SUMMARY,
            card: {},
            description: null,
            skills: [],
            matchSkillIds: [],
            untickedRelatedIds: [],
          }
        : null,
    listMatchSkills: async () => [],
    getApplicantFeed: async () => ({
      postingId: POSTING,
      roleTitle: "Applicants",
      applicants: [
        {
          workerId: "a1b2c3d4-0000-4000-8000-000000000001",
          rank: 1,
          score: 0.9,
          hot: false,
          signals: [],
          tradeLabel: "CNC Turner",
          experienceBand: "6-10 yrs",
          cityLabel: "Pune",
        },
      ],
    }),
    getCapacity: async () => ({
      payerId: COMPANY.payerId,
      activeVacancies: 1,
      activeVacancyAllowance: 3,
      applicantQuotaTotal: 10,
      applicantQuotaUsed: 1,
      postings: [],
    }),
    getCreditTopUps: async () => [],
    getJobPostingChatSessions: async () => [],
    listAgencyJobs: async () => [AGENCY_JOB],
    getAgencyJob: async (id: unknown) => (id === JOB ? AGENCY_JOB : null),
    getAgencyKyc: async () => null,
  });
});

type Persona = "company" | "agency";
interface Route {
  persona: Persona;
  /** The URL the payer is on. */
  path: string;
  /** The page file under (portal)/ (the coverage check matches on it). */
  file: string;
  load: () => Promise<{ default: (props: never) => unknown }>;
  props?: unknown;
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

/** Every portal page, for each persona that can open it. */
const ROUTES: Route[] = [
  // ── a company ──
  { persona: "company", path: "/dashboard", file: "dashboard/page.tsx", load: () => import("./dashboard/page") },
  { persona: "company", path: "/postings", file: "postings/page.tsx", load: () => import("./postings/page") },
  { persona: "company", path: "/postings/new", file: "postings/new/page.tsx", load: () => import("./postings/new/page") },
  { persona: "company", path: "/postings/ai/new", file: "postings/ai/new/page.tsx", load: () => import("./postings/ai/new/page") },
  { persona: "company", path: `/postings/${POSTING}`, file: "postings/[id]/page.tsx", load: () => import("./postings/[id]/page"), props: params({ id: POSTING }) },
  { persona: "company", path: `/postings/${POSTING}/edit`, file: "postings/[id]/edit/page.tsx", load: () => import("./postings/[id]/edit/page"), props: params({ id: POSTING }) },
  { persona: "company", path: `/postings/${POSTING}/applicants`, file: "postings/[id]/applicants/page.tsx", load: () => import("./postings/[id]/applicants/page"), props: params({ id: POSTING }) },
  { persona: "company", path: "/plans", file: "plans/page.tsx", load: () => import("./plans/page") },
  { persona: "company", path: "/credits", file: "credits/page.tsx", load: () => import("./credits/page") },
  { persona: "company", path: "/account", file: "account/page.tsx", load: () => import("./account/page") },
  { persona: "company", path: "/team", file: "team/page.tsx", load: () => import("./team/page") },
  { persona: "company", path: "/team/accept", file: "team/accept/page.tsx", load: () => import("./team/accept/page"), props: { searchParams: Promise.resolve({ token: "tok" }) } },
  // ── an agency ──
  { persona: "agency", path: "/dashboard", file: "dashboard/page.tsx", load: () => import("./dashboard/page") },
  { persona: "agency", path: "/agency/jobs", file: "agency/jobs/page.tsx", load: () => import("./agency/jobs/page") },
  { persona: "agency", path: "/agency/jobs/new", file: "agency/jobs/new/page.tsx", load: () => import("./agency/jobs/new/page") },
  { persona: "agency", path: `/agency/jobs/${JOB}`, file: "agency/jobs/[jobId]/page.tsx", load: () => import("./agency/jobs/[jobId]/page"), props: params({ jobId: JOB }) },
  { persona: "agency", path: "/agency/workers", file: "agency/workers/page.tsx", load: () => import("./agency/workers/page") },
  { persona: "agency", path: "/agency/referrals", file: "agency/referrals/page.tsx", load: () => import("./agency/referrals/page") },
  { persona: "agency", path: "/agency/qr", file: "agency/qr/page.tsx", load: () => import("./agency/qr/page") },
  { persona: "agency", path: "/agency/revenue", file: "agency/revenue/page.tsx", load: () => import("./agency/revenue/page") },
  { persona: "agency", path: "/agency/bulk-upload", file: "agency/bulk-upload/page.tsx", load: () => import("./agency/bulk-upload/page") },
  // An agency's OLDER company postings: view-only, by direct link.
  { persona: "agency", path: "/postings", file: "postings/page.tsx", load: () => import("./postings/page") },
  { persona: "agency", path: `/postings/${POSTING}`, file: "postings/[id]/page.tsx", load: () => import("./postings/[id]/page"), props: params({ id: POSTING }) },
  { persona: "agency", path: "/credits", file: "credits/page.tsx", load: () => import("./credits/page") },
  { persona: "agency", path: "/account", file: "account/page.tsx", load: () => import("./account/page") },
  { persona: "agency", path: "/team", file: "team/page.tsx", load: () => import("./team/page") },
];
/** Pages that render nothing of their own (a server redirect) — no head, no trail to compare. */
const REDIRECT_ONLY = new Set(["profile/page.tsx", "agency/dashboard/page.tsx", "capacity/page.tsx"]);

interface Rendered {
  route: Route;
  html: string;
  back: string | null;
  crumbLinks: string[];
  crumbIsLandmark: boolean;
}

/** Render the shell around the page, as the payer gets it. */
async function renderRoute(route: Route): Promise<Rendered> {
  session = route.persona === "agency" ? AGENCY : COMPANY;
  pathname = route.path;
  const mod = await route.load();
  const page = (await mod.default((route.props ?? {}) as never)) as ReactNode;
  const html = renderToStaticMarkup((await PortalLayout({ children: page })) as ReactElement);
  const crumb = /<(nav|div) class="pcrumb"[^>]*>([\s\S]*?)<\/\1>/.exec(html);
  return {
    route,
    html,
    back: /<p class="page-back"><a href="([^"]*)"/.exec(html)?.[1] ?? null,
    crumbLinks: crumb ? Array.from(crumb[2]!.matchAll(/<a href="([^"]*)"/g), (m) => m[1]!) : [],
    crumbIsLandmark: crumb?.[1] === "nav",
  };
}

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return pageFiles(full);
    return e.name === "page.tsx" ? [full.slice(here.length + 1).split("\\").join("/")] : [];
  });
}

describe("the shell's trail and the page's back link never open the same page (every route)", () => {
  it("the table covers every portal page (a new page must be added here)", () => {
    const covered = new Set([...ROUTES.map((r) => r.file), ...REDIRECT_ONLY]);
    expect(pageFiles(here).filter((f) => !covered.has(f))).toEqual([]);
  });

  it.each(ROUTES.map((r) => [`${r.persona} ${r.path}`, r] as const))(
    "%s: no href is both a trail link and the back link; the trail is a landmark only with a link",
    async (_name, route) => {
      const r = await renderRoute(route);
      // The shell and the page both rendered (the head is there; the rail is there).
      expect(r.html).toContain('class="page-head');
      expect(r.html).toContain('href="/dashboard"');
      if (r.back !== null) expect(r.crumbLinks, `back → ${r.back}`).not.toContain(r.back);
      expect(r.crumbIsLandmark).toBe(r.crumbLinks.length > 0);
    },
  );

  it("the scan is not vacuous: real back links, real trail links, and pages with BOTH", async () => {
    // One at a time: a render sets the session and the path the mocks read.
    const all: Rendered[] = [];
    for (const r of ROUTES) all.push(await renderRoute(r));
    const withBack = all.filter((r) => r.back !== null);
    const withCrumbLink = all.filter((r) => r.crumbLinks.length > 0);
    const both = withBack.filter((r) => r.crumbLinks.length > 0);
    expect(withBack.map((r) => `${r.route.persona} ${r.route.path}`).sort()).toEqual(
      [
        `agency /agency/bulk-upload`,
        `agency /agency/jobs/${JOB}`,
        `agency /postings/${POSTING}`,
        `company /postings/${POSTING}`,
        `company /postings/${POSTING}/applicants`,
        `company /postings/${POSTING}/edit`,
        `company /postings/ai/new`,
      ].sort(),
    );
    // A deeper page keeps BOTH doors, to DIFFERENT pages: the trail → Postings, the back link →
    // the posting.
    expect(both.map((r) => [r.route.path, r.crumbLinks, r.back])).toEqual([
      [`/postings/${POSTING}/edit`, ["/postings"], `/postings/${POSTING}`],
      [`/postings/${POSTING}/applicants`, ["/postings"], `/postings/${POSTING}`],
    ]);
    expect(withCrumbLink.length).toBeGreaterThanOrEqual(both.length);
  });

  it("one level below a destination, the trail names it as text (the back link is the way up)", async () => {
    for (const route of ROUTES.filter((r) =>
      [`/postings/${POSTING}`, `/agency/jobs/${JOB}`, "/postings/ai/new"].includes(r.path),
    )) {
      const r = await renderRoute(route);
      expect(r.crumbLinks, route.path).toEqual([]);
      expect(r.crumbIsLandmark, route.path).toBe(false);
      expect(r.back, route.path).not.toBeNull();
    }
  });
});
