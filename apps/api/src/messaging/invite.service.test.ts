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
    markAccepted: vi.fn(),
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

  it("recordClick is neutral on an unknown code", async () => {
    const { svc } = harness({ findByCode: vi.fn().mockResolvedValue(undefined) });
    expect(await svc.recordClick("nope")).toEqual({ ok: false });
  });
});
