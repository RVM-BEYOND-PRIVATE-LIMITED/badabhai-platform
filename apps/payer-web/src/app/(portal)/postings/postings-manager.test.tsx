import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { PostingSummary } from "../../../lib/contracts";

/**
 * POSTINGS-MANAGER tests — CONFIRM-ON-SPEND (C11) + A11Y-OF-FAILURE (B8).
 *
 * C11: a quota TOP-UP and a PAUSE both call `window.confirm` BEFORE the Server Action. A
 * declined confirm (→ false) blocks the action; an accepted confirm (→ true) proceeds.
 * B8: each per-row error region is wrapped in `aria-live="polite"`, so an assistive
 * technology announces a row failure.
 *
 * Env is node (no DOM); we inject React state via mocked hooks, render the component to an
 * element tree, find a row button by its label, fire its onClick, and assert the action
 * call / confirm gate. `useTransition` → [false, run-immediately]; `window.confirm` is mocked.
 */

const pausePostingAction = vi.fn();
const resumePostingAction = vi.fn();
const topUpQuotaAction = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("./actions", () => ({
  pausePostingAction: (i: { postingId: string }) => pausePostingAction(i),
  resumePostingAction: (i: { postingId: string }) => resumePostingAction(i),
  topUpQuotaAction: (i: { postingId: string }) => topUpQuotaAction(i),
}));

// Inject React state via a mocked useState (source order: rows, busyId, errorById).
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

function render(postings: PostingSummary[], errorById: Record<string, string | null> = {}) {
  // useState order: rows, busyId, errorById.
  stateQueue = [postings, null, errorById];
  stateCursor = 0;
  return PostingsManager({ postings }) as ReactElement;
}

// The env is `node` (no DOM) — stub a minimal `window` so the component's `window.confirm`
// spend gate resolves to a mock we can assert on.
const confirmMock = vi.fn();
vi.stubGlobal("window", { confirm: confirmMock });

beforeEach(() => {
  pausePostingAction.mockReset().mockResolvedValue({ ok: true, posting: OPEN });
  resumePostingAction.mockReset().mockResolvedValue({ ok: true, posting: OPEN });
  topUpQuotaAction.mockReset().mockResolvedValue({ ok: true, posting: { ...OPEN, applicantQuota: 20 } });
  refresh.mockReset();
  useState.mockClear();
  useTransition.mockClear();
  confirmMock.mockReset();
});

describe("PostingsManager — CONFIRM-ON-SPEND on quota top-up (C11)", () => {
  it("a DECLINED confirm (false) blocks the top-up action", () => {
    confirmMock.mockReturnValue(false);
    const { buttons } = collect(render([OPEN]));
    const topUp = buttons.find((b) => b.text.includes("Top up applicant quota"));
    expect(topUp).toBeDefined();
    topUp!.onClick!();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(topUpQuotaAction).not.toHaveBeenCalled();
  });

  it("an ACCEPTED confirm (true) proceeds to the top-up action with ONLY the posting id (no amount)", () => {
    confirmMock.mockReturnValue(true);
    const { buttons } = collect(render([OPEN]));
    const topUp = buttons.find((b) => b.text.includes("Top up applicant quota"));
    topUp!.onClick!();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(topUpQuotaAction).toHaveBeenCalledWith({ postingId: OPEN.id });
    // XT5: the client sends only the id — no amount/price/quota number.
    const arg = topUpQuotaAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg)).toEqual(["postingId"]);
  });
});

describe("PostingsManager — CONFIRM-ON-SPEND on pause (C3/C11)", () => {
  it("a DECLINED confirm blocks the pause; an ACCEPTED one proceeds", () => {
    confirmMock.mockReturnValueOnce(false);
    let buttons = collect(render([OPEN])).buttons;
    buttons.find((b) => b.text === "Pause")!.onClick!();
    expect(pausePostingAction).not.toHaveBeenCalled();

    confirmMock.mockReturnValue(true);
    buttons = collect(render([OPEN])).buttons;
    buttons.find((b) => b.text === "Pause")!.onClick!();
    expect(pausePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
  });
});

describe("PostingsManager — A11Y-OF-FAILURE: per-row error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' error container per row", () => {
    const { ariaLiveCount } = collect(render([OPEN]));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });

  it("renders one aria-live region per posting row (announces a row failure)", () => {
    const second = { ...OPEN, id: "bbbb2222-0000-4000-8000-000000000002" };
    const { ariaLiveCount } = collect(render([OPEN, second]));
    expect(ariaLiveCount).toBe(2);
  });
});
