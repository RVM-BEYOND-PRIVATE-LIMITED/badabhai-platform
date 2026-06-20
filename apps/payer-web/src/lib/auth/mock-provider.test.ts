import { describe, expect, it } from "vitest";
import { decodeSession, encodeSession } from "./session-token";
import { matchMockAccountByEmail } from "./fixtures";
import type { PayerSession } from "./types";

const session: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools (mock)",
  role: "employer",
};

describe("session-token codec (XB-H tamper resistance)", () => {
  it("round-trips a valid signed session", () => {
    expect(decodeSession(encodeSession(session))).toEqual(session);
  });

  it("rejects a tampered payload (forged payer id) with the old MAC", () => {
    const [, mac] = encodeSession(session).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...session, payerId: "99999999-9999-4999-8999-999999999999" }),
    ).toString("base64url");
    expect(decodeSession(`${forged}.${mac}`)).toBeNull();
  });

  it("rejects a malformed cookie", () => {
    expect(decodeSession("not-a-cookie")).toBeNull();
    expect(decodeSession("")).toBeNull();
  });

  it("rejects a session with a bad role enum", () => {
    const bad = Buffer.from(JSON.stringify({ ...session, role: "ops" })).toString("base64url");
    // Re-sign so the MAC matches but the shape is invalid → still rejected.
    const reSigned = encodeSession({ ...session, role: "employer" });
    const [, mac] = reSigned.split(".");
    expect(decodeSession(`${bad}.${mac}`)).toBeNull();
  });
});

describe("mock fixtures (OTP-flow email lookup)", () => {
  it("matches a known demo account by email (case-insensitive)", () => {
    expect(matchMockAccountByEmail("DEMO@acme-tools.example")).not.toBeNull();
  });

  it("returns null for an unknown email", () => {
    expect(matchMockAccountByEmail("nobody@example.com")).toBeNull();
  });
});
