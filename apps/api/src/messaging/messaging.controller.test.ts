import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { MessagingController } from "./messaging.controller";
import type { InviteService } from "./invite.service";
import type { ServerConfig } from "@badabhai/config";
import type { InviteClickService, PublicClickOutcome } from "./invite-click.service";
import type { ReengagementService } from "./reengagement.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";

const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };
const CODE = "abcdef012345";
const IP = "203.0.113.7";

function make() {
  const invites = {
    createInvite: vi.fn(async () => ({ code: "abc" })),
    recordClick: vi.fn(async () => ({ ok: true })),
  };
  const clicks = {
    recordPublicClick: vi.fn(async (): Promise<PublicClickOutcome> => ({ kind: "worker" })),
  };
  const reengagement = { sendReengagement: vi.fn(async () => ({ ok: true })) };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn().mockResolvedValue(undefined) };
  const config = { REFERRAL_CLICK_MAX_PER_IP_PER_HOUR: 600 } as unknown as ServerConfig;
  return {
    controller: new MessagingController(
      invites as unknown as InviteService,
      clicks as unknown as InviteClickService,
      reengagement as unknown as ReengagementService,
      ipRateLimit as unknown as IpRateLimit,
      config,
    ),
    invites,
    clicks,
    reengagement,
    ipRateLimit,
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
    await controller.recordClick({ code: CODE }, IP);
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
      expect(await controller.recordClick({ code: CODE }, IP)).toEqual({ ok: true });
    }
  });
});

describe("MessagingController.recordClick — per-IP cap (B4; QR at factory gates)", () => {
  it("checks the cap BEFORE touching either table", async () => {
    const { controller, ipRateLimit } = make();
    await controller.recordClick({ code: CODE }, IP);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("invite_click", IP, 600);
  });

  it("SHEDS the work over cap — no DB round-trip, and the SAME neutral body (no 429 oracle)", async () => {
    const { controller, clicks, ipRateLimit } = make();
    ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(new Error("429"));
    // A distinguishable status here would be exactly the oracle shape just removed.
    expect(await controller.recordClick({ code: CODE }, IP)).toEqual({ ok: true });
    expect(clicks.recordPublicClick).not.toHaveBeenCalled();
  });

  it("a fail-closed Redis outage degrades the STAT, never the worker's install page", async () => {
    const { controller, clicks, ipRateLimit } = make();
    // IpRateLimit throws 429 when Redis is unreachable (fail closed by design).
    ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(new Error("redis down"));
    expect(await controller.recordClick({ code: CODE }, IP)).toEqual({ ok: true });
    expect(clicks.recordPublicClick).not.toHaveBeenCalled();
  });

  it("tolerates a missing IP rather than throwing (public route, no session to fall back on)", async () => {
    const { controller, ipRateLimit } = make();
    await controller.recordClick({ code: CODE }, undefined as unknown as string);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "invite_click",
      "unknown",
      600,
    );
  });
});
