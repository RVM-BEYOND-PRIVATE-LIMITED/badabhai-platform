import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { MessagingController } from "./messaging.controller";
import type { InviteService } from "./invite.service";
import type { ReengagementService } from "./reengagement.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";

const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };

function make() {
  const invites = {
    createInvite: vi.fn(async () => ({ code: "abc" })),
    recordClick: vi.fn(async () => ({ ok: true })),
  };
  const reengagement = { sendReengagement: vi.fn(async () => ({ ok: true })) };
  return {
    controller: new MessagingController(
      invites as unknown as InviteService,
      reengagement as unknown as ReengagementService,
    ),
    invites,
    reengagement,
  };
}

describe("MessagingController (thin) — worker from token", () => {
  it("createInvite uses the authed worker id (not the body) + campaign", async () => {
    const { controller, invites } = make();
    await controller.createInvite(WORKER, { campaign: "spring" } as never);
    expect(invites.createInvite).toHaveBeenCalledWith(WORKER.id, "spring");
  });

  it("recordClick delegates the public code", async () => {
    const { controller, invites } = make();
    await controller.recordClick("abc");
    expect(invites.recordClick).toHaveBeenCalledWith("abc");
  });

  it("reengage (internal) delegates worker_id + template", async () => {
    const { controller, reengagement } = make();
    await controller.reengage({ worker_id: "w9", template: "nudge" } as never);
    expect(reengagement.sendReengagement).toHaveBeenCalledWith("w9", "nudge");
  });
});
