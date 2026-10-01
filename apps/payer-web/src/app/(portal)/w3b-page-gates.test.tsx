import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { PayerSession } from "../../lib/auth/types";
import type { Capacity } from "../../lib/contracts";

/**
 * W3-B — the six polished screens (/postings, /plans, /capacity, /account, /team, /team/accept)
 * keep their SERVER invariants through the re-layout:
 *   · `dynamic = "force-dynamic"` on every page;
 *   · the role gate runs FIRST — when it rejects (redirect / neutral 404) no data seam is read;
 *     /team is gated by `requireOwner` (Owner-only), not merely a signed-in payer;
 *   · every return branch is wrapped in its page's namespacing class and nothing else (the
 *     W3-B CSS block is scoped to these wrappers — see w3b-page-polish.css.test.ts);
 *   · the per-posting tables on /plans + /capacity are focusable scroll regions NAMED BY their
 *     panel heading (aria-labelledby → the heading's id, not a copied aria-label string);
 *   · /plans: every credit pack's action is a LINK to /credits (the purchase happens there),
 *     never an in-card button — and only for an OWNER (/credits is Owner-only);
 *   · /postings for an AGENT: redirected to their own Postings, unless they own older company
 *     postings, which are shown READ-ONLY (no create action).
 * Env is node: each async Server Component is awaited to an element tree and walked. The
 * client children are stubbed — they are unit-tested in their own suites.
 */

const EMPLOYER: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools",
  role: "employer",
  status: "active",
  email: "ops@acme.example",
  phoneLast4: "1234",
};
const AGENCY: PayerSession = { ...EMPLOYER, role: "agent" };

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const requireOwner = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn<(s: unknown) => "owner" | "recruiter">();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
const getPostings = vi.fn();
const getCapacity = vi.fn<() => Promise<Capacity>>();
const getAgencyKyc = vi.fn();
const getLiveCatalog = vi.fn();
const listOrgMembers = vi.fn();

vi.mock("../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../lib/auth/org-roles", () => ({
  requireOwner: () => requireOwner(),
  getOrgRole: (s: unknown) => getOrgRole(s),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("../../lib/payer-api", () => ({
  getPostings: () => getPostings(),
  getCapacity: () => getCapacity(),
  getAgencyKyc: () => getAgencyKyc(),
}));
vi.mock("../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
vi.mock("../../lib/org-members", () => ({ listOrgMembers: () => listOrgMembers() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// Client children → inert stubs (their own suites cover them).
vi.mock("../../components/retry-button", () => ({ RetryButton: () => null }));
vi.mock("./postings/postings-manager", () => ({ PostingsManager: () => null }));
vi.mock("./capacity/capacity-panel", () => ({ CapacityPanel: () => null }));
vi.mock("./account/account-form", () => ({ AccountForm: () => null }));
vi.mock("./team/team-manager", () => ({ TeamManager: () => null }));
vi.mock("./team/accept/accept-invite", () => ({ AcceptInvite: () => null }));

const postings = await import("./postings/page");
const plans = await import("./plans/page");
const capacityPage = await import("./capacity/page");
const account = await import("./account/page");
const team = await import("./team/page");
const accept = await import("./team/accept/page");

const withToken = () => ({ searchParams: Promise.resolve({ token: "tok" }) });

/** Every element whose className carries `cls`, depth-first (the tree is NOT expanded). */
function byClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const c of node) byClass(c, cls, acc);
    return acc;
  }
  const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
  const cn = el.props?.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
  if (el.props && "children" in el.props) byClass(el.props.children, cls, acc);
  return acc;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

const props = (el: ReactElement) => el.props as Record<string, unknown>;

function cap(over: Partial<Capacity> = {}): Capacity {
  return {
    payerId: EMPLOYER.payerId,
    activeVacancies: 1,
    activeVacancyAllowance: 3,
    applicantQuotaTotal: 20,
    applicantQuotaUsed: 4,
    postings: [
      {
        postingId: "bbbb2222-0000-4000-8000-000000000001",
        roleTitle: "CNC Machinist",
        status: "open",
        vacancyBand: "6-20",
        applicantsUsed: 2,
        applicantQuota: 10,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  for (const f of [
    requirePayer,
    requireOwner,
    getOrgRole,
    redirect,
    getPostings,
    getCapacity,
    getAgencyKyc,
    getLiveCatalog,
    listOrgMembers,
  ]) {
    f.mockReset();
  }
  requirePayer.mockResolvedValue(EMPLOYER);
  requireOwner.mockResolvedValue(EMPLOYER);
  getOrgRole.mockReturnValue("owner");
  redirect.mockImplementation((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  });
  getPostings.mockResolvedValue([]);
  getCapacity.mockResolvedValue(cap());
  getAgencyKyc.mockResolvedValue(null);
  getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
  listOrgMembers.mockResolvedValue([]);
});

const PAGES = [
  { name: "/postings", mod: postings, wrapper: "postings-page", run: () => postings.default() },
  { name: "/plans", mod: plans, wrapper: "plans-page", run: () => plans.default() },
  {
    name: "/capacity",
    mod: capacityPage,
    wrapper: "capacity-page",
    run: () => capacityPage.default(),
  },
  { name: "/account", mod: account, wrapper: "account-page", run: () => account.default() },
  { name: "/team", mod: team, wrapper: "team-page", run: () => team.default() },
  {
    name: "/team/accept",
    mod: accept,
    wrapper: "team-accept-page",
    run: () => accept.default(withToken()),
  },
] as const;

describe("W3-B · every screen stays force-dynamic and namespaced", () => {
  for (const p of PAGES) {
    it(`${p.name} exports dynamic = "force-dynamic"`, () => {
      expect(p.mod.dynamic).toBe("force-dynamic");
    });

    it(`${p.name} renders inside exactly its namespacing wrapper`, async () => {
      const root = (await p.run()) as ReactElement;
      expect(root.type).toBe("div");
      expect(props(root).className).toBe(p.wrapper);
    });
  }

  it("/account's missing-email retry branch is namespaced too", async () => {
    requirePayer.mockResolvedValue({ ...EMPLOYER, email: undefined });
    const root = (await account.default()) as ReactElement;
    expect(props(root).className).toBe("account-page");
    expect(byClass(root, "state--error")).toHaveLength(1);
  });
});

describe("W3-B · the role gate runs before any read", () => {
  const redirect = () => new Error("NEXT_REDIRECT");

  it("/postings: no catalog or postings read when requirePayer rejects", async () => {
    requirePayer.mockRejectedValue(redirect());
    await expect(postings.default()).rejects.toThrow("NEXT_REDIRECT");
    expect(getLiveCatalog).not.toHaveBeenCalled();
    expect(getPostings).not.toHaveBeenCalled();
  });

  it("/plans: no catalog or capacity read when requirePayer rejects", async () => {
    requirePayer.mockRejectedValue(redirect());
    await expect(plans.default()).rejects.toThrow("NEXT_REDIRECT");
    expect(getLiveCatalog).not.toHaveBeenCalled();
    expect(getCapacity).not.toHaveBeenCalled();
  });

  it("/capacity: no catalog or capacity read when requirePayer rejects", async () => {
    requirePayer.mockRejectedValue(redirect());
    await expect(capacityPage.default()).rejects.toThrow("NEXT_REDIRECT");
    expect(getLiveCatalog).not.toHaveBeenCalled();
    expect(getCapacity).not.toHaveBeenCalled();
  });

  it("/account: no KYC read when requirePayer rejects", async () => {
    requirePayer.mockResolvedValue(AGENCY);
    requirePayer.mockRejectedValueOnce(redirect());
    await expect(account.default()).rejects.toThrow("NEXT_REDIRECT");
    expect(getAgencyKyc).not.toHaveBeenCalled();
  });

  it("/team is OWNER-only: a signed-in non-owner (requireOwner → neutral 404) reads no members", async () => {
    requirePayer.mockResolvedValue(EMPLOYER); // a valid payer session is NOT enough
    requireOwner.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(team.default()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listOrgMembers).not.toHaveBeenCalled();
  });

  it("/team/accept is NOT owner-gated (any signed-in payer), but it IS payer-gated", async () => {
    requireOwner.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(accept.default(withToken())).resolves.toBeTruthy();
    requirePayer.mockRejectedValue(redirect());
    await expect(accept.default(withToken())).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("W3-B · per-posting tables are labelled, keyboard-scrollable regions", () => {
  const cases = [
    { name: "/plans", run: () => plans.default() },
    { name: "/capacity", run: () => capacityPage.default() },
  ];
  for (const c of cases) {
    for (const session of [EMPLOYER, AGENCY]) {
      it(`${c.name} (${session.role}): tabIndex 0 + region, NAMED BY its panel heading (referenced)`, async () => {
        requirePayer.mockResolvedValue(session);
        const tree = (await c.run()) as ReactElement;
        const wraps = byClass(tree, "tablewrap");
        expect(wraps).toHaveLength(1);
        const wrap = props(wraps[0]!);
        expect(wrap).toMatchObject({ tabIndex: 0, role: "region" });
        // The name is the heading's own text, referenced — not a second hand-kept copy of it.
        expect(wrap["aria-label"]).toBeUndefined();
        const panel = byClass(tree, "panel--table");
        expect(panel).toHaveLength(1);
        const heading = byClass(panel[0]!, "panel__title");
        expect(heading).toHaveLength(1);
        const id = props(heading[0]!).id;
        expect(typeof id === "string" && id.length > 0).toBe(true);
        expect(wrap["aria-labelledby"]).toBe(id);
        // One word for the entity, both personas (owner ruling 2026-10-01).
        expect(textOf(heading[0]!)).toContain("posting");
        expect(textOf(heading[0]!)).not.toMatch(/vacanc/i);
      });
    }
  }

  it("the tile rows opt into the compact phone variant of the shared stat row", async () => {
    for (const run of [() => plans.default(), () => capacityPage.default()]) {
      const rows = byClass((await run()) as ReactElement, "stat-row");
      expect(rows).toHaveLength(1);
      expect(props(rows[0]!).className).toBe("stat-row stat-row--kpi");
    }
  });
});

describe("W3-B · /plans — credits are bought on /credits", () => {
  const creditPacks = (tree: ReactElement) =>
    byClass(tree, "plan-card").filter((c) => /\bcredits\b/.test(textOf(c)) && !/Valid for/.test(textOf(c)));

  it("OWNER: every credit pack's one action is a link to /credits", async () => {
    const tree = (await plans.default()) as ReactElement;
    const packs = creditPacks(tree);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const links = byClass(pack, "bb-btn");
      expect(links).toHaveLength(1);
      expect(props(links[0]!).href).toBe("/credits");
      expect(textOf(links[0]!)).toContain("Buy credits");
    }
  });

  it("RECRUITER: no pack links to /credits (it is Owner-only — a 404 for them)", async () => {
    getOrgRole.mockReturnValue("recruiter");
    const tree = (await plans.default()) as ReactElement;
    const packs = creditPacks(tree);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) expect(byClass(pack, "bb-btn")).toEqual([]);
    expect(textOf(tree)).toContain("An account owner buys credits");
  });
});

describe("/plans + /capacity — an agency is never linked into the company posting surface", () => {
  /** Every href in the tree, expanding nothing (the pages' own links). */
  function hrefs(node: ReactNode, acc: string[] = []): string[] {
    if (node === null || node === undefined || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      for (const c of node) hrefs(c, acc);
      return acc;
    }
    const el = node as ReactElement<{ href?: unknown; children?: ReactNode }>;
    if (typeof el.props?.href === "string") acc.push(el.props.href);
    if (el.props && "children" in el.props) hrefs(el.props.children, acc);
    return acc;
  }

  for (const [name, run] of [
    ["/plans", () => plans.default()],
    ["/capacity", () => capacityPage.default()],
  ] as const) {
    it(`${name} (agent): no /postings link; New posting opens the agency form`, async () => {
      requirePayer.mockResolvedValue(AGENCY);
      const tree = (await run()) as ReactElement;
      expect(hrefs(tree).filter((h) => h.startsWith("/postings"))).toEqual([]);
      getCapacity.mockResolvedValue(cap({ postings: [] }));
      const empty = (await run()) as ReactElement;
      expect(hrefs(empty)).toContain("/agency/jobs/new");
      expect(hrefs(empty).filter((h) => h.startsWith("/postings"))).toEqual([]);
    });

    it(`${name} (company): the role links still open the posting's applicants`, async () => {
      const tree = (await run()) as ReactElement;
      expect(hrefs(tree)).toContain("/postings/bbbb2222-0000-4000-8000-000000000001/applicants");
    });
  }
});

describe("/postings for an AGENT — their own Postings, or their older ones read-only", () => {
  it("an agent with no company postings is redirected to /agency/jobs", async () => {
    requirePayer.mockResolvedValue(AGENCY);
    getPostings.mockResolvedValue([]);
    await expect(postings.default()).rejects.toThrow("NEXT_REDIRECT /agency/jobs");
    expect(redirect).toHaveBeenCalledWith("/agency/jobs");
  });

  it("an agent who OWNS older company postings sees them read-only — never a 404, no create", async () => {
    requirePayer.mockResolvedValue(AGENCY);
    getPostings.mockResolvedValue([
      {
        id: "bbbb2222-0000-4000-8000-000000000001",
        roleTitle: "CNC Machinist",
        locationLabel: null,
        vacancyBand: "1",
        status: "open",
        applicantCount: 0,
        applicantQuota: 10,
        createdAt: "2026-06-22T00:00:00.000Z",
      },
    ]);
    const root = (await postings.default()) as ReactElement;
    expect(redirect).not.toHaveBeenCalled();
    expect(props(root).className).toBe("postings-page");
    const kids = (props(root).children as ReactNode[]).flat() as ReactElement[];
    const head = kids.find((k) => k && typeof k === "object" && "title" in (k.props as object))!;
    expect(props(head).title).toBe("Older postings");
    expect(props(head).primaryAction).toBeUndefined();
    const manager = kids.find(
      (k) => k && typeof k === "object" && (k.props as { readOnly?: unknown }).readOnly !== undefined,
    )!;
    expect(props(manager).readOnly).toBe(true);
  });

  it("a company is never redirected and keeps its New posting action", async () => {
    getPostings.mockResolvedValue([]);
    const root = (await postings.default()) as ReactElement;
    expect(redirect).not.toHaveBeenCalled();
    const kids = (props(root).children as ReactNode[]).flat() as ReactElement[];
    const head = kids.find((k) => k && typeof k === "object" && "title" in (k.props as object))!;
    expect(props(head).title).toBe("Postings");
    expect(props(head).primaryAction).toMatchObject({ href: "/postings/new", label: "New posting" });
  });
});
