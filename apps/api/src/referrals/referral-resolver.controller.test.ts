import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { ReferralResolverController } from "./referral-resolver.controller";
import type { ReferralLinkService } from "./referral-link.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { AgencyInvitesController } from "../agency/agency-invites.controller";
import { MessagingController } from "../messaging/messaging.controller";

const CODE = "abcdef012345";
const BASE = "https://app.badabhai.in";
const ANDROID = "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36";

function make(
  overrides: { resolve?: ReturnType<typeof vi.fn>; cap?: ReturnType<typeof vi.fn> } = {},
) {
  const links = {
    resolve:
      overrides.resolve ??
      vi.fn().mockResolvedValue({
        redirectTo: `${BASE}/i/${CODE}`,
        leg: "app_link",
        clickRecorded: true,
      }),
  };
  const ipRateLimit = {
    assertWithinHourlyIpCap: overrides.cap ?? vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    REFERRAL_SHORT_LINK_BASE: BASE,
    REFERRAL_CLICK_MAX_PER_IP_PER_HOUR: 600,
  } as unknown as ServerConfig;

  const ctrl = new ReferralResolverController(
    links as unknown as ReferralLinkService,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { ctrl, links, ipRateLimit };
}

describe("GET /r/:code — always a 302, never a dead end", () => {
  it("redirects with 302 (not 301 — a cached permanent redirect would zero the funnel)", async () => {
    const h = make();
    const out = await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    expect(out).toEqual({ url: `${BASE}/i/${CODE}`, statusCode: 302 });
  });

  it("threads ip + user-agent to the service so it can hash and branch", async () => {
    const h = make();
    await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    expect(h.links.resolve).toHaveBeenCalledWith({
      code: CODE,
      ip: "1.2.3.4",
      userAgent: ANDROID,
      skipClick: false,
    });
  });

  it("checks the per-IP cap BEFORE doing any work", async () => {
    const h = make();
    await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    expect(h.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "invite_click",
      "1.2.3.4",
      600,
    );
  });

  it("shares the `invite_click` bucket with the legacy click path — one funnel, one budget", async () => {
    const h = make();
    await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    expect(h.ipRateLimit.assertWithinHourlyIpCap.mock.calls[0]![0]).toBe("invite_click");
  });

  it("OVER CAP: sheds the click WRITE but keeps the code in the redirect", async () => {
    // The regression this pins: the landing page pings server-side from payer-web's single
    // egress IP, so an entire factory gate shares one bucket. Dropping the code here would
    // strip attribution from legitimate workers — the exact defect B4 exists to fix.
    const h = make({ cap: vi.fn().mockRejectedValue(new Error("over cap")) });
    const out = await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);

    expect(h.links.resolve).toHaveBeenCalledWith(expect.objectContaining({ skipClick: true }));
    expect(out.statusCode).toBe(302);
    expect(out.url).toContain(CODE);
  });

  it("a fail-closed Redis outage degrades the STAT, never the worker's install page", async () => {
    const h = make({ cap: vi.fn().mockRejectedValue(new Error("redis down")) });
    const out = await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    expect(out.statusCode).toBe(302);
    expect(out.url).toContain(CODE);
  });

  it("an unforeseen service throw still redirects rather than 500-ing a shared link", async () => {
    const h = make({ resolve: vi.fn().mockRejectedValue(new Error("boom")) });
    const out = await h.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    expect(out).toEqual({ url: `${BASE}/i/unknown`, statusCode: 302 });
  });

  it("tolerates a missing IP — a public route has no session to fall back on", async () => {
    const h = make();
    await h.ctrl.resolve(CODE, undefined as unknown as string, ANDROID);
    expect(h.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "invite_click",
      "unknown",
      600,
    );
  });

  it("NO-ORACLE: a valid and a garbage code produce the same status and no body", async () => {
    const valid = make();
    const garbage = make({
      resolve: vi.fn().mockResolvedValue({
        redirectTo: `${BASE}/i/unknown`,
        leg: "fallback",
        clickRecorded: false,
      }),
    });
    const a = await valid.ctrl.resolve(CODE, "1.2.3.4", ANDROID);
    const b = await garbage.ctrl.resolve("zzzz", "1.2.3.4", ANDROID);
    expect(a.statusCode).toBe(b.statusCode);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — TD113: the invited WORKER can record their own click.
//
// These assert the GUARD TOPOLOGY structurally, via Nest's own metadata, because that is
// where the defect actually lived: the only click route that accepted an agency code sat
// behind PayerAuthGuard + @PayerRoles('agent'), so the one party who can physically click a
// shared link — the invited worker, who holds no agency session — could never reach it.
// ───────────────────────────────────────────────────────────────────────────────
describe("SCENARIO 3 — TD113: a worker's own click is accepted, not just the agent's", () => {
  const guardsOf = (target: object) =>
    (Reflect.getMetadata("__guards__", target) ?? []) as unknown[];
  const guardNames = (target: object) => guardsOf(target).map((g) => (g as { name?: string }).name);

  it("the AGENT-ONLY click route is guarded — this is the gate that excluded the worker", () => {
    const names = guardNames(AgencyInvitesController);
    expect(names).toContain("PayerAuthGuard");
    expect(names).toContain("PayerRoleGuard");
    expect(Reflect.getMetadata("payer_roles", AgencyInvitesController)).toContain("agent");
  });

  it("the PUBLIC click route carries NO controller guard, so an unauthenticated worker reaches it", () => {
    expect(guardsOf(MessagingController)).toHaveLength(0);
    // ...and specifically the click handler itself is unguarded.
    expect(guardsOf(MessagingController.prototype.recordClick)).toHaveLength(0);
  });

  it("`POST /invites/:code/click` is the worker-reachable path and resolves BOTH funnels", async () => {
    const clicks = { recordPublicClick: vi.fn().mockResolvedValue({ kind: "agency_or_unknown" }) };
    const ctrl = new MessagingController(
      {} as never,
      clicks as never,
      {} as never,
      { assertWithinHourlyIpCap: vi.fn().mockResolvedValue(undefined) } as never,
      { REFERRAL_CLICK_MAX_PER_IP_PER_HOUR: 600 } as unknown as ServerConfig,
    );

    // No worker session, no agent session — exactly an invited worker tapping a link.
    const res = await ctrl.recordClick({ code: CODE }, "1.2.3.4");

    expect(clicks.recordPublicClick).toHaveBeenCalledWith(CODE);
    // Accepted and recorded, with the neutral no-oracle body.
    expect(res).toEqual({ ok: true });
  });

  it("the NEW resolver route is likewise unguarded — it must not reintroduce the TD113 gate", () => {
    expect(guardsOf(ReferralResolverController)).toHaveLength(0);
    expect(guardsOf(ReferralResolverController.prototype.resolve)).toHaveLength(0);
  });
});
