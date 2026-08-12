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
vi.mock("../../lib/auth", () => ({ payerAuth: () => ({ currentSession: () => currentSession() }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
// The brand lockup + theme toggle are client/SVG primitives; render them as inert markers so the
// page shell's own copy + structure is the thing under test (no hooks, no font/SVG concerns).
vi.mock("../../components/ds", () => ({
  BadaBhaiLogo: () => null,
  ThemeToggle: () => null,
}));
// The auth form is a client component with hooks — mock it to a stable marker function. The page
// renders `<LoginForm />`, so the rendered element's `.type` is this very function; we find that
// element in the tree (the marker is referenced, not invoked, during the page's own render).
const LoginFormMock = vi.fn(() => null);
vi.mock("./login-form", () => ({ LoginForm: () => LoginFormMock() }));

const { default: LoginPage } = await import("./page");
const { LoginForm: MockedLoginForm } = await import("./login-form");

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
});

describe("login page — one column, no marketing panel", () => {
  it("renders NO second column beside the form", async () => {
    // The screen was a two-pane split above 1024px: a brand/value panel + the card. It is one
    // centred card at every width now. Asserted by class AND by element type, so re-adding the
    // panel under a different class name still trips this.
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    expect(findByClass(tree, "login-aside")).toHaveLength(0);
    expect(findByClass(tree, "login-shell")).toHaveLength(0);
    expect(findAll(tree, "aside")).toHaveLength(0);
  });

  it("carries no value-prop / testimonial copy at all", async () => {
    currentSession.mockResolvedValue(null);
    const txt = textOf((await LoginPage()) as ReactElement);
    // The panel's own copy is gone with it.
    expect(txt).not.toMatch(/Verified CNC\/VMC talent|Masked until you unlock|self-serve/);
    // And the guard the panel used to carry now covers the WHOLE page: no testimonials, no
    // logo-wall claims, no invented metrics anywhere on the sign-in screen.
    expect(txt).not.toMatch(/testimonial|trusted by|loved by|rated \d|\d+ ?stars?/i);
  });

  it("keeps a single <h1> and no heading above it", () => {
    // The panel's tagline used to render BEFORE the card; as an <h2> it put a heading ahead of
    // the page's only <h1>. With the panel gone the card's <h1> is the first heading — locked
    // at the source level so a future addition above it is caught.
    const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/login-aside/);
    expect(source.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/<h2\b/);
  });

  it("exposes no PII anywhere on the page (it is static copy + the form)", async () => {
    currentSession.mockResolvedValue(null);
    const txt = textOf((await LoginPage()) as ReactElement);
    expect(txt).not.toMatch(/@/); // no email
    expect(txt).not.toMatch(/\+?\d[\d\s-]{7,}/); // no phone-like run
  });
});
