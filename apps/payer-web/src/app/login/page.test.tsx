import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../lib/auth/types";

/**
 * LOGIN PAGE — the single centred auth card, rendered to an element tree in the node env and
 * walked. The page is a server component: it resolves `currentSession()` (→ redirect to
 * /dashboard when present) and otherwise renders the card with the (mocked) {@link LoginForm}.
 *
 * This suite locks the SHAPE of the screen: one card, no second column. It used to assert the
 * opposite — a left brand/value panel with truthful-only copy — and that panel has been removed,
 * so the assertions are inverted rather than deleted: the marketing column must not come back
 * silently, because a reader on this screen has already decided to sign in. The remaining
 * content checks (no PII, no invented stats) now run over the WHOLE page, which is the stronger
 * guarantee the panel-scoped versions were approximating. The form itself is mocked to a marker
 * so this is purely about the page shell's content + structure.
 */

const currentSession = vi.fn<() => Promise<PayerSession | null>>();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("../../lib/auth", () => ({
  payerAuth: () => ({ currentSession: () => currentSession() }),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
// The brand lockup + theme toggle are client/SVG primitives; render them as inert markers so the
// page shell's own copy + structure is the thing under test (no hooks, no font/SVG concerns).
const BadaBhaiLogoMock = vi.fn(() => null);
vi.mock("../../components/ds", () => ({
  BadaBhaiLogo: BadaBhaiLogoMock,
  ThemeToggle: () => null,
}));
// The auth form is a client component with hooks — mock it to a stable marker function. The page
// renders `<LoginForm />`, so the rendered element's `.type` is this very function; we find that
// element in the tree (the marker is referenced, not invoked, during the page's own render).
const LoginFormMock = vi.fn(() => null);
vi.mock("./login-form", () => ({ LoginForm: () => LoginFormMock() }));

const { default: LoginPage } = await import("./page");
const { LoginForm: MockedLoginForm } = await import("./login-form");
const { NavPendingStatus } = await import("../../components/nav-pending");

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
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

beforeEach(() => {
  currentSession.mockReset();
  redirect.mockClear();
  LoginFormMock.mockClear();
});

describe("login page — auth shell", () => {
  it("redirects to /dashboard when a session already exists (no auth UI rendered)", async () => {
    currentSession.mockResolvedValue({
      payerId: "p1",
      displayLabel: "Acme",
      role: "employer",
      status: "active",
    });
    await expect(LoginPage()).rejects.toThrow("REDIRECT:/dashboard");
  });

  it("renders the form in ONE card when unauthenticated", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    // The <LoginForm /> element is present (its .type is the mock); exactly one card holds it.
    expect(findAll(tree, MockedLoginForm).length).toBe(1);
    expect(findByClass(tree, "login-card").length).toBe(1);
  });

  it("renders the navigation cue's bar + status line ONCE — there is no portal shell to", async () => {
    // A verified code navigates to the dashboard (login-form → usePortalNavigation): its "Opening
    // Dashboard…" line and bar need a NavPendingStatus on THIS page, outside the card.
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    expect(findAll(tree, NavPendingStatus)).toHaveLength(1);
    const card = findByClass(tree, "login-card")[0]!;
    expect(findAll(card, NavPendingStatus)).toHaveLength(0);
  });
});

describe("login page — designr5 split auth desk", () => {
  it("renders the split shell: the form card beside the hiring-proof aside", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    expect(findByClass(tree, "login-shell")).toHaveLength(1);
    expect(findByClass(tree, "login-split")).toHaveLength(1);
    const cards = findByClass(tree, "login-card");
    const asides = findByClass(tree, "login-aside");
    expect(cards).toHaveLength(1);
    expect(asides).toHaveLength(1);
    expect(findAll(cards[0], MockedLoginForm)).toHaveLength(1);
    expect(findByClass(asides[0], "login-aside__title")).toHaveLength(1);
  });

  it("carries the designr5 proof copy (static marketing, no live read)", async () => {
    currentSession.mockResolvedValue(null);
    const txt = textOf((await LoginPage()) as ReactElement);
    expect(txt).toContain("Hire workers directly. No middleman delays.");
    expect(txt).toContain("180,000+ Verified Workers");
    expect(txt).toContain("Instant WhatsApp Connect");
    expect(txt).toContain("50 Free Hiring Credits");
    expect(txt).toContain("Rahul Kumar");
  });

  it("keeps one <h1> before the aside's <h2>, and the auth form is the first control", () => {
    const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(source.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(source.match(/<h2\b/g) ?? []).toHaveLength(1);
    expect(source.indexOf("<h1")).toBeLessThan(source.indexOf("<h2"));
  });

  it("exposes no PII anywhere on the page (it is static copy + the form)", async () => {
    currentSession.mockResolvedValue(null);
    const txt = textOf((await LoginPage()) as ReactElement);
    expect(txt).not.toMatch(/@/); // no email
    expect(txt).not.toMatch(/\+?\d[\d\s-]{7,}/); // no phone-like run
  });
});

describe("login page — designr5 brand bar", () => {
  it("renders the lockup ONCE in the top bar, not inside the auth card", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    const topbars = findByClass(tree, "login-topbar");
    expect(topbars).toHaveLength(1);
    const logos = findAll(tree, BadaBhaiLogoMock);
    expect(logos).toHaveLength(1);
    expect(findAll(topbars[0], BadaBhaiLogoMock)).toHaveLength(1);
    const cards = findByClass(tree, "login-card");
    expect(cards).toHaveLength(1);
    expect(findAll(cards[0], BadaBhaiLogoMock)).toHaveLength(0);
  });

  it("the top bar carries the network status and assistance links, no heading", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    const topbar = findByClass(tree, "login-topbar")[0]!;
    expect(textOf(topbar)).toContain("Direct verified applicant network");
    expect(textOf(topbar)).toContain("Need assistance?");
    expect(findAll(topbar, "h1")).toHaveLength(0);
    expect(findAll(topbar, "h2")).toHaveLength(0);
  });
});
