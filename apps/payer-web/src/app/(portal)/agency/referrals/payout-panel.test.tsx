import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button } from "../../../../components/ds";
import type { AgencyEarnings, AgencyPayout } from "../../../../lib/contracts";

/**
 * PayoutPanel tests — the request button is DISABLED with a mapped reason when
 * `canRequest` is false, and the history list renders PII-free rows. Env is node (no DOM);
 * hooks are mocked. `useTransition` runs its callback immediately; `useRouter().refresh`
 * is captured to assert the post-request re-read.
 */

const requestPayoutAction = vi.fn();
vi.mock("./supply-actions", () => ({ requestPayoutAction: () => requestPayoutAction() }));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => useTransition(),
  };
});

const { PayoutPanel } = await import("./payout-panel");

interface Collected {
  buttons: ReactElement<Record<string, unknown>>[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") return void acc.text.push(node);
  if (typeof node === "number") return void acc.text.push(String(node));
  if (Array.isArray(node)) return void node.forEach((c) => walk(c, acc));
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === Button) acc.buttons.push(el);
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], text: [] };
  walk(tree, acc);
  return acc;
}

const BASE: AgencyEarnings = {
  totalAccruedInr: 1200,
  requestableInr: 800,
  inRequestInr: 0,
  paidInr: 400,
  accrualCount: 30,
  kycStatus: "verified",
  thresholdInr: 500,
  basisInr: 40,
  rateBps: 2500,
  windowDays: 90,
  payoutsEnabled: true,
  canRequest: true,
  blockedReason: null,
};

function render(earnings: AgencyEarnings, payouts: AgencyPayout[] = []) {
  stateQueue = [null]; // outcome
  stateCursor = 0;
  return PayoutPanel({ earnings, payouts }) as ReactElement;
}

beforeEach(() => {
  requestPayoutAction.mockReset().mockResolvedValue({
    ok: true,
    requestId: "req_1",
    amountInr: 800,
    accrualCount: 30,
  });
  refresh.mockReset();
  useState.mockClear();
  useTransition.mockClear();
});

describe("PayoutPanel — disabled with a mapped reason", () => {
  it("kyc_not_verified → button disabled + 'Complete KYC verification first.'", () => {
    const { buttons, text } = collect(
      render({ ...BASE, canRequest: false, blockedReason: "kyc_not_verified" }),
    );
    expect(buttons[0]?.props.disabled).toBe(true);
    expect(text.join(" ")).toMatch(/Complete KYC verification first/i);
  });

  it("below_threshold → weaves the ₹ threshold into the reason", () => {
    const { buttons, text } = collect(
      render({ ...BASE, canRequest: false, blockedReason: "below_threshold" }),
    );
    expect(buttons[0]?.props.disabled).toBe(true);
    expect(text.join(" ")).toContain("You need at least ₹500 to request a payout.");
  });

  it("disabled reason → 'Payouts aren't enabled yet.'", () => {
    const { text } = collect(render({ ...BASE, canRequest: false, blockedReason: "disabled" }));
    expect(text.join(" ")).toMatch(/aren't enabled yet/i);
  });
});

describe("PayoutPanel — request flow", () => {
  it("enabled → button NOT disabled; clicking calls the action and re-reads history", async () => {
    const { buttons } = collect(render(BASE));
    expect(buttons[0]?.props.disabled).toBe(false);
    (buttons[0]!.props.onClick as () => void)();
    expect(requestPayoutAction).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("PayoutPanel — history", () => {
  it("renders PII-free payout rows (₹ amount + status)", () => {
    const payouts: AgencyPayout[] = [
      { id: "p1", amountInr: 400, accrualCount: 10, status: "paid", createdAt: "2026-07-01T00:00:00Z" },
    ];
    const { text } = collect(render(BASE, payouts));
    const joined = text.join(" ");
    expect(joined).toContain("₹400");
    expect(joined).toContain("paid");
  });

  it("shows an empty state when there are no requests", () => {
    // UI-1: the bare "No payout requests yet." sentence is now the shared `.state` primitive.
    // Same intent (an empty history is a first-class state, never a blank surface), plus the
    // Phase-16 requirement that an empty state also says what to do next.
    const joined = collect(render(BASE, [])).text.join(" ");
    expect(joined).toContain("No payout requests yet");
    expect(joined).toMatch(/clears the threshold/);
    expect(joined).toMatch(/listed here with its status/);
  });
});

/* ── W2-B: head source order, and the history ledger's own scroll region ─────────────────── */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function elements(node: ReactNode, acc: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => elements(c, acc));
    return acc;
  }
  const el = node as El;
  acc.push(el);
  if (el.props && "children" in el.props) elements(el.props.children as ReactNode, acc);
  return acc;
}
const kids = (el: El) =>
  ([] as ReactNode[])
    .concat(el.props.children as ReactNode)
    .filter((k): k is El => k !== null && typeof k === "object" && !Array.isArray(k));

const PAYOUT: AgencyPayout = {
  id: "r1",
  amountInr: 400,
  accrualCount: 10,
  status: "paid",
  createdAt: "2026-08-14T00:00:00.000Z",
};

describe("PayoutPanel — W2-B layout", () => {
  it("the request head reads title → action → sub, so the button shares the title row", () => {
    const head = elements(render(BASE)).find((e) => e.props.className === "panel__head")!;
    expect(kids(head).map((k) => String(k.props.className ?? k.type))).toEqual([
      "panel__title",
      "panel__actions",
      "panel__sub",
    ]);
    expect(collect(kids(head)[1]!).buttons).toHaveLength(1);
  });

  it("the requestable figure is the panel's focal number, shown only when a request is possible", () => {
    const shown = elements(render(BASE)).find((e) =>
      String(e.props.className).includes("agency-referrals-payout__now"),
    );
    expect(shown).toBeDefined();
    expect(collect(shown!).text.join("")).toContain("₹800");
    const blocked = elements(
      render({ ...BASE, canRequest: false, blockedReason: "below_threshold" }),
    );
    expect(
      blocked.some((e) => String(e.props.className).includes("agency-referrals-payout__now")),
    ).toBe(false);
  });

  it("the history scrolls in a focusable, labelled region; a no-wrap ledger with numeric heads", () => {
    const els = elements(render(BASE, [PAYOUT]));
    const wrap = els.find((e) => e.props.className === "tablewrap")!;
    expect(wrap.props).toMatchObject({
      tabIndex: 0,
      role: "region",
      "aria-label": "Request history",
    });
    const table = els.find((e) => e.type === "table")!;
    expect(table.props.className).toBe("table table--nowrap");
    expect(
      els
        .filter((e) => e.type === "th" && e.props.className === "num")
        .map((e) => String(e.props.children).trim()),
    ).toEqual(["Amount", "Accruals"]);
  });
});
