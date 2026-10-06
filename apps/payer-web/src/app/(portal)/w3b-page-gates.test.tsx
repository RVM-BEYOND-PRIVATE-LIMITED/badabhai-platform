import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { PayerSession } from "../../lib/auth/types";
import type { Capacity } from "../../lib/contracts";

/**
 * W3-B — the polished screens (/postings, /plans, /account, /team, /team/accept) keep their
 * SERVER invariants through the re-layout (/capacity is now a redirect to /plans — its own test):
 *   · `dynamic = "force-dynamic"` on every page;
 *   · the role gate runs FIRST — when it rejects (redirect / neutral 404) no data seam is read;
 *     /team is gated by `requireOwner` (Owner-only), not merely a signed-in payer; /plans is a
 *     COMPANY page — an agent is sent to the dashboard before any read;
 *   · every return branch is wrapped in its page's namespacing class and nothing else (the
 *     W3-B CSS block is scoped to these wrappers — see w3b-page-polish.css.test.ts);
 *   · the per-posting table on /plans is a focusable scroll region NAMED BY its panel heading
 *     (aria-labelledby → the heading's id, not a copied aria-label string);
 *   · /plans: credits are bought on /credits, and the shell's balance chip is an owner's door
 *     there — so the page adds none of its own (F15; per-pack buttons were one door N times, and
 *     a section "Buy credits" beside the chip was two); the pack cards carry no action;
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

  it("/plans is a COMPANY page: an agent goes to the dashboard before any read", async () => {
    requirePayer.mockResolvedValue(AGENCY);
    await expect(plans.default()).rejects.toThrow("NEXT_REDIRECT /dashboard");
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

describe("W3-B · the per-posting table is a labelled, keyboard-scrollable region", () => {
  it("/plans: tabIndex 0 + region, NAMED BY its panel heading (referenced)", async () => {
    const tree = (await plans.default()) as ReactElement;
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
    // One word for the entity (owner ruling 2026-10-01).
    expect(textOf(heading[0]!)).toContain("posting");
    expect(textOf(heading[0]!)).not.toMatch(/vacanc/i);
  });

  it("the tile row opts into the compact phone variant of the shared stat row", async () => {
    const rows = byClass((await plans.default()) as ReactElement, "stat-row");
    expect(rows).toHaveLength(1);
    expect(props(rows[0]!).className).toBe("stat-row stat-row--kpi");
  });
});

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

describe("W3-B · /plans — credits are bought on /credits, through the shell's ONE door", () => {
  const creditPacks = (tree: ReactElement) =>
    byClass(tree, "plan-card").filter((c) => /\bcredits\b/.test(textOf(c)) && !/Valid for/.test(textOf(c)));

  it("OWNER: no in-page door to /credits (the header balance is it — F15); packs carry no action", async () => {
    const tree = (await plans.default()) as ReactElement;
    const packs = creditPacks(tree);
    expect(packs.length).toBeGreaterThan(1);
    for (const pack of packs) {
      expect(byClass(pack, "bb-btn")).toEqual([]);
      expect(hrefs(pack)).toEqual([]);
    }
    expect(hrefs(tree).filter((h) => h === "/credits")).toEqual([]);
    expect(byClass(tree, "bb-btn").filter((b) => props(b).href === "/credits")).toEqual([]);
    // …and the section says where buying happens instead.
    expect(textOf(tree)).toContain("your balance at the top of the page opens Credits");
  });

  it("RECRUITER: no link to /credits anywhere (it is Owner-only — a 404 for them)", async () => {
    getOrgRole.mockReturnValue("recruiter");
    const tree = (await plans.default()) as ReactElement;
    expect(creditPacks(tree).length).toBeGreaterThan(0);
    expect(hrefs(tree)).not.toContain("/credits");
    expect(textOf(tree)).toContain("Ask your account owner to buy credits");
  });
});

describe("/plans — one New posting, and the role links open the posting (F12)", () => {
  it("the page offers ONE 'New posting', to the company form", async () => {
    const tree = (await plans.default()) as ReactElement;
    const create = hrefs(tree).filter((h) => h === "/postings/new");
    expect(create).toHaveLength(1);
    getCapacity.mockResolvedValue(cap({ postings: [] }));
    // The empty per-posting table adds no second one.
    const empty = (await plans.default()) as ReactElement;
    expect(hrefs(empty).filter((h) => h === "/postings/new")).toHaveLength(1);
  });

  it("each role in the per-posting table opens that posting's details, never its applicants", async () => {
    const tree = (await plans.default()) as ReactElement;
    expect(hrefs(tree)).toContain("/postings/bbbb2222-0000-4000-8000-000000000001");
    expect(hrefs(tree).filter((h) => h.endsWith("/applicants"))).toEqual([]);
  });
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

/**
 * F30 (final sweep) — a 500 on the members read threw to the (portal) error boundary: "Something
 * went wrong", with the page head AND the invite form gone. The read is now caught in place.
 */
describe("/team — a failed members read stays on the page (F30)", () => {
  it("renders its head and the manager with NO members list (null), never throwing", async () => {
    listOrgMembers.mockRejectedValue(new Error("members 500"));
    const root = (await team.default()) as ReactElement;
    expect(props(root).className).toBe("team-page");
    const kids = (props(root).children as ReactNode[]).filter(
      (c): c is ReactElement => typeof c === "object" && c !== null,
    );
    expect(kids.map((k) => (k.type as { name?: string }).name)).toEqual([
      "PageHeader",
      "TeamManager",
    ]);
    expect(props(kids[0]!).title).toBe("Team");
    // null = "the read failed" (never [] — that would say the team is empty).
    expect(props(kids[1]!).members).toBeNull();
  });

  it("a successful read still hands the members through", async () => {
    listOrgMembers.mockResolvedValue([{ memberId: "m1" }]);
    const root = (await team.default()) as ReactElement;
    const manager = (props(root).children as ReactNode[]).find(
      (c): c is ReactElement =>
        typeof c === "object" && c !== null && "members" in (c as ReactElement<object>).props,
    )!;
    expect(props(manager).members).toEqual([{ memberId: "m1" }]);
  });
});
