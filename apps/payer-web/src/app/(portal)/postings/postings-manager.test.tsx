import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button } from "../../../components/ds";
import type { QuotaTopUpTierOption } from "./postings-manager";

/**
 * POSTINGS-MANAGER tests (DS2.2 + FE-4) — STATUS RENDERING + LIVE QUOTA TOP-UP + A11Y (B8).
 *
 * The manager is a client component with hooks (useState / useTransition / useRouter). It renders
 * each posting as a DS Card with its REAL `status` Badge, a LIVE "Top up applicant quota" Button
 * (the B2 refill — POST /payer/job-postings/:id/quota-topup via the Server Action), and DISABLED
 * pause/resume Buttons + a "coming soon" note. These tests assert:
 *  - the status Badge reflects the posting's real `status` (open → success tone, etc.);
 *  - Pause/Resume render DISABLED (never fire a fake live action);
 *  - the LIVE top-up Button is ENABLED (a config'd tier exists) and its onClick opens the confirm
 *    gate + fires `topUpQuotaAction` with ONLY { postingId, tier } — never a payer_id/amount;
 *  - the top-up Button is DISABLED when the catalog carries no quota tier (fail-closed);
 *  - each row keeps an `aria-live="polite"` region (B8 — announces a row failure).
 *
 * Env is node (no DOM). React hooks are mocked: `useState` is injected per source order
 * (liveQuota, pendingId, rowError) and `useTransition` runs its callback synchronously; the
 * action + `useRouter`/`next/link` are mocked. `window.confirm` is stubbed true.
 */

const topUpQuotaAction = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));
vi.mock("./actions", () => ({ topUpQuotaAction: (i: unknown) => topUpQuotaAction(i) }));

// Injected per-render state queue (source order: liveQuota, pendingId, rowError). Setters are
// captured by index; useTransition returns [isPending=false, run] where run invokes synchronously.
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

const { PostingsManager } = await import("./postings-manager");

const OPEN: PostingSummary = {
  id: "bbbb2222-0000-4000-8000-000000000001",
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  vacancyBand: "6-20",
  status: "open",
  applicantCount: 2,
  applicantQuota: 10,
  createdAt: "2026-06-22T00:00:00.000Z",
};

const TIERS: QuotaTopUpTierOption[] = [
  { code: "topup_10", priceInr: 1000, additionalVisibilityQuota: 10 },
  { code: "topup_30", priceInr: 2500, additionalVisibilityQuota: 30 },
];

interface CollectedButton {
  text: string;
  disabled: boolean;
  onClick?: () => void;
  loading?: boolean;
}
interface CollectedBadge {
  text: string;
  tone: string;
}
interface Collected {
  buttons: CollectedButton[];
  badges: CollectedBadge[];
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
  if (el.type === Badge) {
    acc.badges.push({
      text: textOf(el.props.children).trim(),
      tone: typeof el.props.tone === "string" ? el.props.tone : "neutral",
    });
    return;
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], badges: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

/** Let the awaited action's microtasks settle (the handler is async; useTransition runs it sync). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function render(
  postings: PostingSummary[],
  opts: { quotaTiers?: QuotaTopUpTierOption[]; liveQuota?: Record<string, { used: number; quota: number }> } = {},
) {
  // Source order of useState: liveQuota, pendingId, rowError.
  stateQueue = [opts.liveQuota ?? {}, null, {}];
  stateCursor = 0;
  setters = [];
  return PostingsManager({
    postings,
    quotaTiers: opts.quotaTiers ?? TIERS,
  }) as ReactElement;
}

beforeEach(() => {
  topUpQuotaAction.mockReset().mockResolvedValue({
    ok: true,
    quota: {
      postingId: OPEN.id,
      planId: "cccc3333-0000-4000-8000-000000000001",
      applicantQuota: 20,
      applicantsUsed: 2,
    },
  });
  routerRefresh.mockReset();
  // Env is node (no DOM): provide a minimal `window` with a stubbed `confirm` (default: accept).
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});

describe("PostingsManager — STATUS RENDERING reflects the real status", () => {
  it("an open posting renders a success-tone status Badge with the real status text", () => {
    const status = collect(render([OPEN])).badges.find((b) => b.text === "open");
    expect(status).toBeDefined();
    expect(status!.tone).toBe("success");
  });

  it("a paused posting renders a warning-tone status Badge; draft/closed render neutral", () => {
    expect(collect(render([{ ...OPEN, status: "paused" }])).badges.find((b) => b.text === "paused")?.tone).toBe(
      "warning",
    );
    expect(collect(render([{ ...OPEN, status: "draft" }])).badges.find((b) => b.text === "draft")?.tone).toBe(
      "neutral",
    );
    expect(collect(render([{ ...OPEN, status: "closed" }])).badges.find((b) => b.text === "closed")?.tone).toBe(
      "neutral",
    );
  });
});

describe("PostingsManager — PAUSE/RESUME stay gated (disabled, coming-soon)", () => {
  it("Pause renders DISABLED (no fake live action) with the coming-soon note", () => {
    const { buttons } = collect(render([OPEN]));
    expect(buttons.find((b) => b.text === "Pause")!.disabled).toBe(true);
    expect(textOf(render([OPEN]))).toContain("coming soon");
  });

  it("a paused posting offers a DISABLED Resume button (still gated, not wired)", () => {
    const resume = collect(render([{ ...OPEN, status: "paused" }])).buttons.find((b) => b.text === "Resume");
    expect(resume).toBeDefined();
    expect(resume!.disabled).toBe(true);
  });
});

describe("PostingsManager — LIVE quota top-up (FE-4)", () => {
  it("the Top up button is ENABLED when a config'd tier exists", () => {
    const topUp = collect(render([OPEN])).buttons.find((b) => b.text.includes("Top up applicant quota"));
    expect(topUp).toBeDefined();
    expect(topUp!.disabled).toBe(false);
  });

  it("the Top up button is DISABLED when the catalog carries no quota tier (fail-closed)", () => {
    const topUp = collect(render([OPEN], { quotaTiers: [] })).buttons.find((b) =>
      b.text.includes("Top up applicant quota"),
    );
    expect(topUp!.disabled).toBe(true);
  });

  it("clicking Top up fires the action with ONLY { postingId, tier } — never a payer_id/amount", () => {
    const topUp = collect(render([OPEN])).buttons.find((b) => b.text.includes("Top up applicant quota"));
    topUp!.onClick!();
    expect(topUpQuotaAction).toHaveBeenCalledTimes(1);
    const arg = topUpQuotaAction.mock.calls[0]![0] as Record<string, unknown>;
    // The SMALLEST config'd tier code is sent (topup_10) — never a client price/amount.
    expect(arg).toEqual({ postingId: OPEN.id, tier: "topup_10" });
    expect(Object.keys(arg).sort()).toEqual(["postingId", "tier"]);
    expect(arg).not.toHaveProperty("payer_id");
    expect(JSON.stringify(arg)).not.toMatch(/payer_id|price|amount|₹|\binr\b/i);
  });

  it("a successful top-up records the REAL raised quota on the row (liveQuota setter index 0)", async () => {
    const topUp = collect(render([OPEN])).buttons.find((b) => b.text.includes("Top up applicant quota"));
    topUp!.onClick!();
    await flush(); // the handler awaits the action; let its microtasks settle.
    // liveQuota is setter index 0; the updater stores { used, quota } for this posting.
    expect(setters[0]).toHaveBeenCalledTimes(1);
    const updater = setters[0]!.mock.calls[0]![0] as (
      p: Record<string, { used: number; quota: number }>,
    ) => Record<string, { used: number; quota: number }>;
    expect(updater({})).toEqual({ [OPEN.id]: { used: 2, quota: 20 } });
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders the LIVE raised quota (used / quota) once seeded for the row", () => {
    const joined = textOf(render([OPEN], { liveQuota: { [OPEN.id]: { used: 3, quota: 40 } } }));
    expect(joined.replace(/\s+/g, " ")).toContain("3 / 40");
  });

  it("does NOT fire the action when the user cancels the confirm", () => {
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    collect(render([OPEN])).buttons.find((b) => b.text.includes("Top up applicant quota"))!.onClick!();
    expect(topUpQuotaAction).not.toHaveBeenCalled();
  });

  it("surfaces a neutral failure into the row error region (no leaked cause)", async () => {
    topUpQuotaAction.mockResolvedValueOnce({ ok: false, error: "Applicant top-up isn't available for this posting yet." });
    const topUp = collect(render([OPEN])).buttons.find((b) => b.text.includes("Top up applicant quota"));
    topUp!.onClick!();
    await flush(); // the failure setter runs after the awaited action resolves.
    // rowError is setter index 2; the updater stores the neutral message for this posting.
    expect(setters[2]).toHaveBeenCalled();
    const lastCall = setters[2]!.mock.calls.at(-1)![0] as (p: Record<string, string>) => Record<string, string>;
    expect(lastCall({})[OPEN.id]).not.toMatch(/payer_id|forbidden|consent/i);
  });
});

describe("PostingsManager — A11Y-OF-FAILURE: per-row error region is aria-live='polite' (B8)", () => {
  it("renders one aria-live='polite' error container per row", () => {
    expect(collect(render([OPEN])).ariaLiveCount).toBeGreaterThanOrEqual(1);
    const second = { ...OPEN, id: "bbbb2222-0000-4000-8000-000000000002" };
    expect(collect(render([OPEN, second])).ariaLiveCount).toBe(2);
  });

  it("renders a faceless empty state when there are no postings", () => {
    expect(textOf(render([]))).toContain("haven");
  });
});
