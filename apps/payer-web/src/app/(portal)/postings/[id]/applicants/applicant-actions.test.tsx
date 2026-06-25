import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { FacelessApplicant } from "../../../../../lib/contracts";

/**
 * APPLICANT-ACTIONS tests — CONFIRM-ON-SPEND (C11) + A11Y-OF-FAILURE (B8).
 *
 * C11: the FIRST unlock per row calls `window.confirm` (the spend gate); a declined confirm
 * blocks the spend. The confirm fires ONCE per row — a later reveal/resume (NOT spend
 * actions) never re-prompts, and a row already confirmed this session does not re-prompt.
 * B8: each per-row error region (unlock/contact/resume) is wrapped in `aria-live="polite"`.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * rows, confirmedUnlock). The component's handlers are async; we fire onClick and assert the
 * confirm gate + whether the unlock action ran. `window.confirm` is mocked per case.
 */

const unlockAction = vi.fn();
const revealContactAction = vi.fn();
const maskedResumeAction = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("./actions", () => ({
  unlockAction: (i: unknown) => unlockAction(i),
  revealContactAction: (i: unknown) => revealContactAction(i),
  maskedResumeAction: (i: unknown) => maskedResumeAction(i),
}));

// Injected per-render state queue (rows, confirmedUnlock).
let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useState: (initial: unknown) => useState(initial) };
});

const { ApplicantActions } = await import("./applicant-actions");

const WORKER = "55555555-5555-4555-8555-555555555555";
const APPLICANT: FacelessApplicant = {
  workerId: WORKER,
  rank: 1,
  score: 0.9,
  hot: true,
  signals: ["on-trade"],
  experienceBand: "6-10 yrs",
  tradeLabel: "VMC Operator",
  cityLabel: "pune",
};

interface Collected {
  buttons: Array<{ text: string; onClick?: () => void }>;
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
  if (el.type === "button") {
    acc.buttons.push({
      text: textOf(el.props.children).trim(),
      onClick: el.props.onClick as (() => void) | undefined,
    });
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

function render(opts: {
  confirmedUnlock?: Record<string, boolean>;
  applicants?: FacelessApplicant[];
  balance?: number;
}) {
  // Source order of useState: rows (Record), confirmedUnlock (Record).
  stateQueue = [{}, opts.confirmedUnlock ?? {}];
  stateCursor = 0;
  return ApplicantActions({
    postingId: "33333333-3333-4333-8333-333333333333",
    applicants: opts.applicants ?? [APPLICANT],
    balance: opts.balance ?? 5,
  }) as ReactElement;
}

// The env is `node` (no DOM) — stub a minimal `window` so the component's `window.confirm`
// spend gate resolves to a mock we can assert on.
const confirmMock = vi.fn();
vi.stubGlobal("window", { confirm: confirmMock });

beforeEach(() => {
  unlockAction.mockReset().mockResolvedValue({ ok: true, view: { kind: "unavailable", message: "x" } });
  revealContactAction.mockReset();
  maskedResumeAction.mockReset();
  confirmMock.mockReset();
});

describe("ApplicantActions — CONFIRM-ON-SPEND on the FIRST unlock per row (C11)", () => {
  it("a DECLINED confirm (false) blocks the first unlock spend", () => {
    confirmMock.mockReturnValue(false);
    const { buttons } = collect(render({}));
    const unlock = buttons.find((b) => b.text.includes("Unlock contact"));
    expect(unlock).toBeDefined();
    unlock!.onClick!();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(unlockAction).not.toHaveBeenCalled();
  });

  it("an ACCEPTED confirm (true) proceeds to the unlock with ONLY ids (no amount)", () => {
    confirmMock.mockReturnValue(true);
    const { buttons } = collect(render({}));
    buttons.find((b) => b.text.includes("Unlock contact"))!.onClick!();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(unlockAction).toHaveBeenCalledWith({
      postingId: "33333333-3333-4333-8333-333333333333",
      workerId: WORKER,
    });
    // XT5: ids only — no price/amount/credit number in the body.
    const arg = unlockAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["postingId", "workerId"]);
  });

  it("does NOT re-prompt when the row was already confirmed this session (fires once per row)", () => {
    confirmMock.mockReturnValue(true);
    // Seed confirmedUnlock[WORKER] = true → the confirm branch is skipped.
    const { buttons } = collect(render({ confirmedUnlock: { [WORKER]: true } }));
    buttons.find((b) => b.text.includes("Unlock contact"))!.onClick!();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(unlockAction).toHaveBeenCalledTimes(1); // the retry still runs, just no re-prompt.
  });
});

describe("ApplicantActions — A11Y-OF-FAILURE: per-row unlock error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' region around the per-row error", () => {
    confirmMock.mockReturnValue(true);
    const { ariaLiveCount } = collect(render({}));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });
});

describe("ApplicantActions — guardrails: faceless row, no PII / no oracle", () => {
  it("the rendered row carries no name/phone/email/employer text", () => {
    confirmMock.mockReturnValue(true);
    const tree = render({});
    const all: string[] = [];
    (function gather(node: ReactNode): void {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (typeof node === "string" || typeof node === "number") {
        all.push(String(node));
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(gather);
        return;
      }
      const el = node as ReactElement<{ children?: ReactNode }>;
      if (el.props && "children" in el.props) gather(el.props.children);
    })(tree);
    const joined = all.join(" ");
    expect(joined).not.toMatch(/phone|\bemail\b|employer/i);
    // The candidate is shown as a truncated opaque id (8 hex chars), never a phone number:
    // no '+'-prefixed or 10+ digit run (a real Indian phone is 10+ digits).
    expect(joined).not.toMatch(/\+\d{7,}/);
    expect(joined).not.toMatch(/\d{10,}/);
  });
});
