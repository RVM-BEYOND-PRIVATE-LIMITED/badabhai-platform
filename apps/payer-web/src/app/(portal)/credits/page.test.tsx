import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import {
  lowBalanceThreshold,
  offeredCreditPacks,
  unlockUnitPriceInr,
} from "../../../lib/pricing-config";
import { addMonthsIso } from "../../../lib/credit-history";
import type { CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";

/**
 * CREDITS PAGE render tests — assert the page actually surfaces the nudge / history / expiry
 * and that packs + unit price + the nudge threshold are PROVABLY config-sourced (not literals).
 *
 * The data seam (`payer-api`) is mocked so we control the balance + unlock/top-up ledger; but
 * `pricing-config` is REAL — so the rendered packs/unit-price/threshold come from the
 * @badabhai/pricing catalog + the config functions, and the tests assert the rendered values
 * EQUAL those config outputs (drift-proof, i.e. not hardcoded). Env is node (no DOM): the async
 * server component is awaited to an element tree and walked. PII guard: no worker id / phone /
 * name / email may appear in any row.
 */

const getDashboard = vi.fn();
const getCreditTopUps = vi.fn();
vi.mock("../../../lib/payer-api", () => ({
  getDashboard: () => getDashboard(),
  getCreditTopUps: () => getCreditTopUps(),
  topUp: vi.fn(), // transitively imported by ./credits-panel → ./actions; never called here.
}));
// Billing/wallet is an OWNER-only surface (org-RBAC). The page calls requireOwner() FIRST; mock
// it through a referenced spy so the render tests ADMIT (default) and a dedicated test can make
// it 404. The deep gate logic itself is tested in lib/auth/org-roles.test.ts.
const requireOwner = vi.fn();
vi.mock("../../../lib/auth/org-roles", () => ({ requireOwner: () => requireOwner() }));
// The LIVE catalog seam (D-6). Default: live catalog = the default products (the tests
// below assert the rendered figures EQUAL the pricing-config outputs over these products);
// dedicated tests re-point it at an ops-EDITED catalog (live) or the fallback (live:false).
const getLiveCatalog = vi.fn();
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));

const { default: CreditsPage } = await import("./page");

const PAYER = "11111111-1111-4111-8111-111111111111";
const WORKER = "99999999-9999-4999-8999-999999999999"; // must NOT appear in any rendered row
const UNLOCK = "22222222-2222-4222-8222-222222222222";

const unlock = (over: Partial<UnlockHistoryItem> = {}): UnlockHistoryItem => ({
  unlockId: UNLOCK,
  workerId: WORKER,
  status: "granted",
  createdAt: "2026-01-12T00:00:00.000Z",
  expiresAt: "2026-01-26T00:00:00.000Z",
  ...over,
});
const topUp = (over: Partial<CreditTopUp> = {}): CreditTopUp => ({
  topUpId: "33333333-3333-4333-8333-333333333333",
  packCode: "pack_50",
  credits: 50,
  priceInr: 2000,
  createdAt: "2026-01-10T08:00:00.000Z",
  ...over,
});

function dashboard(balance: number, unlocks: UnlockHistoryItem[] = []): Dashboard {
  return { credits: { payerId: PAYER, balance }, unlocks, postings: [] };
}

function setData(opts: { balance: number; unlocks?: UnlockHistoryItem[]; topUps?: CreditTopUp[] }) {
  getDashboard.mockResolvedValue(dashboard(opts.balance, opts.unlocks ?? []));
  getCreditTopUps.mockResolvedValue(opts.topUps ?? []);
}

interface Collected {
  text: string[];
  panelPacks: unknown;
}
function collect(node: ReactNode, acc: Collected = { text: [], panelPacks: undefined }): Collected {
  if (node === null || node === undefined || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, acc));
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  // The CreditsPanel child receives the config packs as a prop (we never hook-render it).
  if (el.props && "packs" in el.props && acc.panelPacks === undefined) {
    acc.panelPacks = el.props.packs;
  }
  // Expand a FUNCTION component one level (the DS primitives + CachedPricingNote are
  // hookless/presentational — the capacity-page walker pattern) so text rendered INSIDE a
  // component (not passed as a children prop) is reachable. A hook-using client child
  // (CreditsPanel) throws outside React → fall back to walking its children prop.
  if (typeof el.type === "function") {
    const Fn = el.type as (props: unknown) => ReactNode;
    let rendered: ReactNode = null;
    try {
      rendered = Fn(el.props);
    } catch {
      rendered = el.props && "children" in el.props ? el.props.children : null;
    }
    collect(rendered, acc);
    return acc;
  }
  if (el.props && "children" in el.props) collect(el.props.children as ReactNode, acc);
  return acc;
}
async function render(opts: { balance: number; unlocks?: UnlockHistoryItem[]; topUps?: CreditTopUp[] }) {
  setData(opts);
  const tree = (await CreditsPage()) as ReactElement;
  const c = collect(tree);
  return { joined: c.text.join(" "), panelPacks: c.panelPacks };
}

beforeEach(() => {
  getDashboard.mockReset();
  getCreditTopUps.mockReset();
  // Default: the LIVE catalog resolved (D-6) with the default products.
  getLiveCatalog.mockReset().mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
  // Default: ADMIT an Owner so the render tests below exercise the page body.
  requireOwner.mockReset().mockResolvedValue({
    payerId: "11111111-1111-4111-8111-111111111111",
    displayLabel: "Acme",
    role: "employer",
  });
});
afterEach(() => {
  delete process.env.PAYER_LOW_BALANCE_THRESHOLD;
});

describe("credits page — OWNER-gated billing/wallet (server gate, not nav)", () => {
  it("calls requireOwner() FIRST and propagates its neutral 404 (a Recruiter never renders)", async () => {
    const NOT_FOUND = new Error("NEXT_NOT_FOUND");
    requireOwner.mockReset().mockRejectedValue(NOT_FOUND);
    setData({ balance: 50 });
    // The gate runs before any fetch/render — the page rejects with the not-found sentinel.
    await expect(CreditsPage()).rejects.toBe(NOT_FOUND);
    expect(getDashboard).not.toHaveBeenCalled();
  });
});

describe("credits page — (a) low-balance nudge shows ONLY below the CONFIG threshold", () => {
  it("uses the config threshold, not a literal: env-driven boundary flips the nudge", async () => {
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "8";
    expect(lowBalanceThreshold()).toBe(8); // the page reads THIS

    // 7 < 8 → nudge shows, and the copy interpolates the config threshold (8), not a literal 5.
    const below = await render({ balance: 7 });
    expect(below.joined).toMatch(/running low/i);
    expect(below.joined).toMatch(/below\s+8\s+credits/); // threshold value comes from config

    // 8 is NOT below 8 → no nudge. (A hardcoded 5 would have hidden at 7 too — this proves config.)
    const atThreshold = await render({ balance: 8 });
    expect(atThreshold.joined).not.toMatch(/running low/i);
  });

  it("does not show the nudge when the balance is comfortably above the threshold", async () => {
    const { joined } = await render({ balance: 50 });
    expect(joined).not.toMatch(/running low/i);
  });
});

describe("credits page — (b) history renders unlock + top-up rows", () => {
  it("renders a spend row per unlock and a top-up row from the mock ledger", async () => {
    const { joined } = await render({
      balance: 50,
      unlocks: [unlock()],
      topUps: [topUp({ credits: 50, priceInr: 2000 })],
    });
    expect(joined).toMatch(/History/);
    expect(joined).toContain("Unlock"); // spend row badge
    expect(joined).toContain("Top-up"); // top-up row badge
    expect(joined).toContain("-1"); // each unlock spends 1 credit
    expect(joined).toContain("+50"); // top-up credits
    expect(joined).toContain("₹2,000"); // the STAMPED amount, en-IN formatted
  });

  /**
   * D-6 MEDIUM-2: a legacy ledger row (written before the price stamp existed) has NO amount.
   * The row must still render, showing an honest dash — NEVER a price fabricated from the
   * current catalog (which is what retroactively re-priced the past).
   */
  it("a top-up with NO stamped price renders an honest dash, not a fabricated amount", async () => {
    const { joined } = await render({
      balance: 50,
      topUps: [topUp({ credits: 50, priceInr: undefined })],
    });
    // The movement still shows...
    expect(joined).toContain("Top-up");
    expect(joined).toContain("+50");
    // ...with a dash for the amount, and NO invented ₹ figure anywhere.
    expect(joined).toContain("—");
    expect(joined).not.toMatch(/₹2,000/);
    expect(joined).not.toMatch(/₹0\b/); // never a fake zero either
  });
});

describe("credits page — (c) expiry shows purchase + 12 months", () => {
  it("renders the purchase date and the +12-month expiry date", async () => {
    const purchased = "2026-01-10T08:00:00.000Z";
    const { joined } = await render({ balance: 50, topUps: [topUp({ createdAt: purchased })] });
    expect(joined).toMatch(/Credit expiry/);
    expect(joined).toContain("2026-01-10"); // purchased
    // +12 months via the same pure helper the page uses → 2027-01-10.
    expect(joined).toContain(addMonthsIso(purchased, 12).slice(0, 10));
    expect(joined).toContain("2027-01-10");
  });
});

describe("credits page — (d) zero PII in any row (ids/amounts only)", () => {
  it("never renders the worker id, a phone, a name, or an email", async () => {
    const { joined } = await render({
      balance: 50,
      unlocks: [unlock()],
      topUps: [topUp()],
    });
    // History rows reference the opaque UNLOCK id, never the worker id.
    expect(joined).not.toContain(WORKER);
    expect(joined).not.toMatch(/\d{10,}/); // no phone-length digit run
    expect(joined).not.toMatch(/\+\d{7,}/); // no +country-code phone
    expect(joined).not.toMatch(/@/); // no email
    expect(joined).not.toMatch(/\bname\b/i); // no name label
  });
});

describe("credits page — (e) packs + unit price resolve from the live catalog (not literals)", () => {
  it("passes the catalog packs to the panel and shows the config unit price", async () => {
    const { joined, panelPacks } = await render({ balance: 50 });
    // The rendered packs are EXACTLY the catalog-derived set — not a hardcoded 50/200/1000 list.
    expect(panelPacks).toEqual(offeredCreditPacks(DEFAULT_CATALOG.products));
    expect((panelPacks as unknown[]).length).toBeGreaterThan(0);
    // Unit price is the config-derived per-unlock price (₹40 from the catalog), not a literal.
    const unit = unlockUnitPriceInr(DEFAULT_CATALOG.products);
    expect(unit).not.toBeNull();
    expect(joined).toContain(`₹${unit} per unlock`);
  });

  it("keeps checkout MOCK-only (no real payment is taken)", async () => {
    const { joined } = await render({ balance: 50 });
    expect(joined).toMatch(/Mock payments only/i);
    expect(joined).toMatch(/no real payment is taken/i);
  });
});

describe("credits page — (f) D-6: the LIVE catalog drives the render; fallback shows the note", () => {
  // An ops-EDITED live catalog: every unlock pack re-priced +₹500 (so the smallest pack's
  // ₹/credit unit price changes too) — a compile-time DEFAULT_CATALOG read could not show it.
  const EDITED = DEFAULT_CATALOG.products.map((p) =>
    p.kind === "credit_pack" && p.code === "contact_unlock"
      ? { ...p, tiers: p.tiers.map((t) => ({ ...t, priceInr: t.priceInr + 500 })) }
      : p,
  );

  it("renders the ops-edited LIVE prices (no rebuild): packs + unit price change with the wire", async () => {
    getLiveCatalog.mockResolvedValue({ products: EDITED, live: true });
    const { joined, panelPacks } = await render({ balance: 50 });
    expect(panelPacks).toEqual(offeredCreditPacks(EDITED));
    expect(panelPacks).not.toEqual(offeredCreditPacks(DEFAULT_CATALOG.products));
    expect(joined).toContain(`₹${unlockUnitPriceInr(EDITED)} per unlock`);
    // And the live render carries NO cached-pricing note.
    expect(joined).not.toMatch(/cached pricing/i);
  });

  it("a catalog fetch FAILURE falls back to the defaults + the subtle cached-pricing note (never blank)", async () => {
    // getLiveCatalog itself fails OPEN (live:false) — the page must still render packs.
    getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: false });
    const { joined, panelPacks } = await render({ balance: 50 });
    expect(joined).toMatch(/cached pricing/i); // the subtle disclosure
    expect(panelPacks).toEqual(offeredCreditPacks(DEFAULT_CATALOG.products)); // defaults, not blank
    expect(joined).toContain(`₹${unlockUnitPriceInr(DEFAULT_CATALOG.products)} per unlock`);
  });
});

describe("credits page — ledger degrade (C2 decoupling)", () => {
  it("a REJECTED getCreditTopUps (live fetch failure) never blanks the balance/packs", async () => {
    getDashboard.mockResolvedValue(dashboard(7, []));
    getCreditTopUps.mockRejectedValue(new Error("ledger unavailable"));
    const tree = (await CreditsPage()) as ReactElement;
    const { text } = collect(tree);
    const joined = text.join(" ");
    // The page still renders (balance section present), with an empty history — no crash.
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toMatch(/ledger unavailable/);
  });
});
