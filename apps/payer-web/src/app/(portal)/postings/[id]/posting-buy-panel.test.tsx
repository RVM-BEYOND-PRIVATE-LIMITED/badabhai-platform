import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Toast } from "../../../../components/ds";
import type { BoostTierOption, PlanTierOption } from "./posting-buy-panel";

/**
 * POSTING-BUY-PANEL tests (FE-3) — MIRRORS the capacity buy UX. Covers the plan (standard/pro) +
 * boost (all_candidates) BUY flow + the optional coupon + the neutral-failure card. The panel is a
 * client component with hooks (useState / useTransition / useRouter). These tests assert:
 *  - each config'd plan/boost tier renders an ENABLED "Buy (mock)" Button;
 *  - clicking Buy opens the confirm gate + fires buyPlanAction/buyBoostAction with ONLY
 *    { postingId, tier, coupon? } — never a payer_id / price / amount;
 *  - the optional coupon (from the shared field) rides the action call when present;
 *  - a neutral failure surfaces in the aria-live result region (no leaked cause);
 *  - a paused plan result surfaces the over-capacity copy.
 *
 * Env is node (no DOM). React hooks are mocked (useState source order: coupon, pendingCode,
 * message, error; useTransition runs its callback synchronously); the actions + useRouter +
 * `window.confirm` are stubbed.
 */

const buyPlanAction = vi.fn();
const buyBoostAction = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));
vi.mock("./actions", () => ({
  buyPlanAction: (i: unknown) => buyPlanAction(i),
  buyBoostAction: (i: unknown) => buyBoostAction(i),
}));

let stateQueue: unknown[] = [];
let stateCursor = 0;
let setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const setter = vi.fn();
  setters[i] = setter;
  return [seeded, setter] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => [false, (cb: () => void) => cb()] as [boolean, (cb: () => void) => void],
  };
});

const { PostingBuyPanel } = await import("./posting-buy-panel");

const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";
const PLAN_TIERS: PlanTierOption[] = [
  { code: "standard", priceInr: 1000, validityDays: 14, applicantVisibilityQuota: 10 },
  { code: "pro", priceInr: 2500, validityDays: 30, applicantVisibilityQuota: 30 },
];
const BOOST_TIERS: BoostTierOption[] = [{ code: "all_candidates", priceInr: 1200, boostDays: 2 }];

interface CollectedButton {
  text: string;
  disabled: boolean;
  onClick?: () => void;
  loading?: boolean;
}
interface Collected {
  buttons: CollectedButton[];
  toasts: Array<{ tone: string; text: string }>;
  ariaLiveCount: number;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === Button) {
    acc.buttons.push({
      text: textOf(el.props.children).trim(),
      disabled: el.props.disabled === true,
      onClick: el.props.onClick as (() => void) | undefined,
      loading: el.props.loading as boolean | undefined,
    });
    return;
  }
  if (el.type === Toast) {
    acc.toasts.push({
      tone: typeof el.props.tone === "string" ? el.props.tone : "neutral",
      text: textOf(el.props.children).trim(),
    });
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], toasts: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function render(opts: { coupon?: string; message?: string | null; error?: string | null } = {}) {
  // Source order of useState: coupon, pendingCode, message, error.
  stateQueue = [opts.coupon ?? "", null, opts.message ?? null, opts.error ?? null];
  stateCursor = 0;
  setters = [];
  return PostingBuyPanel({
    postingId: POSTING_ID,
    planTiers: PLAN_TIERS,
    boostOptions: BOOST_TIERS,
  }) as ReactElement;
}

/** All "Buy (mock)" buttons in render order (plans first, then boost). */
function buyButtons(tree: ReactElement): CollectedButton[] {
  return collect(tree).buttons.filter((b) => b.text.includes("Buy"));
}

beforeEach(() => {
  buyPlanAction.mockReset().mockResolvedValue({
    ok: true,
    tier: "standard",
    status: "active",
    paused: false,
    expiresAt: "2026-07-20T00:00:00.000Z",
  });
  buyBoostAction.mockReset().mockResolvedValue({
    ok: true,
    tier: "all_candidates",
    status: "active",
    endsAt: "2026-06-22T00:00:00.000Z",
  });
  routerRefresh.mockReset();
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});

describe("PostingBuyPanel — renders config'd plan + boost tiers as enabled buy buttons", () => {
  it("renders a Buy button per plan tier + the boost tier (all enabled)", () => {
    const buttons = buyButtons(render());
    // 2 plan tiers + 1 boost tier = 3 buy buttons, all enabled.
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });
});

describe("PostingBuyPanel — buy PLAN fires the action with ONLY { postingId, tier } (no payer_id)", () => {
  it("clicking the first plan Buy opens confirm + fires buyPlanAction with the tier code only", () => {
    // The first buy button is the smallest-priced plan (standard).
    buyButtons(render())[0]!.onClick!();
    expect(buyPlanAction).toHaveBeenCalledTimes(1);
    const arg = buyPlanAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toEqual({ postingId: POSTING_ID, tier: "standard", coupon: undefined });
    expect(arg).not.toHaveProperty("payer_id");
    expect(JSON.stringify(arg)).not.toMatch(/payer_id|price|amount|₹|\binr\b/i);
    expect(buyBoostAction).not.toHaveBeenCalled();
  });

  it("passes the optional coupon (from the shared field) when it is non-empty", () => {
    buyButtons(render({ coupon: "SAVE10" }))[1]!.onClick!(); // the pro plan
    const arg = buyPlanAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toEqual({ postingId: POSTING_ID, tier: "pro", coupon: "SAVE10" });
  });

  it("surfaces the over-capacity paused copy when the plan came back paused", async () => {
    buyPlanAction.mockResolvedValueOnce({ ok: true, tier: "standard", status: "paused", paused: true, expiresAt: null });
    buyButtons(render())[0]!.onClick!();
    await flush();
    // message setter (index 2) carries the paused/over-capacity copy.
    expect(setters[2]).toHaveBeenCalled();
    const msg = setters[2]!.mock.calls.at(-1)![0] as string;
    expect(msg).toMatch(/paused|capacity/i);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("PostingBuyPanel — buy BOOST fires buyBoostAction with { tier: all_candidates }", () => {
  it("clicking the boost Buy fires buyBoostAction with the tier code only (no payer_id)", () => {
    // The boost button is the last buy button (plans render first).
    const buttons = buyButtons(render());
    buttons[buttons.length - 1]!.onClick!();
    expect(buyBoostAction).toHaveBeenCalledTimes(1);
    const arg = buyBoostAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toEqual({ postingId: POSTING_ID, tier: "all_candidates", coupon: undefined });
    expect(arg).not.toHaveProperty("payer_id");
    expect(buyPlanAction).not.toHaveBeenCalled();
  });
});

describe("PostingBuyPanel — neutral failure + no-fire-on-cancel + a11y result region", () => {
  it("does NOT fire the action when the user cancels the confirm", () => {
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    buyButtons(render())[0]!.onClick!();
    expect(buyPlanAction).not.toHaveBeenCalled();
  });

  it("routes a neutral action failure into the error setter (no leaked cause)", async () => {
    buyPlanAction.mockResolvedValueOnce({ ok: false, error: "Plan purchase failed (service unavailable). Please retry." });
    buyButtons(render())[0]!.onClick!();
    await flush();
    // error setter (index 3) carries the neutral message — no role name / deny cause / PII.
    expect(setters[3]).toHaveBeenCalled();
    const err = setters[3]!.mock.calls.at(-1)![0] as string;
    expect(err).not.toMatch(/payer_id|forbidden|employer|agent|consent|phone|email/i);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("renders the neutral-failure card (danger Toast) when an error is present, in an aria-live region", () => {
    const { toasts, ariaLiveCount } = collect(render({ error: "Plan purchase failed. Please retry." }));
    expect(toasts.some((t) => t.tone === "danger")).toBe(true);
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });

  it("renders the success card (success Toast) when a message is present", () => {
    const { toasts } = collect(render({ message: "standard plan recorded — status active." }));
    expect(toasts.some((t) => t.tone === "success")).toBe(true);
  });
});
