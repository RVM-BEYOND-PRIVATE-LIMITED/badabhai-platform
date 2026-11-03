import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The trusted-device cookie (ADR-0060 A3). The token is a bearer secret, so it is held exactly
 * like the session — httpOnly, SameSite=strict, path "/" — under its OWN name (signing out must
 * not drop it), for the server's stated lifetime. A cookie value that is not the shape the API
 * accepts back is treated as absent, because sending it would fail the whole sign-in request.
 */
const jar = new Map<string, string>();
const set = vi.fn((name: string, value: string, _options: unknown) => {
  jar.set(name, value);
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options: unknown) => set(name, value, options),
  }),
}));

const {
  ADMIN_DEVICE_COOKIE_NAME,
  ADMIN_TOKEN_COOKIE_NAME,
  clearAdminToken,
  isDeviceTokenShape,
  readAdminDeviceToken,
  writeAdminDeviceToken,
} = await import("./session-cookie");

const TOKEN = "Abc_-123".repeat(5) + "xyz"; // 43 chars, base64url

beforeEach(() => {
  jar.clear();
  set.mockClear();
});

describe("the device cookie", () => {
  it("is httpOnly, SameSite=strict, path / and lives as long as the server said", async () => {
    await writeAdminDeviceToken(TOKEN, 2592000);
    expect(set).toHaveBeenCalledWith(
      "bb_admin_device",
      TOKEN,
      expect.objectContaining({ httpOnly: true, sameSite: "strict", path: "/", maxAge: 2592000 }),
    );
  });

  it("has its own name — distinct from the session cookie", () => {
    expect(ADMIN_DEVICE_COOKIE_NAME).toBe("bb_admin_device");
    expect(ADMIN_DEVICE_COOKIE_NAME).not.toBe(ADMIN_TOKEN_COOKIE_NAME);
  });

  it("survives sign-out: clearing the session never touches it", async () => {
    await writeAdminDeviceToken(TOKEN, 60);
    await clearAdminToken();
    expect(set).not.toHaveBeenCalledWith("bb_admin_device", "", expect.anything());
    expect(await readAdminDeviceToken()).toBe(TOKEN);
  });

  it("reads back a well-formed token, and nothing at all otherwise", async () => {
    expect(await readAdminDeviceToken()).toBeNull();
    jar.set("bb_admin_device", TOKEN);
    expect(await readAdminDeviceToken()).toBe(TOKEN);
    for (const bad of ["short", "has space in it and is long enough", "x".repeat(129), ""]) {
      jar.set("bb_admin_device", bad);
      expect(await readAdminDeviceToken(), bad).toBeNull();
    }
  });

  it("the shape is the API's: base64url, 20..128", () => {
    expect(isDeviceTokenShape("a".repeat(20))).toBe(true);
    expect(isDeviceTokenShape("a".repeat(128))).toBe(true);
    expect(isDeviceTokenShape("a".repeat(19))).toBe(false);
    expect(isDeviceTokenShape("a".repeat(129))).toBe(false);
    expect(isDeviceTokenShape("abc+/=".repeat(5))).toBe(false);
  });
});
