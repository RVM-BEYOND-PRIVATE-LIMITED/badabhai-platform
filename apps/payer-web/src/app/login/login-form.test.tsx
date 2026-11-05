import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, Button, Input, Tabs, Toast } from "../../components/ds";
import { OtpCodeInput } from "../../components/otp-input";

/**
 * AUTH-1 — Company|Agency tabs + self-serve signup, re-skinned onto the design system.
 *
 * Env is node (no DOM): React state is injected via a `useState` mock (call-order seed) and the
 * component is rendered to an element tree, then walked. `useTransition` → [pending=false,
 * run-immediately]; `useEffect` is a no-op (cooldown timer); `useRef` returns a stable ref;
 * the navigation helper (components/portal-navigation.ts) + the server actions are mocked. The actions are observed via the mocks so
 * we can assert the ROLE-AGNOSTIC contract + the no-enumeration / no-code-echo invariants.
 *
 * Asserts: the role TABS (ARIA tablist + arrow-key nav + role from the active tab feeds signup),
 * the signin/signup mode toggle (radiogroup), the shared OTP code step (OtpCodeInput — the sixth
 * digit submits, one request at a time; its flow across renders is login-form.code-step.test.tsx),
 * and the NO-ORACLE contract (neutral DS Toasts, no code ever rendered).
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
// A verified code navigates through the shared helper (the "Opening Dashboard…" cue); its router
// mechanics are components/portal-navigation.ts's own suite.
const navigate = vi.fn();
vi.mock("../../components/portal-navigation", () => ({
  usePortalNavigation: () => ({ pending: false, navigate }),
}));
// Observe the Server Actions. The render path never AWAITS them (no event seeded), but the
// handler tests below invoke the form's handlers to assert what gets sent to the seam.
const requestCodeAction = vi.fn();
const signupAction = vi.fn();
const verifyCodeAction = vi.fn();
vi.mock("./actions", () => ({
  requestCodeAction: (i: unknown) => requestCodeAction(i),
  signupAction: (i: unknown) => signupAction(i),
  verifyCodeAction: (i: unknown) => verifyCodeAction(i),
}));

// Real single-source-of-truth copy constants (plain module — safe to import).
const { NEUTRAL_SEND_ERROR, SEND_CONFIRMATION } = await import("./messages");
const { LoginForm } = await import("./login-form");

// useState call order in the source:
// role, mode, step, email, orgName, phone, code, emailError, orgError, phoneError, codeError,
// error, info, cooldown, succeeded, method (… identifier, change, arrival, codeAttempt — left
// unseeded).
//
// #2587: password sign-in is now the DEFAULT sign-in view, so this suite — the email-code flow's —
// seeds `method: "code"` to keep testing the email-code view it always tested. The password
// method has its own suites (login-form.password.test.tsx, password-forms.test.tsx).
function render(seed: {
  role?: "company" | "agency";
  mode?: "signin" | "signup";
  step?: "entry" | "code";
  email?: string;
  orgName?: string;
  phone?: string;
  code?: string;
  emailError?: string | null;
  orgError?: string | null;
  phoneError?: string | null;
  codeError?: string | null;
  error?: string | null;
  info?: string | null;
  cooldown?: number;
  succeeded?: boolean;
  method?: "password" | "code";
}): ReactElement {
  stateQueue = [
    seed.role ?? "company",
    seed.mode ?? "signin",
    seed.step ?? "entry",
    seed.email ?? "",
    seed.orgName ?? "",
    seed.phone ?? "",
    seed.code ?? "",
    seed.emailError ?? null,
    seed.orgError ?? null,
    seed.phoneError ?? null,
    seed.codeError ?? null,
    seed.error ?? null,
    seed.info ?? null,
    seed.cooldown ?? 0,
    seed.succeeded ?? false,
    seed.method ?? "code",
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

/** Collect every element whose props carry a given key (e.g. role="radiogroup"). */
function findByProp(node: ReactNode, key: string, val: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findByProp(c, key, val, acc));
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props && (el.props as Record<string, unknown>)[key] === val) acc.push(el);
  if (el.props && "children" in (el.props as Record<string, unknown>)) {
    findByProp((el.props as { children?: ReactNode }).children, key, val, acc);
  }
  return acc;
}

const p = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
  requestCodeAction.mockReset();
  signupAction.mockReset();
  verifyCodeAction.mockReset();
  navigate.mockReset();
});

describe("AUTH-1 · role tabs (Company | Agency) — ARIA tablist", () => {
  it("renders a DS Tabs tablist with Company + Agency, idBase wired for tabpanel linkage", () => {
    const tree = render({ step: "entry" });
    const tabs = findAll(tree, Tabs);
    expect(tabs.length).toBe(1);
    const props = p(tabs[0]!);
    expect(props.value).toBe("company");
    expect(props.idBase).toBe("auth-role");
    const items = props.tabs as Array<{ id: string; label: string }>;
    expect(items.map((t) => t.id)).toEqual(["company", "agency"]);
  });

  it("the matching tabpanel is role=tabpanel + aria-labelledby the active tab id", () => {
    const tree = render({ step: "entry", role: "agency" });
    const panels = findByProp(tree, "role", "tabpanel");
    expect(panels.length).toBe(1);
    expect(p(panels[0]!)["aria-labelledby"]).toBe("auth-role-tab-agency");
    expect(p(panels[0]!).id).toBe("auth-role-panel-agency");
  });

  it("the segmented DS Tabs is an ARIA tablist and arrow-keys move selection (onChange)", () => {
    // Render the Tabs primitive itself with an onChange spy: simulate ArrowRight from the
    // active (first) tab and assert selection advances. (Node env: focus() is a no-op, the
    // observable contract is onChange.)
    const onChange = vi.fn();
    const tree = Tabs({
      idBase: "auth-role",
      variant: "segmented",
      value: "company",
      onChange,
      tabs: [
        { id: "company", label: "Company" },
        { id: "agency", label: "Agency" },
      ],
    }) as ReactElement;
    expect(p(tree).role).toBe("tablist");
    const tabButtons = findByProp(tree, "role", "tab");
    expect(tabButtons.length).toBe(2);
    // roving tabindex: only the active tab is a tab-stop.
    expect(p(tabButtons[0]!).tabIndex).toBe(0);
    expect(p(tabButtons[1]!).tabIndex).toBe(-1);
    expect(p(tabButtons[0]!)["aria-selected"]).toBe(true);
    // ArrowRight on the active tab → selection moves to "agency". (Node env: there is no
    // live DOM, so `currentTarget.parentElement` is undefined and the focus() is a no-op;
    // the observable selection contract is onChange.)
    const onKeyDown = p(tabButtons[0]!).onKeyDown as (e: unknown) => void;
    const evt = { preventDefault: vi.fn(), currentTarget: { parentElement: null } };
    onKeyDown({ ...evt, key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("agency");
    // ArrowLeft wraps from the first tab to the last.
    onChange.mockClear();
    onKeyDown({ ...evt, key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("agency");
  });

  it("each tab's tagline uses the product's nouns: a company publishes POSTINGS, an agency sources WORKERS", () => {
    const tagline = (role: "company" | "agency") =>
      findAll(render({ step: "entry", role }), "span")
        .filter((s) => p(s).className === "login-context__tag")
        .map((s) => textOf(p(s).children as ReactNode).trim());
    expect(tagline("company")).toEqual(["Publish postings and hire."]);
    expect(tagline("agency")).toEqual(["Source workers for your clients."]);
    // …never the retired nouns, anywhere in the form's copy (incl. the unrendered signup line).
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "login-form.tsx"), "utf8");
    expect(src).not.toMatch(/post jobs|source candidates/i);
  });

  it("shows an active-context Badge naming the account type per tab", () => {
    const co = findAll(render({ step: "entry", role: "company" }), Badge);
    expect(co.some((b) => textOf(p(b).children as ReactNode).includes("Company account"))).toBe(true);
    const ag = findAll(render({ step: "entry", role: "agency" }), Badge);
    expect(ag.some((b) => textOf(p(b).children as ReactNode).includes("Agency account"))).toBe(true);
  });
});

describe("AUTH-1 · mode toggle (sign in / create account)", () => {
  it("renders a labelled radiogroup with both modes", () => {
    const groups = findByProp(render({ step: "entry" }), "role", "radiogroup");
    expect(groups.length).toBe(1);
  });

  it("signin entry shows ONLY the email Input (no org / phone)", () => {
    const tree = render({ step: "entry", mode: "signin" });
    const inputs = findAll(tree, Input);
    expect(inputs.length).toBe(1);
    expect(p(inputs[0]!).label).toBe("Email");
    const submit = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(textOf(p(submit!).children as ReactNode)).toContain("Send login code");
  });

  it("signup entry shows org name + email + optional phone", () => {
    const tree = render({ step: "entry", mode: "signup", role: "company" });
    const inputs = findAll(tree, Input);
    const labels = inputs.map((i) => p(i).label);
    expect(labels).toContain("Company name");
    expect(labels).toContain("Email");
    expect(labels).toContain("Phone");
    // Phone is marked optional via the DS Input prop.
    const phone = inputs.find((i) => p(i).label === "Phone");
    expect(p(phone!).optional).toBe(true);
    const submit = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(textOf(p(submit!).children as ReactNode)).toContain("Create account");
  });

  it("the org-name label follows the active tab (Agency name on the Agency tab)", () => {
    const tree = render({ step: "entry", mode: "signup", role: "agency" });
    const labels = findAll(tree, Input).map((i) => p(i).label);
    expect(labels).toContain("Agency name");
    expect(labels).not.toContain("Company name");
  });
});

describe("AUTH-1 · signup submit sends the role from the active tab (no payer_id)", () => {
  it("company tab → signupAction({ role: 'employer', orgName, email }) — NO payer_id", () => {
    signupAction.mockResolvedValue({ ok: true, resendInSeconds: 60 });
    const tree = render({
      step: "entry",
      mode: "signup",
      role: "company",
      orgName: "Acme Tools",
      email: "ops@acme.co",
    });
    const form = findByProp(tree, "className", "login-form")[0]!;
    const onSubmit = p(form).onSubmit as (e: { preventDefault: () => void }) => void;
    onSubmit({ preventDefault: vi.fn() });
    expect(signupAction).toHaveBeenCalledTimes(1);
    const arg = signupAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.role).toBe("employer");
    expect(arg.orgName).toBe("Acme Tools");
    expect(arg.email).toBe("ops@acme.co");
    expect("payer_id" in arg).toBe(false);
    expect("payerId" in arg).toBe(false);
  });

  it("agency tab → signupAction({ role: 'agent', … })", () => {
    signupAction.mockResolvedValue({ ok: true, resendInSeconds: 60 });
    const tree = render({
      step: "entry",
      mode: "signup",
      role: "agency",
      orgName: "Best Staffing",
      email: "desk@best.co",
    });
    const form = findByProp(tree, "className", "login-form")[0]!;
    (p(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect((signupAction.mock.calls[0]![0] as Record<string, unknown>).role).toBe("agent");
  });
});

/** The code step's one OTP input (exactly one). */
function otpOf(tree: ReactElement): ReactElement {
  const otp = findAll(tree, OtpCodeInput);
  expect(otp.length).toBe(1);
  return otp[0]!;
}
/** The sixth digit, as OtpCodeInput reports it: `onComplete` with the code it completed. */
const completeCode = (tree: ReactElement, code: string) =>
  (p(otpOf(tree)).onComplete as (code: string) => void)(code);
/** Verify, or Enter in a box: the code step's form submit. */
const submitCode = (tree: ReactElement) =>
  (p(findByProp(tree, "className", "login-form")[0]!).onSubmit as (e: {
    preventDefault: () => void;
  }) => void)({ preventDefault: vi.fn() });

describe("AUTH-1 · code step (OtpCodeInput) — shared for signin and signup", () => {
  it("renders a single 6-box OtpCodeInput wired to the code value + a verify Button; no role tabs", () => {
    const tree = render({ step: "code", email: "a@b.co", code: "12" });
    const otp = otpOf(tree);
    expect(p(otp).length).toBe(6);
    expect(p(otp).value).toBe("12");
    expect(p(otp).autoFocus).toBe(true);
    // The role tabs are NOT rendered on the code step — switching tab is impossible
    // mid-verification (the toggle simply isn't present).
    expect(findAll(tree, Tabs).length).toBe(0);
    const submit = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(textOf(p(submit!).children as ReactNode)).toContain("Verify");
  });

  it("keeps the field's name and autofill: the visible label names the group; the first box takes one-time-code", () => {
    const otp = otpOf(render({ step: "code", email: "a@b.co" }));
    expect(p(otp).label).toBe("Enter the 6-digit login code");
    const html = renderToStaticMarkup(otp);
    // One label, drawn by the input itself — never a second one beside it.
    const label = /<span class="otp-code__label" id="([^"]+)">Enter the 6-digit login code<\/span>/.exec(
      html,
    );
    expect(label).not.toBeNull();
    expect(html).toContain(`role="group" aria-labelledby="${label![1]}"`);
    const boxes = Array.from(html.matchAll(/<input\b[^>]*>/g), (m) => m[0]);
    expect(boxes).toHaveLength(6);
    boxes.forEach((box, i) => expect(box).toContain(`aria-label="Digit ${i + 1} of 6"`));
    expect(boxes[0]).toMatch(/autocomplete="one-time-code"/i);
    expect(boxes.filter((b) => /one-time-code/.test(b))).toHaveLength(1);
  });

  it("the sixth digit submits: onComplete verifies the code it completed — the same action and payload as Verify", () => {
    verifyCodeAction.mockResolvedValue({ ok: true, isNewPayer: false });
    // The edit that completes the code reaches the form before it re-renders: this render still
    // holds the five digits before it, so the code sent is the one onComplete hands over.
    const tree = render({ step: "code", email: "a@b.co", code: "12345" });
    completeCode(tree, "123456");
    expect(verifyCodeAction).toHaveBeenCalledTimes(1);
    expect(verifyCodeAction).toHaveBeenCalledWith({ email: "a@b.co", code: "123456" });
  });

  it("one request at a time: while a verify (or a resend) is in flight, neither the sixth digit nor Verify sends", () => {
    useTransition.mockReturnValueOnce([true, (cb) => cb()]);
    const tree = render({ step: "code", email: "a@b.co", code: "123456" });
    completeCode(tree, "123456");
    submitCode(tree);
    expect(verifyCodeAction).not.toHaveBeenCalled();
  });

  it("an accepted code is never sent again, and stays readable: locked in the boxes, with the check", () => {
    const tree = render({ step: "code", email: "a@b.co", code: "123456", succeeded: true });
    expect(p(otpOf(tree))).toMatchObject({ value: "123456", success: true });
    completeCode(tree, "123456");
    submitCode(tree);
    expect(verifyCodeAction).not.toHaveBeenCalled();
    // Until then the boxes are open.
    expect(p(otpOf(render({ step: "code", email: "a@b.co", code: "123" }))).success).toBe(false);
  });

  it("the inline code error describes every box while it shows", () => {
    const message = "Enter the numeric code (4–8 digits).";
    const tree = render({ step: "code", email: "a@b.co", code: "12", codeError: message });
    const alert = findByProp(tree, "role", "alert")[0]!;
    expect(textOf(p(alert).children as ReactNode)).toBe(message);
    expect(p(alert).id).toBe("login-code-error");
    expect(p(otpOf(tree)).describedBy).toBe("login-code-error");
    // No error, no description (never an id that points at nothing).
    expect(p(otpOf(render({ step: "code", email: "a@b.co", code: "12" }))).describedBy).toBeUndefined();
  });

  it("verify calls verifyCodeAction → replaces sign-in with the dashboard, cued, on success", async () => {
    verifyCodeAction.mockResolvedValue({ ok: true, isNewPayer: true });
    const tree = render({ step: "code", email: "a@b.co", code: "123456" });
    const form = findByProp(tree, "className", "login-form")[0]!;
    (p(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(verifyCodeAction).toHaveBeenCalledWith({ email: "a@b.co", code: "123456" });
    // REPLACE (Back never returns to the used code), REFRESH (the session is new), and the shell's
    // "Opening Dashboard…" cue while the dashboard renders.
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith("/dashboard", {
      pendingLabel: "Dashboard",
      replace: true,
      refresh: true,
    });
  });

  it("a refused code stays on the page — no navigation", async () => {
    verifyCodeAction.mockResolvedValue({ ok: false, error: "Invalid or expired code." });
    const tree = render({ step: "code", email: "a@b.co", code: "123456" });
    const form = findByProp(tree, "className", "login-form")[0]!;
    (p(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(verifyCodeAction).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the action's continuation has run
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers 'use a different email' alongside resend", () => {
    const tree = render({ step: "code", cooldown: 0 });
    const buttons = findAll(tree, Button);
    expect(buttons.some((b) => textOf(p(b).children as ReactNode).includes("different email"))).toBe(
      true,
    );
  });
});

describe("AUTH-1 · guided 2-step flow affordances", () => {
  it("the ENTRY step shows a 'Step 1 of 2' progress cue", () => {
    const tree = render({ step: "entry" });
    expect(textOf(tree)).toContain("Step 1 of 2");
    expect(textOf(tree)).not.toContain("Step 2 of 2");
  });

  it("the CODE step shows a 'Step 2 of 2' progress cue", () => {
    const tree = render({ step: "code", email: "a@b.co" });
    expect(textOf(tree)).toContain("Step 2 of 2");
    expect(textOf(tree)).not.toContain("Step 1 of 2");
  });

  it("the role selector is labelled PRIMARY ('I'm a') and is the only segmented Tabs", () => {
    const tree = render({ step: "entry" });
    expect(textOf(tree)).toContain("I’m a");
    // A single role Tabs — the mode switch is a radiogroup, NOT a second Tabs (no duplicate bar).
    expect(findAll(tree, Tabs).length).toBe(1);
  });

  it("shows truthful trust microcopy near the CTA (no code, no secret)", () => {
    // #2587: sign-in offers a password right above this line, so it no longer says "no passwords".
    for (const mode of ["signin", "signup"] as const) {
      const txt = textOf(render({ step: "entry", mode, email: "a@b.co" }));
      expect(txt).toContain("Secure one-time-code sign-in.");
      expect(txt).toContain("never share your details");
      expect(txt).not.toContain("no passwords");
      expect(txt).not.toMatch(/\b\d{4,8}\b/);
    }
  });

  it("'use a different email' is wired to a handler that returns to the entry step", () => {
    // The back control carries an onClick (backToEntry); with the mocked no-op setters we assert
    // the affordance is present + interactive (the structural return-to-entry is covered by the
    // entry/code render split — the code step renders NO Tabs, the entry step renders one).
    const tree = render({ step: "code", email: "a@b.co" });
    const back = findAll(tree, Button).find((b) =>
      textOf(p(b).children as ReactNode).includes("different email"),
    );
    expect(back).toBeDefined();
    expect(typeof p(back!).onClick).toBe("function");
  });
});

describe("AUTH-1 · login stays ROLE-AGNOSTIC (the one design truth)", () => {
  it("an agency account verifies from the COMPANY tab — verify does NOT branch on the tab", () => {
    // The user picked the Company tab but is signing into an Agency account. The code step
    // carries NO role; verify is identical. (Role is set at signup; the server resolves it.)
    verifyCodeAction.mockResolvedValue({ ok: true, isNewPayer: true });
    const tree = render({ role: "company", mode: "signin", step: "code", email: "agent@x.co", code: "654321" });
    const form = findByProp(tree, "className", "login-form")[0]!;
    (p(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    // verify is called with ONLY email + code — no role/tab anywhere in the payload.
    expect(verifyCodeAction).toHaveBeenCalledTimes(1);
    const arg = verifyCodeAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toEqual({ email: "agent@x.co", code: "654321" });
    expect("role" in arg).toBe(false);
    expect("tab" in arg).toBe(false);
  });

  it("the signin email step never calls signupAction (no role sent on sign IN)", () => {
    requestCodeAction.mockResolvedValue({ ok: true, resendInSeconds: 30 });
    const tree = render({ step: "entry", mode: "signin", email: "a@b.co" });
    const form = findByProp(tree, "className", "login-form")[0]!;
    (p(form).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(requestCodeAction).toHaveBeenCalledWith({ email: "a@b.co" });
    expect(signupAction).not.toHaveBeenCalled();
  });
});

describe("AUTH-1 · no OTP code displayed (real-OTP only) in ANY state", () => {
  const CODE_LIKE = /\b\d{4,8}\b/;

  it("signup entry renders no code-like digit run", () => {
    const tree = render({ step: "entry", mode: "signup", role: "company", info: SEND_CONFIRMATION });
    expect(textOf(tree)).not.toMatch(CODE_LIKE);
  });

  it("pre-fills NOTHING into the OtpCodeInput on the fresh code step", () => {
    const tree = render({ step: "code", email: "a@b.co", info: SEND_CONFIRMATION });
    expect(p(otpOf(tree)).value).toBe("");
    expect(textOf(tree)).not.toMatch(CODE_LIKE);
  });
});

describe("AUTH-1 · resend wired to the SERVER cooldown (no hard-coded number)", () => {
  it("disables resend while the cooldown runs and shows the remaining seconds", () => {
    const tree = render({ step: "code", cooldown: 20 });
    const resend = findAll(tree, Button).find((b) =>
      textOf(p(b).children as ReactNode).includes("Resend"),
    );
    expect(p(resend!).disabled).toBe(true);
    expect(textOf(p(resend!).children as ReactNode)).toContain("20s");
  });

  it("re-enables resend once the cooldown reaches 0", () => {
    const tree = render({ step: "code", cooldown: 0 });
    const resend = findAll(tree, Button).find((b) =>
      textOf(p(b).children as ReactNode).includes("Resend"),
    );
    expect(p(resend!).disabled).toBe(false);
  });
});

describe("AUTH-1 · errors are neutral (no enumeration oracle) via DS Toast", () => {
  const ENUM = /unknown|not found|no account|isn'?t registered|not registered|does ?n'?t exist|no such|already exists|already registered/i;

  it("a signup send error renders the single neutral message in a danger Toast", () => {
    const tree = render({ step: "entry", mode: "signup", role: "company", error: NEUTRAL_SEND_ERROR });
    const danger = findAll(tree, Toast).find((t) => p(t).tone === "danger");
    expect(danger).toBeDefined();
    expect(textOf(p(danger!).children as ReactNode)).toBe(NEUTRAL_SEND_ERROR);
    expect(textOf(tree)).not.toMatch(ENUM);
  });

  it("the send confirmation is NOT rendered as a blue card", () => {
    const tree = render({ step: "code", info: SEND_CONFIRMATION });
    const brand = findAll(tree, Toast).find((t) => p(t).tone === "brand");
    expect(brand).toBeUndefined();
  });

  it("an inline org-name error is surfaced through the DS Input error slot", () => {
    const tree = render({ step: "entry", mode: "signup", role: "company", orgError: "Enter your organisation name." });
    const org = findAll(tree, Input).find((i) => p(i).label === "Company name");
    expect(p(org!).error).toBe("Enter your organisation name.");
    expect(p(org!)["aria-invalid"]).toBe(true);
  });
});
