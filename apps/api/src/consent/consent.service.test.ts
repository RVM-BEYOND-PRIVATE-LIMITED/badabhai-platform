import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ConsentService } from "./consent.service";
import type { ConsentRepository } from "./consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { SessionService } from "../auth/session.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
// No `worker_id`: the service takes the subject as its FIRST ARGUMENT, from the
// controller's verified session. There is no id on the dto to confuse it with.
const DTO = {
  consent_version: "2026-06-01",
  purposes: ["profiling", "resume_generation"],
} as never;

function setup() {
  const consents = {
    create: vi.fn(async (_i: Record<string, unknown>) => ({ id: "consent-1" })),
    withdraw: vi.fn(async () => {}),
    findLatestByWorker: vi.fn(async () => undefined as Record<string, unknown> | undefined),
  };
  const workers = { findById: vi.fn(async () => undefined as Record<string, unknown> | undefined) };
  const events = {
    emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown>; idempotencyKey?: string }) => p),
  };
  const pii = { hashIp: vi.fn(() => "iphash") };
  const sessions = { revokeAll: vi.fn(async () => 1) };
  const svc = new ConsentService(
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
    pii as unknown as PiiCryptoService,
    sessions as unknown as SessionService,
  );
  return { svc, consents, workers, events, pii, sessions };
}

describe("ConsentService.accept", () => {
  it("404s when the worker does not exist (nothing recorded/emitted)", async () => {
    const { svc, consents, events } = setup();
    await expect(svc.accept(WORKER, DTO, "1.2.3.4", "ua", CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(consents.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("records consent + emits consent.accepted (hashed ip, no raw PII)", async () => {
    const { svc, consents, workers, events, pii } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    const res = await svc.accept(WORKER, DTO, "1.2.3.4", "ua", CTX);
    expect(res.consent_id).toBe("consent-1");
    expect(pii.hashIp).toHaveBeenCalledWith("1.2.3.4"); // ip is hashed, never stored raw
    const created = consents.create.mock.calls[0]![0];
    expect(created.ipHash).toBe("iphash");
    expect(JSON.stringify(created)).not.toContain("1.2.3.4");
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("consent.accepted");
    expect(call.payload.purposes).toEqual(["profiling", "resume_generation"]);
    expect(JSON.stringify(call.payload)).not.toMatch(/phone|full_?name|1\.2\.3\.4/i);
  });

  it("passes ipHash null when no ip is provided", async () => {
    const { svc, workers, consents, pii } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    await svc.accept(WORKER, DTO, undefined, undefined, CTX);
    expect(pii.hashIp).not.toHaveBeenCalled();
    expect(consents.create.mock.calls[0]![0]).toMatchObject({ ipHash: null, userAgent: null });
  });
});

describe("ConsentService.withdraw (TD69)", () => {
  it("stamps revokedAt, revokes all sessions, emits consent.revoked", async () => {
    const { svc, consents, sessions, events } = setup();
    const res = await svc.withdraw(WORKER, CTX);
    expect(res).toEqual({ ok: true });
    expect(consents.withdraw).toHaveBeenCalledWith(WORKER);
    expect(sessions.revokeAll).toHaveBeenCalledWith(WORKER);
    const evt = events.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("consent.revoked");
    expect(evt.payload).toEqual({ worker_id: WORKER, sessions_revoked: 1 });
    expect(evt.idempotencyKey).toBe(`consent.revoked:${WORKER}`);
  });

  it("STRICT ORDER: withdraw (repo) fires BEFORE revokeAll, which fires BEFORE emit", async () => {
    const { svc, consents, sessions, events } = setup();
    await svc.withdraw(WORKER, CTX);

    const withdrawOrder = consents.withdraw.mock.invocationCallOrder[0]!;
    const revokeOrder = sessions.revokeAll.mock.invocationCallOrder[0]!;
    const emitOrder = events.emit.mock.invocationCallOrder[0]!;

    expect(withdrawOrder).toBeLessThan(revokeOrder);
    expect(revokeOrder).toBeLessThan(emitOrder);
  });

  it("is fail-closed on session revoke failure (event still emitted, withdrawal still committed)", async () => {
    const { svc, consents, sessions, events } = setup();
    vi.mocked(sessions.revokeAll).mockRejectedValueOnce(new Error("redis down"));
    const res = await svc.withdraw(WORKER, CTX);
    expect(res).toEqual({ ok: true });
    expect(consents.withdraw).toHaveBeenCalledWith(WORKER);
    expect(sessions.revokeAll).toHaveBeenCalledWith(WORKER);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe("ConsentService.getLatestForWorker (#1637)", () => {
  it("maps the latest row to purposes + revocation only — never ipHash/userAgent", async () => {
    const { svc, consents } = setup();
    vi.mocked(consents.findLatestByWorker).mockResolvedValueOnce({
      id: "consent-9",
      consentVersion: "2026-06-01",
      acceptedAt: new Date("2026-09-21T10:00:00.000Z"),
      revokedAt: null,
      purposes: ["profiling", "employer_sharing", "employer_messaging"],
      ipHash: "iphash-sentinel",
      userAgent: "ua-sentinel",
    });
    const out = await svc.getLatestForWorker(WORKER);
    expect(out).toEqual({
      consent_id: "consent-9",
      consent_version: "2026-06-01",
      accepted_at: "2026-09-21T10:00:00.000Z",
      revoked_at: null,
      purposes: ["profiling", "employer_sharing", "employer_messaging"],
    });
    expect(JSON.stringify(out)).not.toContain("sentinel");
  });

  it("no row is a REAL answer — nulls and [] (the switch renders off, not an error)", async () => {
    const { svc } = setup();
    expect(await svc.getLatestForWorker(WORKER)).toEqual({
      consent_id: null,
      consent_version: null,
      accepted_at: null,
      revoked_at: null,
      purposes: [],
    });
  });

  it("reflects the C-2 exit on the NEXT read — the server truth the switch renders from", async () => {
    const { svc, consents } = setup();
    vi.mocked(consents.findLatestByWorker).mockResolvedValueOnce({
      id: "consent-old",
      consentVersion: "2026-06-01",
      acceptedAt: new Date("2026-09-21T09:00:00.000Z"),
      revokedAt: null,
      purposes: ["profiling", "employer_sharing", "employer_messaging"],
    });
    await svc.withdrawEmployerContact(WORKER, undefined, undefined, CTX);

    vi.mocked(consents.findLatestByWorker).mockResolvedValueOnce({
      id: "consent-1",
      consentVersion: "2026-06-01",
      acceptedAt: new Date("2026-09-21T10:00:00.000Z"),
      revokedAt: null,
      purposes: ["profiling"],
    });
    const after = await svc.getLatestForWorker(WORKER);
    expect(after.consent_id).toBe("consent-1");
    expect(after.purposes).toEqual(["profiling"]);
  });
});

describe("ConsentService.withdrawEmployerContact (E0 C-2)", () => {
  const LATEST = {
    id: "consent-old",
    consentVersion: "2026-06-01",
    revokedAt: null as Date | null,
    purposes: ["profiling", "resume_generation", "voice_processing", "employer_sharing", "employer_messaging"],
  };

  it("writes a NEW row derived SERVER-SIDE: both employer purposes gone, everything else carried over", async () => {
    const { svc, consents, events, sessions } = setup();
    vi.mocked(consents.findLatestByWorker).mockResolvedValueOnce(LATEST);

    const res = await svc.withdrawEmployerContact(WORKER, "1.2.3.4", "ua", CTX);

    expect(res).toMatchObject({ ok: true, consent_id: "consent-1" });
    expect(res.withdrawn.sort()).toEqual(["employer_messaging", "employer_sharing"]);
    const created = consents.create.mock.calls[0]![0];
    expect(created.purposes).toEqual(["profiling", "resume_generation", "voice_processing"]);
    // The notice version the worker ACTUALLY read is carried over — never bumped here.
    expect(created.consentVersion).toBe("2026-06-01");
    // NOT the all-or-nothing exit: the worker keeps his sessions.
    expect(sessions.revokeAll).not.toHaveBeenCalled();
    const evt = events.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("consent.purposes_withdrawn");
    expect((evt.payload.withdrawn_purposes as string[]).sort()).toEqual([
      "employer_messaging",
      "employer_sharing",
    ]);
  });

  it("is a no-op when the latest row already omits both purposes — no new row, no event", async () => {
    const { svc, consents, events } = setup();
    vi.mocked(consents.findLatestByWorker).mockResolvedValueOnce({
      ...LATEST,
      purposes: ["profiling", "resume_generation"],
    });
    expect(await svc.withdrawEmployerContact(WORKER, undefined, undefined, CTX)).toEqual({
      ok: true,
      consent_id: null,
      withdrawn: [],
    });
    expect(consents.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("404s when there is no live consent row to derive from (nothing written, nothing emitted)", async () => {
    const missing = setup();
    await expect(
      missing.svc.withdrawEmployerContact(WORKER, undefined, undefined, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.consents.create).not.toHaveBeenCalled();

    const revoked = setup();
    vi.mocked(revoked.consents.findLatestByWorker).mockResolvedValueOnce({
      ...LATEST,
      revokedAt: new Date(),
    });
    await expect(
      revoked.svc.withdrawEmployerContact(WORKER, undefined, undefined, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(revoked.consents.create).not.toHaveBeenCalled();
  });

  it("the request cannot supply the purposes — the service has no parameter for them", async () => {
    const { svc, consents } = setup();
    vi.mocked(consents.findLatestByWorker).mockResolvedValueOnce(LATEST);
    // Structural: calling with extra arguments changes nothing. The derived array above is
    // the only path into `create`, which is the C-2 trap this method exists to close.
    await (
      svc.withdrawEmployerContact as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(WORKER, undefined, undefined, CTX, { purposes: ["profiling"] });
    expect(consents.create.mock.calls[0]![0].purposes).toEqual([
      "profiling",
      "resume_generation",
      "voice_processing",
    ]);
  });
});
