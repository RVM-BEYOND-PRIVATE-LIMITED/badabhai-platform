import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { createHookHarness, findByType, propsOf, textOf } from "../../../test/hook-harness";

/**
 * #2588 (W8) — the login code step's six boxes (components/otp-input.tsx), followed through real
 * state changes (test/hook-harness.ts). OtpCodeInput is an element in the frame, so a test plays
 * the payer's typing by calling the props the form handed it — `onChange`, then `onComplete` on the
 * edit that completes the code, in the order the input reports it — and reads the next frame.
 *
 * Locks: the sixth digit submits through the same verify as the Verify button (signin and signup
 * alike); an accepted code stays readable — locked in the boxes, with the check — while the
 * dashboard opens; a refused code clears the boxes and re-arms them (a fresh input, focus on its
 * first box), so the next sixth digit submits again.
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
const navigate = vi.fn();
vi.mock("../../components/portal-navigation", () => ({
  usePortalNavigation: () => ({ pending: false, navigate }),
}));
const actions = {
  requestCodeAction: vi.fn(),
  signupAction: vi.fn(),
  verifyCodeAction: vi.fn(),
  passwordSignInAction: vi.fn(),
  setNewPasswordAction: vi.fn(),
};
vi.mock("./actions", () => ({
  requestCodeAction: (i: unknown) => actions.requestCodeAction(i),
  signupAction: (i: unknown) => actions.signupAction(i),
  verifyCodeAction: (i: unknown) => actions.verifyCodeAction(i),
  passwordSignInAction: (i: unknown) => actions.passwordSignInAction(i),
  setNewPasswordAction: (i: unknown) => actions.setNewPasswordAction(i),
}));

const { LoginForm } = await import("./login-form");
const { OtpCodeInput } = await import("../../components/otp-input");
const { Button, Toast } = await import("../../components/ds");
const { NEUTRAL_VERIFY_ERROR } = await import("./messages");

const EMAIL = "owner@example.com";
const DASHBOARD = ["/dashboard", { pendingLabel: "Dashboard", replace: true, refresh: true }];
const TOO_SHORT = "Enter the numeric code (4–8 digits).";

// LoginForm's useState order (login-form.tsx): mode 1, step 2, email 3, code 6, method 15.
const SLOT = { mode: 1, step: 2, email: 3, code: 6, method: 15 } as const;

let focused: string[] = [];
beforeEach(() => {
  focused = [];
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({ focus: () => focused.push(id) }),
  });
  navigate.mockReset();
  for (const fn of Object.values(actions)) fn.mockReset();
});

const render = () => h.render(LoginForm as (props: undefined) => ReactElement, undefined);

/** A fresh code step for EMAIL with `code` already typed; `mode` is the door the payer came in by. */
function openCodeStep(code = "", mode: "signin" | "signup" = "signin"): ReactElement {
  const seed: unknown[] = [];
  seed[SLOT.mode] = mode;
  seed[SLOT.step] = "code";
  seed[SLOT.email] = EMAIL;
  seed[SLOT.code] = code;
  seed[SLOT.method] = "code";
  h.reset(seed);
  return render();
}

/** The code step's one OTP input. */
function boxesOf(tree: ReactNode): ReactElement {
  const all = findByType(tree, OtpCodeInput);
  expect(all).toHaveLength(1);
  return all[0]!;
}
const edit = (tree: ReactNode, code: string) =>
  (propsOf(boxesOf(tree)).onChange as (value: string) => void)(code);
/** The edit that completes the code, as OtpCodeInput reports it: onChange, then onComplete. */
function completeCode(tree: ReactNode, code: string) {
  const boxes = propsOf(boxesOf(tree));
  (boxes.onChange as (value: string) => void)(code);
  (boxes.onComplete as (value: string) => void)(code);
}
/** Verify, or Enter in a box. */
const submit = (tree: ReactNode) =>
  (propsOf(findByType(tree, "form")[0]!).onSubmit as (e: { preventDefault: () => void }) => void)({
    preventDefault: () => {},
  });
const button = (tree: ReactNode, text: string) =>
  findByType(tree, Button).find((b) => textOf(propsOf(b).children as ReactNode).includes(text));
const toastText = (tree: ReactNode, tone: string) => {
  const toast = findByType(tree, Toast).find((t) => propsOf(t).tone === tone);
  return toast ? textOf(propsOf(toast).children as ReactNode) : undefined;
};

describe("the sixth digit signs in", () => {
  it.each(["signin", "signup"] as const)(
    "from %s: one verify with the code, then the dashboard — the code stays readable, locked, with the check",
    async (mode) => {
      actions.verifyCodeAction.mockResolvedValue({ ok: true, isNewPayer: mode === "signup" });
      completeCode(openCodeStep("12345", mode), "123456");
      expect(actions.verifyCodeAction).toHaveBeenCalledTimes(1);
      expect(actions.verifyCodeAction).toHaveBeenCalledWith({ email: EMAIL, code: "123456" });
      await h.settle();
      const tree = render();
      expect(propsOf(boxesOf(tree))).toMatchObject({ value: "123456", success: true });
      expect(propsOf(button(tree, "Signed in")!)).toMatchObject({ variant: "success", disabled: true });
      expect(toastText(tree, "success")).toBe(
        mode === "signup" ? "Account created — welcome!" : "Welcome back!",
      );
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(...DASHBOARD);
    },
  );

  it("a box edited while the code is checked: the boxes show the code that was accepted", async () => {
    actions.verifyCodeAction.mockResolvedValue({ ok: true, isNewPayer: false });
    completeCode(openCodeStep("12345"), "123456");
    // Backspace on the sixth box before the answer is in.
    edit(render(), "12345");
    await h.settle();
    expect(propsOf(boxesOf(render()))).toMatchObject({ value: "123456", success: true });
  });
});

describe("a refused code clears the boxes and re-arms them", () => {
  it("empty, a fresh input whose first box takes focus, the neutral error shown — no portal", async () => {
    actions.verifyCodeAction.mockResolvedValue({ ok: false, error: NEUTRAL_VERIFY_ERROR });
    const first = openCodeStep("12345");
    const before = boxesOf(first);
    completeCode(first, "123456");
    await h.settle();
    const tree = render();
    const after = boxesOf(tree);
    expect(propsOf(after)).toMatchObject({ value: "", success: false, autoFocus: true });
    // A new key remounts it: its first box takes focus on mount, and none of the refused code's
    // editing state carries over.
    expect(after.key).not.toBe(before.key);
    expect(toastText(tree, "danger")).toBe(NEUTRAL_VERIFY_ERROR);
    expect(toastText(tree, "success")).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
    // The step's heading took focus on arrival only; a refusal never sends it back there.
    expect(focused).toEqual(["login-code-heading"]);
  });

  it("the next sixth digit submits again — the new code", async () => {
    actions.verifyCodeAction.mockResolvedValueOnce({ ok: false, error: NEUTRAL_VERIFY_ERROR });
    completeCode(openCodeStep("12345"), "123456");
    await h.settle();
    actions.verifyCodeAction.mockResolvedValueOnce({ ok: true, isNewPayer: false });
    completeCode(render(), "654321");
    expect(actions.verifyCodeAction).toHaveBeenCalledTimes(2);
    expect(actions.verifyCodeAction).toHaveBeenLastCalledWith({ email: EMAIL, code: "654321" });
    await h.settle();
    const tree = render();
    expect(propsOf(boxesOf(tree))).toMatchObject({ value: "654321", success: true });
    // The old refusal is gone once the new code is in.
    expect(toastText(tree, "danger")).toBeUndefined();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("a refusal after Verify by hand clears and re-arms the same way", async () => {
    actions.verifyCodeAction.mockResolvedValue({ ok: false, error: NEUTRAL_VERIFY_ERROR });
    const first = openCodeStep("123456");
    const before = boxesOf(first);
    submit(first);
    expect(actions.verifyCodeAction).toHaveBeenCalledWith({ email: EMAIL, code: "123456" });
    await h.settle();
    const after = boxesOf(render());
    expect(propsOf(after).value).toBe("");
    expect(after.key).not.toBe(before.key);
  });
});

describe("Verify by hand", () => {
  it("submits the code in the boxes", () => {
    actions.verifyCodeAction.mockResolvedValue({ ok: true, isNewPayer: false });
    submit(openCodeStep("123456"));
    expect(actions.verifyCodeAction).toHaveBeenCalledExactlyOnceWith({ email: EMAIL, code: "123456" });
  });

  it("too few digits: the inline error, describing the boxes — nothing sent; typing clears it", () => {
    submit(openCodeStep("12"));
    expect(actions.verifyCodeAction).not.toHaveBeenCalled();
    const tree = render();
    const alert = findByType(tree, "span").find((s) => propsOf(s).role === "alert");
    expect(textOf(propsOf(alert!).children as ReactNode)).toBe(TOO_SHORT);
    expect(propsOf(boxesOf(tree)).describedBy).toBe(propsOf(alert!).id);
    edit(tree, "123");
    expect(propsOf(boxesOf(render())).describedBy).toBeUndefined();
  });
});
