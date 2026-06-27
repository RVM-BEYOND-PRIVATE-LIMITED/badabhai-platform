import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../../lib/auth/types";

/**
 * ACCOUNT PAGE (PROF-2 read shell + PROF-4 edit) — server component rendered to an element
 * tree in the node env and walked. The page now renders an identity header (org label + email
 * in mono) and delegates org/phone/email/role/status to the {@link AccountForm} (PROF-4),
 * which is MOCKED here to a marker that echoes the props it received — so this suite asserts
 * the page WIRES the session's OWN fields into the form (org/email/phoneLast4/role/status) and
 * passes NO worker PII / full phone. A session missing its account fields renders the neutral
 * retry Card (the form is NOT rendered).
 */

const requirePayer = vi.fn<() => Promise<PayerSession>>();
vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// The edit form is a client component; mock it to a stable marker function so the page's
// WIRING (which session fields it forwards as props) is the thing under test here. The page
// renders `<AccountForm .../>`, so the element's `.type` is this very function — we find that
// element and read its props directly (no need to invoke it).
const AccountFormMock = vi.fn((_props: Record<string, unknown>) => null);
vi.mock("./account-form", () => ({ AccountForm: (props: Record<string, unknown>) => AccountFormMock(props) }));

const { default: AccountPage } = await import("./page");
const { AccountForm: MockedAccountForm } = await import("./account-form");

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

function findByClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findByClass(c, cls, acc));
    return acc;
  }
  const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
  const cn = el.props?.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
  if (el.props && "children" in el.props) findByClass(el.props.children, cls, acc);
  return acc;
}

const p = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;

const SESSION: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools",
  role: "employer",
  email: "ops@acme.example",
  phoneLast4: "1234",
  status: "active",
};

async function render(over: Partial<PayerSession> = {}): Promise<ReactElement> {
  requirePayer.mockResolvedValue({ ...SESSION, ...over });
  return (await AccountPage()) as ReactElement;
}

/** Find the `<AccountForm/>` element (its `.type` is the mocked fn) and return its props. */
function accountFormProps(tree: ReactElement): Record<string, unknown> | undefined {
  const found = findAll(tree, MockedAccountForm);
  return found[0] ? p(found[0]) : undefined;
}

beforeEach(() => {
  requirePayer.mockReset();
});

describe("AccountPage — identity header + edit form wiring", () => {
  it("shows org + email (mono) in the identity header", async () => {
    const tree = await render();
    const text = textOf(tree);
    expect(text).toContain("Acme Tools");
    expect(text).toContain("ops@acme.example");
    const monos = findByClass(tree, "bb-mono");
    expect(monos.map((m) => textOf(m)).join(" ")).toContain("ops@acme.example");
  });

  it("forwards the session's OWN fields into the AccountForm (org/email/phoneLast4/role/status)", async () => {
    const props = accountFormProps(await render());
    expect(props).toBeDefined();
    expect(props!.orgName).toBe("Acme Tools");
    expect(props!.email).toBe("ops@acme.example");
    expect(props!.phoneLast4).toBe("1234");
    expect(props!.role).toBe("employer");
    expect(props!.status).toBe("active");
  });

  it("passes phoneLast4 as null (not the full number) when there is no phone on file", async () => {
    const props = accountFormProps(await render({ phoneLast4: null }));
    expect(props!.phoneLast4).toBeNull();
  });

  it("forwards agency role + suspended status through to the form", async () => {
    const props = accountFormProps(await render({ role: "agent", status: "suspended" }));
    expect(props!.role).toBe("agent");
    expect(props!.status).toBe("suspended");
  });
});

describe("AccountPage — no worker PII", () => {
  it("renders ONLY the payer's own data; no full phone, no worker identity", async () => {
    const tree = await render();
    const text = textOf(tree);
    expect(text).not.toMatch(/\b\d{10}\b/);
    expect(text).not.toMatch(/\+91/);
    expect(text).not.toContain("worker");
  });
});

describe("AccountPage — resilient state when account fields are unavailable", () => {
  it("renders the neutral retry Card and NOT the form when the session has no email yet", async () => {
    const tree = await render({ email: undefined });
    const text = textOf(tree);
    expect(text).toContain("Service unavailable");
    // The edit form is NOT rendered on the failure path.
    expect(findAll(tree, MockedAccountForm).length).toBe(0);
  });
});
