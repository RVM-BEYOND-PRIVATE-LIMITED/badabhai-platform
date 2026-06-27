import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../lib/auth/types";

/**
 * LOGIN PAGE (AUTH-1) — the enterprise two-column auth shell, rendered to an element tree in the
 * node env and walked. The page is a server component: it resolves `currentSession()` (→ redirect
 * to /dashboard when present) and otherwise renders the left BRAND/VALUE panel + the right card
 * with the (mocked) {@link LoginForm}.
 *
 * This suite locks the TRUTHFUL-content contract of the left panel: it renders ONLY the product's
 * real positioning (verified CNC/VMC talent · masked-until-unlocked · self-serve) and carries NO
 * invented testimonials / customer logos / fake stats, and NO PII. The form itself is mocked to a
 * marker so this is purely about the page shell's content + structure.
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

  it("renders the form + the left value panel when unauthenticated", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    // The <LoginForm /> element is present (its .type is the mock); the left panel renders once.
    expect(findAll(tree, MockedLoginForm).length).toBe(1);
    expect(findByClass(tree, "login-aside").length).toBe(1);
  });
});

describe("login page — left value panel is truthful + non-PII", () => {
  it("renders the product's REAL positioning (verified talent · masked-until-unlocked · self-serve)", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    const aside = findByClass(tree, "login-aside")[0]!;
    const txt = textOf(aside);
    expect(txt).toContain("Verified CNC/VMC talent");
    expect(txt).toContain("Masked until you unlock");
    expect(txt).toContain("self-serve");
  });

  it("carries NO invented testimonials / customer logos / fake stats", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    const txt = textOf(findByClass(tree, "login-aside")[0]!);
    // No quotation-style testimonials, no "trusted by N", no star-rating / logo-wall claims.
    expect(txt).not.toMatch(/testimonial|trusted by|loved by|rated \d|\d+ ?stars?/i);
    // No numeric stat/metric claims (e.g. "10,000+ hires", "98% match", "500 companies").
    expect(txt).not.toMatch(/\d/);
  });

  it("is aria-hidden so screen-reader users aren't read a decorative column twice", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    const aside = findByClass(tree, "login-aside")[0]!;
    expect((aside.props as Record<string, unknown>)["aria-hidden"]).toBe("true");
  });

  it("exposes no PII fields from any session (the panel is static product copy only)", async () => {
    currentSession.mockResolvedValue(null);
    const tree = (await LoginPage()) as ReactElement;
    const txt = textOf(findByClass(tree, "login-aside")[0]!);
    expect(txt).not.toMatch(/@/); // no email
    expect(txt).not.toMatch(/\+?\d[\d\s-]{7,}/); // no phone-like run
  });
});
