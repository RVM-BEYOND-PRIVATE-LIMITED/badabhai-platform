import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import {
  createHookHarness,
  findByProp,
  findByType,
  findElements,
  propsOf,
  textOf,
} from "../../../test/hook-harness";

/**
 * #2587 — the password sign-in form and the "Set a new password" step, followed through real state
 * changes (test/hook-harness.ts: kept useState slots, transitions awaited, effects run). Node env:
 * each frame is an element tree; a test types through the fields' `onChange`, submits through the
 * form's `onSubmit`, lets the (mocked) Server Action answer, and reads the next frame.
 *
 * Locks: the inline rules tick as the payer types; a mismatch / a broken rule / the API's 400 land
 * inline with focus on the field; a 401 on the resend returns to sign-in; a refused sign-in shows
 * the neutral copy and shakes once per refusal; "Use email code instead"; autocomplete + labels;
 * and neither password is ever rendered as text or kept after it has done its job.
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
const passwordSignInAction = vi.fn();
const setNewPasswordAction = vi.fn();
vi.mock("./actions", () => ({
  passwordSignInAction: (input: unknown) => passwordSignInAction(input),
  setNewPasswordAction: (input: unknown) => setNewPasswordAction(input),
}));

const { PasswordSignInForm, IDENTIFIER_FIELD_ID, PASSWORD_FIELD_ID } = await import("./password-sign-in");
const {
  SetNewPasswordStep,
  NEW_PASSWORD_FIELD_ID,
  NEW_PASSWORD_HEADING_ID,
  CONFIRM_PASSWORD_FIELD_ID,
} = await import("./set-new-password");
const { PasswordField } = await import("./password-field");
const { Button, IconButton, Input, Toast } = await import("../../components/ds");
const {
  IDENTIFIER_REQUIRED,
  NEW_PASSWORD_UNAVAILABLE,
  PASSWORD_RATE_LIMITED,
  PASSWORD_REQUIRED,
  PASSWORD_SIGNIN_ERROR,
  PASSWORD_SIGNIN_UNAVAILABLE,
  TEMPORARY_PASSWORD_REQUIRED,
} = await import("./messages");
const { CONFIRM_MISMATCH, NEW_PASSWORD_ERRORS } = await import("./password-rules");

type SignInProps = Parameters<typeof PasswordSignInForm>[0];
type StepProps = Parameters<typeof SetNewPasswordStep>[0];

const TEMPORARY = "Xk7mPq2rTn9wZa";
const CHOSEN = "my-own-pass-42";

// focusControl() moves focus by id through the DOM; record where it went.
let focused: string[] = [];
beforeEach(() => {
  h.reset();
  focused = [];
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({ focus: () => focused.push(id) }),
  });
  passwordSignInAction.mockReset();
  setNewPasswordAction.mockReset();
});

/* ---- Interaction helpers over a frame ---- */

/** The DS Input or PasswordField whose label is `label`. */
function field(tree: ReactNode, label: string): ReactElement {
  const el = findElements(
    tree,
    (e) => (e.type === Input || e.type === PasswordField) && propsOf(e).label === label,
  )[0];
  expect(el, `field "${label}"`).toBeDefined();
  return el!;
}
/** Type into a field: PasswordField hands the value, the DS Input hands the event. */
function typeInto(tree: ReactNode, label: string, value: string) {
  const el = field(tree, label);
  const onChange = propsOf(el).onChange as (arg: unknown) => void;
  onChange(el.type === PasswordField ? value : { target: { value } });
}
function submit(tree: ReactNode) {
  const form = findByType(tree, "form")[0]!;
  (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
}
function button(tree: ReactNode, text: string): ReactElement {
  const el = findByType(tree, Button).find((b) => textOf(propsOf(b).children as ReactNode).includes(text));
  expect(el, `button "${text}"`).toBeDefined();
  return el!;
}
const click = (el: ReactElement) => (propsOf(el).onClick as () => void)();
const formClass = (tree: ReactNode) => String(propsOf(findByType(tree, "form")[0]!).className);
const toast = (tree: ReactNode, tone: string) =>
  findByType(tree, Toast).find((t) => propsOf(t).tone === tone);

/** A sign-in form whose login ID is held by a stand-in parent, like LoginForm holds it. */
function signInForm(overrides: Partial<SignInProps> = {}) {
  const parent = {
    props: {
      identifier: "",
      onSignedIn: vi.fn(),
      onChangeRequired: vi.fn(),
      onUseEmailCode: vi.fn(),
      ...overrides,
    } as SignInProps,
  };
  parent.props.onIdentifierChange = (value: string) => {
    parent.props = { ...parent.props, identifier: value };
  };
  return { parent, render: () => h.render(PasswordSignInForm, parent.props) };
}

function changeStep(overrides: Partial<StepProps> = {}) {
  const props: StepProps = {
    identifier: "owner@example.com",
    temporaryPassword: TEMPORARY,
    onSignedIn: vi.fn(),
    onRestart: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { props, render: () => h.render(SetNewPasswordStep, props) };
}

describe("password sign-in form — fields, labels, autocomplete", () => {
  it("login ID is `username` (named, for password managers); the password is `current-password`", () => {
    const tree = signInForm().render();
    const id = field(tree, "Email, phone or company name");
    expect(propsOf(id).id).toBe(IDENTIFIER_FIELD_ID);
    expect(propsOf(id).autoComplete).toBe("username");
    expect(propsOf(id).name).toBe("username");
    const pw = field(tree, "Password");
    expect(pw.type).toBe(PasswordField);
    expect(propsOf(pw).id).toBe(PASSWORD_FIELD_ID);
    expect(propsOf(pw).autoComplete).toBe("current-password");
    const submitButton = findByType(tree, Button).find((b) => propsOf(b).type === "submit")!;
    expect(textOf(propsOf(submitButton).children as ReactNode)).toBe("Sign in");
  });

  it("empty fields: inline errors, focus on the first one, and no request", () => {
    const form = signInForm();
    submit(form.render());
    const tree = form.render();
    expect(propsOf(field(tree, "Email, phone or company name")).error).toBe(IDENTIFIER_REQUIRED);
    expect(propsOf(field(tree, "Password")).error).toBe(PASSWORD_REQUIRED);
    expect(focused).toEqual([IDENTIFIER_FIELD_ID]);
    expect(passwordSignInAction).not.toHaveBeenCalled();
    // A field error is not a refused sign-in: no shake.
    expect(formClass(tree)).toBe("login-form");
  });

  it("only the password missing: its error, focus on the password", () => {
    const form = signInForm({ identifier: "owner@example.com" });
    submit(form.render());
    expect(focused).toEqual([PASSWORD_FIELD_ID]);
    expect(propsOf(field(form.render(), "Password")).error).toBe(PASSWORD_REQUIRED);
  });
});

describe("password sign-in form — outcomes", () => {
  it("submits the trimmed login ID and the password exactly as typed (no payer id)", async () => {
    passwordSignInAction.mockResolvedValue({ ok: true, isNewPayer: false });
    const form = signInForm();
    typeInto(form.render(), "Email, phone or company name", "  owner@example.com ");
    typeInto(form.render(), "Password", " spaced pass 1 ");
    submit(form.render());
    await h.settle();
    expect(passwordSignInAction).toHaveBeenCalledWith({
      identifier: "owner@example.com",
      password: " spaced pass 1 ",
    });
  });

  it("success: hands off to the parent, reads Signed in, and clears the password", async () => {
    passwordSignInAction.mockResolvedValue({ ok: true, isNewPayer: false });
    const form = signInForm({ identifier: "owner@example.com" });
    typeInto(form.render(), "Password", "Settled-pass-9");
    submit(form.render());
    await h.settle();
    const tree = form.render();
    expect(form.parent.props.onSignedIn).toHaveBeenCalledTimes(1);
    expect(textOf(propsOf(button(tree, "Signed in")).children as ReactNode)).toBe("Signed in");
    expect(propsOf(field(tree, "Password")).value).toBe("");
    expect(toast(tree, "success")).toBeDefined();
  });

  it("change required: the login ID and the TEMPORARY password go to the parent; nothing signs in", async () => {
    passwordSignInAction.mockResolvedValue({ ok: false, outcome: "change_required" });
    const form = signInForm({ identifier: "owner@example.com" });
    typeInto(form.render(), "Password", TEMPORARY);
    submit(form.render());
    await h.settle();
    expect(form.parent.props.onChangeRequired).toHaveBeenCalledWith({
      identifier: "owner@example.com",
      temporaryPassword: TEMPORARY,
    });
    expect(form.parent.props.onSignedIn).not.toHaveBeenCalled();
    // Its own copy is dropped at once; the step holds the only one.
    expect(propsOf(field(form.render(), "Password")).value).toBe("");
    expect(JSON.stringify(h.state())).not.toContain(TEMPORARY);
  });

  it("a refusal: the neutral copy in a danger toast and ONE shake per refusal — never the password", async () => {
    passwordSignInAction.mockResolvedValue({ ok: false, outcome: "refused", error: PASSWORD_SIGNIN_ERROR });
    const form = signInForm({ identifier: "owner@example.com" });
    typeInto(form.render(), "Password", TEMPORARY);
    submit(form.render());
    await h.settle();
    let tree = form.render();
    expect(textOf(propsOf(toast(tree, "danger")!).children as ReactNode)).toBe(PASSWORD_SIGNIN_ERROR);
    expect(formClass(tree)).toBe("login-form login-form--shake-a");
    expect(textOf(tree)).not.toContain(TEMPORARY);

    passwordSignInAction.mockResolvedValue({ ok: false, outcome: "refused", error: PASSWORD_RATE_LIMITED });
    submit(tree);
    await h.settle();
    tree = form.render();
    // The second refusal switches keyframes, so the shake runs again without a remount.
    expect(formClass(tree)).toBe("login-form login-form--shake-b");
    expect(textOf(propsOf(toast(tree, "danger")!).children as ReactNode)).toBe(PASSWORD_RATE_LIMITED);
    expect(form.parent.props.onSignedIn).not.toHaveBeenCalled();
  });

  it("the portal unreachable (the action itself rejects): the retry copy, not a crash", async () => {
    passwordSignInAction.mockRejectedValue(new Error("network"));
    const form = signInForm({ identifier: "owner@example.com" });
    typeInto(form.render(), "Password", TEMPORARY);
    submit(form.render());
    await h.settle();
    const tree = form.render();
    expect(textOf(propsOf(toast(tree, "danger")!).children as ReactNode)).toBe(PASSWORD_SIGNIN_UNAVAILABLE);
  });

  it("'Use email code instead' hands the trimmed login ID to the parent", () => {
    const form = signInForm({ identifier: " owner@example.com " });
    click(button(form.render(), "Use email code instead"));
    expect(form.parent.props.onUseEmailCode).toHaveBeenCalledWith("owner@example.com");
  });

  it("arrives with the parent's message: guidance as a neutral toast, a refusal as a danger toast", () => {
    let tree = signInForm({ initialNotice: "Use the temporary password." }).render();
    expect(textOf(propsOf(toast(tree, "neutral")!).children as ReactNode)).toBe("Use the temporary password.");
    h.reset();
    tree = signInForm({ initialError: PASSWORD_SIGNIN_ERROR }).render();
    expect(textOf(propsOf(toast(tree, "danger")!).children as ReactNode)).toBe(PASSWORD_SIGNIN_ERROR);
    // Arriving is not a refusal: no shake.
    expect(formClass(tree)).toBe("login-form");
  });

  it.each([
    ["the code door's instruction", { initialNotice: TEMPORARY_PASSWORD_REQUIRED }],
    ["the resend's 401", { initialError: PASSWORD_SIGNIN_ERROR }],
  ] as const)(
    "arriving with %s: it describes the password field (where focus lands) until the first submit",
    async (_, arrival) => {
      passwordSignInAction.mockResolvedValue({ ok: false, outcome: "refused", error: PASSWORD_SIGNIN_ERROR });
      const form = signInForm({ identifier: "owner@example.com", ...arrival });
      let tree = form.render();
      // Mounted together with its live region, it is not reliably announced — so it describes the
      // field the parent focuses (login-form.password.test.tsx).
      const status = findByProp(tree, "aria-live", "polite").find((e) => e.type === "div")!;
      expect(propsOf(status).id).toBeTruthy();
      expect(propsOf(field(tree, "Password")).describedBy).toBe(propsOf(status).id);
      expect(propsOf(field(tree, "Email, phone or company name"))["aria-describedby"]).toBeUndefined();

      // Once the payer submits, the region is already in place and announces what comes next.
      typeInto(tree, "Password", "Settled-pass-9");
      submit(form.render());
      await h.settle();
      tree = form.render();
      expect(textOf(propsOf(toast(tree, "danger")!).children as ReactNode)).toBe(PASSWORD_SIGNIN_ERROR);
      expect(propsOf(field(tree, "Password")).describedBy).toBeUndefined();
    },
  );

  it("without an arrival message the password field has no extra description", () => {
    expect(propsOf(field(signInForm().render(), "Password")).describedBy).toBeUndefined();
  });
});

describe("set-new-password step — the rules tick as the payer types", () => {
  const rules = (tree: ReactNode) =>
    findByType(tree, "li").map((li) => ({
      label: textOf(propsOf(li).children as ReactNode).trim().replace(/^(Done:|Not yet:)\s*/, ""),
      met: String(propsOf(li).className).includes("login-rule--met"),
    }));
  const metLabels = (tree: ReactNode) => rules(tree).filter((r) => r.met).map((r) => r.label);
  const summary = (tree: ReactNode) =>
    textOf(propsOf(findByProp(tree, "aria-live", "polite").find((e) => e.type === "p")!).children as ReactNode);

  it("shows the five rules, none met, and announces nothing on arrival", () => {
    const tree = changeStep().render();
    expect(rules(tree).map((r) => r.label)).toEqual([
      "8 to 128 characters",
      "At least one letter",
      "At least one number",
      "Different from your temporary password",
      "Both passwords match",
    ]);
    expect(metLabels(tree)).toEqual([]);
    expect(summary(tree)).toBe("");
  });

  it("updates on every keystroke, and the live summary counts the met rules", () => {
    const step = changeStep();
    typeInto(step.render(), "New password", "abc");
    let tree = step.render();
    expect(metLabels(tree)).toEqual(["At least one letter", "Different from your temporary password"]);
    expect(summary(tree)).toBe("2 of 5 password rules met.");

    typeInto(tree, "New password", "abcdefg1");
    tree = step.render();
    expect(metLabels(tree)).toEqual([
      "8 to 128 characters",
      "At least one letter",
      "At least one number",
      "Different from your temporary password",
    ]);

    typeInto(tree, "Confirm new password", "abcdefg1");
    tree = step.render();
    expect(metLabels(tree)).toHaveLength(5);
    expect(summary(tree)).toBe("All password rules met.");
  });

  it("typing the temporary password leaves 'Different from your temporary password' unmet", () => {
    const step = changeStep();
    typeInto(step.render(), "New password", TEMPORARY);
    expect(metLabels(step.render())).not.toContain("Different from your temporary password");
  });

  it("the rules list describes the new-password field (read with it), each state in words too", () => {
    const tree = changeStep().render();
    const list = findByType(tree, "ul")[0]!;
    expect(propsOf(field(tree, "New password")).describedBy).toBe(propsOf(list).id);
    for (const li of findByType(tree, "li")) {
      expect(textOf(propsOf(li).children as ReactNode).trim()).toMatch(/^(Done:|Not yet:) /);
    }
  });
});

describe("set-new-password step — submit", () => {
  function typed(step: ReturnType<typeof changeStep>, value: string, confirm: string) {
    typeInto(step.render(), "New password", value);
    typeInto(step.render(), "Confirm new password", confirm);
  }

  it("a mismatch: the confirm field's inline error, focus there, no request", () => {
    const step = changeStep();
    typed(step, CHOSEN, `${CHOSEN}x`);
    submit(step.render());
    expect(propsOf(field(step.render(), "Confirm new password")).error).toBe(CONFIRM_MISMATCH);
    expect(focused).toEqual([CONFIRM_PASSWORD_FIELD_ID]);
    expect(setNewPasswordAction).not.toHaveBeenCalled();
  });

  it.each([
    ["abc1", NEW_PASSWORD_ERRORS.too_short],
    ["onlyletters", NEW_PASSWORD_ERRORS.letter_and_digit],
    [TEMPORARY, NEW_PASSWORD_ERRORS.same_as_temporary],
  ])("%j: the rule it breaks, inline on the new password, focus there, no request", (value, copy) => {
    const step = changeStep();
    typed(step, value, value);
    submit(step.render());
    expect(propsOf(field(step.render(), "New password")).error).toBe(copy);
    expect(focused).toEqual([NEW_PASSWORD_FIELD_ID]);
    expect(setNewPasswordAction).not.toHaveBeenCalled();
  });

  it("sends the login ID, the temporary password and the new one", async () => {
    setNewPasswordAction.mockResolvedValue({ ok: true, isNewPayer: false });
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    submit(step.render());
    await h.settle();
    expect(setNewPasswordAction).toHaveBeenCalledWith({
      identifier: "owner@example.com",
      temporaryPassword: TEMPORARY,
      newPassword: CHOSEN,
    });
  });

  it("the API's refusal (a 400) lands inline on the new-password field, with focus", async () => {
    setNewPasswordAction.mockResolvedValue({
      ok: false,
      outcome: "new_password_rejected",
      error: NEW_PASSWORD_ERRORS.same_as_temporary,
    });
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    submit(step.render());
    await h.settle();
    const tree = step.render();
    expect(propsOf(field(tree, "New password")).error).toBe(NEW_PASSWORD_ERRORS.same_as_temporary);
    expect(focused).toEqual([NEW_PASSWORD_FIELD_ID]);
    expect(step.props.onSignedIn).not.toHaveBeenCalled();
    expect(step.props.onRestart).not.toHaveBeenCalled();
  });

  it("a 401 on the resend: both fields cleared, back to sign-in with the neutral error", async () => {
    setNewPasswordAction.mockResolvedValue({
      ok: false,
      outcome: "temporary_password_rejected",
      error: PASSWORD_SIGNIN_ERROR,
    });
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    submit(step.render());
    await h.settle();
    expect(step.props.onRestart).toHaveBeenCalledWith(PASSWORD_SIGNIN_ERROR);
    const tree = step.render();
    expect(propsOf(field(tree, "New password")).value).toBe("");
    expect(propsOf(field(tree, "Confirm new password")).value).toBe("");
  });

  it("another refusal (429, an outage): stays on the step with a danger toast and one shake", async () => {
    setNewPasswordAction.mockResolvedValue({ ok: false, outcome: "refused", error: PASSWORD_RATE_LIMITED });
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    submit(step.render());
    await h.settle();
    const tree = step.render();
    expect(textOf(propsOf(toast(tree, "danger")!).children as ReactNode)).toBe(PASSWORD_RATE_LIMITED);
    expect(formClass(tree)).toBe("login-form login-form--shake-a");
    expect(propsOf(field(tree, "New password")).value).toBe(CHOSEN);
  });

  it("the action rejecting outright is the retry copy, not a crash", async () => {
    setNewPasswordAction.mockRejectedValue(new Error("network"));
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    submit(step.render());
    await h.settle();
    expect(textOf(propsOf(toast(step.render(), "danger")!).children as ReactNode)).toBe(NEW_PASSWORD_UNAVAILABLE);
  });

  it("success: both passwords cleared and the fields gone, Signed in, the parent navigates", async () => {
    setNewPasswordAction.mockResolvedValue({ ok: true, isNewPayer: false });
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    submit(step.render());
    await h.settle();
    const tree = step.render();
    expect(step.props.onSignedIn).toHaveBeenCalledTimes(1);
    expect(findByType(tree, PasswordField)).toHaveLength(0);
    expect(textOf(propsOf(button(tree, "Signed in")).children as ReactNode)).toBe("Signed in");
    // Nothing the step still holds is the new password.
    expect(JSON.stringify(h.state())).not.toContain(CHOSEN);
  });

  it("'Back to sign in' clears both fields and hands back to the parent", () => {
    const step = changeStep();
    typed(step, CHOSEN, CHOSEN);
    click(button(step.render(), "Back to sign in"));
    expect(step.props.onCancel).toHaveBeenCalledTimes(1);
    expect(propsOf(field(step.render(), "New password")).value).toBe("");
  });
});

describe("set-new-password step — accessibility and privacy", () => {
  it("a focusable heading names the step; both new fields are `new-password`", () => {
    const tree = changeStep().render();
    const heading = findByType(tree, "h2")[0]!;
    expect(propsOf(heading).id).toBe(NEW_PASSWORD_HEADING_ID);
    expect(propsOf(heading).tabIndex).toBe(-1);
    expect(textOf(propsOf(heading).children as ReactNode)).toBe("Set a new password");
    expect(propsOf(field(tree, "New password")).autoComplete).toBe("new-password");
    expect(propsOf(field(tree, "Confirm new password")).autoComplete).toBe("new-password");
    // The form is named by the heading.
    expect(propsOf(findByType(tree, "form")[0]!)["aria-labelledby"]).toBe(NEW_PASSWORD_HEADING_ID);
  });

  it("a hidden username field tells a password manager which account the new password is for", () => {
    const tree = changeStep().render();
    const username = findByProp(tree, "autoComplete", "username")[0]!;
    expect(username.type).toBe("input");
    expect(propsOf(username).value).toBe("owner@example.com");
    expect(propsOf(username).hidden).toBe(true);
    expect(propsOf(username).readOnly).toBe(true);
  });

  it("never renders the temporary or the new password as text", () => {
    const step = changeStep();
    typeInto(step.render(), "New password", CHOSEN);
    typeInto(step.render(), "Confirm new password", CHOSEN);
    const text = textOf(step.render());
    expect(text).not.toContain(TEMPORARY);
    expect(text).not.toContain(CHOSEN);
    expect(text).toContain("owner@example.com");
  });
});

describe("the password field — show / hide", () => {
  const fieldProps = {
    id: "pw",
    label: "Password",
    value: "secret-1",
    onChange: () => {},
    autoComplete: "current-password" as const,
  };
  const eye = (tree: ReactNode) => findByType(tree, IconButton)[0]!;
  const input = (tree: ReactNode) => findByType(tree, Input)[0]!;

  it("masked at first: an open eye named 'Show password', controlling the input; no morph, no announcement", () => {
    const tree = h.render(PasswordField, fieldProps);
    expect(propsOf(input(tree)).type).toBe("password");
    expect(propsOf(input(tree)).name).toBeUndefined();
    expect(propsOf(eye(tree))).toMatchObject({
      icon: "eye",
      label: "Show password",
      "aria-controls": "pw",
      variant: "outline",
      size: "lg",
    });
    expect(propsOf(eye(tree))["data-morph"]).toBeUndefined();
    expect(textOf(findByProp(tree, "aria-live", "polite")[0]!)).toBe("");
  });

  it("a toggle shows it (slashed eye, 'Hide password'), morphs, announces; a second hides it again", () => {
    let tree = h.render(PasswordField, fieldProps);
    click(eye(tree));
    tree = h.render(PasswordField, fieldProps);
    expect(propsOf(input(tree)).type).toBe("text");
    expect(propsOf(eye(tree))).toMatchObject({ icon: "eye-slash", label: "Hide password", "data-morph": "hide" });
    expect(textOf(findByProp(tree, "aria-live", "polite")[0]!)).toBe("Your password is shown.");

    click(eye(tree));
    tree = h.render(PasswordField, fieldProps);
    expect(propsOf(input(tree)).type).toBe("password");
    expect(propsOf(eye(tree))).toMatchObject({ icon: "eye", label: "Show password", "data-morph": "show" });
    expect(textOf(findByProp(tree, "aria-live", "polite")[0]!)).toBe("Your password is hidden.");
  });

  it("is never auto-corrected or auto-capitalised", () => {
    const tree = h.render(PasswordField, fieldProps);
    expect(propsOf(input(tree))).toMatchObject({
      autoCapitalize: "none",
      autoCorrect: "off",
      spellCheck: false,
      autoComplete: "current-password",
    });
  });
});
