import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * AGENCY-INVITE-PANEL tests — INLINE PII screen (C11) + A11Y-OF-FAILURE (B8).
 *
 * C11: a phone-like / email-like campaign tag is rejected INLINE (PHONE_OR_EMAIL) BEFORE the
 * Server Action is called; an empty tag is allowed (optional); a clean tag proceeds. The
 * inline error names the field, never echoes the offending content.
 * B8: the invite error region is wrapped in `aria-live="polite"`.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * campaign, campaignError, invite, copied, error). `useTransition` → [false, run-immediately].
 * The submit handler reads the injected `campaign` state, so a phone-like seed exercises the
 * inline reject path with the action mocked.
 */

const createInviteAction = vi.fn();
vi.mock("./invite-actions", () => ({ createInviteAction: (i: unknown) => createInviteAction(i) }));

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

const { AgencyInvitePanel } = await import("./invite-panel");

interface Collected {
  forms: Array<{ onSubmit?: (e: { preventDefault: () => void }) => void }>;
  ariaLiveCount: number;
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === "form") {
    acc.forms.push({
      onSubmit: el.props.onSubmit as ((e: { preventDefault: () => void }) => void) | undefined,
    });
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { forms: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

function render(campaign: string) {
  // useState order: campaign, campaignError, invite, copied, error.
  stateQueue = [campaign, null, null, false, null];
  stateCursor = 0;
  return AgencyInvitePanel() as ReactElement;
}

function submit(tree: ReactElement) {
  const { forms } = collect(tree);
  expect(forms[0]?.onSubmit).toBeDefined();
  forms[0]!.onSubmit!({ preventDefault: () => {} });
}

beforeEach(() => {
  createInviteAction.mockReset().mockResolvedValue({ ok: true, code: "abc123", link: "/i/abc123" });
  useState.mockClear();
  useTransition.mockClear();
});

describe("AgencyInvitePanel — INLINE PII screen rejects a phone/email tag before the action (C11)", () => {
  it("a phone-like campaign tag is rejected inline; the action is NEVER called", () => {
    submit(render("call +91 98123 45678"));
    expect(createInviteAction).not.toHaveBeenCalled();
  });

  it("an email-like campaign tag is rejected inline; the action is NEVER called", () => {
    submit(render("ping ramesh@example.com"));
    expect(createInviteAction).not.toHaveBeenCalled();
  });

  it("a clean (non-PII) campaign tag proceeds to the action", () => {
    submit(render("diwali-drive"));
    expect(createInviteAction).toHaveBeenCalledWith({ campaign: "diwali-drive" });
  });

  it("an empty tag is allowed (optional) and proceeds with campaign: undefined", () => {
    submit(render(""));
    expect(createInviteAction).toHaveBeenCalledWith({ campaign: undefined });
  });
});

describe("AgencyInvitePanel — A11Y-OF-FAILURE: error region is aria-live='polite' (B8)", () => {
  it("wraps the invite error in an aria-live='polite' region", () => {
    const { ariaLiveCount } = collect(render(""));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });
});
