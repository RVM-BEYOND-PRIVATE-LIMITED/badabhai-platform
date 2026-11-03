import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /login picks its door from the URL (ADR-0060): `?method=code` is the emailed-code door kept for
 * admins with no password; anything else — absent, repeated, unknown — is the password door. A
 * signed-in admin is sent into the portal.
 */
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../lib/auth", () => ({ currentSession: async () => session.current }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  passwordLoginAction: vi.fn(),
  requestCodeAction: vi.fn(),
  verifyCodeAction: vi.fn(),
  verifyMfaAction: vi.fn(),
}));

const { default: LoginPage } = await import("./page");

const render = async (method?: string | string[]) =>
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ method }) }));

beforeEach(() => {
  session.current = null;
});

describe("the door", () => {
  it("defaults to email + password", async () => {
    const html = await render();
    expect(html).toContain("Admin sign-in");
    expect(html).toMatch(/type="password"/);
  });

  it("?method=code is the emailed-code door", async () => {
    const html = await render("code");
    expect(html).toContain("Sign in with an email code");
    expect(html).not.toMatch(/type="password"/);
  });

  it("a repeated parameter takes the first; an unknown one is the password door", async () => {
    expect(await render(["code", "password"])).toContain("Sign in with an email code");
    expect(await render("magic")).toMatch(/type="password"/);
  });

  it("a signed-in admin goes straight to the portal", async () => {
    session.current = { adminId: "a-1", role: "ops_admin", capabilities: [] };
    await expect(render()).rejects.toThrow("NEXT_REDIRECT /");
  });
});
