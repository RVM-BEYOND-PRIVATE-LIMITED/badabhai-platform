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
 * retry state (the form is NOT rendered).
 *
 * UI-1: the page composes the shared spine, so the structural assertions below name the
 * primitives (`page-head__title`, `state--error`, `state__actions`) rather than the retired
 * per-page classes (`dash-title`, `dash-state`).
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
const { Badge } = await import("../../../components/ds");
const { EMAIL_SUPPORT_HELPER } = await import("./messages");
const { AccountForm: MockedAccountForm } = await import("./account-form");

const { PageHeader } = await import("../../../components/page-header");
type PageHeaderProps = Parameters<typeof PageHeader>[0];

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

  it("titles the screen with the shared page-head primitive + a one-line purpose", async () => {
    // The head is the shared PageHeader; render it to assert the markup it emits.
    const heads = findAll(await render(), PageHeader);
    expect(heads.length).toBe(1);
    const head = PageHeader(heads[0]!.props as PageHeaderProps);
    const titles = findByClass(head, "page-head__title");
    expect(titles.length).toBe(1);
    expect(textOf(titles[0]!)).toBe("Account");
    expect(findByClass(head, "page-head__sub").length).toBe(1);
    // A top-level page (the account menu opens it): no back link.
    expect(findByClass(head, "page-back")).toEqual([]);
  });

  it("forwards the session's OWN editable fields into the AccountForm (org + phoneLast4) only", async () => {
    const props = accountFormProps(await render());
    expect(props).toBeDefined();
    expect(props).toEqual({ orgName: "Acme Tools", phoneLast4: "1234" });
  });

  it("passes phoneLast4 as null (not the full number) when there is no phone on file", async () => {
    const props = accountFormProps(await render({ phoneLast4: null }));
    expect(props!.phoneLast4).toBeNull();
  });

  it("shows agency role + suspended status as Badges in the read-only panel", async () => {
    const tree = await render({ role: "agent", status: "suspended" });
    const panel = findByClass(tree, "panel").find((x) => textOf(x).includes("Signed in as"))!;
    const badges = findAll(panel, Badge).map((b) => textOf(b).trim());
    expect(badges).toEqual(["Agency", "Suspended"]);
  });
});

/**
 * F22 (final sweep) — "Save changes", the page's one primary, sat at y=1,046 on an 800px screen
 * (y=1,288 at 375): a read-only identity panel led the page and the form carried a read-only
 * block between its fields and Save. What you can EDIT now leads; the facts follow it.
 */
describe("AccountPage — the editable form leads, the read-only facts follow (F22)", () => {
  const panels = (tree: ReactElement) =>
    findByClass(tree, "panel").map((x) => textOf(findByClass(x, "panel__title")[0]!).trim());

  it("'Your details' (the form) comes first, 'Signed in as' after it", async () => {
    const tree = await render();
    expect(panels(tree)).toEqual(["Your details", "Signed in as"]);
    const first = findByClass(tree, "panel")[0]!;
    expect(findAll(first, MockedAccountForm)).toHaveLength(1);
  });

  it("the read-only panel holds the login email (mono), role, status and the support helper", async () => {
    const tree = await render();
    const panel = findByClass(tree, "panel")[1]!;
    const text = textOf(panel);
    for (const k of ["Organisation", "Account email", "Role", "Status"]) expect(text).toContain(k);
    expect(text).toContain("Acme Tools");
    expect(textOf(findByClass(panel, "bb-mono")[0]!)).toBe("ops@acme.example");
    expect(findAll(panel, Badge).map((b) => textOf(b).trim())).toEqual(["Company", "Active"]);
    expect(text).toContain(EMAIL_SUPPORT_HELPER);
    // The email is shown ONCE on the page.
    expect(textOf(tree).match(/ops@acme\.example/g)).toHaveLength(1);
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
  it("renders the neutral retry state and NOT the form when the session has no email yet", async () => {
    const tree = await render({ email: undefined });
    const text = textOf(tree);
    expect(text).toContain("Service unavailable");
    // The failure renders as the shared ERROR state, with a recovery action (RetryButton).
    expect(findByClass(tree, "state--error").length).toBe(1);
    expect(findByClass(tree, "state__actions").length).toBe(1);
    // The edit form is NOT rendered on the failure path.
    expect(findAll(tree, MockedAccountForm).length).toBe(0);
  });
});
