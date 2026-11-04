import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { createHookHarness, findByProp, findByType, propsOf, textOf } from "../../../test/hook-harness";

/**
 * #2587 — the login card's password flows, followed through real state changes
 * (test/hook-harness.ts). The children (PasswordSignInForm, SetNewPasswordStep) are elements in
 * the frame, so a test plays a child's event by calling the prop the card handed it, then reads the
 * next frame: what the card shows, what it passed down, where focus went, and whether it navigated.
 *
 * Locks: password sign-in is the default sign-in view (signup stays the code flow); the switch both
 * ways, carrying what was typed; the set-new-password step replaces the card (no tabs) and drops the
 * temporary password the moment it is no longer needed; only a signed-in child navigates; the code
 * door's temporary-password answer (409) lands on the password form, not the portal.
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

const { LoginForm, loginFocusTarget } = await import("./login-form");
const { PasswordSignInForm, IDENTIFIER_FIELD_ID, PASSWORD_FIELD_ID } = await import("./password-sign-in");
const { SetNewPasswordStep, NEW_PASSWORD_HEADING_ID } = await import("./set-new-password");
const { Button, Input, Tabs } = await import("../../components/ds");
const { OtpCodeInput } = await import("../../components/otp-input");
const { PASSWORD_SIGNIN_ERROR, TEMPORARY_PASSWORD_REQUIRED } = await import("./messages");

const TEMPORARY = "Xk7mPq2rTn9wZa";
const DASHBOARD = ["/dashboard", { pendingLabel: "Dashboard", replace: true, refresh: true }];

// LoginForm's useState order: role 0, mode 1, step 2, email 3, orgName 4, phone 5, code 6,
// emailError 7, orgError 8, phoneError 9, codeError 10, error 11, info 12, cooldown 13,
// succeeded 14, method 15, identifier 16, change 17, arrival 18, codeAttempt 19.
const SLOT = { mode: 1, step: 2, email: 3, code: 6, method: 15, arrival: 18 } as const;
function seed(values: Partial<Record<keyof typeof SLOT, unknown>>): unknown[] {
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(values)) out[SLOT[key as keyof typeof SLOT]] = value;
  return out;
}

let focused: string[] = [];
beforeEach(() => {
  h.reset();
  focused = [];
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({ focus: () => focused.push(id) }),
  });
  navigate.mockReset();
  for (const fn of Object.values(actions)) fn.mockReset();
});

const render = () => h.render(LoginForm as (props: undefined) => ReactElement, undefined);
const passwordForm = (tree: ReactNode) => findByType(tree, PasswordSignInForm)[0];
const changeStep = (tree: ReactNode) => findByType(tree, SetNewPasswordStep)[0];
const emailField = (tree: ReactNode) => findByType(tree, Input).find((i) => propsOf(i).label === "Email");
/** Play a child's event: call the prop the card handed it. */
const play = (el: ReactElement | undefined, prop: string, ...args: unknown[]) => {
  expect(el, `element for ${prop}`).toBeDefined();
  (propsOf(el!)[prop] as (...a: unknown[]) => unknown)(...args);
};
const button = (tree: ReactNode, text: string) =>
  findByType(tree, Button).find((b) => textOf(propsOf(b).children as ReactNode).includes(text));
const pickMode = (tree: ReactNode, mode: "signin" | "signup") => {
  const radios = findByProp(tree, "name", "auth-mode");
  (propsOf(radios[mode === "signin" ? 0 : 1]!).onChange as () => void)();
};

describe("the default sign-in view is password sign-in", () => {
  it("shows the password form (no email field, no 2-step cue); the role tabs stay; focus on the login ID", () => {
    const tree = render();
    expect(passwordForm(tree)).toBeDefined();
    expect(emailField(tree)).toBeUndefined();
    expect(findByType(tree, Tabs)).toHaveLength(1);
    expect(textOf(tree)).not.toContain("Step 1 of 2");
    expect(focused).toEqual([IDENTIFIER_FIELD_ID]);
  });

  it("signup is always the code flow: Create account shows the email form, never the password form", () => {
    pickMode(render(), "signup");
    const tree = render();
    expect(passwordForm(tree)).toBeUndefined();
    expect(emailField(tree)).toBeDefined();
    expect(textOf(tree)).toContain("Step 1 of 2");
    expect(button(tree, "Sign in with a password instead")).toBeUndefined();
    // A mode switch never moves focus (the radio keeps it).
    expect(focused).toEqual([IDENTIFIER_FIELD_ID]);
  });

  it("the login ID survives a trip to Create account and back", () => {
    play(passwordForm(render()), "onIdentifierChange", "Acme Manufacturing");
    pickMode(render(), "signup");
    pickMode(render(), "signin");
    expect(propsOf(passwordForm(render())!).identifier).toBe("Acme Manufacturing");
  });
});

describe("switching between password and email code", () => {
  it("'Use email code instead' opens the UNCHANGED code form with the email carried over, focused", () => {
    play(passwordForm(render()), "onIdentifierChange", "owner@example.com");
    play(passwordForm(render()), "onUseEmailCode", "owner@example.com");
    const tree = render();
    expect(passwordForm(tree)).toBeUndefined();
    expect(propsOf(emailField(tree)!).value).toBe("owner@example.com");
    expect(textOf(tree)).toContain("Step 1 of 2");
    expect(focused.at(-1)).toBe("login-email");
    // Still the code flow: its submit requests a code for that email.
    actions.requestCodeAction.mockResolvedValue({ ok: true, resendInSeconds: 30 });
    const form = findByType(tree, "form")[0]!;
    (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    expect(actions.requestCodeAction).toHaveBeenCalledWith({ email: "owner@example.com" });
    expect(actions.passwordSignInAction).not.toHaveBeenCalled();
  });

  it("a login ID that is not an email (a company name, a phone) is not put in the email field", () => {
    play(passwordForm(render()), "onUseEmailCode", "Acme Manufacturing");
    expect(propsOf(emailField(render())!).value).toBe("");
  });

  it("'Sign in with a password instead' brings the typed email as the login ID and focuses the password", () => {
    play(passwordForm(render()), "onUseEmailCode", "");
    const codeView = render();
    (propsOf(emailField(codeView)!).onChange as (e: unknown) => void)({
      target: { value: "owner@example.com" },
    });
    (propsOf(button(render(), "Sign in with a password instead")!).onClick as () => void)();
    const tree = render();
    expect(propsOf(passwordForm(tree)!).identifier).toBe("owner@example.com");
    expect(focused.at(-1)).toBe(PASSWORD_FIELD_ID);
  });
});

describe("the set-new-password step", () => {
  function openStep() {
    play(passwordForm(render()), "onChangeRequired", {
      identifier: "owner@example.com",
      temporaryPassword: TEMPORARY,
    });
    return render();
  }

  it("a temporary password replaces the card with the step — no tabs, heading focused, no navigation", () => {
    const tree = openStep();
    expect(propsOf(changeStep(tree)!)).toMatchObject({
      identifier: "owner@example.com",
      temporaryPassword: TEMPORARY,
    });
    expect(findByType(tree, Tabs)).toHaveLength(0);
    expect(passwordForm(tree)).toBeUndefined();
    expect(focused.at(-1)).toBe(NEW_PASSWORD_HEADING_ID);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("'Back to sign in': the password form with the login ID, and the temporary password dropped", () => {
    play(changeStep(openStep()), "onCancel");
    const tree = render();
    expect(changeStep(tree)).toBeUndefined();
    expect(propsOf(passwordForm(tree)!)).toMatchObject({
      identifier: "owner@example.com",
      initialError: null,
    });
    expect(JSON.stringify(h.state())).not.toContain(TEMPORARY);
    expect(focused.at(-1)).toBe(PASSWORD_FIELD_ID);
  });

  it("a 401 on the resend: back to the password form with the neutral error, the temporary password dropped", () => {
    play(changeStep(openStep()), "onRestart", PASSWORD_SIGNIN_ERROR);
    const tree = render();
    expect(propsOf(passwordForm(tree)!)).toMatchObject({
      identifier: "owner@example.com",
      initialError: PASSWORD_SIGNIN_ERROR,
    });
    expect(JSON.stringify(h.state())).not.toContain(TEMPORARY);
    expect(navigate).not.toHaveBeenCalled();
    // Focus lands on the password, which that error describes (password-forms.test.tsx).
    expect(focused.at(-1)).toBe(PASSWORD_FIELD_ID);
  });

  it("success: the dashboard, exactly like a verified code — and the temporary password is dropped", () => {
    play(changeStep(openStep()), "onSignedIn");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(...DASHBOARD);
    const tree = render();
    // The step stays for its "Signed in" moment, holding no temporary password.
    expect(propsOf(changeStep(tree)!).temporaryPassword).toBe("");
    expect(JSON.stringify(h.state())).not.toContain(TEMPORARY);
  });
});

describe("password sign-in success", () => {
  it("navigates exactly like a verified code (replace, refresh, the Dashboard cue)", () => {
    play(passwordForm(render()), "onSignedIn");
    expect(navigate).toHaveBeenCalledWith(...DASHBOARD);
  });
});

describe("the code door's temporary-password answer (#2628 409)", () => {
  async function verifyAnswered(mode: "signin" | "signup") {
    h.reset(seed({ mode, step: "code", email: "owner@example.com", code: "123456", method: "code" }));
    actions.verifyCodeAction.mockResolvedValue({
      ok: false,
      error: TEMPORARY_PASSWORD_REQUIRED,
      usePassword: true,
    });
    const codeStep = render();
    expect(findByType(codeStep, OtpCodeInput)).toHaveLength(1);
    const form = findByType(codeStep, "form")[0]!;
    (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    await h.settle();
    return render();
  }

  it.each(["signin", "signup"] as const)(
    "from %s: the password form, the email as login ID, the instruction shown — and no portal",
    async (mode) => {
      const tree = await verifyAnswered(mode);
      expect(findByType(tree, OtpCodeInput)).toHaveLength(0);
      expect(propsOf(passwordForm(tree)!)).toMatchObject({
        identifier: "owner@example.com",
        initialNotice: TEMPORARY_PASSWORD_REQUIRED,
        initialError: null,
      });
      expect(navigate).not.toHaveBeenCalled();
      // Focus lands on the password, which the instruction describes (password-forms.test.tsx).
      expect(focused.at(-1)).toBe(PASSWORD_FIELD_ID);
    },
  );

  it("a stale arrival message is gone after a mode switch", async () => {
    await verifyAnswered("signin");
    pickMode(render(), "signup");
    pickMode(render(), "signin");
    expect(propsOf(passwordForm(render())!).initialNotice).toBeNull();
  });
});

describe("loginFocusTarget — where focus lands", () => {
  const base = { view: "entry", method: "password", isSignup: false, identifier: "" } as const;
  it.each([
    [{ ...base, view: "code" }, "login-code-heading"],
    [{ ...base, view: "new_password" }, NEW_PASSWORD_HEADING_ID],
    [base, IDENTIFIER_FIELD_ID],
    [{ ...base, identifier: "owner@example.com" }, PASSWORD_FIELD_ID],
    [{ ...base, identifier: "   " }, IDENTIFIER_FIELD_ID],
    [{ ...base, method: "code" }, "login-email"],
    [{ ...base, isSignup: true }, "login-email"],
  ] as const)("%o → %s", (state, target) => {
    expect(loginFocusTarget(state)).toBe(target);
  });
});
