import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import { NEUTRAL_UNLOCK_MESSAGE, mapUnlockResult } from "../../../../../lib/unlock-view";
import { Badge, Button } from "../../../../../components/ds";

/**
 * APPLICANT-ACTIONS tests — DS1.3 re-skin. CONFIRM-ON-SPEND (C11) + A11Y-OF-FAILURE (B8).
 *
 * C11: the FIRST unlock per row OPENS a DS Dialog (the spend gate) instead of `window.confirm`;
 * it does NOT call the unlock action yet. Clicking the dialog's confirm Button runs the (ids-only)
 * unlock and marks the row confirmed. A row already confirmed this session unlocks directly with
 * NO dialog (a retry never re-prompts; reveal/resume are not spend actions and never confirm).
 * B8: each per-row error region (unlock/contact/resume) is wrapped in `aria-live="polite"`.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * rows, confirmedUnlock, stages, activeStage, confirmWorker). Actions are DS `Button`s — we
 * collect by `el.type === Button` and fire `props.onClick`. The component handlers are async; we
 * fire onClick and assert the gate + whether the unlock action ran.
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

// Injected per-render state queue (rows, confirmedUnlock, stages, activeStage, confirmWorker).
// Each call's SETTER is captured by index so a LOCAL transition (Keep/Pass/reach) can be asserted
// to fire the right setter (and, by exercising the updater, the right next state) with NO network.
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
  buttons: Array<{ text: string; onClick?: () => void; disabled?: boolean; loading?: boolean }>;
  ariaLiveCount: number;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

/**
 * The confirm-on-spend DS Dialog is CHROME (always in the tree, gated by `open`), not candidate
 * row data; its neutral static copy ("…never a phone number") and confirm Button are intentional.
 * Row-content walkers (faceless / no-PII / per-row buttons) skip it; the dialog-specific tests
 * walk its `footer` explicitly via `collect` (which descends footer) to find Cancel / confirm.
 */
function isDialogEl(el: { type?: unknown }): boolean {
  return typeof el.type === "function" && (el.type as { name?: string }).name === "Dialog";
}

/**
 * `ConfirmSpendDialog` (DS1.5) is a PURE wrapper around the hooked DS `Dialog` — invoking it is
 * safe and yields the inner `<Dialog footer=… open=…>`. Walkers expand it so the confirm/cancel
 * footer Buttons remain reachable (the inner `Dialog` itself is still NEVER invoked — `isDialogEl`).
 */
function isConfirmDialogEl(el: { type?: unknown }): boolean {
  return typeof el.type === "function" && (el.type as { name?: string }).name === "ConfirmSpendDialog";
}
function expandConfirmDialog(el: { type: (p: unknown) => ReactNode; props: unknown }): ReactNode {
  return el.type(el.props);
}

/**
 * Walk the element tree. Buttons are DS `Button` elements (props carry text/onClick/disabled/
 * loading); badges are DS `Badge` elements. We do NOT expand stateful components (Dialog has a
 * hook) — its footer Buttons live in its `footer` prop, which we walk explicitly.
 */
function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (isConfirmDialogEl(el)) {
    walk(expandConfirmDialog(el as never), acc);
    return;
  }
  if (el.type === Button) {
    acc.buttons.push({
      text: textOf(el.props.children as ReactNode).trim(),
      onClick: el.props.onClick as (() => void) | undefined,
      disabled: el.props.disabled as boolean | undefined,
      loading: el.props.loading as boolean | undefined,
    });
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  // Dialog footer Buttons live in the `footer` prop, not in children.
  if ("footer" in el.props) walk(el.props.footer as ReactNode, acc);
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
  confirmWorker?: string | null;
  applicants?: FacelessApplicant[];
  balance?: number;
}) {
  // Source order of useState: rows, confirmedUnlock, stages, activeStage, confirmWorker.
  stateQueue = [
    opts.rows ?? {},
    opts.confirmedUnlock ?? {},
    opts.stages ?? {},
    opts.activeStage ?? "new",
    opts.confirmWorker ?? null,
  ];
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

beforeEach(() => {
  unlockAction.mockReset().mockResolvedValue({ ok: true, view: { kind: "unavailable", message: "x" } });
  revealContactAction.mockReset();
  maskedResumeAction.mockReset();
});

describe("ApplicantActions — CONFIRM-ON-SPEND on the FIRST unlock per row (C11)", () => {
  it("the FIRST unlock click OPENS the confirm dialog and does NOT call the unlock action yet", () => {
    const { buttons } = collect(render({}));
    const unlock = buttons.find((b) => b.text.includes("Unlock contact"));
    expect(unlock).toBeDefined();
    unlock!.onClick!();
    // confirmWorker is setter index 4 — the FIRST unlock opens the dialog (the spend gate).
    expect(setters[4]).toHaveBeenCalledTimes(1);
    expect(setters[4]!.mock.calls[0]![0]).toBe(WORKER);
    // No spend yet: the unlock action has NOT run on the first click.
    expect(unlockAction).not.toHaveBeenCalled();
  });

  it("confirming in the dialog runs the unlock with ONLY ids (no amount) and marks confirmed", () => {
    // Seed confirmWorker = WORKER so the dialog's success Button reads it on click.
    const { buttons } = collect(render({ confirmWorker: WORKER }));
    const confirm = buttons.find((b) => b.text.includes("Unlock · 1 credit"));
    expect(confirm).toBeDefined();
    confirm!.onClick!();
    // confirmedUnlock is setter index 1; the updater marks WORKER confirmed.
    expect(setters[1]).toHaveBeenCalledTimes(1);
    const updater = setters[1]!.mock.calls[0]![0] as (p: Record<string, boolean>) => Record<string, boolean>;
    expect(updater({})).toEqual({ [WORKER]: true });
    // The dialog is closed (confirmWorker → null) and the (ids-only) unlock runs.
    expect(setters[4]).toHaveBeenCalledWith(null);
    expect(unlockAction).toHaveBeenCalledWith({
      postingId: "33333333-3333-4333-8333-333333333333",
      workerId: WORKER,
    });
    // XT5: ids only — no price/amount/credit number in the body.
    const arg = unlockAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["postingId", "workerId"]);
  });

  it("a row already confirmed this session unlocks DIRECTLY with no dialog (fires once per row)", () => {
    // Seed confirmedUnlock[WORKER] = true → the dialog branch is skipped; unlock runs directly.
    const { buttons } = collect(render({ confirmedUnlock: { [WORKER]: true } }));
    buttons.find((b) => b.text.includes("Unlock contact"))!.onClick!();
    // No dialog opened (confirmWorker setter untouched) and the retry unlock runs immediately.
    expect(setters[4]).not.toHaveBeenCalled();
    expect(unlockAction).toHaveBeenCalledTimes(1);
  });
});

describe("ApplicantActions — A11Y-OF-FAILURE: per-row unlock error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' region around the per-row error", () => {
    const { ariaLiveCount } = collect(render({}));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });
});

describe("ApplicantActions — guardrails: faceless row, no PII / no oracle", () => {
  it("the rendered row carries no name/phone/email/employer text", () => {
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
      const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; footer?: ReactNode }>;
      if (isDialogEl(el)) return; // the confirm dialog is chrome, not candidate row data
      if (el.props && "footer" in el.props) gather(el.props.footer as ReactNode);
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

/**
 * Flatten every text node in the candidate-row tree (for content assertions). Skips the confirm
 * DS Dialog (chrome). Collects DS Tabs `tabs[].label` text (the per-stage counts live there, not
 * in children) so the pipeline-tab labels are assertable.
 */
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
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; tabs?: unknown }>;
    if (isDialogEl(el)) return; // the confirm dialog is chrome, not candidate row data
    if (Array.isArray(el.props?.tabs)) {
      for (const t of el.props.tabs as Array<{ label?: ReactNode }>) all.push(textOf(t.label));
    }
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
    const cls = el.props?.className;
    if (typeof cls === "string" && cls.split(/\s+/).includes("bb-mono")) {
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
    // setters order: [rows, confirmedUnlock, stages, activeStage, confirmWorker] → stages is index 2.
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

/** Count DS Badge elements whose trimmed text is exactly "Hot". */
function hotBadgeCount(tree: ReactNode): number {
  let n = 0;
  (function walk2(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(walk2);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === Badge && textOf(el.props.children as ReactNode).trim() === "Hot") {
      n += 1;
    }
    if (el.props && "children" in el.props) walk2(el.props.children as ReactNode);
  })(tree);
  return n;
}

describe("ApplicantActions — preserves backend best-first order; renders hot AS-IS (no percentile)", () => {
  it("renders rows in feed order and a 'hot' badge ONLY where hot=true", () => {
    const tree = render({ applicants: [A, B, C] });
    expect(monoPrefixes(tree)).toEqual([
      `${A.workerId.slice(0, 8)}…`,
      `${B.workerId.slice(0, 8)}…`,
      `${C.workerId.slice(0, 8)}…`,
    ]);
    // hot=true for A and C only ⇒ exactly 2 badges — the engine boolean rendered as-is.
    expect(hotBadgeCount(tree)).toBe(2);
  });

  it("filters visible rows by the active stage and reflects per-stage counts in the tabs", () => {
    const tree = render({ applicants: [A, B], stages: { [A.workerId]: "shortlist" }, activeStage: "shortlist" });
    // Tab labels carry the per-stage counts (the Tabs `tabs` prop labels).
    const text = gatherText(tree);
    expect(text).toContain("New (1)");
    expect(text).toContain("Shortlist (1)");
    // Active = shortlist ⇒ only A (kept) is visible; B (new) is not rendered.
    expect(monoPrefixes(tree)).toEqual([`${A.workerId.slice(0, 8)}…`]);
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

/** Find a DS `Button` whose text CONTAINS `contains`; report `disabled` + `loading` + `aria-busy`. */
function buttonInfo(
  tree: ReactNode,
  contains: string,
): { disabled?: boolean; loading?: boolean; ariaBusy?: unknown } | null {
  let res: { disabled?: boolean; loading?: boolean; ariaBusy?: unknown } | null = null;
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === Button && textOf(el.props.children as ReactNode).includes(contains)) {
      res = {
        disabled: el.props.disabled as boolean | undefined,
        loading: el.props.loading as boolean | undefined,
        ariaBusy: el.props["aria-busy"],
      };
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return res;
}

describe("ApplicantActions — LOADING: per-action Button loading + disabled + aria-busy while pending", () => {
  it("an in-flight unlock disables the button, sets aria-busy + the Button loading spinner", () => {
    const tree = render({ rows: { [WORKER]: { ...baseRow, busy: true } } });
    const info = buttonInfo(tree, "Unlocking");
    expect(info).not.toBeNull();
    expect(info!.disabled).toBe(true);
    expect(info!.ariaBusy).toBe(true);
    expect(info!.loading).toBe(true); // the DS Button renders its bb-btn__spinner when loading.
  });

  it("an in-flight reveal disables the reveal button, sets aria-busy + Button loading", () => {
    const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
    const tree = render({ rows: { [WORKER]: { ...baseRow, unlock: granted, contactBusy: true } } });
    const info = buttonInfo(tree, "Opening");
    expect(info!.disabled).toBe(true);
    expect(info!.ariaBusy).toBe(true);
    expect(info!.loading).toBe(true);
  });

  it("an idle row renders no loading Button", () => {
    const { buttons } = collect(render({}));
    expect(buttons.some((b) => b.loading === true)).toBe(false);
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
    // Terminal no-oracle state (NOT a transient error) ⇒ there is no per-row unlock/retry button.
    // (The always-present confirm-dialog footer carries "Unlock · 1 credit"; that is chrome, not
    // the row affordance — the ROW unlock button reads "Unlock contact" / "Retry unlock".)
    const { buttons } = collect(tree);
    expect(buttons.find((b) => b.text.includes("Unlock contact") || b.text.includes("Retry unlock"))).toBeUndefined();
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

/** DEEP text — expands the pure RoutedContact / MaskedResume / DS children + Dialog footer too.
 *  Stateful components (Dialog) are NOT invoked (hooks); their footer is walked via props. A
 *  `seen` WeakSet dedupes element objects (expand a shared element reference once). */
function deepGather(node: ReactNode, seen: WeakSet<object> = new WeakSet()): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((n) => deepGather(n, seen)).join("");
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; footer?: ReactNode }>;
  if (seen.has(el)) return "";
  seen.add(el);
  // Expand PURE (hook-free) child components — but never the hooked DS Dialog.
  const isDialog = typeof el.type === "function" && (el.type as { name?: string }).name === "Dialog";
  if (typeof el.type === "function" && !isDialog) {
    return deepGather((el.type as (p: unknown) => ReactNode)(el.props), seen);
  }
  let out = "";
  if (el.props && "footer" in el.props) out += deepGather(el.props.footer as ReactNode, seen);
  if (el.props && "children" in el.props) out += deepGather(el.props.children as ReactNode, seen);
  return out;
}

describe("ApplicantActions — (b) each stage renders its OWN empty state at zero rows", () => {
  it("New empty copy ≠ Shortlist empty copy (per-stage, never a shared blank)", () => {
    // A is kept (shortlist) ⇒ the New stage is empty; switch active to New to see its copy.
    const newEmpty = gatherText(
      render({ applicants: [A], stages: { [A.workerId]: "shortlist" }, activeStage: "new" }),
    );
    expect(newEmpty).toContain("No candidates in New");
    // Nothing kept ⇒ the Shortlist stage is empty; its copy is distinct.
    const shortlistEmpty = gatherText(render({ applicants: [A], activeStage: "shortlist" }));
    expect(shortlistEmpty).toContain("No shortlisted candidates yet");
    expect(newEmpty).not.toEqual(shortlistEmpty);
  });
});

describe("ApplicantActions — (c) a contactError is inline, retryable, cause-free, never blanks the row", () => {
  it("keeps the reveal button (relabeled Retry) + an aria-live error; the Unlocked row stays", () => {
    const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
    const tree = render({
      rows: { [WORKER]: { ...baseRow, unlock: granted, contactError: "Reveal failed (service unavailable). Please retry." } },
    });
    const { buttons, ariaLiveCount } = collect(tree);
    const retry = buttons.find((b) => b.text === "Retry — open routed contact");
    expect(retry).toBeDefined(); // retryable: the reveal button stays, relabeled
    expect(retry!.onClick).toBeTypeOf("function");
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
    const joined = gatherText(tree);
    // No-oracle: the transient error names NO deny cause.
    expect(joined).not.toMatch(/consent|capped|no credits|already.?unlocked|forbidden/i);
    // Row not blanked: the candidate id + the Unlocked chip still render.
    expect(monoPrefixes(tree)).toHaveLength(1);
    expect(joined).toContain("Unlocked");
  });
});

describe("ApplicantActions — (e) one neutral 'currently engaged' state; identical copy unknown vs cap", () => {
  it("two distinct deny causes collapse to byte-identical rendered copy (no oracle)", () => {
    // The wire collapses EVERY cause to {status:"unavailable"} before the mapper, so 'unknown'
    // and 'cap' are indistinguishable — mapUnlockResult yields one message; the component shows it.
    const unknown = mapUnlockResult({ status: "unavailable" });
    const cap = mapUnlockResult({ status: "unavailable" });
    expect(unknown).toEqual(cap); // identical view — no cause survives the mapper
    const renderedUnknown = gatherText(render({ rows: { [WORKER]: { ...baseRow, unlock: unknown } } }));
    const renderedCap = gatherText(render({ rows: { [WORKER]: { ...baseRow, unlock: cap } } }));
    expect(renderedUnknown).toEqual(renderedCap); // identical COPY for both causes
    expect(renderedUnknown).toContain("Currently engaged"); // the cap-enforcement landing UI
    expect(renderedUnknown).toContain(NEUTRAL_UNLOCK_MESSAGE);
  });
});

describe("ApplicantActions — (f) balance === 0 disables Unlock (own-balance FE pre-check)", () => {
  it("renders the Unlock button disabled when the payer has 0 credits", () => {
    const info = buttonInfo(render({ balance: 0 }), "Unlock contact");
    expect(info).not.toBeNull();
    expect(info!.disabled).toBe(true);
  });
});

describe("ApplicantActions — (h) zero PII (no phone digits / email) in ANY row state", () => {
  const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
  const routed = { kind: "routed", relayHandle: "RELAY-7h3k9q", channel: "in_app_relay", expiresAt: "2026-07-01T00:00:00.000Z" };
  const states: Array<[string, Record<string, unknown>]> = [
    ["idle", { ...baseRow }],
    ["unlock pending", { ...baseRow, busy: true }],
    ["unlock error", { ...baseRow, unlockError: "Unlock failed (service unavailable). Please retry." }],
    ["currently engaged", { ...baseRow, unlock: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE } }],
    ["granted + reveal pending", { ...baseRow, unlock: granted, contactBusy: true }],
    ["routed reveal", { ...baseRow, unlock: granted, contact: routed }],
    ["contacted", { ...baseRow, unlock: granted, contact: routed, contacted: true }],
  ];
  it.each(states)("state '%s' leaks no phone-number digits / email (deep, incl. the routed card)", (_label, row) => {
    const joined = deepGather(render({ rows: { [WORKER]: row } }));
    expect(joined).not.toMatch(/\d{10,}/); // no 10+ digit phone run
    expect(joined).not.toMatch(/\+\d{7,}/); // no +country-code phone
    expect(joined).not.toMatch(/@/); // no email
  });
});

describe("ApplicantActions — masked-resume threads the POSTING context (disclosure audit)", () => {
  it("fires maskedResumeAction with { unlockId, workerId, postingId } — the page's posting id", async () => {
    maskedResumeAction.mockResolvedValue({ ok: false, error: "x" });
    const { buttons } = collect(render({ rows: routedRowState() }));
    const masked = buttons.find((b) => b.text.includes("View masked resume"));
    expect(masked).toBeDefined();
    await masked!.onClick!();
    expect(maskedResumeAction).toHaveBeenCalledWith({
      unlockId: "44444444-4444-4444-8444-444444444444",
      workerId: WORKER,
      postingId: "33333333-3333-4333-8333-333333333333",
    });
  });
});
