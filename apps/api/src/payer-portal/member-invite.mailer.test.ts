import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "@nestjs/common";
import { MockMemberInviteMailer } from "./member-invite.mailer";

const EMAIL = "hire@acmestaffing.example";
const ACCEPT_URL = "mock://invite/accept?token=tok-raw-0123456789abcdef";

/** Fake crypto mirroring PiiCryptoService.hmac (the mailer only needs the hash prefix). */
const pii = { hmac: (v: string) => `hmac<${v}>` };

describe("MockMemberInviteMailer — default alpha mailer, no send, PII-free logs", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  it("does NOT send and logs neither the email, the accept link, nor the token", async () => {
    const mailer = new MockMemberInviteMailer(pii as never);
    await expect(mailer.send({ email: EMAIL, acceptUrl: ACCEPT_URL })).resolves.toBeUndefined();
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain("acmestaffing");
    expect(logged).not.toContain("tok-raw-0123456789abcdef");
    // It DOES log a safe hash prefix + a mock status marker.
    expect(logged).toContain("status=mock");
  });
});
