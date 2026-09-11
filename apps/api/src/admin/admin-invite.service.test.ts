import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AdminInviteService } from "./admin-invite.service";
import type { AdminInviteMailer } from "./admin-invite.mailer";

// Real crypto with deterministic test secrets, so `hashToken` is asserted as a GENUINE keyed
// HMAC rather than a stub that happens to return a string.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: TEST_KEY,
} as unknown as ServerConfig);

const EMAIL = "new.admin@badabhai.in";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function make(over: Partial<ServerConfig> = {}, mailer?: Partial<AdminInviteMailer>) {
  const send = vi.fn(async () => undefined);
  const svc = new AdminInviteService(
    {
      ADMIN_INVITE_TTL_HOURS: 48,
      ADMIN_INVITE_ACCEPT_URL: "https://admin.badabhai.in/invite/accept",
      ...over,
    } as unknown as ServerConfig,
    { send, ...mailer } as AdminInviteMailer,
    pii,
  );
  return { svc, send };
}

describe("AdminInviteService.mintToken — the accept credential", () => {
  it("mints a high-entropy, URL-safe, non-repeating token", () => {
    const { svc } = make();
    const a = svc.mintToken();
    const b = svc.mintToken();

    // 32 bytes base64url → 43 chars, no padding, no characters needing escaping.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Two mints never collide — the whole security of the link rests on this.
    expect(a).not.toBe(b);
  });

  it("survives a query string unchanged (no escaping surprises in the link)", () => {
    const { svc } = make();
    const raw = svc.mintToken();
    expect(encodeURIComponent(raw)).toBe(raw);
  });
});

describe("AdminInviteService.hashToken — only the HMAC is ever stored", () => {
  it("is the keyed HMAC of the raw token and leaks no fragment of it", () => {
    const { svc } = make();
    const raw = svc.mintToken();
    const hash = svc.hashToken(raw);

    expect(hash).toBe(pii.hmac(raw));
    // Irreversible: the stored value must not contain the credential it authenticates.
    expect(hash).not.toContain(raw);
    // Distinct tokens → distinct hashes (a real digest, not a constant).
    expect(svc.hashToken(svc.mintToken())).not.toBe(hash);
  });

  it("is deterministic, so a presented token resolves the row it minted", () => {
    const { svc } = make();
    const raw = svc.mintToken();
    expect(svc.hashToken(raw)).toBe(svc.hashToken(raw));
  });
});

describe("AdminInviteService.expiryFrom — the 48h window", () => {
  it("adds the configured TTL to the supplied instant", () => {
    const { svc } = make();
    const now = new Date("2026-09-11T00:00:00.000Z");
    expect(svc.expiryFrom(now).toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });

  it("honours a non-default TTL", () => {
    const { svc } = make({ ADMIN_INVITE_TTL_HOURS: 2 } as Partial<ServerConfig>);
    const now = new Date("2026-09-11T00:00:00.000Z");
    expect(svc.expiryFrom(now).toISOString()).toBe("2026-09-11T02:00:00.000Z");
  });
});

describe("AdminInviteService.buildAcceptUrl — the shared link", () => {
  it("appends the token to the configured accept page", () => {
    const { svc } = make();
    expect(svc.buildAcceptUrl("tok123")).toBe(
      "https://admin.badabhai.in/invite/accept?token=tok123",
    );
  });

  it("uses & when the configured base already carries a query string", () => {
    const { svc } = make({
      ADMIN_INVITE_ACCEPT_URL: "https://admin.badabhai.in/invite/accept?src=mail",
    } as Partial<ServerConfig>);
    expect(svc.buildAcceptUrl("tok123")).toBe(
      "https://admin.badabhai.in/invite/accept?src=mail&token=tok123",
    );
  });

  it("percent-encodes the token rather than emitting a broken URL", () => {
    const { svc } = make();
    expect(svc.buildAcceptUrl("a b&c")).toBe(
      "https://admin.badabhai.in/invite/accept?token=a%20b%26c",
    );
  });

  it("degrades to an obviously-fake mock:// link when no base is configured", () => {
    const { svc } = make({ ADMIN_INVITE_ACCEPT_URL: undefined } as Partial<ServerConfig>);
    // Deliberately unusable: an operator sees immediately that the base is unset, rather than
    // sharing a plausible link that points at the wrong origin.
    expect(svc.buildAcceptUrl("tok123")).toBe("mock://admin-invite/accept?token=tok123");
  });
});

describe("AdminInviteService.deliver — best-effort, never fatal", () => {
  it("hands the raw link to the mailer (its one legitimate destination)", async () => {
    const { svc, send } = make();
    await svc.deliver(EMAIL, "https://admin.badabhai.in/invite/accept?token=tok123", ADMIN_ID);

    expect(send).toHaveBeenCalledWith({
      email: EMAIL,
      acceptUrl: "https://admin.badabhai.in/invite/accept?token=tok123",
      expiresInHours: 48,
    });
  });

  it("SWALLOWS a transport failure — the invite is already committed when this runs", async () => {
    const boom = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const { svc } = make({}, { send: boom });

    // Must not reject: throwing here would report failure for an invite that genuinely
    // exists, and would roll nothing back. The caller still returns the link to the inviter.
    await expect(
      svc.deliver(EMAIL, "https://admin.badabhai.in/invite/accept?token=tok123", ADMIN_ID),
    ).resolves.toBeUndefined();
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("the failure log names the opaque admin id ONLY — never the email, token, or link", async () => {
    const boom = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const { svc } = make({}, { send: boom });
    const warn = vi
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, "warn")
      .mockImplementation(() => undefined);

    await svc.deliver(EMAIL, "https://admin.badabhai.in/invite/accept?token=tok123", ADMIN_ID);

    const line = warn.mock.calls[0]![0] as string;
    expect(line).toContain(ADMIN_ID);
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain("tok123");
    expect(line).not.toContain("new.admin");
  });
});
