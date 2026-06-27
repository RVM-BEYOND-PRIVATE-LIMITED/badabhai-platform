import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Badge, Button, Input, Toast } from "../../../components/ds";

/**
 * ACCOUNT EDIT FORM (PROF-4) — node-env element-walk tests (the login-form / posting-form
 * sibling). Env is node (no DOM): React state is injected via a `useState` mock (call-order
 * seed) and the component is rendered to an element tree, then walked. `useTransition` →
 * [pending=false, run-immediately]; `next/navigation` + the server action are mocked.
 *
 * Asserts: the edit affordances (org Input pre-filled, NEW-phone Input, NO email input,
 * email read-only + support helper, role/status Badges); the SUBMIT BODY is built from
 * CHANGED fields only with NO `payer_id`; client validation parity (a non-E.164 phone / a
 * 1-char org are rejected BEFORE the action runs); a pristine form keeps Save disabled; and
 * the no-oracle error path renders ONE neutral Toast.
 */

const updateAccountAction = vi.fn();

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
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ updateAccountAction: (...args: unknown[]) => updateAccountAction(...args) }));

const { ACCOUNT_SAVE_ERROR, EMAIL_SUPPORT_HELPER } = await import("./messages");
const { AccountForm } = await import("./account-form");

interface FieldErrors {
  orgName?: string;
  phone?: string;
}

const PROPS: {
  orgName: string;
  email: string;
  phoneLast4: string | null;
  role: "employer" | "agent";
  status: "pending" | "active" | "suspended";
} = {
  orgName: "Acme Tools",
  email: "ops@acme.example",
  phoneLast4: "1234",
  role: "employer",
  status: "active",
};

// useState call order in the source: orgValue, phoneValue, fieldErrors, error, saved.
function render(
  seed: {
    orgValue?: string;
    phoneValue?: string;
    fieldErrors?: FieldErrors;
    error?: string | null;
    saved?: boolean;
  },
  propsOver: Partial<typeof PROPS> = {},
): ReactElement {
  stateQueue = [
    seed.orgValue ?? PROPS.orgName,
    seed.phoneValue ?? "",
    seed.fieldErrors ?? {},
    seed.error ?? null,
    seed.saved ?? false,
  ];
  stateCursor = 0;
  return AccountForm({ ...PROPS, ...propsOver }) as ReactElement;
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

const p = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;

/** The form's onSubmit handler lives on the root `Card as="form"`. */
function submitHandler(tree: ReactElement): (e: { preventDefault: () => void }) => void {
  return p(tree).onSubmit as (e: { preventDefault: () => void }) => void;
}

function submit(tree: ReactElement) {
  submitHandler(tree)({ preventDefault: () => {} });
}

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
  updateAccountAction.mockReset();
  updateAccountAction.mockResolvedValue({ ok: true });
  // Provide a minimal `document` for the focus-first-invalid path (node env has none).
  (globalThis as { document?: unknown }).document = { getElementById: () => null };
});

describe("AccountForm — edit affordances", () => {
  it("pre-fills the org Input with the current org name and offers a blank NEW-phone Input", () => {
    const tree = render({});
    const inputs = findAll(tree, Input);
    const org = inputs.find((el) => p(el).id === "account-org");
    const phone = inputs.find((el) => p(el).id === "account-phone");
    expect(org).toBeDefined();
    expect(p(org!).value).toBe("Acme Tools");
    expect(phone).toBeDefined();
    // The new-phone field is blank by default (we never pre-fill — only last-4 is known).
    expect(p(phone!).value).toBe("");
  });

  it("shows the current masked phone (•••• 1234), never the full number", () => {
    const text = textOf(render({}));
    expect(text).toContain("•••• 1234");
    expect(text).not.toMatch(/\b\d{10}\b/);
  });

  it("shows 'Not set' as the current phone when there is none on file", () => {
    expect(textOf(render({}, { phoneLast4: null }))).toContain("Not set");
  });

  it("renders role + status as Badges", () => {
    const tree = render({}, { role: "agent", status: "suspended" });
    const text = textOf(tree);
    expect(text).toContain("Agency");
    expect(text).toContain("Suspended");
    expect(findAll(tree, Badge).length).toBeGreaterThanOrEqual(2);
  });
});

describe("AccountForm — email is read-only (no input, support helper present)", () => {
  it("renders NO email Input and shows the contact-support helper", () => {
    const tree = render({});
    const emailInputs = findAll(tree, Input).filter(
      (el) => p(el).type === "email" || /email/i.test(String(p(el).label ?? "")),
    );
    expect(emailInputs.length).toBe(0);
    expect(textOf(tree)).toContain(EMAIL_SUPPORT_HELPER);
    expect(textOf(tree)).toContain("ops@acme.example");
  });
});

describe("AccountForm — submit body is built from CHANGED fields only (no payer_id)", () => {
  it("sends ONLY the changed org name when phone is left blank", () => {
    const tree = render({ orgValue: "Acme CNC Works" });
    submit(tree);
    expect(updateAccountAction).toHaveBeenCalledTimes(1);
    expect(updateAccountAction).toHaveBeenCalledWith({ orgName: "Acme CNC Works" });
    const body = updateAccountAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("phone");
  });

  it("sends ONLY the new phone when the org is unchanged", () => {
    const tree = render({ phoneValue: "+919876543210" });
    submit(tree);
    expect(updateAccountAction).toHaveBeenCalledWith({ phone: "+919876543210" });
    expect(updateAccountAction.mock.calls[0]![0]).not.toHaveProperty("orgName");
  });

  it("sends BOTH when org and phone both change", () => {
    const tree = render({ orgValue: "Acme CNC Works", phoneValue: "+919876543210" });
    submit(tree);
    expect(updateAccountAction).toHaveBeenCalledWith({
      orgName: "Acme CNC Works",
      phone: "+919876543210",
    });
  });
});

describe("AccountForm — client validation parity (rejects BEFORE the action runs)", () => {
  it("does NOT call the action for a non-E.164 phone", () => {
    const tree = render({ phoneValue: "98765 43210" });
    submit(tree);
    expect(updateAccountAction).not.toHaveBeenCalled();
  });

  it("does NOT call the action for a 1-character org name", () => {
    const tree = render({ orgValue: "A" });
    submit(tree);
    expect(updateAccountAction).not.toHaveBeenCalled();
  });
});

describe("AccountForm — pristine form keeps Save disabled and never submits an empty body", () => {
  it("renders the submit Button DISABLED when nothing changed", () => {
    const tree = render({});
    const submitBtn = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(submitBtn).toBeDefined();
    expect(p(submitBtn!).disabled).toBe(true);
  });

  it("enables Save once the org name changes", () => {
    const tree = render({ orgValue: "Acme CNC Works" });
    const submitBtn = findAll(tree, Button).find((b) => p(b).type === "submit");
    expect(p(submitBtn!).disabled).toBe(false);
  });

  it("a pristine submit never calls the action (empty body never sent)", () => {
    const tree = render({});
    submit(tree);
    expect(updateAccountAction).not.toHaveBeenCalled();
  });
});

describe("AccountForm — neutral error path (no field-level oracle)", () => {
  it("renders ONE neutral danger Toast and no enumeration copy", () => {
    const tree = render({ error: ACCOUNT_SAVE_ERROR });
    const toasts = findAll(tree, Toast);
    const danger = toasts.filter((t) => p(t).tone === "danger");
    expect(danger.length).toBe(1);
    expect(textOf(p(danger[0]!).children as ReactNode)).toBe(ACCOUNT_SAVE_ERROR);
    // No field-level oracle: the error never names which field/check failed.
    const ORACLE = /unknown|not found|already taken|invalid phone|invalid email|that org/i;
    expect(textOf(tree)).not.toMatch(ORACLE);
  });
});

describe("AccountForm — a11y wiring", () => {
  it("sets aria-invalid + aria-describedby on the org Input when it has an error", () => {
    const tree = render({
      orgValue: "A",
      fieldErrors: { orgName: "Organisation name must be 2–120 characters." },
    });
    const org = findAll(tree, Input).find((el) => p(el).id === "account-org")!;
    expect(p(org).label).toBe("Organisation name");
    expect(p(org)["aria-invalid"]).toBe(true);
    expect(p(org)["aria-describedby"]).toBe("account-org-error");
    expect(p(org).error).toBe("Organisation name must be 2–120 characters.");
  });

  it("leaves aria-invalid UNSET on a clean phone field", () => {
    const tree = render({});
    const phone = findAll(tree, Input).find((el) => p(el).id === "account-phone")!;
    expect(p(phone)["aria-invalid"]).toBeUndefined();
    expect(p(phone)["aria-describedby"]).toBeUndefined();
  });
});
