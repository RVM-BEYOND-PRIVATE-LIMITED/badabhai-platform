import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { PayerSession } from "../../../lib/auth/types";
import type * as ConfigModule from "../../../lib/config";

/**
 * The COMPANY posting surface's server gates (owner ruling 2026-10-01): an agency posts AGENCY
 * jobs only, so every company posting page sends an agent elsewhere — BEFORE any read — and an
 * agent's older company postings are VIEW-ONLY.
 *
 *   /postings/new, /postings/ai/new  agent → /agency/jobs/new  (flag off → /dashboard)
 *   /postings                        agent with none → /agency/jobs (flag off → /dashboard);
 *                                    with older ones → read-only, pointer only while the flag is on
 *   /postings/<id>                   non-uuid → 404 before the read; agent → no action at all;
 *                                    company draft → ONE action (Edit posting); live → Applicants
 *                                    + Edit
 *   /postings/<id>/edit              non-uuid → 404 and agent → /postings/<id>, both before the read
 *
 * Each async Server Component is awaited to an element tree (its PageHeader props are read
 * directly); the client children are inert stubs (their own suites cover them).
 */

const COMPANY: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools",
  role: "employer",
  status: "active",
};
const AGENT: PayerSession = { ...COMPANY, role: "agent" };
const ID = "33333333-3333-4333-8333-333333333333";

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const flags = { agencyPortalEnabled: true };
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const getPostings = vi.fn();
const getPostingDetail = vi.fn();
const listMatchSkills = vi.fn();
const getCapacity = vi.fn();
const getJobPostingChatSessions = vi.fn();
const getLiveCatalog = vi.fn();
const READS = [getPostings, getPostingDetail, listMatchSkills, getCapacity, getJobPostingChatSessions, getLiveCatalog];

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, agencyFlags: () => flags };
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to), notFound: () => notFound() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("../../../lib/payer-api", () => ({
  getPostings: () => getPostings(),
  getPostingDetail: (id: string) => getPostingDetail(id),
  listMatchSkills: () => listMatchSkills(),
  getCapacity: () => getCapacity(),
  getJobPostingChatSessions: () => getJobPostingChatSessions(),
}));
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
vi.mock("./postings-manager", () => ({ PostingsManager: () => null }));
vi.mock("./new/posting-form", () => ({ PostingForm: () => null }));
vi.mock("./[id]/edit/edit-posting-form", () => ({ EditPostingForm: () => null }));
vi.mock("./ai/new/job-posting-chat", () => ({ JobPostingChat: () => null }));
vi.mock("../../../components/job-card-preview", () => ({ JobCardPreview: () => null }));
vi.mock("../../../components/retry-button", () => ({ RetryButton: () => null }));

const { PageHeader } = await import("../../../components/page-header");
const { PostingsManager } = await import("./postings-manager");
const { quotaTopUpTier } = await import("../../../lib/pricing-config");
const { formatInr } = await import("../../../lib/format");
const list = await import("./page");
const create = await import("./new/page");
const ai = await import("./ai/new/page");
const detail = await import("./[id]/page");
const edit = await import("./[id]/edit/page");

const SUMMARY = {
  id: ID,
  roleTitle: "CNC Turner",
  locationLabel: "Pune",
  vacancyBand: "2-5",
  status: "open",
  applicantCount: 1,
  applicantQuota: 10,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const DETAIL = (status = "open") => ({
  summary: { ...SUMMARY, status },
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
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * The page's PageHeader props — a direct child of the page's fragment / wrapper, or inside a
 * form's `lead` (the create / edit pages hand their head to the form column, #1887).
 */
function head(tree: unknown): Record<string, unknown> {
  const found: ReactElement[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === PageHeader) found.push(el);
    if (el.props && "children" in el.props) walk(el.props.children);
    if (el.props && "lead" in el.props) walk((el.props as { lead?: ReactNode }).lead);
  })(tree as ReactNode);
  expect(found).toHaveLength(1);
  return found[0]!.props as Record<string, unknown>;
}
/** Every href the page renders itself, plus its head's action targets. */
function hrefs(tree: unknown): string[] {
  const out: string[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.type === PageHeader) {
      const p = el.props as { back?: { href: string }; primaryAction?: { href: string }; secondaryActions?: Array<{ href: string }> };
      if (p.back) out.push(p.back.href);
      if (p.primaryAction) out.push(p.primaryAction.href);
      for (const a of p.secondaryActions ?? []) out.push(a.href);
    }
    if (el.props && "children" in el.props) walk(el.props.children);
  })(tree as ReactNode);
  return out;
}
function text(tree: unknown): string {
  const out: string[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.props && "children" in el.props) walk(el.props.children);
  })(tree as ReactNode);
  return out.join(" ");
}
const noReads = () => {
  for (const r of READS) expect(r).not.toHaveBeenCalled();
};

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(COMPANY);
  flags.agencyPortalEnabled = true;
  redirect.mockClear();
  notFound.mockClear();
  for (const r of READS) r.mockReset();
  getPostings.mockResolvedValue([SUMMARY]);
  getPostingDetail.mockResolvedValue(DETAIL());
  listMatchSkills.mockResolvedValue([]);
  getCapacity.mockResolvedValue({
    payerId: COMPANY.payerId,
    activeVacancies: 0,
    activeVacancyAllowance: 3,
    applicantQuotaTotal: 0,
    applicantQuotaUsed: 0,
    postings: [],
  });
  getJobPostingChatSessions.mockResolvedValue([]);
  getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
});

describe("New posting + Post with AI are COMPANY pages — an agent goes to its own form, before any read", () => {
  for (const [name, run] of [
    ["/postings/new", () => create.default()],
    ["/postings/ai/new", () => ai.default()],
  ] as const) {
    it(`${name}: agent → /agency/jobs/new; nothing is read`, async () => {
      requirePayer.mockResolvedValue(AGENT);
      await expect(run()).rejects.toThrow("NEXT_REDIRECT /agency/jobs/new");
      noReads();
    });

    it(`${name}: agency surface OFF → the dashboard (never a 404 link)`, async () => {
      requirePayer.mockResolvedValue(AGENT);
      flags.agencyPortalEnabled = false;
      await expect(run()).rejects.toThrow("NEXT_REDIRECT /dashboard");
      noReads();
    });

    it(`${name}: no session → the session gate's own redirect, nothing read`, async () => {
      requirePayer.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(run()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(redirect).not.toHaveBeenCalled();
      noReads();
    });

    it(`${name}: a company is not redirected`, async () => {
      await run();
      expect(redirect).not.toHaveBeenCalled();
    });
  }

  it("Post with AI (a mode of New posting) and New posting (a rail destination) have no back link", async () => {
    // F15: the chat's own "Use the manual form instead" is its one way to the form; a back link
    // to the same page beside it was a second door.
    expect(head(await ai.default()).back).toBeUndefined();
    expect(head(await create.default()).back).toBeUndefined();
  });
});

describe("/postings — an agent's own Postings, or its older company postings view-only", () => {
  it("agent with no company postings, agency surface OFF → the dashboard", async () => {
    requirePayer.mockResolvedValue(AGENT);
    flags.agencyPortalEnabled = false;
    getPostings.mockResolvedValue([]);
    await expect(list.default()).rejects.toThrow("NEXT_REDIRECT /dashboard");
  });

  it("older postings, surface ON: view-only, with ONE pointer to the agency's own Postings", async () => {
    requirePayer.mockResolvedValue(AGENT);
    const tree = await list.default();
    expect(head(tree).title).toBe("Older postings");
    expect(head(tree).primaryAction).toBeUndefined();
    expect(hrefs(tree)).toEqual(["/agency/jobs"]);
  });

  it("older postings, surface OFF: still view-only, and no pointer to a page that would 404", async () => {
    requirePayer.mockResolvedValue(AGENT);
    flags.agencyPortalEnabled = false;
    const tree = await list.default();
    expect(head(tree).title).toBe("Older postings");
    expect(hrefs(tree)).toEqual([]);
    expect(text(tree)).not.toContain("Go to Postings");
  });

  it("the agent description names postings in the product's words (no 'Job postings')", async () => {
    requirePayer.mockResolvedValue(AGENT);
    expect(String(head(await list.default()).description)).not.toMatch(/job postings/i);
  });
});

/**
 * Owner ruling 2026-10-07 (F11): Add applicant slots shows its price. The price must be the one the
 * charge is resolved from — `topUpQuotaAction` → `topUpPostingQuota` buys `quotaTopUpTier()` of the
 * LIVE catalog — so the page reads that same tier and hands its ₹ + slots to the manager. Never a
 * literal, never the posting tiers' quota step.
 */
describe("/postings — the slot top-up on offer comes from the live catalog tier the charge uses", () => {
  // An ops-EDITED live catalog: the top-up tiers re-priced and re-sized (a compile-time
  // DEFAULT_CATALOG read could not show this), while the posting tiers are left alone.
  const EDITED = DEFAULT_CATALOG.products.map((p) =>
    p.kind === "quota_topup"
      ? {
          ...p,
          tiers: p.tiers.map((t) => ({
            ...t,
            priceInr: t.priceInr + 250,
            additionalVisibilityQuota: t.additionalVisibilityQuota + 5,
          })),
        }
      : p,
  );
  const managerProps = (tree: unknown) => {
    const found: ReactElement[] = [];
    (function walk(node: ReactNode): void {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const el = node as ReactElement<{ children?: ReactNode }>;
      if (el.type === PostingsManager) found.push(el);
      if (el.props && "children" in el.props) walk(el.props.children);
    })(tree as ReactNode);
    expect(found).toHaveLength(1);
    return found[0]!.props as { topUpOffer: unknown; readOnly?: boolean };
  };

  it("hands the manager the live tier's price and slots — an ops re-price shows without a rebuild", async () => {
    getLiveCatalog.mockResolvedValue({ products: EDITED, live: true });
    const tree = await list.default();
    const tier = quotaTopUpTier({ products: EDITED })!;
    // …and its CODE, which the confirm sends back so exactly this tier is bought (#2085 L1).
    expect(managerProps(tree).topUpOffer).toEqual({
      code: tier.code,
      priceInr: tier.priceInr,
      additionalViews: tier.additionalViews,
    });
    expect(tier.priceInr).not.toBe(quotaTopUpTier({ products: DEFAULT_CATALOG.products })!.priceInr);
    // The page's quota note names the SAME slots and price as the button.
    const note = text(tree).replace(/\s+/g, " ");
    expect(note).toContain(`adds ${tier.additionalViews} more applicant slots`);
    expect(note).toContain(formatInr(tier.priceInr));
  });

  it("no top-up tier in the catalog → no offer (the manager draws no purchase it cannot price)", async () => {
    getLiveCatalog.mockResolvedValue({
      products: DEFAULT_CATALOG.products.filter((p) => p.kind !== "quota_topup"),
      live: true,
    });
    expect(managerProps(await list.default()).topUpOffer).toBeNull();
  });
});

describe("/postings/<id> — Posting details", () => {
  it("a non-uuid id is a 404 BEFORE the read", async () => {
    await expect(detail.default(params("not-a-uuid"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getPostingDetail).not.toHaveBeenCalled();
  });

  it("an unknown (or not-owned) posting is the same neutral 404", async () => {
    getPostingDetail.mockResolvedValue(null);
    await expect(detail.default(params(ID))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("company, live posting: Applicants (primary) + Edit posting, back to Postings", async () => {
    const h = head(await detail.default(params(ID)));
    expect(h.back).toEqual({ href: "/postings", label: "Postings" });
    expect(h.primaryAction).toEqual({
      href: `/postings/${ID}/applicants`,
      label: "Applicants",
      icon: "users-three",
    });
    expect(h.secondaryActions).toEqual([
      expect.objectContaining({ href: `/postings/${ID}/edit`, label: "Edit posting" }),
    ]);
  });

  it("company, DRAFT: ONE action — finish it on the edit page — and the alert says to publish", async () => {
    getPostingDetail.mockResolvedValue(DETAIL("draft"));
    const tree = await detail.default(params(ID));
    const h = head(tree);
    expect(h.primaryAction).toMatchObject({ href: `/postings/${ID}/edit`, label: "Edit posting" });
    expect(h.secondaryActions).toEqual([]);
    expect(text(tree)).toContain("publish it so workers can find it");
    expect(text(tree)).not.toMatch(/find the job/);
  });

  it("agent (an older posting): VIEW-ONLY — no action at all, live or draft", async () => {
    requirePayer.mockResolvedValue(AGENT);
    for (const status of ["open", "draft"]) {
      getPostingDetail.mockResolvedValue(DETAIL(status));
      const tree = await detail.default(params(ID));
      const h = head(tree);
      expect(h.primaryAction, status).toBeUndefined();
      expect(h.secondaryActions, status).toEqual([]);
      expect(h.back).toEqual({ href: "/postings", label: "Older postings" });
      // Nothing that edits, works or unlocks it.
      expect(hrefs(tree).filter((x) => /\/(edit|applicants)$/.test(x)), status).toEqual([]);
      // …and no instruction it cannot follow.
      expect(text(tree), status).not.toMatch(/publish it/i);
      expect(String(h.description), status).not.toMatch(/unlock/i);
    }
  });
});

describe("/postings/<id>/edit — Edit posting", () => {
  it("a non-uuid id is a 404 before the read", async () => {
    await expect(edit.default(params("x"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getPostingDetail).not.toHaveBeenCalled();
  });

  it("an agent goes to the (view-only) details BEFORE the read", async () => {
    requirePayer.mockResolvedValue(AGENT);
    await expect(edit.default(params(ID))).rejects.toThrow(`NEXT_REDIRECT /postings/${ID}`);
    expect(getPostingDetail).not.toHaveBeenCalled();
    expect(listMatchSkills).not.toHaveBeenCalled();
  });

  it("a company edits it, with the way back to the posting by its own name", async () => {
    const h = head(await edit.default(params(ID)));
    expect(redirect).not.toHaveBeenCalled();
    // One label per destination: the link back to a posting is its title — the details page's H1
    // and the label the applicants page's back link uses — never a generic "Posting details".
    expect(h.back).toEqual({ href: `/postings/${ID}`, label: "CNC Turner" });
    expect((h.back as { label: string }).label).toBe(head(await detail.default(params(ID))).title);
    expect(h.title).toBe("Edit posting");
  });
});

/**
 * #2085 — the slot offer the page hands the manager is the price the top-up is CHARGED: under an
 * active offer, the offer price (what the row's button and confirm show and send) plus the list
 * price, which the page's quota note strikes. With no `prices[]` (an older API) it is the catalog
 * price and nothing is struck.
 */
describe("/postings — #2085: the slot offer is the charged price", () => {
  const offerOf = (tree: unknown) => {
    const found: ReactElement[] = [];
    (function walk(node: ReactNode): void {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const el = node as ReactElement<{ children?: ReactNode }>;
      if (el.type === PostingsManager) found.push(el);
      if (el.props && "children" in el.props) walk(el.props.children);
    })(tree as ReactNode);
    expect(found).toHaveLength(1);
    return (found[0]!.props as { topUpOffer: unknown }).topUpOffer;
  };
  const struck = (tree: unknown) => {
    const out: string[] = [];
    (function walk(node: ReactNode): void {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const el = node as ReactElement<{ children?: ReactNode }>;
      if (el.type === "s") out.push(text(el));
      if (el.props && "children" in el.props) walk(el.props.children);
    })(tree as ReactNode);
    return out;
  };
  const topUpPrices = (topup10: number) =>
    [
      ["topup_10", 1000, topup10],
      ["topup_30", 2500, 2500],
    ].map(([tierCode, base, price]) => ({
      productCode: "quota_topup",
      tierCode: tierCode as string,
      basePriceInr: base as number,
      priceInr: price as number,
      discountInr: (base as number) - (price as number),
      offer: (price as number) < (base as number) ? { code: "DIWALI", endsAt: "2026-11-01T00:00:00.000Z" } : null,
    }));

  it("under an offer: the manager gets the offer price and the list price; the note strikes the list price", async () => {
    getLiveCatalog.mockResolvedValue({
      products: DEFAULT_CATALOG.products,
      prices: topUpPrices(750),
      live: true,
    });
    const tree = await list.default();
    expect(offerOf(tree)).toEqual({
      code: "topup_10",
      priceInr: 750,
      listPriceInr: 1000,
      additionalViews: 10,
    });
    expect(struck(tree)).toEqual(["₹1,000"]);
    expect(text(tree)).toContain("₹750");
  });

  it("no prices[] (an older API): the catalog price, nothing struck", async () => {
    getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, prices: null, live: true });
    const tree = await list.default();
    expect(offerOf(tree)).toEqual({ code: "topup_10", priceInr: 1000, additionalViews: 10 });
    expect(struck(tree)).toEqual([]);
  });
});
