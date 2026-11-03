import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { validateEvent } from "@badabhai/event-schema";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { AdminProvisioningService } from "./admin-provisioning.service";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const CREATOR_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const DTO = {
  email: "new.admin@badabhai.in",
  name: "Asha R",
  role: "ops_admin" as const,
  temporary_password: "Temp-pass-1234",
};

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);

function setup(taken = false) {
  const TX = { tx: true };
  const admins = {
    createActiveWithTemporaryPassword: vi.fn(async () => (taken ? undefined : { id: NEW_ID })),
    withTransaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(TX)),
  };
  const events = {
    emit: vi.fn(async (_e: { payload: Record<string, unknown>; tx?: unknown }) => undefined),
  };
  const svc = new AdminProvisioningService(admins as never, pii, events as never);
  return { svc, admins, events, TX };
}

describe("AdminProvisioningService.createDirect (0144)", () => {
  it("creates with a HASHED temporary password + emits admin_created (creator → new admin) on the tx", async () => {
    const d = setup();
    const res = await d.svc.createDirect(CREATOR_ID, DTO, CTX);
    expect(res).toEqual({ admin_id: NEW_ID });

    const [input, tx] = d.admins.createActiveWithTemporaryPassword.mock.calls[0]! as unknown as [
      {
        role: string;
        email: string;
        name: string;
        password: { hash: string; pepperVersion: number; setAt: Date };
      },
      unknown,
    ];
    expect(tx).toBe(d.TX);
    expect(input).toMatchObject({ role: "ops_admin", email: DTO.email, name: DTO.name });
    expect(input.password.hash).not.toContain(DTO.temporary_password);
    expect(pii.verifyPassword(DTO.temporary_password, input.password.hash)).toBe(true);
    expect(input.password.pepperVersion).toBe(1);
    expect(input.password.setAt).toBeInstanceOf(Date);

    const call = d.events.emit.mock.calls[0]![0];
    expect(call.tx).toBe(d.TX);
    expect(call.payload).toEqual({
      admin_id: CREATOR_ID,
      action_code: "admin_created",
      target_type: "admin_session",
      target_id: NEW_ID,
    });
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: "admin.action_performed",
      event_version: 1,
      occurred_at: "2026-11-03T00:00:00.000Z",
      actor: { actor_type: "admin", actor_id: CREATOR_ID },
      subject: { subject_type: "admin_session", subject_id: NEW_ID },
      source: "api",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: null,
      payload: call.payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(built.success).toBe(true);
    // No PII and no credential on the spine.
    const blob = JSON.stringify(d.events.emit.mock.calls);
    for (const s of [DTO.email, DTO.name, DTO.temporary_password, "badabhai.in"]) {
      expect(blob).not.toContain(s);
    }
  });

  it("an email that belongs to ANY admin → 409, and NOTHING is evented", async () => {
    const d = setup(true);
    await expect(d.svc.createDirect(CREATOR_ID, DTO, CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("the 409 is value-free — it never echoes the email", async () => {
    const d = setup(true);
    const err = (await d.svc.createDirect(CREATOR_ID, DTO, CTX).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(DTO.email);
  });
});
