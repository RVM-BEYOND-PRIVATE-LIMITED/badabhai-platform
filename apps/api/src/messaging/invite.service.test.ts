import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { EventsService } from "../events/events.service";
import type { InviteRepository } from "./invite.repository";
import { InviteService } from "./invite.service";

function harness(repoOverrides: Partial<InviteRepository> = {}) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const repo = {
    create: vi.fn(async (i: { code: string; inviterWorkerId: string }) => ({
      id: "inv-1",
      code: i.code,
      inviterWorkerId: i.inviterWorkerId,
      invitedWorkerId: null,
      channel: "whatsapp",
      status: "created",
      campaign: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    findByCode: vi.fn(),
    markClicked: vi.fn(),
    markAccepted: vi.fn().mockResolvedValue(true),
    ...repoOverrides,
  } as unknown as InviteRepository;
  const svc = new InviteService(repo, { emit } as unknown as EventsService);
  return { svc, emit, repo };
}

describe("InviteService — funnel + PII-free attribution (ADR-0020)", () => {
  it("createInvite mints an opaque code + link and emits a PII-free invite.created", async () => {
    const { svc, emit } = harness();
    const out = await svc.createInvite("worker-A", "diwali");
    expect(out.code).toMatch(/^[a-f0-9]{12}$/);
    expect(out.link).toBe(`/i/${out.code}`);
    const call = emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(call.event_name).toBe("invite.created");
    expect(call.payload.inviter_worker_id).toBe("worker-A");
    // no phone/name anywhere — only ids + channel + campaign code
    expect(JSON.stringify(call.payload)).not.toMatch(/\+?\d{10}/);
  });

  it("recordAccept attributes invited→inviter and emits invite.accepted", async () => {
    const { svc, emit } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: null }),
    });
    const r = await svc.recordAccept("code1", "B");
    expect(r).toEqual({ ok: true });
    expect(emit.mock.calls[0]![0]).toMatchObject({ event_name: "invite.accepted" });
  });

  // ---- B4: the install actually attributed, + WHICH leg of the chain delivered it ----

  it("recordAccept ALSO emits invite.install with the source, keyed once per invite", async () => {
    const { svc, emit } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: null }),
    });
    await svc.recordAccept("code1", "B", "install_referrer");
    const install = emit.mock.calls[1]![0] as {
      event_name: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(install.event_name).toBe("invite.install");
    expect(install.payload).toEqual({
      invite_id: "inv-1",
      invite_kind: "worker",
      source: "install_referrer",
    });
    expect(install.idempotencyKey).toBe("invite.install:inv-1");
    // The shareable CODE is a bearer token and must never ride the spine.
    expect(JSON.stringify(install.payload)).not.toContain("code1");
  });

  it("source DEFAULTS to 'unknown' — a pre-B4 client that sends none still attributes", async () => {
    const { svc, emit } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: null }),
    });
    await svc.recordAccept("code1", "B");
    expect((emit.mock.calls[1]![0] as { payload: { source: string } }).payload.source).toBe(
      "unknown",
    );
  });

  it("emits NO invite.install when attribution does not happen (self / duplicate / unknown)", async () => {
    const self = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: null }),
    });
    await self.svc.recordAccept("code1", "A", "app_link");
    expect(self.emit).not.toHaveBeenCalled();

    const dup = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: "X" }),
    });
    await dup.svc.recordAccept("code1", "B", "app_link");
    expect(dup.emit).not.toHaveBeenCalled();

    const unknown = harness({ findByCode: vi.fn().mockResolvedValue(undefined) });
    await unknown.svc.recordAccept("code1", "B", "app_link");
    expect(unknown.emit).not.toHaveBeenCalled();
  });

  it("rejects a SELF-invite (anti-abuse) and emits nothing", async () => {
    const { svc, emit } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: null }),
    });
    expect(await svc.recordAccept("code1", "A")).toEqual({ ok: false, reason: "self_invite" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a DUPLICATE attribution (already attributed)", async () => {
    const { svc } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: "X" }),
    });
    expect(await svc.recordAccept("code1", "B")).toEqual({ ok: false, reason: "already_attributed" });
  });

  it("rejects a RACE where the read check passes but the write guard wins (TOCTOU safety)", async () => {
    const { svc, repo } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: "A", invitedWorkerId: null }),
    });
    vi.mocked(repo.markAccepted).mockResolvedValueOnce(false);
    expect(await svc.recordAccept("code1", "B")).toEqual({ ok: false, reason: "already_attributed" });
  });

  it("recordClick reports unknown_code so the public path can try the AGENCY code space", async () => {
    const { svc, emit } = harness({ findByCode: vi.fn().mockResolvedValue(undefined) });
    // Internal signal only — the HTTP surface stays neutral (see MessagingController).
    expect(await svc.recordClick("nope")).toEqual({ ok: false, reason: "unknown_code" });
    expect(emit).not.toHaveBeenCalled();
  });

  // ---- ADR-0026 Phase 5: invites.inviter_worker_id became NULLABLE (DSAR SET NULL) ----

  it("recordAccept on a NULL inviter_worker_id fails closed (inviter_unavailable) and emits NO invite.accepted", async () => {
    // A worker hard-delete SET-NULLs invites.inviter_worker_id. At accept time the inviter is
    // non-null by construction, but the fail-closed branch guarantees the PII-free invite.accepted
    // event is NEVER emitted with a null uuid (the event schema keeps a non-null inviter_worker_id).
    const { svc, emit, repo } = harness({
      findByCode: vi.fn().mockResolvedValue({ id: "inv-1", inviterWorkerId: null, invitedWorkerId: null }),
    });
    const r = await svc.recordAccept("code1", "B");
    expect(r).toEqual({ ok: false, reason: "inviter_unavailable" });
    expect(emit).not.toHaveBeenCalled(); // no invite.accepted with a null uuid
    expect(repo.markAccepted).not.toHaveBeenCalled(); // no attribution write either
  });
});
