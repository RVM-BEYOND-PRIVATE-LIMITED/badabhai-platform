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
 *   · the per-posting tables on /plans + /capacity are focusable, labelled scroll regions whose
 *     name is the panel heading's own text;
 *   · /plans: every credit pack's action is a LINK to /credits (the purchase happens there),
 *     never an in-card button.
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
const getPostings = vi.fn();
const getCapacity = vi.fn<() => Promise<Capacity>>();
const getAgencyKyc = vi.fn();
const getLiveCatalog = vi.fn();
const listOrgMembers = vi.fn();

vi.mock("../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../lib/auth/org-roles", () => ({ requireOwner: () => requireOwner() }));
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

const noParams = () => ({ searchParams: Promise.resolve({ token: "tok" }) });

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
    run: () => accept.default(noParams()),
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
    await expect(accept.default(noParams())).resolves.toBeTruthy();
    requirePayer.mockRejectedValue(redirect());
    await expect(accept.default(noParams())).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("W3-B · per-posting tables are labelled, keyboard-scrollable regions", () => {
  const cases = [
    { name: "/plans", run: () => plans.default() },
    { name: "/capacity", run: () => capacityPage.default() },
  ];
  for (const c of cases) {
    for (const session of [EMPLOYER, AGENCY]) {
      it(`${c.name} (${session.role}): tabIndex 0 + region, named by its panel heading's text`, async () => {
        requirePayer.mockResolvedValue(session);
        const tree = (await c.run()) as ReactElement;
        const wraps = byClass(tree, "tablewrap");
        expect(wraps).toHaveLength(1);
        expect(props(wraps[0]!)).toMatchObject({ tabIndex: 0, role: "region" });
        const panel = byClass(tree, "panel--table");
        expect(panel).toHaveLength(1);
        const heading = textOf(byClass(panel[0]!, "panel__title")[0]!);
        expect(props(wraps[0]!)["aria-label"]).toBe(heading);
        expect(heading).toContain(session.role === "agent" ? "vacancy" : "posting");
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
  it("every credit pack's one action is a link to /credits", async () => {
    const tree = (await plans.default()) as ReactElement;
    const packs = byClass(tree, "plan-card").filter((c) => textOf(c).includes("credits"));
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const links = byClass(pack, "bb-btn");
      expect(links).toHaveLength(1);
      expect(props(links[0]!).href).toBe("/credits");
    }
  });
});
