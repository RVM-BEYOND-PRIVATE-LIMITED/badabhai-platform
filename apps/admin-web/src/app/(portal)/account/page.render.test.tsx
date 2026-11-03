import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Account page (ADR-0060 A2/A5): session-only, and every panel drawn from what the SERVER
 * reports on `GET /admin/me`.
 *
 *  - no password → "Set a password" (new + confirm); a password → "Change password" (current +
 *    new + confirm, with the current-password autocomplete token);
 *  - the two-step verification switch's `aria-checked` is the server's `mfa_enabled`;
 *  - a field the server did not send is "not available", never a guessed default;
 *  - a failed read is an error state, not an empty form.
 */
const stub = vi.hoisted(() => ({
  security: null as unknown,
  failure: null as unknown,
  gate: vi.fn(),
}));

vi.mock("../../../lib/auth", () => ({
  requireSession: async () => {
    stub.gate();
    return { adminId: "a-1", role: "analyst", capabilities: [] };
  },
}));
vi.mock("../../../lib/account", () => ({
  readAccountSecurity: async () => {
    if (stub.failure) throw stub.failure;
    return stub.security;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  setOwnPasswordAction: vi.fn(),
  enableMfaAction: vi.fn(),
  confirmMfaAction: vi.fn(),
  disableMfaAction: vi.fn(),
}));

const { default: AccountPage, metadata } = await import("./page");

const render = async () => renderToStaticMarkup(await AccountPage());
const switchTag = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";

beforeEach(() => {
  stub.security = { hasPassword: false, mustChangePassword: false, mfaEnabled: false };
  stub.failure = null;
  stub.gate.mockReset();
});

describe("the gate", () => {
  it("is the session alone — every role manages its own sign-in", async () => {
    await render();
    expect(stub.gate).toHaveBeenCalledTimes(1);
    expect(metadata.title).toBe("Account");
  });
});

describe("the password panel", () => {
  it("no password yet: Set a password, new + confirm, no current-password field", async () => {
    const html = await render();
    expect(html).toContain("Set a password");
    expect(html).not.toContain("Change password");
    expect(html).not.toMatch(/autocomplete="current-password"/i);
    expect((html.match(/autocomplete="new-password"/gi) ?? []).length).toBe(2);
  });

  it("a password: Change password, with the current one first", async () => {
    stub.security = { hasPassword: true, mustChangePassword: false, mfaEnabled: false };
    const html = await render();
    expect(html).toContain("Change password");
    const current = html.search(/autocomplete="current-password"/i);
    const next = html.search(/autocomplete="new-password"/i);
    expect(current).toBeGreaterThan(-1);
    expect(current).toBeLessThan(next);
  });

  it("a temporary password is called out above the panels", async () => {
    stub.security = { hasPassword: true, mustChangePassword: true, mfaEnabled: false };
    expect(await render()).toContain("You are signed in with a temporary password.");
  });

  it("always states the policy before the first keystroke", async () => {
    expect(await render()).toContain("8–128 characters, with at least one letter and one digit.");
  });
});

describe("the two-step verification switch", () => {
  it("off: aria-checked false, the word Off, and the recommendation", async () => {
    const html = await render();
    expect(switchTag(html)).toContain('aria-checked="false"');
    expect(html).toContain(">Off<");
    expect(html).toContain("Recommended for every admin");
  });

  it("on: aria-checked true and the word On — the server's state, not a request", async () => {
    stub.security = { hasPassword: true, mustChangePassword: false, mfaEnabled: true };
    const html = await render();
    expect(switchTag(html)).toContain('aria-checked="true"');
    expect(html).toContain(">On<");
    expect(html).not.toContain("Recommended for every admin");
  });

  it("explains both positions in plain words", async () => {
    const html = await render();
    expect(html).toContain("you sign in with your email and password only");
    expect(html).toContain("trust a device for 30 days");
  });

  it("shows no QR code and no code field until the switch is used", async () => {
    const html = await render();
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("one-time-code");
  });
});

describe("what the server did not say", () => {
  it("an older API (fields absent): each panel says so and offers nothing to press", async () => {
    stub.security = { hasPassword: null, mustChangePassword: false, mfaEnabled: null };
    const html = await render();
    expect((html.match(/Not available on this server yet/g) ?? []).length).toBe(2);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toMatch(/type="password"/);
  });

  it("a failed read is an error state with Retry — never a blank form", async () => {
    stub.failure = new Error("boom");
    const html = await render();
    expect(html).toContain("Your sign-in settings could not be loaded");
    expect(html).toContain('href="/account"');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toMatch(/type="password"/);
  });
});
