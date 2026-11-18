import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import {
  createHookHarness,
  findByProp,
  findByType,
  propsOf,
  textOf,
} from "../../../../test/hook-harness";

/**
 * "Confirm your number" (#2754 item 3) — the UI states and the Idempotency-Key lifecycle.
 * Rendered through the stateful hook harness so a request → code → verify flow can be followed
 * across renders.
 */

const h = createHookHarness();
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => h.useState(initial),
    useTransition: () => h.useTransition(),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => h.useEffect(effect, deps),
  };
});

const actions = {
  requestPhoneProofAction: vi.fn(),
  verifyPhoneProofAction: vi.fn(),
};
vi.mock("./phone-proof-actions", () => ({
  requestPhoneProofAction: () => actions.requestPhoneProofAction(),
  verifyPhoneProofAction: (input: unknown) => actions.verifyPhoneProofAction(input),
}));

const { PhoneProofPrompt } = await import("./phone-proof-prompt");
const { Button, Toast } = await import("../../../components/ds");
const M = await import("./messages");

// PhoneProofPrompt's useState order: step, code, cooldown, codeError, error, provenNow,
// attemptKey, attemptCode.
const SLOT = {
  step: 0,
  code: 1,
  cooldown: 2,
  codeError: 3,
  error: 4,
  provenNow: 5,
  attemptKey: 6,
  attemptCode: 7,
} as const;

function seed(values: Partial<Record<keyof typeof SLOT, unknown>>): unknown[] {
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(values)) out[SLOT[key as keyof typeof SLOT]] = value;
  return out;
}

const render = () =>
  h.render(PhoneProofPrompt as (props: { proven: boolean; phoneLast4: string | null }) => ReactElement, {
    proven: false,
    phoneLast4: "1234",
  });
const button = (tree: ReactNode, text: string) =>
  findByType(tree, Button).find((b) => textOf(propsOf(b).children as ReactNode).includes(text));
const codeInput = (tree: ReactNode) => findByProp(tree, "id", "phone-proof-code")[0];
const click = (el: ReactElement | undefined) => {
  expect(el, "button").toBeDefined();
  (propsOf(el!).onClick as () => void)();
};

let keys: string[] = [];
beforeEach(() => {
  h.reset();
  keys = ["key-attempt-1", "key-attempt-2", "key-attempt-3"];
  vi.stubGlobal("crypto", { randomUUID: () => keys.shift() ?? "key-fallback" });
  actions.requestPhoneProofAction.mockReset();
  actions.verifyPhoneProofAction.mockReset();
});

describe("PhoneProofPrompt — the three static states", () => {
  it("proven false offers 'Confirm your number' and shows no code box yet", () => {
    const tree = render();
    expect(textOf(tree)).toContain("Confirm your number");
    expect(codeInput(tree)).toBeUndefined();
  });

  it("proven true renders the masked number as confirmed (never the full number)", () => {
    h.reset();
    const tree = h.render(
      PhoneProofPrompt as (props: { proven: boolean; phoneLast4: string | null }) => ReactElement,
      { proven: true, phoneLast4: "1234" },
    );
    expect(textOf(tree)).toContain("Confirmed");
    expect(textOf(tree)).toContain("••••1234");
    expect(textOf(tree)).not.toMatch(/\+91/);
    expect(button(tree, "Confirm your number")).toBeUndefined();
  });
});

describe("PhoneProofPrompt — request a code, then verify", () => {
  it("requesting a code reveals the input and the server's resend timer", async () => {
    actions.requestPhoneProofAction.mockResolvedValue({ ok: true, resendInSeconds: 30 });
    click(button(render(), "Confirm your number"));
    await h.settle();
    const tree = render();
    expect(codeInput(tree)).toBeDefined();
    expect(textOf(tree)).toContain("Resend code (30s)");
  });

  it("verify mints one key, sends the code, and renders confirmed on success", async () => {
    actions.verifyPhoneProofAction.mockResolvedValue({ ok: true });
    h.reset(seed({ step: "sent", code: "123456" }));
    click(button(render(), "Confirm number"));
    await h.settle();
    expect(actions.verifyPhoneProofAction).toHaveBeenCalledWith({
      code: "123456",
      idempotencyKey: "key-attempt-1",
    });
    expect(textOf(render())).toContain("Confirmed");
  });

  it("a retry of the SAME code reuses the key; editing the code mints a new one", async () => {
    actions.verifyPhoneProofAction
      .mockResolvedValueOnce({ ok: false, error: M.PHONE_PROOF_UNAVAILABLE, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true });
    h.reset(seed({ step: "sent", code: "123456" }));
    click(button(render(), "Confirm number"));
    await h.settle();
    // Same code, retry: same attempt key (a replayed success must not answer 401).
    click(button(render(), "Confirm number"));
    await h.settle();
    const calls = actions.verifyPhoneProofAction.mock.calls.map(
      (c) => c[0] as { code: string; idempotencyKey: string },
    );
    expect(calls[0]).toEqual({ code: "123456", idempotencyKey: "key-attempt-1" });
    expect(calls[1]).toEqual({ code: "123456", idempotencyKey: "key-attempt-1" });
  });

  it("a wrong code shows its own message and keeps the input open", async () => {
    actions.verifyPhoneProofAction.mockResolvedValue({
      ok: false,
      error: M.PHONE_PROOF_WRONG_CODE,
      reason: "wrong_code",
    });
    h.reset(seed({ step: "sent", code: "000000" }));
    click(button(render(), "Confirm number"));
    await h.settle();
    const tree = render();
    const toast = findByType(tree, Toast).find((t) => propsOf(t).tone === "danger");
    expect(textOf(propsOf(toast!).children as ReactNode)).toBe(M.PHONE_PROOF_WRONG_CODE);
    expect(codeInput(tree)).toBeDefined();
  });

  it("phone_changed returns to the prompt to request a new code", async () => {
    actions.verifyPhoneProofAction.mockResolvedValue({
      ok: false,
      error: M.PHONE_PROOF_PHONE_CHANGED,
      reason: "phone_changed",
    });
    h.reset(seed({ step: "sent", code: "123456" }));
    click(button(render(), "Confirm number"));
    await h.settle();
    const tree = render();
    expect(button(tree, "Confirm your number")).toBeDefined();
    expect(codeInput(tree)).toBeUndefined();
    expect(textOf(tree)).toContain(M.PHONE_PROOF_PHONE_CHANGED);
  });
});
