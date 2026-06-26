import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Input, OtpInput, Toast } from "../../components/ds";

/**
 * LOGIN FORM (DS1.1) — re-skinned onto the design system. Env is node (no DOM): React
 * state is injected via a `useState` mock (call-order seed) and the component is rendered
 * to an element tree, then walked. `useTransition` → [pending=false, run-immediately];
 * `useEffect` is a no-op (cooldown timer); `next/navigation` + the server actions are
 * mocked (the render path never calls them).
 *
 * Asserts the DS affordances (email Input, 6-cell OtpInput, brand Button) and the
 * NO-ORACLE contract: errors render in a neutral DS Toast with no enumeration copy.
 */

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
    useState: (i: unknown) => useState(i),
    useTransition: () => useTransition(),
    useEffect: () => {},
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
// Mock the Server Action module (the render path never calls it). The neutral copy lives
// in ./messages (a plain module), so the assertions read the REAL constants from there.
vi.mock("./actions", () => ({ requestCodeAction: vi.fn(), verifyCodeAction: vi.fn() }));

// Real, single-source-of-truth copy constants (not "use server" — safe to import).
const { NEUTRAL_SEND_ERROR, SEND_CONFIRMATION } = await import("./messages");
const { LoginForm } = await import("./login-form");

// useState call order in the source: step, email, code, emailError, codeError, error, info, cooldown.
function render(seed: {
  step?: "email" | "code";
  email?: string;
  code?: string;
  emailError?: string | null;
  codeError?: string | null;
  error?: string | null;
  info?: string | null;
  cooldown?: number;
}): ReactElement {
  stateQueue = [
    seed.step ?? "email",
    seed.email ?? "",
    seed.code ?? "",
    seed.emailError ?? null,
    seed.codeError ?? null,
    seed.error ?? null,
    seed.info ?? null,
    seed.cooldown ?? 0,
  ];
  stateCursor = 0;
  return LoginForm() as ReactElement;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function findAll(node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findAll(c, type, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) acc.push(el);
  if (el.props && "children" in el.props) findAll(el.props.children, type, acc);
  return acc;
}

/** props helper with the loose typing the element tree carries in the node test env. */
const p = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
});

describe("LoginForm · email step (DS skin)", () => {
  it("renders a DS email Input and a brand 'Send login code' submit Button", () => {
    const tree = render({ step: "email" });
    const emailInput = findAll(tree, Input).find((el) => p(el).label === "Email");
    expect(emailInput).toBeDefined();
    expect(p(emailInput!).type).toBe("email");

    const submit = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(submit).toBeDefined();
    expect(p(submit!).variant).toBe("primary");
    expect(textOf(p(submit!).children as ReactNode)).toContain("Send login code");
  });

  it("surfaces an inline email error through the DS Input error slot", () => {
    const tree = render({ step: "email", emailError: "Enter a valid email address." });
    const emailInput = findAll(tree, Input).find((el) => p(el).label === "Email");
    expect(p(emailInput!).error).toBe("Enter a valid email address.");
  });
});

describe("LoginForm · code step (OtpInput)", () => {
  it("renders a single 6-cell OtpInput wired to the code value, plus a verify Button", () => {
    const tree = render({ step: "code", email: "a@b.co", code: "12" });
    const otp = findAll(tree, OtpInput);
    expect(otp.length).toBe(1);
    expect(p(otp[0]!).length).toBe(6);
    // The OtpInput shows ONLY what the user has typed (here a partial seed) — never a
    // server- or mock-supplied code.
    expect(p(otp[0]!).value).toBe("12");

    const submit = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(textOf(p(submit!).children as ReactNode)).toContain("Verify");
  });

  it("offers 'use a different email' alongside resend", () => {
    const tree = render({ step: "code", cooldown: 0 });
    const buttons = findAll(tree, Button);
    expect(
      buttons.some((b) => textOf(p(b).children as ReactNode).includes("different email")),
    ).toBe(true);
  });
});

describe("LoginForm · no OTP code is ever displayed or pre-filled (OTP-4)", () => {
  // A digit-run that would be a leaked/echoed code. The OtpInput value is bound to the
  // `code` state; with nothing seeded it must be empty in every state.
  const CODE_LIKE = /\b\d{4,8}\b/;

  it("pre-fills NOTHING into the OtpInput on the fresh code step", () => {
    const tree = render({ step: "code", email: "a@b.co" });
    const otp = findAll(tree, OtpInput);
    expect(otp.length).toBe(1);
    expect(p(otp[0]!).value).toBe("");
  });

  it("renders no code-like digit run in the code-step UI (no echoed/prefilled code)", () => {
    const tree = render({ step: "code", email: "a@b.co", info: SEND_CONFIRMATION });
    expect(p(findAll(tree, OtpInput)[0]!).value).toBe("");
    expect(textOf(tree)).not.toMatch(CODE_LIKE);
  });

  it("the email-step confirmation never contains a code-like digit run", () => {
    const tree = render({ step: "email", info: SEND_CONFIRMATION });
    expect(textOf(tree)).not.toMatch(CODE_LIKE);
  });
});

describe("LoginForm · resend is wired to the SERVER cooldown (OTP-4)", () => {
  it("disables resend while the cooldown runs and shows the remaining seconds", () => {
    const tree = render({ step: "code", cooldown: 20 });
    const resend = findAll(tree, Button).find((b) =>
      textOf(p(b).children as ReactNode).includes("Resend"),
    );
    expect(resend).toBeDefined();
    expect(p(resend!).disabled).toBe(true);
    // Countdown reflects the server value (here seeded to 20s), not a hard-coded number.
    expect(textOf(p(resend!).children as ReactNode)).toContain("20s");
  });

  it("re-enables resend once the cooldown reaches 0", () => {
    const tree = render({ step: "code", cooldown: 0 });
    const resend = findAll(tree, Button).find((b) =>
      textOf(p(b).children as ReactNode).includes("Resend"),
    );
    expect(resend).toBeDefined();
    expect(p(resend!).disabled).toBe(false);
    expect(textOf(p(resend!).children as ReactNode)).not.toMatch(/\d+s/);
  });
});

describe("LoginForm · errors are neutral (no enumeration oracle) via DS Toast", () => {
  const ENUM = /unknown|not found|no account|isn'?t registered|not registered|does ?n'?t exist|no such/i;

  it("renders a verify error in a danger Toast with the exact neutral copy", () => {
    const tree = render({ step: "code", error: "Invalid or expired code." });
    const danger = findAll(tree, Toast).find((t) => p(t).tone === "danger");
    expect(danger).toBeDefined();
    expect(textOf(p(danger!).children as ReactNode)).toBe("Invalid or expired code.");
    expect(textOf(tree)).not.toMatch(ENUM);
  });

  it("the send-error / limit path renders the single neutral message in a danger Toast", () => {
    // The action collapses invalid-email, send-failure, rate-limit/cap (429), and the
    // unknown-account path to this one constant — the form just renders it.
    const tree = render({ step: "email", error: NEUTRAL_SEND_ERROR });
    const danger = findAll(tree, Toast).find((t) => p(t).tone === "danger");
    expect(danger).toBeDefined();
    expect(textOf(p(danger!).children as ReactNode)).toBe(NEUTRAL_SEND_ERROR);
    expect(textOf(tree)).not.toMatch(ENUM);
  });

  it("the neutral send confirmation renders in a brand (non-error) Toast with no code", () => {
    const tree = render({ step: "code", info: SEND_CONFIRMATION });
    const brand = findAll(tree, Toast).find((t) => p(t).tone === "brand");
    expect(brand).toBeDefined();
    expect(textOf(p(brand!).children as ReactNode)).not.toMatch(/\b\d{4,8}\b/);
  });
});
