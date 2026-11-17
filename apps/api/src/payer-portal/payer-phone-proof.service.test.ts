import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { PayerSmsSendCapExceededException } from "../common/otp-send-cap";
import { memoryIdempotency } from "../campus-drives/campus-drive-requests.test-support";
import { PayerPhoneProofService } from "./payer-phone-proof.service";
import { PayerPhoneProofController } from "./payer-phone-proof.controller";
import { PHONE_PROOF_CONFLICT_REASONS, PayerPhoneProofVerifySchema } from "./payer-phone-proof.dto";

/**
 * #2754 item 3 — a signed-in company proves the phone on its account: `POST /payer/me/phone-proof`
 * and `/verify`. The OTP slot rules live in payer-otp.service.test.ts and the write's transaction in
 * payer-phone-proofs.repository.test.ts (and the real index in the DB gate); this file pins the
 * route rules: the switch, what may be said, the 409s, the 503s and the idempotent verify.
 */
const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
const PHONE = "+919876543210";
const HASH = "h".repeat(64);
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const missingTable = () => Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });

function setup(
  over: {
    sms?: boolean;
    row?: Record<string, unknown> | undefined;
    phone?: string;
    write?: "proven" | "phone_changed" | "held_elsewhere" | Error;
  } = {},
) {
  const config = {
    PAYER_SMS_OTP_ENABLED: over.sms ?? true,
    PAYER_AUTH_MAX_PER_IP_PER_HOUR: 50,
  } as unknown as ServerConfig;
  const row =
    "row" in over ? over.row : { id: PAYER, status: "active", phoneHash: HASH, phoneEnc: "enc" };
  const payers = { findById: vi.fn(async () => row) };
  const tx = { tag: "tx" };
  const proofs = {
    assertTablePresent: vi.fn(async () => undefined),
    recordSmsProof: vi.fn(
      async (_payerId: string, _hash: string, onProven: (t: unknown) => Promise<void>) => {
        const w = over.write ?? "proven";
        if (w instanceof Error) throw w;
        if (w === "proven") await onProven(tx);
        return w;
      },
    ),
  };
  const otp = {
    issuePhoneProof: vi.fn(
      async (_input: { payerId: string; phoneHash: string; phone: string }) => ({
        resendInSeconds: 30,
      }),
    ),
    verifyPhoneProof: vi.fn(
      async (_input: { payerId: string; phoneHash: string; code: string }) => undefined,
    ),
  };
  const events = { emit: vi.fn(async (_e: Record<string, unknown>) => undefined) };
  const pii = { decrypt: vi.fn(() => over.phone ?? PHONE) };
  const svc = new PayerPhoneProofService(
    config,
    payers as never,
    proofs as never,
    otp as never,
    events as never,
    pii as never,
  );
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const idem = memoryIdempotency();
  const controller = new PayerPhoneProofController(svc, ipRateLimit as never, idem.seam, config);
  return { svc, controller, payers, proofs, otp, events, pii, ipRateLimit, idem, tx };
}

const SELF = { id: PAYER, sid: "sid", role: "employer" as const };
const req = (key?: string) =>
  ({
    ip: "203.0.113.9",
    header: (name: string) => (name.toLowerCase() === "idempotency-key" ? key : undefined),
  }) as unknown as Request;
const reasonOf = (err: unknown) =>
  ((err as HttpException).getResponse() as { reason?: string }).reason;

describe("the switch — both routes 404 while PAYER_SMS_OTP_ENABLED is off", () => {
  it("request and verify 404 before any counter moves, any row is read or any code is checked", async () => {
    const d = setup({ sms: false });
    await expect(d.controller.requestProof(SELF, req(), CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      d.controller.verifyProof(SELF, { code: "123456" }, req("k1"), CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(d.ipRateLimit.assertWithinHourlyIpCap).not.toHaveBeenCalled();
    expect(d.payers.findById).not.toHaveBeenCalled();
    expect(d.otp.issuePhoneProof).not.toHaveBeenCalled();
    expect(d.otp.verifyPhoneProof).not.toHaveBeenCalled();
  });

  it("the service refuses on its own too (defence in depth)", async () => {
    const d = setup({ sms: false });
    await expect(d.svc.requestProof(PAYER, CTX)).rejects.toBeInstanceOf(NotFoundException);
    await expect(d.svc.verifyProof(PAYER, "123456", CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("POST /payer/me/phone-proof — a code to the account's CURRENT phone", () => {
  it("sends to the stored phone (decrypted here only), keyed by the guard principal, under the per-IP cap", async () => {
    const d = setup();
    await expect(d.controller.requestProof(SELF, req(), CTX)).resolves.toEqual({
      status: "code_sent",
      resend_in_seconds: 30,
    });
    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "payer_auth",
      "203.0.113.9",
      50,
    );
    expect(d.payers.findById).toHaveBeenCalledWith(PAYER);
    expect(d.otp.issuePhoneProof).toHaveBeenCalledWith({
      payerId: PAYER,
      phoneHash: HASH,
      phone: PHONE,
    });
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("no phone on the account → 409 no_phone_on_account, no SMS", async () => {
    const d = setup({ row: { id: PAYER, status: "active", phoneHash: null, phoneEnc: null } });
    const err = await d.svc.requestProof(PAYER, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(reasonOf(err)).toBe(PHONE_PROOF_CONFLICT_REASONS.noPhone);
    expect(d.otp.issuePhoneProof).not.toHaveBeenCalled();
  });

  it.each([["+15551234567"], ["+447911123456"], ["+915876543210"]])(
    "a stored phone SMS cannot prove (%s) → 409 phone_not_provable, no SMS",
    async (phone) => {
      const d = setup({ phone });
      const err = await d.svc.requestProof(PAYER, CTX).catch((e: unknown) => e);
      expect(reasonOf(err)).toBe(PHONE_PROOF_CONFLICT_REASONS.notProvable);
      expect(d.otp.issuePhoneProof).not.toHaveBeenCalled();
    },
  );

  it("42P01 (the table not migrated) → 503 BEFORE any SMS is spent", async () => {
    const d = setup();
    d.proofs.assertTablePresent.mockRejectedValueOnce(missingTable());
    await expect(d.svc.requestProof(PAYER, CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(d.otp.issuePhoneProof).not.toHaveBeenCalled();
  });

  it("the company-SMS ceiling: its breach event, then the 429 (signed in, so no neutral body)", async () => {
    const d = setup();
    d.otp.issuePhoneProof.mockRejectedValueOnce(
      new PayerSmsSendCapExceededException({ limit: 500, window: "20261117" }),
    );
    await expect(d.svc.requestProof(PAYER, CTX)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(d.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "payer.sms_send_cap_exceeded",
        payload: { cap: "global_daily", limit: 500, window: "20261117" },
      }),
    );
  });

  it("a gone payer row → the neutral not-found; an undecryptable phone → a generic 500", async () => {
    await expect(setup({ row: undefined }).svc.requestProof(PAYER, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const d = setup();
    d.pii.decrypt.mockImplementationOnce(() => {
      throw new Error("gcm auth failed");
    });
    await expect(d.svc.requestProof(PAYER, CTX)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe("POST /payer/me/phone-proof/verify — the proof row and its event", () => {
  it("checks the code for (account, current phone hash), writes the proof and emits payer.phone_proven IN the transaction", async () => {
    const d = setup();
    await expect(d.svc.verifyProof(PAYER, "123456", CTX)).resolves.toEqual({ status: "proven" });
    expect(d.otp.verifyPhoneProof).toHaveBeenCalledWith({
      payerId: PAYER,
      phoneHash: HASH,
      code: "123456",
    });
    expect(d.proofs.recordSmsProof).toHaveBeenCalledWith(PAYER, HASH, expect.any(Function));
    expect(d.events.emit).toHaveBeenCalledTimes(1);
    const event = d.events.emit.mock.calls[0]![0];
    expect(event).toMatchObject({
      event_name: "payer.phone_proven",
      payload: { payer_id: PAYER, method: "sms_code" },
      tx: d.tx,
    });
    // Registry-valid, and ids + a closed code only.
    expect(() =>
      validateEvent({
        event_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
        event_name: "payer.phone_proven",
        event_version: 1,
        occurred_at: new Date().toISOString(),
        actor: { actor_type: "payer", actor_id: PAYER },
        subject: { subject_type: "payer", subject_id: PAYER },
        correlation_id: CTX.correlationId,
        payload: event.payload,
      } as never),
    ).not.toThrow();
    expect(JSON.stringify(event.payload)).not.toContain("9876543210");
    expect(JSON.stringify(event.payload)).not.toContain(HASH);
  });

  it("a wrong or expired code is the OTP 401, and nothing is written", async () => {
    const d = setup();
    d.otp.verifyPhoneProof.mockRejectedValueOnce(
      new UnauthorizedException("Incorrect or expired code"),
    );
    await expect(d.svc.verifyProof(PAYER, "000000", CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.proofs.recordSmsProof).not.toHaveBeenCalled();
  });

  it("the phone is proven by ANOTHER account → a clear 409 phone_linked_to_another_account, no event", async () => {
    const d = setup({ write: "held_elsewhere" });
    const err = await d.svc.verifyProof(PAYER, "123456", CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(reasonOf(err)).toBe(PHONE_PROOF_CONFLICT_REASONS.heldElsewhere);
    expect((err as HttpException).message).toMatch(/linked to another BadaBhai account/);
    expect((err as HttpException).message).toMatch(/Contact BadaBhai support/);
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("the phone changed between send and verify → 409 phone_changed, no event", async () => {
    const d = setup({ write: "phone_changed" });
    const err = await d.svc.verifyProof(PAYER, "123456", CTX).catch((e: unknown) => e);
    expect(reasonOf(err)).toBe(PHONE_PROOF_CONFLICT_REASONS.phoneChanged);
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("42P01 on the write → 503, never a 500", async () => {
    const d = setup({ write: missingTable() });
    await expect(d.svc.verifyProof(PAYER, "123456", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("any other write error propagates unchanged", async () => {
    const d = setup({ write: new Error("deadlock detected") });
    await expect(d.svc.verifyProof(PAYER, "123456", CTX)).rejects.toThrow("deadlock detected");
  });

  it("the body is { code } only: 4–8 digits, strict (no payer id, no phone)", () => {
    expect(PayerPhoneProofVerifySchema.safeParse({ code: "123456" }).success).toBe(true);
    for (const body of [
      { code: "12" },
      { code: "12a456" },
      { code: "123456", payer_id: PAYER },
      { code: "123456", phone: PHONE },
      {},
    ]) {
      expect(PayerPhoneProofVerifySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("the verify write is IDEMPOTENT under Idempotency-Key", () => {
  it("a retry with the same key replays the first answer and runs the work ONCE", async () => {
    const d = setup();
    const first = await d.controller.verifyProof(SELF, { code: "123456" }, req("key-1"), CTX);
    const again = await d.controller.verifyProof(SELF, { code: "123456" }, req("key-1"), CTX);
    expect(first).toEqual({ status: "proven" });
    expect(again).toEqual(first);
    expect(d.otp.verifyPhoneProof).toHaveBeenCalledTimes(1);
    expect(d.proofs.recordSmsProof).toHaveBeenCalledTimes(1);
    expect(d.events.emit).toHaveBeenCalledTimes(1);
  });

  it("a stored failure replays as itself (a 409 stays a 409; nothing re-runs)", async () => {
    const d = setup({ write: "held_elsewhere" });
    const a = await d.controller
      .verifyProof(SELF, { code: "123456" }, req("key-2"), CTX)
      .catch((e: unknown) => e);
    const b = await d.controller
      .verifyProof(SELF, { code: "123456" }, req("key-2"), CTX)
      .catch((e: unknown) => e);
    expect((a as HttpException).getStatus()).toBe(409);
    expect((b as HttpException).getStatus()).toBe(409);
    expect(d.proofs.recordSmsProof).toHaveBeenCalledTimes(1);
  });

  it("a fresh key is a new action (runs again); no key runs unguarded", async () => {
    const d = setup();
    await d.controller.verifyProof(SELF, { code: "123456" }, req("key-3"), CTX);
    await d.controller.verifyProof(SELF, { code: "123456" }, req("key-4"), CTX);
    await d.controller.verifyProof(SELF, { code: "123456" }, req(), CTX);
    expect(d.proofs.recordSmsProof).toHaveBeenCalledTimes(3);
  });

  it("keys are scoped by the session payer: another company's same key is never served this answer", async () => {
    const d = setup();
    await d.controller.verifyProof(SELF, { code: "123456" }, req("shared"), CTX);
    const other = { ...SELF, id: "bbbbbbbb-0000-4000-8000-000000000002" };
    await d.controller.verifyProof(other, { code: "123456" }, req("shared"), CTX);
    expect(d.otp.verifyPhoneProof).toHaveBeenCalledTimes(2);
    expect(d.otp.verifyPhoneProof.mock.calls[1]![0]).toMatchObject({ payerId: other.id });
  });
});
