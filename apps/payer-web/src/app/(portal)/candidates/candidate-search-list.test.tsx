import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { IconButtonBase } from "@badabhai/icons/button";
import { Button, Card } from "../../../components/ds";
import type { CandidateSearchRow } from "../../../lib/contracts";

/**
 * ALL CANDIDATES — the card list's spend → reveal flow, DRIVEN (the applicant feed's harness:
 * node env, a STATEFUL `useState` model that re-renders on setState, the Server Actions mocked).
 *
 * The flow is the applicant card's, with NO posting (owner rulings 2026-11-03):
 *  - Unlock opens the ONE ConfirmSpendDialog; confirming calls `candidateUnlockAction` with the
 *    worker id ONLY (its `job_id` is null on the wire — unlock-action.test.ts and the seam pin
 *    that) and never the posting-bound `unlockAction`; a retry never re-prompts; Cancel spends
 *    nothing;
 *  - the masked résumé is hidden until the card is unlocked, and asks `maskedResumeAction` with NO
 *    posting (→ `job_posting_id: null`); the reveal is the routed relay handle only;
 *  - a call that never arrives is a retryable inline error — never a stuck spinner;
 *  - faceless before and after: no phone / email / full id in the text.
 * Cells are positional: rows 0, confirmed 1, confirmWorker 2, result 3.
 */

const candidateUnlockAction = vi.fn();
const unlockAction = vi.fn();
const revealContactAction = vi.fn();
const maskedResumeAction = vi.fn();

vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => ({
    type: "a",
    props: { href, className, children },
  }),
}));
// A PortalLink's cue is a client component with an effect, which this walk cannot run.
vi.mock("../../../components/nav-pending", () => ({ NavPendingCue: () => null }));
vi.mock("../postings/[id]/applicants/actions", () => ({
  candidateUnlockAction: (i: unknown) => candidateUnlockAction(i),
  unlockAction: (i: unknown) => unlockAction(i),
  revealContactAction: (i: unknown) => revealContactAction(i),
  maskedResumeAction: (i: unknown) => maskedResumeAction(i),
}));

let cells: unknown[] = [];
let cursor = 0;
let renderFn: (() => void) | null = null;
let currentTree: ReactElement | null = null;

const useState = vi.fn((init: unknown) => {
  const i = cursor++;
  if (i >= cells.length) cells[i] = typeof init === "function" ? (init as () => unknown)() : init;
  const setter = (v: unknown) => {
    cells[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(cells[i]) : v;
    renderFn?.();
  };
  return [cells[i], setter] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useState: (init: unknown) => useState(init) };
});

const { CandidateSearchList } = await import("./candidate-search-list");

const W1 = "face2000-0000-4000-8000-000000000001";
const W2 = "face2000-0000-4000-8000-000000000002";
const UNLOCK_ID = "44444444-4444-4444-8444-444444444444";
const UNTIL = "2026-12-01T00:00:00.000Z";

const row = (workerId: string, over: Partial<CandidateSearchRow> = {}): CandidateSearchRow => ({
  workerId,
  matchesFilters: true,
  matchTier: null,
  role: { id: "mskill_cnc_turner", label: "CNC Turner" },
  otherRoles: [],
  skillMonths: 48,
  industry: { id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" },
  industryMonths: 54,
  city: "Pune",
  tradeLevels: [],
  ...over,
});

function mount(
  candidates: CandidateSearchRow[],
  opts: { balance?: number; unlocked?: Record<string, { kind: "granted"; unlockId: string; expiresAt: string }> } = {},
) {
  cells = [];
  renderFn = () => {
    cursor = 0;
    currentTree = CandidateSearchList({
      header: { title: "Candidates", description: "Everyone you can unlock." },
      counts: { total: 2, matched: 2, unrecorded: 0, filtered: false, strict: false },
      candidates,
      relatedTo: null,
      balance: opts.balance ?? 5,
      ...(opts.unlocked ? { unlocked: opts.unlocked } : {}),
    }) as ReactElement;
  };
  renderFn();
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

const isNamed = (el: { type?: unknown }, name: string) =>
  typeof el.type === "function" && (el.type as { name?: string }).name === name;

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Every element in the returned tree (ConfirmSpendDialog expanded; the hooked Dialog never). */
function elements(node: ReactNode = currentTree, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  const el = node as El;
  out.push(el);
  if (isNamed(el, "ConfirmSpendDialog")) {
    elements((el.type as (p: unknown) => ReactNode)(el.props), out);
    return out;
  }
  if (el.props && "footer" in el.props) elements(el.props.footer as ReactNode, out);
  if (el.props && "children" in el.props) elements(el.props.children, out);
  return out;
}

interface Btn {
  text: string;
  onClick?: () => unknown;
  disabled?: boolean;
}
function buttons(scope: ReactNode = currentTree): Btn[] {
  return elements(scope)
    .filter((el) => el.type === Button)
    .map((el) => ({
      text: textOf(el.props.children as ReactNode).trim(),
      onClick: el.props.onClick as (() => unknown) | undefined,
      disabled: el.props.disabled as boolean | undefined,
    }));
}
const cards = () => elements().filter((el) => el.type === Card && el.props.className === "applicant");
const button = (scope: ReactNode, text: string) => buttons(scope).find((b) => b.text === text);
const confirm = () => buttons().find((b) => b.text.startsWith("Unlock · 1 credit"))!.onClick!();

/**
 * Deep visible text, expanding pure child components (never the hooked Dialog / icon button).
 * Scoped to `node`: the recursion is `walkText`, which has NO default — an `undefined` child (an
 * expanded component's empty slot) is empty text, never the whole tree again.
 */
function deepText(node: ReactNode = currentTree): string {
  return walkText(node, new WeakSet());
}
function walkText(node: ReactNode, seen: WeakSet<object>): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((n) => walkText(n, seen)).join("");
  const el = node as El;
  if (seen.has(el)) return "";
  seen.add(el);
  const hooked = isNamed(el, "Dialog") || el.type === IconButtonBase;
  if (typeof el.type === "function" && !hooked) {
    return walkText((el.type as (p: unknown) => ReactNode)(el.props), seen);
  }
  let out = "";
  if (el.props && "toolbar" in el.props) out += walkText(el.props.toolbar as ReactNode, seen);
  if (el.props && "footer" in el.props) out += walkText(el.props.footer as ReactNode, seen);
  if (el.props && "children" in el.props) out += walkText(el.props.children as ReactNode, seen);
  return out;
}

const GRANTED = { ok: true, view: { kind: "granted", unlockId: UNLOCK_ID, expiresAt: UNTIL } };

beforeEach(() => {
  for (const f of [candidateUnlockAction, unlockAction, revealContactAction, maskedResumeAction]) f.mockReset();
});

describe("the posting-less unlock (job_id null) — the same confirm-on-spend", () => {
  it("Unlock opens the ONE dialog; confirm spends through candidateUnlockAction with the worker id ONLY", async () => {
    candidateUnlockAction.mockResolvedValue(GRANTED);
    mount([row(W1), row(W2)]);
    button(cards()[1]!, "Unlock contact (1 credit)")!.onClick!();
    expect(candidateUnlockAction).not.toHaveBeenCalled(); // the dialog opened; nothing spent yet
    expect(cells[2]).toBe(W2);
    await confirm();
    expect(candidateUnlockAction).toHaveBeenCalledTimes(1);
    expect(candidateUnlockAction.mock.calls[0]![0]).toStrictEqual({ workerId: W2 });
    expect(unlockAction).not.toHaveBeenCalled(); // never the posting-bound spend
    expect(cells[2]).toBeNull();
    // Granted: the card shows the reveal band; the other card still offers its own spend.
    const [first, second] = cards();
    expect(buttons(second!).map((b) => b.text)).toEqual(["Open routed contact", "View masked resume"]);
    expect(deepText(second!)).toContain("Unlocked");
    expect(buttons(first!).map((b) => b.text)).toEqual(["Unlock contact (1 credit)"]);
    expect(cells[3]).toBe("granted");
  });

  it("a failed spend: a retryable inline error; Retry spends again WITHOUT a re-prompt", async () => {
    candidateUnlockAction
      .mockResolvedValueOnce({ ok: false, error: "Unlock failed (service unavailable). Please retry." })
      .mockResolvedValueOnce(GRANTED);
    mount([row(W1)]);
    button(cards()[0]!, "Unlock contact (1 credit)")!.onClick!();
    await confirm();
    expect(deepText(cards()[0]!)).toContain("Unlock failed (service unavailable). Please retry.");
    await button(cards()[0]!, "Retry unlock (1 credit)")!.onClick!();
    expect(cells[2]).toBeNull(); // no dialog the second time
    expect(candidateUnlockAction).toHaveBeenCalledTimes(2);
    expect(cells[3]).toBe("granted");
  });

  it("Cancel closes the dialog and spends nothing", () => {
    mount([row(W1)]);
    button(cards()[0]!, "Unlock contact (1 credit)")!.onClick!();
    buttons().find((b) => b.text === "Cancel")!.onClick!();
    expect(cells[2]).toBeNull();
    expect(candidateUnlockAction).not.toHaveBeenCalled();
  });

  it("an unavailable answer is the ONE neutral engaged state (no-oracle)", async () => {
    candidateUnlockAction.mockResolvedValue({ ok: true, view: { kind: "unavailable", message: "This profile isn’t available to unlock right now." } });
    mount([row(W1)]);
    button(cards()[0]!, "Unlock contact (1 credit)")!.onClick!();
    await confirm();
    expect(deepText(cards()[0]!)).toContain("Currently engaged");
    expect(buttons(cards()[0]!)).toEqual([]);
    expect(cells[3]).toBe("unavailable");
  });

  it("a call that never arrives (offline) is a retryable error — never a stuck spinner", async () => {
    candidateUnlockAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount([row(W1)]);
    button(cards()[0]!, "Unlock contact (1 credit)")!.onClick!();
    await confirm();
    const b = button(cards()[0]!, "Retry unlock (1 credit)");
    expect(b).toBeDefined();
    expect(b!.disabled).toBe(false);
    expect(deepText(cards()[0]!)).toContain("Couldn’t reach BadaBhai. Please retry.");
  });

  it("ONE ConfirmSpendDialog for the whole list, outside every card", () => {
    mount([row(W1), row(W2)]);
    expect(elements().filter((el) => isNamed(el, "ConfirmSpendDialog"))).toHaveLength(1);
    for (const card of cards()) {
      expect(elements(card).filter((el) => isNamed(el, "ConfirmSpendDialog"))).toHaveLength(0);
    }
  });

  it("a zero balance disables Unlock (with its reason) and offers Buy credits", () => {
    mount([row(W1)], { balance: 0 });
    const unlock = elements(cards()[0]!).find((el) => el.type === Button)!;
    expect(unlock.props.disabled).toBe(true);
    expect(unlock.props["aria-describedby"]).toBe("candidate-0-unlock-hint");
    expect(elements(cards()[0]!).some((el) => el.props?.href === "/credits")).toBe(true);
  });
});

describe("the reveal and the masked résumé — no posting context", () => {
  const held = { [W1]: { kind: "granted" as const, unlockId: UNLOCK_ID, expiresAt: UNTIL } };

  it("the masked résumé is HIDDEN until the card is unlocked", () => {
    mount([row(W1), row(W2)], { unlocked: held });
    expect(buttons(cards()[0]!).map((b) => b.text)).toContain("View masked resume");
    expect(buttons(cards()[1]!).map((b) => b.text)).not.toContain("View masked resume");
    expect(deepText(cards()[1]!)).not.toMatch(/masked resume/i);
  });

  it("View masked resume asks with NO posting (→ job_posting_id null) and shows the masked card", async () => {
    maskedResumeAction.mockResolvedValue({
      ok: true,
      view: { kind: "masked", resumeUrl: "https://cdn.example/r.pdf", expiresAt: UNTIL },
    });
    mount([row(W1)], { unlocked: held });
    await button(cards()[0]!, "View masked resume")!.onClick!();
    expect(maskedResumeAction).toHaveBeenCalledTimes(1);
    const input = maskedResumeAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toStrictEqual({ unlockId: UNLOCK_ID, workerId: W1 });
    expect(input).not.toHaveProperty("postingId");
    expect(deepText(cards()[0]!)).toContain("Masked resume.");
  });

  it("Open routed contact reveals the relay handle — never a phone", async () => {
    revealContactAction.mockResolvedValue({
      ok: true,
      view: { kind: "routed", relayHandle: "RELAY-7h3k9q", channel: "in_app_relay", expiresAt: UNTIL },
    });
    mount([row(W1)], { unlocked: held });
    await button(cards()[0]!, "Open routed contact")!.onClick!();
    expect(revealContactAction.mock.calls[0]![0]).toStrictEqual({ unlockId: UNLOCK_ID });
    const text = deepText(cards()[0]!);
    expect(text).toContain("RELAY-7h3k9q");
    expect(text).toContain("not a phone number");
  });

  it("FACELESS before and after a reveal: no phone / email / full worker id", async () => {
    revealContactAction.mockResolvedValue({
      ok: true,
      view: { kind: "routed", relayHandle: "RELAY-7h3k9q", channel: "in_app_relay", expiresAt: UNTIL },
    });
    mount([row(W1), row(W2)], { unlocked: held });
    const check = () => {
      const text = deepText();
      expect(text).not.toMatch(/\d{10,}/);
      expect(text).not.toMatch(/\+\d{7,}/);
      expect(text).not.toMatch(/@/);
      for (const id of [W1, W2]) expect(text).not.toContain(id);
    };
    check();
    await button(cards()[0]!, "Open routed contact")!.onClick!();
    check();
  });
});
