import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { EventsService } from "../events/events.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { RequestContext } from "../common/request-context";
import {
  DAILY_FACTS_CAP_SCRIPT,
  istDayOf,
  parseStep,
  PrePayFactsDailyCapService,
  secondsToKeepIstDay,
} from "./pre-pay-facts-daily-cap.service";

/**
 * #2838 — the per-company daily cap on distinct workers the search shows pre-pay facts for. The
 * Redis script itself runs against a real Redis in `pre-pay-facts-daily-cap.redis.test.ts`; here
 * the wrapper: the IST day, the keys and arguments it sends, the alerts, and failing closed.
 */
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as TenantKey;
const ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CALLER = {
  actorPayerId: ACTOR,
  ctx: { correlationId: "corr-1", requestId: "req-1" } as unknown as RequestContext,
};
// 19 Nov 2026 20:00 UTC = 20 Nov 01:30 IST.
const LATE_UTC = new Date("2026-11-19T20:00:00.000Z");

function setup(reply: unknown | (() => Promise<unknown>), cap = 300) {
  const evalFn = vi.fn(async () => (typeof reply === "function" ? await (reply as () => Promise<unknown>)() : reply));
  const queue = { client: Promise.resolve({ eval: evalFn }) } as unknown as Queue;
  const events = { emit: vi.fn(async () => undefined) };
  const svc = new PrePayFactsDailyCapService(
    { APPLICANT_FACTS_SEARCH_DAILY_DISTINCT_CAP: cap } as unknown as ServerConfig,
    queue,
    events as unknown as EventsService,
  );
  return { svc, evalFn, events };
}

describe("IST day", () => {
  it("is the India calendar day, not the UTC one", () => {
    expect(istDayOf(LATE_UTC)).toBe("2026-11-20");
    expect(istDayOf(new Date("2026-11-19T18:29:59.000Z"))).toBe("2026-11-19");
    expect(istDayOf(new Date("2026-11-19T18:30:00.000Z"))).toBe("2026-11-20");
  });

  it("keeps the day's keys until the next IST midnight plus an hour", () => {
    // 20 Nov 01:30 IST → 22.5 h to midnight, + 1 h.
    expect(secondsToKeepIstDay(LATE_UTC)).toBe(22.5 * 3600 + 3600);
    // One second before IST midnight → 1 s + 1 h.
    expect(secondsToKeepIstDay(new Date("2026-11-19T18:29:59.000Z"))).toBe(1 + 3600);
  });
});

describe("PrePayFactsDailyCapService.admit", () => {
  it("sends the company's day keys, the cap, the TTL and the page's ids (deduplicated, lower-cased)", async () => {
    const { svc, evalFn } = setup([2, 1, 0, 0, [W1, W2]]);
    const out = await svc.admit(TENANT, [W1, W2.toUpperCase(), W1], CALLER, LATE_UTC);
    expect([...out]).toEqual([W1, W2]);
    expect(evalFn).toHaveBeenCalledWith(
      DAILY_FACTS_CAP_SCRIPT,
      4,
      `prepay_facts:${TENANT}:2026-11-20:workers`,
      `prepay_facts:${TENANT}:2026-11-20:pages`,
      `prepay_facts:${TENANT}:2026-11-20:alert:half`,
      `prepay_facts:${TENANT}:2026-11-20:alert:cap`,
      "300",
      String(secondsToKeepIstDay(LATE_UTC)),
      W1,
      W2,
    );
  });

  it("returns only the admitted workers", async () => {
    const { svc } = setup([300, 40, 0, 0, [W1]]);
    expect([...(await svc.admit(TENANT, [W1, W2], CALLER, LATE_UTC))]).toEqual([W1]);
  });

  it("fails closed on a Redis error: nobody admitted, no alert", async () => {
    const { svc, events } = setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await svc.admit(TENANT, [W1], CALLER, LATE_UTC)).size).toBe(0);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed reply", async () => {
    for (const reply of [null, "OK", [1, 2, 3], [1, 1, 0, 0, "x"], [-1, 1, 0, 0, []], [1.5, 1, 0, 0, []]]) {
      const { svc } = setup(reply);
      expect((await svc.admit(TENANT, [W1], CALLER, LATE_UTC)).size).toBe(0);
    }
  });

  it("emits the half alert once the script says so, PII-free, with a per-day-per-level key", async () => {
    const { svc, events } = setup([150, 12, 1, 0, [W1]]);
    await svc.admit(TENANT, [W1], CALLER, LATE_UTC);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "payer.candidate_search_volume_alert",
        actor: { actor_type: "payer", actor_id: ACTOR },
        subject: { subject_type: "payer", subject_id: TENANT },
        payload: { payer_id: TENANT, level: "half", day: "2026-11-20", cap: 300, distinct_workers: 150, pages: 12 },
        idempotencyKey: `payer.candidate_search_volume_alert:${TENANT}:2026-11-20:half`,
      }),
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain(W1);
  });

  it("emits both alerts when one page crosses half and the cap", async () => {
    const { svc, events } = setup([300, 3, 1, 1, [W1]]);
    await svc.admit(TENANT, [W1], CALLER, LATE_UTC);
    const levels = events.emit.mock.calls.map((c) => (c as unknown as [{ payload: { level: string } }])[0].payload.level);
    expect(levels).toEqual(["half", "cap"]);
  });

  it("a failed alert emit never changes who is admitted", async () => {
    const { svc, events } = setup([300, 3, 0, 1, [W1]]);
    events.emit.mockRejectedValueOnce(new Error("spine down"));
    expect([...(await svc.admit(TENANT, [W1], CALLER, LATE_UTC))]).toEqual([W1]);
  });
});

describe("parseStep", () => {
  it("drops an admitted id the page did not send (the reply can only narrow)", () => {
    const step = parseStep([2, 1, 0, 0, [W1, W2]], [W1]);
    expect([...step.admitted]).toEqual([W1]);
  });
});
