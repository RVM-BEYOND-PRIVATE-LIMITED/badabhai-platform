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
// await (its own suite renders it). The posting forms render only their `lead`: the create /
// edit pages hand their head to the form column (#1887), so the head is the form's lead.
vi.mock("../../components/job-card-preview", () => ({ JobCardPreview: () => null }));
vi.mock("./dashboard/agent-sections", () => ({ AgentSections: () => null }));
vi.mock("./postings/[id]/edit/edit-posting-form", () => ({
  EditPostingForm: ({ lead }: { lead?: ReactNode }) => lead ?? null,
}));
vi.mock("./postings/new/posting-form", () => ({
  PostingForm: ({ lead }: { lead?: ReactNode }) => lead ?? null,
}));

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
            card: {
              role_kind: "cnc_turner",
              city: "Pune",
              area: "Chakan",
              pay_min: 18000,
              pay_max: 26000,
              pay_type: "in_hand",
              min_experience_years: 1,
              max_experience_years: 5,
              shift: "day",
              needed_by: "soon",
              requirements: [],
              benefits: [],
            },
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
type PageModule = { default: (props: never) => unknown };
interface Route {
  persona: Persona;
  /** The URL the payer is on. */
  path: string;
  /** The page file under (portal)/ (the coverage check matches on it). */
  file: string;
  mod: PageModule;
  props?: unknown;
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

// Every page module is imported ONCE, here at the top level — module loading is collection, not a
// test: imported inside the first test, a cold run spent its 5s timeout on the imports.
const PAGE = {
  dashboard: (await import("./dashboard/page")) as PageModule,
  postings: (await import("./postings/page")) as PageModule,
  postingsNew: (await import("./postings/new/page")) as PageModule,
  postingsAi: (await import("./postings/ai/new/page")) as PageModule,
  posting: (await import("./postings/[id]/page")) as PageModule,
  postingEdit: (await import("./postings/[id]/edit/page")) as PageModule,
  applicants: (await import("./postings/[id]/applicants/page")) as PageModule,
  plans: (await import("./plans/page")) as PageModule,
  credits: (await import("./credits/page")) as PageModule,
  account: (await import("./account/page")) as PageModule,
  team: (await import("./team/page")) as PageModule,
  teamAccept: (await import("./team/accept/page")) as PageModule,
  agencyJobs: (await import("./agency/jobs/page")) as PageModule,
  agencyJobsNew: (await import("./agency/jobs/new/page")) as PageModule,
  agencyJob: (await import("./agency/jobs/[jobId]/page")) as PageModule,
  agencyWorkers: (await import("./agency/workers/page")) as PageModule,
  agencyReferrals: (await import("./agency/referrals/page")) as PageModule,
  agencyQr: (await import("./agency/qr/page")) as PageModule,
  agencyRevenue: (await import("./agency/revenue/page")) as PageModule,
  agencyBulk: (await import("./agency/bulk-upload/page")) as PageModule,
};

/** Every portal page, for each persona that can open it. */
const ROUTES: Route[] = [
  // ── a company ──
  { persona: "company", path: "/dashboard", file: "dashboard/page.tsx", mod: PAGE.dashboard },
  { persona: "company", path: "/postings", file: "postings/page.tsx", mod: PAGE.postings },
  { persona: "company", path: "/postings/new", file: "postings/new/page.tsx", mod: PAGE.postingsNew },
  { persona: "company", path: "/postings/ai/new", file: "postings/ai/new/page.tsx", mod: PAGE.postingsAi },
  { persona: "company", path: `/postings/${POSTING}`, file: "postings/[id]/page.tsx", mod: PAGE.posting, props: params({ id: POSTING }) },
  { persona: "company", path: `/postings/${POSTING}/edit`, file: "postings/[id]/edit/page.tsx", mod: PAGE.postingEdit, props: params({ id: POSTING }) },
  { persona: "company", path: `/postings/${POSTING}/applicants`, file: "postings/[id]/applicants/page.tsx", mod: PAGE.applicants, props: params({ id: POSTING }) },
  { persona: "company", path: "/plans", file: "plans/page.tsx", mod: PAGE.plans },
  { persona: "company", path: "/credits", file: "credits/page.tsx", mod: PAGE.credits },
  { persona: "company", path: "/account", file: "account/page.tsx", mod: PAGE.account },
  { persona: "company", path: "/team", file: "team/page.tsx", mod: PAGE.team },
  { persona: "company", path: "/team/accept", file: "team/accept/page.tsx", mod: PAGE.teamAccept, props: { searchParams: Promise.resolve({ token: "tok" }) } },
  // ── an agency ──
  { persona: "agency", path: "/dashboard", file: "dashboard/page.tsx", mod: PAGE.dashboard },
  { persona: "agency", path: "/agency/jobs", file: "agency/jobs/page.tsx", mod: PAGE.agencyJobs },
  { persona: "agency", path: "/agency/jobs/new", file: "agency/jobs/new/page.tsx", mod: PAGE.agencyJobsNew },
  { persona: "agency", path: `/agency/jobs/${JOB}`, file: "agency/jobs/[jobId]/page.tsx", mod: PAGE.agencyJob, props: params({ jobId: JOB }) },
  { persona: "agency", path: "/agency/workers", file: "agency/workers/page.tsx", mod: PAGE.agencyWorkers },
  { persona: "agency", path: "/agency/referrals", file: "agency/referrals/page.tsx", mod: PAGE.agencyReferrals },
  { persona: "agency", path: "/agency/qr", file: "agency/qr/page.tsx", mod: PAGE.agencyQr },
  { persona: "agency", path: "/agency/revenue", file: "agency/revenue/page.tsx", mod: PAGE.agencyRevenue },
  { persona: "agency", path: "/agency/bulk-upload", file: "agency/bulk-upload/page.tsx", mod: PAGE.agencyBulk },
  // An agency's OLDER company postings: view-only, by direct link.
  { persona: "agency", path: "/postings", file: "postings/page.tsx", mod: PAGE.postings },
  { persona: "agency", path: `/postings/${POSTING}`, file: "postings/[id]/page.tsx", mod: PAGE.posting, props: params({ id: POSTING }) },
  { persona: "agency", path: "/credits", file: "credits/page.tsx", mod: PAGE.credits },
  { persona: "agency", path: "/account", file: "account/page.tsx", mod: PAGE.account },
  { persona: "agency", path: "/team", file: "team/page.tsx", mod: PAGE.team },
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
  const page = (await route.mod.default((route.props ?? {}) as never)) as ReactNode;
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

/* ------------------------------------------------------------------------------------------ *
 * When an error REPLACES a page, its back link goes with it — and on a page one level below a
 * destination the trail names that destination as text. The error boundary, rendered inside the
 * REAL shell (which hands it the nav sections), must offer the way back up instead.
 * ------------------------------------------------------------------------------------------ */
const { default: PortalError } = await import("./error");
const { navSections, navTrail } = await import("./nav-model");

describe("an error in place of a page still offers the way back up (every route)", () => {
  function renderError(route: Route) {
    session = route.persona === "agency" ? AGENCY : COMPANY;
    pathname = route.path;
    return PortalLayout({
      children: <PortalError error={new Error("boom")} reset={() => {}} />,
    }).then((tree) => renderToStaticMarkup(tree as ReactElement));
  }

  it.each(ROUTES.map((r) => [`${r.persona} ${r.path}`, r] as const))(
    "%s: the state links the section the path sits under (when below one) and the Dashboard",
    async (_name, route) => {
      const html = await renderError(route);
      const state = html.slice(html.indexOf('class="state state--error"'));
      const ways = Array.from(state.matchAll(/<a href="([^"]*)"/g), (m) => m[1]!);
      // The SAME nav model the shell rendered, for this persona (an owner, the portal on).
      const sections = navSections({
        isAgency: route.persona === "agency",
        isOwner: true,
        agencyPortalEnabled: true,
      });
      const trail = navTrail(sections, route.path);
      const expected = [
        ...(trail && trail.depth > 0 ? [trail.item.href] : []),
        ...(route.path === "/dashboard" ? [] : ["/dashboard"]),
      ];
      expect(ways).toEqual(expected);
    },
  );

  it("the scan is not vacuous: pages one level below a destination get their section", async () => {
    const posting = ROUTES.find((r) => r.persona === "company" && r.path === `/postings/${POSTING}`)!;
    const html = await renderError(posting);
    expect(html).toContain('<div class="pcrumb">'); // the trail names Postings as TEXT here…
    const state = html.slice(html.indexOf('class="state state--error"'));
    expect(state).toContain('<a href="/postings"'); // …so the error state links it.
  });
});
