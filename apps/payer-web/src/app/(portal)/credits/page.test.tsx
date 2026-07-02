import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import {
  lowBalanceThreshold,
  offeredCreditPacks,
  unlockUnitPriceInr,
} from "../../../lib/pricing-config";
import { addMonthsIso } from "../../../lib/credit-history";
import type { CreditLedgerItem, CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";

/**
 * CREDITS PAGE render tests — assert the page actually surfaces the nudge / history / expiry
 * and that packs + unit price + the nudge threshold are PROVABLY config-sourced (not literals).
 *
 * The data seam (`payer-api`) is mocked so we control the balance + the LIVE credit ledger; but
 * `pricing-config` is REAL — so the rendered packs/unit-price/threshold come from the
 * @badabhai/pricing catalog + the config functions, and the tests assert the rendered values
 * EQUAL those config outputs (drift-proof, i.e. not hardcoded). The AUTHORITATIVE history now
 * derives from the LIVE `getCreditLedger` (#177 / FE-5) — there is NO client-side mock merge.
 * Env is node (no DOM): the async server component is awaited to an element tree and walked. PII
 * guard: no worker id / phone / name / email may appear in any row.
 */

const getDashboard = vi.fn();
const getCreditTopUps = vi.fn();
const getCreditLedger = vi.fn();
vi.mock("../../../lib/payer-api", () => ({
  getDashboard: () => getDashboard(),
  getCreditTopUps: () => getCreditTopUps(),
  getCreditLedger: () => getCreditLedger(),
  topUp: vi.fn(), // transitively imported by ./credits-panel → ./actions; never called here.
}));
// Billing/wallet is an OWNER-only surface (org-RBAC). The page calls requireOwner() FIRST; mock
// it through a referenced spy so the render tests ADMIT (default) and a dedicated test can make
// it 404. The deep gate logic itself is tested in lib/auth/org-roles.test.ts.
const requireOwner = vi.fn();
vi.mock("../../../lib/auth/org-roles", () => ({ requireOwner: () => requireOwner() }));

const { default: CreditsPage } = await import("./page");

const PAYER = "11111111-1111-4111-8111-111111111111";
const WORKER = "99999999-9999-4999-8999-999999999999"; // must NOT appear in any rendered row
const UNLOCK = "22222222-2222-4222-8222-222222222222";

const topUp = (over: Partial<CreditTopUp> = {}): CreditTopUp => ({
  topUpId: "33333333-3333-4333-8333-333333333333",
  packCode: "pack_50",
  credits: 50,
  priceInr: 2000,
  createdAt: "2026-01-10T08:00:00.000Z",
  ...over,
});

/** A LIVE credit-ledger purchase movement (positive delta; a config pack code + ₹). */
const purchaseRow = (over: Partial<CreditLedgerItem> = {}): CreditLedgerItem => ({
  id: "33333333-3333-4333-8333-333333333333",
  reason: "pack_purchase",
  delta: 50,
  packCode: "pack_50",
  priceInr: 2000,
  createdAt: "2026-01-10T08:00:00.000Z",
  ...over,
});
/** A LIVE credit-ledger unlock-debit movement (−1; the opaque unlock id, NEVER a worker id). */
const debitRow = (over: Partial<CreditLedgerItem> = {}): CreditLedgerItem => ({
  id: UNLOCK,
  reason: "unlock_debit",
  delta: -1,
  packCode: null,
  priceInr: null,
  createdAt: "2026-01-12T00:00:00.000Z",
  ...over,
});

function dashboard(balance: number, unlocks: UnlockHistoryItem[] = []): Dashboard {
  return { credits: { payerId: PAYER, balance }, unlocks, postings: [] };
}

function setData(opts: {
  balance: number;
  unlocks?: UnlockHistoryItem[];
  topUps?: CreditTopUp[];
  ledger?: CreditLedgerItem[];
}) {
  getDashboard.mockResolvedValue(dashboard(opts.balance, opts.unlocks ?? []));
  getCreditTopUps.mockResolvedValue(opts.topUps ?? []);
  getCreditLedger.mockResolvedValue(opts.ledger ?? []);
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
  // The CreditsPanel child receives the config packs as a prop (we never render it).
  if (el.props && "packs" in el.props && acc.panelPacks === undefined) {
    acc.panelPacks = el.props.packs;
  }
  if (el.props && "children" in el.props) collect(el.props.children as ReactNode, acc);
  return acc;
}
async function render(opts: {
  balance: number;
  unlocks?: UnlockHistoryItem[];
  topUps?: CreditTopUp[];
  ledger?: CreditLedgerItem[];
}) {
  setData(opts);
  const tree = (await CreditsPage()) as ReactElement;
  const c = collect(tree);
  return { joined: c.text.join(" "), panelPacks: c.panelPacks };
}

beforeEach(() => {
  getDashboard.mockReset();
  getCreditTopUps.mockReset();
  getCreditLedger.mockReset();
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

describe("credits page — (b) history renders from the LIVE credit ledger (#177)", () => {
  it("renders a spend row (unlock_debit) and a top-up row (pack_purchase) from the live ledger", async () => {
    const { joined } = await render({
      balance: 50,
      // The AUTHORITATIVE history is the LIVE ledger — BOTH movements come from it (no mock merge).
      ledger: [purchaseRow({ delta: 50, priceInr: 2000 }), debitRow()],
    });
    expect(joined).toMatch(/History/);
    expect(joined).toContain("Unlock"); // spend row badge (unlock_debit)
    expect(joined).toContain("Top-up"); // top-up row badge (pack_purchase)
    expect(joined).toContain("-1"); // each unlock spends 1 credit
    expect(joined).toContain("+50"); // top-up credits (the ledger delta)
    expect(joined).toContain("₹2,000"); // config-priced amount, en-IN formatted
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
      // The live ledger's unlock_debit carries the opaque unlock id — NEVER a worker id.
      ledger: [purchaseRow(), debitRow()],
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

describe("credits page — (e) packs + unit price resolve from @badabhai/pricing (not literals)", () => {
  it("passes the catalog packs to the panel and shows the config unit price", async () => {
    const { joined, panelPacks } = await render({ balance: 50 });
    // The rendered packs are EXACTLY the catalog-derived set — not a hardcoded 50/200/1000 list.
    expect(panelPacks).toEqual(offeredCreditPacks());
    expect((panelPacks as unknown[]).length).toBeGreaterThan(0);
    // Unit price is the config-derived per-unlock price (₹40 from the catalog), not a literal.
    const unit = unlockUnitPriceInr();
    expect(unit).not.toBeNull();
    expect(joined).toContain(`₹${unit} per unlock`);
  });

  it("keeps checkout MOCK-only (no real payment is taken)", async () => {
    const { joined } = await render({ balance: 50 });
    expect(joined).toMatch(/Mock payments only/i);
    expect(joined).toMatch(/no real payment is taken/i);
  });
});
