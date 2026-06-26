import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import { NEUTRAL_UNLOCK_MESSAGE } from "../../../../../lib/unlock-view";

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

// Injected per-render state queue (rows, confirmedUnlock, stages, activeStage). Each call's
// SETTER is captured by index so a LOCAL transition (Keep/Pass/reach) can be asserted to fire
// the right setter (and, by exercising the updater, the right next state) with NO network call.
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
  buttons: Array<{ text: string; onClick?: () => void; disabled?: boolean }>;
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
      disabled: el.props.disabled as boolean | undefined,
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
  rows?: Record<string, unknown>;
  confirmedUnlock?: Record<string, boolean>;
  stages?: Record<string, "new" | "shortlist" | "passed">;
  activeStage?: "new" | "shortlist";
  applicants?: FacelessApplicant[];
  balance?: number;
}) {
  // Source order of useState: rows, confirmedUnlock, stages, activeStage.
  stateQueue = [opts.rows ?? {}, opts.confirmedUnlock ?? {}, opts.stages ?? {}, opts.activeStage ?? "new"];
  stateCursor = 0;
  setters = [];
  return ApplicantActions({
    postingId: "33333333-3333-4333-8333-333333333333",
    applicants: opts.applicants ?? [APPLICANT],
    balance: opts.balance ?? 5,
  }) as ReactElement;
}

/** A granted-unlock + ROUTED-reveal row state (the gate that enables Call / WhatsApp). */
function routedRowState() {
  return {
    [WORKER]: {
      busy: false,
      unlock: { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" },
      unlockError: null,
      contactBusy: false,
      contact: { kind: "routed", relayHandle: "RELAY-abcdef", channel: "in_app_relay", expiresAt: "2026-07-01T00:00:00.000Z" },
      contactError: null,
      resumeBusy: false,
      resume: null,
      resumeError: null,
      reach: null,
    },
  };
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

/** Flatten every text node in a tree (for content assertions). */
function gatherText(tree: ReactNode): string {
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
  return all.join(" ");
}

/** The workerId-prefix mono cells (e.g. "aaaaaaaa…") in render order — the visible rows. */
function monoPrefixes(tree: ReactNode): string[] {
  const out: string[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.props?.className === "mono") {
      const t = textOf(el.props.children as ReactNode);
      if (t.endsWith("…")) out.push(t);
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
}

/** Find the `view` prop handed to the routed-contact renderer (the opaque relay handle). */
function findRoutedView(tree: ReactNode): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    const v = el.props?.view as Record<string, unknown> | undefined;
    if (v && typeof v.relayHandle === "string") found = v;
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return found;
}

const A = { ...APPLICANT, workerId: "aaaaaaaa-0000-4000-8000-000000000001", rank: 1, hot: true };
const B = { ...APPLICANT, workerId: "bbbbbbbb-0000-4000-8000-000000000002", rank: 2, hot: false };
const C = { ...APPLICANT, workerId: "cccccccc-0000-4000-8000-000000000003", rank: 3, hot: true };

describe("ApplicantActions — pipeline Keep/Pass are LOCAL stage transitions (NO network)", () => {
  it("Keep moves the row New→Shortlist via local state, with no unlock/reveal/resume call", () => {
    const keep = collect(render({})).buttons.find((b) => b.text === "Keep");
    expect(keep).toBeDefined();
    keep!.onClick!();
    // setters order: [rows, confirmedUnlock, stages, activeStage] → stages is index 2.
    expect(setters[2]).toHaveBeenCalledTimes(1);
    const updater = setters[2]!.mock.calls[0]![0] as (p: Record<string, string>) => Record<string, string>;
    expect(updater({})).toEqual({ [WORKER]: "shortlist" });
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
    expect(maskedResumeAction).not.toHaveBeenCalled();
  });

  it("Pass dismisses the row (→ passed) via local state, with no network call", () => {
    collect(render({})).buttons.find((b) => b.text === "Pass")!.onClick!();
    expect(setters[2]).toHaveBeenCalledTimes(1);
    const updater = setters[2]!.mock.calls[0]![0] as (p: Record<string, string>) => Record<string, string>;
    expect(updater({})).toEqual({ [WORKER]: "passed" });
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
  });

  it("a Shortlisted row shows a 'Shortlisted' badge instead of Keep (still Passable)", () => {
    const { buttons } = collect(
      render({ stages: { [WORKER]: "shortlist" }, activeStage: "shortlist" }),
    );
    expect(buttons.find((b) => b.text === "Keep")).toBeUndefined();
    expect(buttons.find((b) => b.text === "Pass")).toBeDefined();
  });
});

describe("ApplicantActions — Call/WhatsApp gated behind a granted unlock + ROUTED reveal", () => {
  it("renders Call and WhatsApp DISABLED until a routed relay handle exists", () => {
    const { buttons } = collect(render({})); // not unlocked ⇒ not routed
    expect(buttons.find((b) => b.text === "Call")!.disabled).toBe(true);
    expect(buttons.find((b) => b.text === "WhatsApp")!.disabled).toBe(true);
  });

  it("ENABLES Call/WhatsApp once row.contact is routed; clicking is LOCAL (no reveal re-call)", () => {
    const { buttons } = collect(render({ rows: routedRowState() }));
    const call = buttons.find((b) => b.text === "Call");
    const wa = buttons.find((b) => b.text === "WhatsApp");
    expect(call!.disabled).toBeFalsy();
    expect(wa!.disabled).toBeFalsy();
    call!.onClick!();
    // reach is recorded on the ROWS state (index 0) — local; never re-hits reveal/unlock.
    expect(setters[0]).toHaveBeenCalledTimes(1);
    expect(revealContactAction).not.toHaveBeenCalled();
    expect(unlockAction).not.toHaveBeenCalled();
  });

  it("the routed reveal carries ONLY the opaque relay handle + channel — never a phone", () => {
    const view = findRoutedView(render({ rows: routedRowState() }));
    expect(view).not.toBeNull();
    expect(view!.relayHandle).toBe("RELAY-abcdef"); // opaque handle
    expect(view!.channel).toBe("in_app_relay"); // channel is in_app_relay | proxy_number ONLY
    // Structural no-phone (ADR-0010 F-4): the routed view has no phone/number field at all.
    expect(view).not.toHaveProperty("phone");
    expect(view).not.toHaveProperty("number");
    // And the row's shallow tree leaks no phone-number digits.
    const joined = gatherText(render({ rows: routedRowState() }));
    expect(joined).not.toMatch(/\+\d{7,}/);
    expect(joined).not.toMatch(/\d{10,}/);
  });
});

describe("ApplicantActions — preserves backend best-first order; renders hot AS-IS (no percentile)", () => {
  it("renders rows in feed order and a 'hot' badge ONLY where hot=true", () => {
    const tree = render({ applicants: [A, B, C] });
    const monos: string[] = [];
    let hotBadges = 0;
    (function walk2(node: ReactNode): void {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (typeof node === "string" || typeof node === "number") return;
      if (Array.isArray(node)) {
        node.forEach(walk2);
        return;
      }
      const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
      const cls = el.props?.className;
      if (cls === "mono") {
        const t = textOf(el.props.children as ReactNode);
        if (t.endsWith("…")) monos.push(t); // the workerId-prefix cell (not the score/handle)
      }
      if (cls === "badge badge-hot" && textOf(el.props.children as ReactNode).trim() === "Hot") {
        hotBadges += 1;
      }
      if (el.props && "children" in el.props) walk2(el.props.children as ReactNode);
    })(tree);
    expect(monos).toEqual([`${A.workerId.slice(0, 8)}…`, `${B.workerId.slice(0, 8)}…`, `${C.workerId.slice(0, 8)}…`]);
    // hot=true for A and C only ⇒ exactly 2 badges — the engine boolean rendered as-is.
    expect(hotBadges).toBe(2);
  });

  it("filters visible rows by the active stage and reflects per-stage counts in the tabs", () => {
    const { buttons } = collect(
      render({ applicants: [A, B], stages: { [A.workerId]: "shortlist" }, activeStage: "shortlist" }),
    );
    expect(buttons.some((b) => b.text === "New (1)")).toBe(true);
    expect(buttons.some((b) => b.text === "Shortlist (1)")).toBe(true);
    // Active = shortlist ⇒ only A (kept) is visible; B (new) is not rendered.
    const ids = monoPrefixes(
      render({ applicants: [A, B], stages: { [A.workerId]: "shortlist" }, activeStage: "shortlist" }),
    );
    expect(ids).toEqual([`${A.workerId.slice(0, 8)}…`]);
  });
});

/* ── Production-quality hardening: loading / error / currently-engaged / contacted ─────────
 *
 * All on the SAME #145 RowState (no new endpoint). These seed a row's busy/error/unlock/contact
 * fields directly and assert the rendered affordance. The faceless + no-oracle + confirm-on-spend
 * guarantees from the blocks above continue to hold (no new network call is ever introduced).
 */

const baseRow = {
  busy: false,
  unlock: null,
  unlockError: null,
  contactBusy: false,
  contact: null,
  contactError: null,
  resumeBusy: false,
  resume: null,
  resumeError: null,
  reach: null,
  contacted: false,
};

/** Find a <button> whose text CONTAINS `contains`; report its `disabled` + `aria-busy` props. */
function buttonInfo(tree: ReactNode, contains: string): { disabled?: boolean; ariaBusy?: unknown } | null {
  let res: { disabled?: boolean; ariaBusy?: unknown } | null = null;
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === "button" && textOf(el.props.children as ReactNode).includes(contains)) {
      res = { disabled: el.props.disabled as boolean | undefined, ariaBusy: el.props["aria-busy"] };
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return res;
}

/** Count rendered inline spinners (deep-expands the pure Spinner / child components). */
function countSpinners(tree: ReactNode): number {
  let n = 0;
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.props?.className === "spinner") {
      n += 1;
      return;
    }
    if (typeof el.type === "function") {
      w((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return n;
}

describe("ApplicantActions — LOADING: per-action spinner + disabled + aria-busy while pending", () => {
  it("an in-flight unlock disables the button, sets aria-busy, and shows an inline spinner", () => {
    const tree = render({ rows: { [WORKER]: { ...baseRow, busy: true } } });
    const info = buttonInfo(tree, "Unlocking");
    expect(info).not.toBeNull();
    expect(info!.disabled).toBe(true);
    expect(info!.ariaBusy).toBe(true);
    expect(countSpinners(tree)).toBeGreaterThanOrEqual(1);
  });

  it("an in-flight reveal disables the reveal button, sets aria-busy, and shows a spinner", () => {
    const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
    const tree = render({ rows: { [WORKER]: { ...baseRow, unlock: granted, contactBusy: true } } });
    const info = buttonInfo(tree, "Opening");
    expect(info!.disabled).toBe(true);
    expect(info!.ariaBusy).toBe(true);
    expect(countSpinners(tree)).toBeGreaterThanOrEqual(1);
  });

  it("an idle row renders no spinner", () => {
    expect(countSpinners(render({}))).toBe(0);
  });
});

describe("ApplicantActions — ERROR: retryable inline error, the row/feed are never blanked", () => {
  it("a transient unlock error relabels the button to Retry, keeps an aria-live error + the row", () => {
    const tree = render({
      rows: { [WORKER]: { ...baseRow, unlockError: "Unlock failed (service unavailable). Please retry." } },
    });
    const { buttons, ariaLiveCount } = collect(tree);
    const retry = buttons.find((b) => b.text === "Retry unlock (1 credit)");
    expect(retry).toBeDefined(); // retryable: the action button stays, relabeled
    expect(retry!.onClick).toBeTypeOf("function");
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
    expect(gatherText(tree)).toContain("Please retry");
    // The row is NOT blanked — the candidate id cell still renders.
    expect(monoPrefixes(tree)).toHaveLength(1);
  });
});

describe("ApplicantActions — CURRENTLY ENGAGED: one neutral state, identical copy (no oracle)", () => {
  it("an unavailable unlock shows a constant 'Currently engaged' badge + the neutral message, no retry", () => {
    const tree = render({
      rows: { [WORKER]: { ...baseRow, unlock: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE } } },
    });
    const joined = gatherText(tree);
    expect(joined).toContain("Currently engaged"); // constant label — identical for every cause
    expect(joined).toContain(NEUTRAL_UNLOCK_MESSAGE); // the mapper's single neutral message
    // Terminal no-oracle state (NOT a transient error) ⇒ there is no unlock/retry button.
    const { buttons } = collect(tree);
    expect(buttons.find((b) => b.text.includes("Unlock"))).toBeUndefined();
  });
});

describe("ApplicantActions — MOVE TO CONTACTED: local transition riding the spent unlock", () => {
  it("shows 'Mark as contacted' once routed; clicking patches ROWS state with NO network", () => {
    const { buttons } = collect(render({ rows: routedRowState() }));
    const mark = buttons.find((b) => b.text === "Mark as contacted");
    expect(mark).toBeDefined();
    mark!.onClick!();
    // contacted is patched on the ROWS state (index 0) — local; no unlock/reveal re-call.
    expect(setters[0]).toHaveBeenCalledTimes(1);
    const updater = setters[0]!.mock.calls[0]![0] as (p: Record<string, unknown>) => Record<string, Record<string, unknown>>;
    expect(updater({})[WORKER]!.contacted).toBe(true);
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
  });

  it("a contacted row shows the 'Contacted' badge instead of the button (no re-spend)", () => {
    const seeded = { [WORKER]: { ...routedRowState()[WORKER], contacted: true } };
    const tree = render({ rows: seeded });
    const { buttons } = collect(tree);
    expect(buttons.find((b) => b.text === "Mark as contacted")).toBeUndefined();
    expect(gatherText(tree)).toContain("Contacted");
  });
});
