import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { MessagingController } from "./messaging.controller";
import type { InviteService } from "./invite.service";
import type { InviteClickService, PublicClickOutcome } from "./invite-click.service";
import type { ReengagementService } from "./reengagement.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";

const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };
const CODE = "abcdef012345";

function make() {
  const invites = {
    createInvite: vi.fn(async () => ({ code: "abc" })),
    recordClick: vi.fn(async () => ({ ok: true })),
  };
  const clicks = {
    recordPublicClick: vi.fn(async (): Promise<PublicClickOutcome> => ({ kind: "worker" })),
  };
  const reengagement = { sendReengagement: vi.fn(async () => ({ ok: true })) };
  return {
    controller: new MessagingController(
      invites as unknown as InviteService,
      clicks as unknown as InviteClickService,
      reengagement as unknown as ReengagementService,
    ),
    invites,
    clicks,
    reengagement,
  };
}

describe("MessagingController (thin) — worker from token", () => {
  it("createInvite uses the authed worker id (not the body) + campaign", async () => {
    const { controller, invites } = make();
    await controller.createInvite(WORKER, { campaign: "spring" } as never);
    expect(invites.createInvite).toHaveBeenCalledWith(WORKER.id, "spring");
  });

  it("recordClick delegates the public code to the BOTH-funnels click path (TD113)", async () => {
    const { controller, clicks, invites } = make();
    await controller.recordClick({ code: CODE });
    expect(clicks.recordPublicClick).toHaveBeenCalledWith(CODE);
    // It must NOT call the worker-only seam directly any more — that path could not reach
    // agency codes, which is exactly the bug TD113 records.
    expect(invites.recordClick).not.toHaveBeenCalled();
  });

  it("reengage (internal) delegates worker_id + template", async () => {
    const { controller, reengagement } = make();
    await controller.reengage({ worker_id: "w9", template: "nudge" } as never);
    expect(reengagement.sendReengagement).toHaveBeenCalledWith("w9", "nudge");
  });
});

describe("MessagingController.recordClick — NO-ORACLE (unauthenticated route)", () => {
  it("returns the IDENTICAL neutral body for a worker code, an agency code, and an unknown code", async () => {
    const { controller, clicks } = make();
    for (const kind of ["worker", "agency_or_unknown", "error"] as const) {
      clicks.recordPublicClick.mockResolvedValueOnce({ kind });
      // Byte-identical: the old body echoed the worker table's hit/miss, which told an
      // anonymous caller whether a code existed.
      expect(await controller.recordClick({ code: CODE })).toEqual({ ok: true });
    }
  });
});
