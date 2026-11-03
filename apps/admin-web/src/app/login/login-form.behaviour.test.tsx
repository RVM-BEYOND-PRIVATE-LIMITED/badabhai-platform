import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../../test/hook-harness";

/**
 * The sign-in form, driven step by step (ADR-0060). The node env has no reconciler, so
 * `useState` / `useId` run on the hook harness, `useTransition` runs its callback and keeps the
 * promise for the test to await, effects are skipped, and each step's tree is WALKED (child
 * components such as `PasswordInput` are found by type and driven through their props).
 *
 * What it pins is the FLOW the server dictates: a session goes straight in from either first
 * factor, a temporary password leads to "Set a new password", and only an MFA answer shows the
 * authenticator step — the one place "Trust this device" appears, and the only thing it does is
 * ask (`trustDevice: true` to the action; the token never comes back here).
 */
const h = vi.hoisted(() => ({
  harness: null as unknown,
  inFlight: [] as Promise<unknown>[],
  replace: vi.fn(),
  refresh: vi.fn(),
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => harness().useId(),
    useRef: () => ({ current: null }),
    useEffect: () => undefined,
    useTransition: () => [
      false,
      (fn: () => Promise<unknown> | void) => {
        const out = fn();
        if (out) h.inFlight.push(out);
      },
    ],
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}));

const actions = vi.hoisted(() => ({
  passwordLoginAction: vi.fn(),
  requestCodeAction: vi.fn(),
  verifyCodeAction: vi.fn(),
  verifyMfaAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { LoginForm } = await import("./login-form");
const { PasswordInput } = await import("../../components/password-input");
const { NewPasswordFields } = await import("../../components/new-password-fields");
const { AuthenticatorEnrollment } = await import("../../components/authenticator-enrollment");

// ── tree walking ────────────────────────────────────────────────────────────────────────────

type El = ReactElement<Record<string, unknown>>;

function all(node: ReactNode, match: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) all(child as ReactNode, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (match(el)) out.push(el);
  all(el.props.children as ReactNode, match, out);
  return out;
}
const one = (node: ReactNode, match: (el: El) => boolean, what: string): El => {
  const found = all(node, match);
  expect(found, what).toHaveLength(1);
  return found[0]!;
};
const text = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map((n) => text(n as ReactNode)).join("")
      : isValidElement(node)
        ? text((node as El).props.children as ReactNode)
        : "";

const tag = (name: string) => (el: El) => el.type === name;
const typed = (type: unknown) => (el: El) => el.type === type;
const named = (name: string) => (el: El) => el.type === "input" && el.props.name === name;

let tree: ReactNode;
let method: "password" | "code" = "password";
const render = () => {
  tree = harness().render(() => LoginForm({ method }));
  return tree;
};
const heading = () => text(one(tree, tag("h1"), "the step heading").props.children as ReactNode);
const type = (el: El, value: string) =>
  (el.props.onChange as (e: unknown) => void)({ target: { value } });
const submit = async () => {
  (one(tree, tag("form"), "the step's form").props.onSubmit as (e: unknown) => void)({
    preventDefault: () => undefined,
  });
  await Promise.all(h.inFlight.splice(0));
  render();
};

beforeEach(() => {
  h.harness = createHookHarness();
  h.inFlight = [];
  h.replace.mockReset();
  h.refresh.mockReset();
  for (const fn of Object.values(actions)) fn.mockReset();
  method = "password";
});

// ── the password door ───────────────────────────────────────────────────────────────────────

describe("email + password", () => {
  async function signIn() {
    render();
    type(one(tree, named("email"), "the email field"), "ops@example.com");
    (one(tree, typed(PasswordInput), "the password field").props.onChange as (v: string) => void)(
      "hunter22",
    );
    render();
    await submit();
  }

  it("a session goes straight in — no authenticator step", async () => {
    actions.passwordLoginAction.mockResolvedValueOnce({ ok: true, next: "signed_in" });
    await signIn();
    expect(actions.passwordLoginAction).toHaveBeenCalledWith({
      email: "ops@example.com",
      password: "hunter22",
    });
    expect(h.replace).toHaveBeenCalledWith("/");
    expect(h.refresh).toHaveBeenCalled();
    expect(actions.verifyMfaAction).not.toHaveBeenCalled();
  });

  it("a refusal stays on the step with the action's message", async () => {
    actions.passwordLoginAction.mockResolvedValueOnce({ ok: false, error: "Nope." });
    await signIn();
    expect(heading()).toBe("Admin sign-in");
    expect(text(one(tree, (el) => el.props.role === "status", "the status line"))).toContain(
      "Nope.",
    );
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("a temporary password → set a new one → MFA with enrolment → trust this device", async () => {
    actions.passwordLoginAction
      .mockResolvedValueOnce({ ok: true, next: "change_password" })
      .mockResolvedValueOnce({
        ok: true,
        next: "mfa",
        needsEnrollment: true,
        enrollment: { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" },
      });
    actions.verifyMfaAction.mockResolvedValueOnce({ ok: true });
    await signIn();

    // Step 2: set a new password. No trust box, no authenticator yet.
    expect(heading()).toBe("Set a new password");
    expect(all(tree, named("trust_device"))).toHaveLength(0);
    const pair = one(tree, typed(NewPasswordFields), "the new-password pair");
    (pair.props.onChange as (v: string) => void)("MyOwnPass9");
    (pair.props.onConfirmChange as (v: string) => void)("MyOwnPass9");
    render();
    await submit();
    expect(actions.passwordLoginAction).toHaveBeenLastCalledWith({
      email: "ops@example.com",
      password: "hunter22",
      newPassword: "MyOwnPass9",
    });

    // Step 3: the authenticator, with the QR from the server and the trust box.
    expect(heading()).toBe("Set up your authenticator");
    expect(one(tree, typed(AuthenticatorEnrollment), "the QR block").props.secret).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    expect(text(tree)).toContain("Your new password is saved");
    const trust = one(tree, named("trust_device"), "the trust-this-device box");
    expect(trust.props.type).toBe("checkbox");
    expect(trust.props.checked).toBe(false);
    (trust.props.onChange as (e: unknown) => void)({ target: { checked: true } });
    type(
      one(tree, (el) => el.type === "input" && el.props.autoComplete === "one-time-code", "code"),
      "123456",
    );
    render();
    await submit();
    expect(actions.verifyMfaAction).toHaveBeenCalledWith({
      email: "ops@example.com",
      code: "123456",
      trustDevice: true,
    });
    expect(h.replace).toHaveBeenCalledWith("/");
  });

  it("a mismatched confirmation never submits the new password", async () => {
    actions.passwordLoginAction.mockResolvedValueOnce({ ok: true, next: "change_password" });
    await signIn();
    const pair = one(tree, typed(NewPasswordFields), "the new-password pair");
    (pair.props.onChange as (v: string) => void)("MyOwnPass9");
    (pair.props.onConfirmChange as (v: string) => void)("MyOwnPass8");
    render();
    await submit();
    expect(actions.passwordLoginAction).toHaveBeenCalledTimes(1);
  });

  it("MFA without trust: the box is unticked by default and nothing is asked", async () => {
    actions.passwordLoginAction.mockResolvedValueOnce({
      ok: true,
      next: "mfa",
      needsEnrollment: false,
    });
    actions.verifyMfaAction.mockResolvedValueOnce({ ok: true });
    await signIn();
    expect(heading()).toBe("MFA code");
    expect(all(tree, typed(AuthenticatorEnrollment))).toHaveLength(0);
    type(
      one(tree, (el) => el.type === "input" && el.props.autoComplete === "one-time-code", "code"),
      "654321",
    );
    render();
    await submit();
    expect(actions.verifyMfaAction).toHaveBeenCalledWith({
      email: "ops@example.com",
      code: "654321",
      trustDevice: false,
    });
  });

  it("Start over from the MFA step returns to the first step with the password cleared", async () => {
    actions.passwordLoginAction.mockResolvedValueOnce({
      ok: true,
      next: "mfa",
      needsEnrollment: false,
    });
    await signIn();
    const startOver = one(
      tree,
      (el) => el.type === "button" && text(el.props.children as ReactNode).includes("Start over"),
      "Start over",
    );
    (startOver.props.onClick as () => void)();
    render();
    expect(heading()).toBe("Admin sign-in");
    expect(one(tree, typed(PasswordInput), "the password field").props.value).toBe("");
  });
});

// ── the emailed-code door ───────────────────────────────────────────────────────────────────

describe("email + emailed code", () => {
  async function reachCodeStep() {
    method = "code";
    actions.requestCodeAction.mockResolvedValueOnce({ ok: true, resendInSeconds: 30 });
    render();
    expect(heading()).toBe("Sign in with an email code");
    type(one(tree, named("email"), "the email field"), "ops@example.com");
    render();
    await submit();
    expect(heading()).toBe("Check your email");
    type(
      one(tree, (el) => el.type === "input" && el.props.autoComplete === "one-time-code", "code"),
      "123456",
    );
    render();
  }

  it("a session (2FA off) goes straight in from the code — ADR-0060", async () => {
    await reachCodeStep();
    actions.verifyCodeAction.mockResolvedValueOnce({ ok: true, next: "signed_in" });
    await submit();
    expect(actions.verifyCodeAction).toHaveBeenCalledWith({
      email: "ops@example.com",
      code: "123456",
    });
    expect(h.replace).toHaveBeenCalledWith("/");
  });

  it("MFA required: the authenticator step, with the trust box", async () => {
    await reachCodeStep();
    actions.verifyCodeAction.mockResolvedValueOnce({
      ok: true,
      next: "mfa",
      needsEnrollment: false,
    });
    await submit();
    expect(heading()).toBe("MFA code");
    expect(all(tree, named("trust_device"))).toHaveLength(1);
    expect(h.replace).not.toHaveBeenCalled();
  });
});
