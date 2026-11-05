import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The forgot-password page's first screen (ADR-0060 A4): one email field, a neutral promise that
 * never confirms an account exists, and the way back to sign in. The page itself sits outside
 * `(portal)` — a signed-in admin is sent to /account instead (asserted below).
 */
const actions = vi.hoisted(() => ({
  requestResetCodeAction: vi.fn(),
  resetPasswordAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

const session = vi.hoisted(() => ({ current: null as unknown }));
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../lib/auth", () => ({ currentSession: async () => session.current }));

const { ForgotPasswordForm } = await import("./forgot-form");
const { default: ForgotPasswordPage, metadata } = await import("./page");

describe("the first screen", () => {
  const html = renderToStaticMarkup(<ForgotPasswordForm />);

  it("asks for the work email only, with the username autocomplete token", () => {
    expect(html).toContain("Reset your password");
    expect(html).toMatch(/<input[^>]*type="email"[^>]*autocomplete="username"/i);
    expect(html).not.toMatch(/type="password"/);
    expect(html).not.toContain("one-time-code");
  });

  it("is phrased as a condition — it never says the address is an admin", () => {
    expect(html).toContain("If it belongs to an active admin account");
    expect(html).not.toMatch(/we (have )?sent/i);
  });

  it("links back to sign in", () => {
    expect(html).toContain('href="/login"');
    expect(html).toContain("Back to sign in");
  });

  it("calls no action on render", () => {
    expect(actions.requestResetCodeAction).not.toHaveBeenCalled();
    expect(actions.resetPasswordAction).not.toHaveBeenCalled();
  });
});

describe("the page", () => {
  it("is titled, never indexed, and renders the form for a signed-out visitor", async () => {
    expect(metadata.title).toBe("Reset your password");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    session.current = null;
    const html = renderToStaticMarkup(await ForgotPasswordPage());
    expect(html).toContain("Reset your password");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends a signed-in admin to Account, where a password is changed without email", async () => {
    session.current = { adminId: "a-1", role: "ops_admin", capabilities: [] };
    await expect(ForgotPasswordPage()).rejects.toThrow("NEXT_REDIRECT /account");
  });
});
