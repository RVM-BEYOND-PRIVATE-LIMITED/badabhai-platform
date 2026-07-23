import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { AgencyKyc } from "../../../../lib/contracts";

/**
 * KycPanel tests — client-side validation MIRRORS the DTO + MASKED-only status display.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * current, form, errors, submitError). `useTransition` → [false, run-immediately]. The
 * submit handler reads the injected `form` state, so a valid/invalid seed exercises the
 * parse path with the action mocked.
 */

const submitKycAction = vi.fn();
vi.mock("./supply-actions", () => ({ submitKycAction: (i: unknown) => submitKycAction(i) }));

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

const { KycPanel } = await import("./kyc-panel");

interface Collected {
  types: string[];
  text: string[];
  forms: Array<{ onSubmit?: (e: { preventDefault: () => void }) => void }>;
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") return void acc.text.push(node);
  if (typeof node === "number") return void acc.text.push(String(node));
  if (Array.isArray(node)) return void node.forEach((c) => walk(c, acc));
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  if (el.type === "form") {
    acc.forms.push({
      onSubmit: el.props.onSubmit as ((e: { preventDefault: () => void }) => void) | undefined,
    });
  }
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], text: [], forms: [] };
  walk(tree, acc);
  return acc;
}

function render(current: AgencyKyc, form?: Record<string, string>) {
  // useState order: current, form, errors, submitError.
  stateQueue = [current, form ?? { pan: "", bankAccount: "", ifsc: "", accountHolderName: "" }, {}, null];
  stateCursor = 0;
  return KycPanel({ kyc: current }) as ReactElement;
}

const NOT_SUBMITTED: AgencyKyc = {
  status: "not_submitted",
  panLast4: null,
  bankLast4: null,
  rejectReason: null,
  updatedAt: null,
};
const VERIFIED: AgencyKyc = {
  status: "verified",
  panLast4: "234F",
  bankLast4: "6789",
  rejectReason: null,
  updatedAt: "2026-07-23T00:00:00.000Z",
};
const VALID_FORM = {
  pan: "abcde1234f",
  bankAccount: "123456789",
  ifsc: "hdfc0001234",
  accountHolderName: "Acme Tools",
};

beforeEach(() => {
  submitKycAction.mockReset().mockResolvedValue({ ok: true, kyc: { ...NOT_SUBMITTED, status: "pending" } });
  useState.mockClear();
  useTransition.mockClear();
});

describe("KycPanel — status-driven rendering (masked only)", () => {
  it("not_submitted → shows the KYC form", () => {
    const { types } = collect(render(NOT_SUBMITTED));
    expect(types).toContain("form");
  });

  it("verified → NO form; shows the green Verified state + masked last-4 (never a full number)", () => {
    const { types, text } = collect(render(VERIFIED));
    expect(types).not.toContain("form");
    const joined = text.join(" ");
    expect(joined).toContain("Verified");
    expect(joined).toContain("••••234F");
    expect(joined).toContain("••••6789");
    // No full PAN / account number is ever present.
    expect(joined).not.toContain("ABCDE1234F");
    expect(joined).not.toContain("123456789");
  });
});

describe("KycPanel — client validation mirrors the DTO", () => {
  function submit(tree: ReactElement) {
    const { forms } = collect(tree);
    expect(forms[0]?.onSubmit).toBeDefined();
    forms[0]!.onSubmit!({ preventDefault: () => {} });
  }

  it("a valid form calls the action with uppercased PAN/IFSC", () => {
    submit(render(NOT_SUBMITTED, VALID_FORM));
    expect(submitKycAction).toHaveBeenCalledWith({
      pan: "ABCDE1234F",
      bankAccount: "123456789",
      ifsc: "HDFC0001234",
      accountHolderName: "Acme Tools",
    });
  });

  it("an invalid PAN is rejected inline; the action is NEVER called", () => {
    submit(render(NOT_SUBMITTED, { ...VALID_FORM, pan: "NOPE" }));
    expect(submitKycAction).not.toHaveBeenCalled();
  });
});
