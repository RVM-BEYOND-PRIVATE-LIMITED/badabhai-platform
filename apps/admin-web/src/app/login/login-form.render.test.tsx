import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the sign-in page's FIRST screen renders, per door (ADR-0060). The step-by-step flow is in
 * `login-form.behaviour.test.tsx`; this pins the markup a password manager and a screen reader
 * meet: the autocomplete tokens, the labelled show/hide toggle, and the two secondary doors as
 * real links. The actions are stubbed — nothing here may call one on render.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
const actions = vi.hoisted(() => ({
  passwordLoginAction: vi.fn(),
  requestCodeAction: vi.fn(),
  verifyCodeAction: vi.fn(),
  verifyMfaAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { LoginForm } = await import("./login-form");

describe("the password door (default)", () => {
  const html = renderToStaticMarkup(<LoginForm method="password" />);

  it("asks for email and password with the autocomplete tokens password managers key on", () => {
    // React writes the attribute as `autoComplete`; HTML attribute names are case-insensitive.
    expect(html).toMatch(/<input[^>]*type="email"[^>]*autocomplete="username"/i);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autocomplete="current-password"/i);
    expect(html).toContain(">Password</label>");
  });

  it("the password field has a labelled show/hide toggle, unpressed, that never submits", () => {
    const toggle = /<button[^>]*aria-label="Show password"[^>]*>/.exec(html)?.[0] ?? "";
    expect(toggle).not.toBe("");
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('aria-pressed="false"');
  });

  it("offers Forgot password and the emailed-code door as real links", () => {
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain("Forgot password?");
    expect(html).toContain('href="/login?method=code"');
    expect(html).toContain("Sign in with an email code instead");
  });

  it("shows no authenticator, no trust box and no QR before the server asks for them", () => {
    expect(html).not.toContain("trust_device");
    expect(html).not.toContain("Trust this device");
    expect(html).not.toContain("one-time-code");
    expect(html).not.toContain("<svg");
  });

  it("calls no action on render", () => {
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the emailed-code door", () => {
  const html = renderToStaticMarkup(<LoginForm method="code" />);

  it("asks for the email only, and links back to the password door", () => {
    expect(html).toContain("Sign in with an email code");
    expect(html).not.toMatch(/type="password"/);
    expect(html).toContain('href="/login"');
    expect(html).toContain("Sign in with a password instead");
  });
});
