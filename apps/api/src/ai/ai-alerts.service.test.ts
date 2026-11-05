import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { AiAlertsService } from "./ai-alerts.service";

/**
 * B13 (#2567) — the loud-AI-alert evaluation.
 *
 * WHAT MAKES THIS SUITE NECESSARY RATHER THAN NICE. The service swallows every failure
 * by design (alerting must not fail the work it observes) and debounces production runs
 * in memory — so a silently-broken threshold, a swapped share, or an email sent to a
 * stale verdict would produce EXACTLY the same behaviour as the working code from every
 * caller's point of view: no exception, no failed request, just no alert. The guard has
 * to be direct: drive `evaluate({ force: true })` (the debounce bypass the acceptance
 * criteria use) and assert the verdicts.
 */

const CONFIG = {
  AI_FALLBACK_ALERT_WINDOW_HOURS: 24,
  AI_FALLBACK_ALERT_MIN_CALLS: 10,
  AI_FALLBACK_ALERT_SHARE: 0.5,
  AI_ALERT_EMAIL_ENABLED: false,
  AI_ALERT_EMAIL_TO: "",
};

function splitFor(overrides: Record<string, unknown> = {}) {
  return [
    {
      taskType: "profile_extraction",
      totalCalls: 20,
      realCalls: 4,
      fallbackCalls: 16,
      ...overrides,
    },
  ];
}

function make(
  opts: {
    split?: ReturnType<typeof splitFor>;
    states?: { taskType: string; eventName: string; occurredAt: Date }[];
    spend?: { count: number; latestId: string | null; latestAt: Date | null };
    config?: Record<string, unknown>;
    emitWritten?: boolean;
    emailThrows?: boolean;
  } = {},
) {
  const emitOnce = vi.fn(async (params: { event_name: string; idempotencyKey?: string }) => ({
    event: params,
    written: opts.emitWritten ?? true,
  }));
  const events = { emit: vi.fn(), emitOnce };
  const repo = {
    taskFallbackSplit: vi.fn(async () => opts.split ?? []),
    latestFallbackAlertPerTask: vi.fn(async () => opts.states ?? []),
    spendCapStats: vi.fn(async () => opts.spend ?? { count: 0, latestId: null, latestAt: null }),
    recentAlerts: vi.fn(async () => []),
  };
  const send = opts.emailThrows
    ? vi.fn(async () => {
        throw new Error("smtp send error");
      })
    : vi.fn(async () => undefined);
  const email = { send };
  const svc = new AiAlertsService(
    repo as never,
    events as never,
    { ...CONFIG, ...opts.config } as never,
    email as never,
  );
  return { svc, emitOnce, events, repo, send };
}

describe("AiAlertsService.evaluate — forcing fallback raises an alert within the window", () => {
  it("a breaching task with no prior verdict raises ai.fallback_alert_raised with thresholds in band", async () => {
    const { svc, emitOnce } = make({ split: splitFor() });

    const res = await svc.evaluate({ force: true });

    expect(res.evaluated).toBe(true);
    expect(res.raised).toEqual(["profile_extraction"]);
    expect(res.cleared).toEqual([]);
    expect(emitOnce).toHaveBeenCalledTimes(1);
    const params = emitOnce.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.event_name).toBe("ai.fallback_alert_raised");
    expect(params.idempotencyKey).toMatch(
      /^ai\.fallback_alert_raised:profile_extraction:\d{4}-\d{2}-\d{2}$/,
    );
    const payload = params.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      task_type: "profile_extraction",
      window_hours: 24,
      total_calls: 20,
      fallback_calls: 16,
      fallback_share: 0.8,
      threshold_share: 0.5,
      min_calls: 10,
    });
  });

  it("below the share threshold: no verdict, no email", async () => {
    const { svc, emitOnce, send } = make({
      split: splitFor({ totalCalls: 20, realCalls: 18, fallbackCalls: 2 }),
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.evaluated).toBe(true);
    expect(res.raised).toEqual([]);
    expect(emitOnce).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("below the minimum volume: a 100% fallback share on 2 calls is not a breach", async () => {
    const { svc, emitOnce } = make({
      split: splitFor({ totalCalls: 2, realCalls: 0, fallbackCalls: 2 }),
    });

    const res = await svc.evaluate({ force: true });

    expect(res.raised).toEqual([]);
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("a raised task that recovered clears with ai.fallback_alert_cleared (and no email)", async () => {
    const { svc, emitOnce, send } = make({
      split: splitFor({ totalCalls: 20, realCalls: 18, fallbackCalls: 2 }),
      states: [
        {
          taskType: "profile_extraction",
          eventName: "ai.fallback_alert_raised",
          occurredAt: new Date(),
        },
      ],
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.cleared).toEqual(["profile_extraction"]);
    expect(res.raised).toEqual([]);
    const params = emitOnce.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.event_name).toBe("ai.fallback_alert_cleared");
    expect(send).not.toHaveBeenCalled();
  });

  it("a still-breaching raised task does not re-raise (exactly-once per state)", async () => {
    const states = [
      {
        taskType: "profile_extraction",
        eventName: "ai.fallback_alert_raised",
        occurredAt: new Date(),
      },
    ];
    const { svc, emitOnce } = make({ split: splitFor(), states });

    const res = await svc.evaluate({ force: true });

    expect(res.raised).toEqual([]);
    expect(res.cleared).toEqual([]);
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("thresholds are configurable: a 0.8 share is quiet at a 0.9 threshold", async () => {
    const { svc, emitOnce } = make({
      split: splitFor(),
      config: { AI_FALLBACK_ALERT_SHARE: 0.9 },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.raised).toEqual([]);
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("an unclassifiable stored task never emits — and never blocks its neighbours", async () => {
    const { svc, emitOnce } = make({
      split: [
        { taskType: "not_a_task", totalCalls: 50, realCalls: 0, fallbackCalls: 50 },
        ...splitFor(),
      ],
    });

    const res = await svc.evaluate({ force: true });

    expect(res.raised).toEqual(["profile_extraction"]);
    expect(emitOnce).toHaveBeenCalledTimes(1);
  });
});

describe("AiAlertsService.evaluate — hitting a spend cap raises an alert", () => {
  it("spend-cap trips in the window surface as active (no new event name needed)", async () => {
    const { svc } = make({
      spend: { count: 3, latestId: "breach-1", latestAt: new Date() },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.evaluated).toBe(true);
    expect(res.spend_cap_active).toBe(true);
    const status = await svc.status();
    expect(status.spend_cap).toMatchObject({ breach_count: 3, active: true });
  });

  it("no trips: inactive, and no email even when enabled", async () => {
    const { svc, send } = make({
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.spend_cap_active).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("AiAlertsService — optional super-admin email behind the config flag", () => {
  it("a raise emails once when enabled; a same-day re-evaluation does not re-email", async () => {
    const { svc, send, repo } = make({
      split: splitFor(),
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });

    const first = await svc.evaluate({ force: true });
    expect(first.emailed).toEqual(["fallback:profile_extraction"]);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = (send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(msg.principal).toBe("admin");
    expect(msg.purpose).toBe("ai_alert");
    expect(String(msg.subject)).toMatch(/profile_extraction/);

    // The verdict now exists on the spine → no re-raise, no second email.
    repo.latestFallbackAlertPerTask = vi.fn(async () => [
      {
        taskType: "profile_extraction",
        eventName: "ai.fallback_alert_raised",
        occurredAt: new Date(),
      },
    ]);
    const second = await svc.evaluate({ force: true });
    expect(second.raised).toEqual([]);
    expect(second.emailed).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a deduped raise (written=false) sends no email", async () => {
    const { svc, send } = make({
      split: splitFor(),
      emitWritten: false,
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.raised).toEqual(["profile_extraction"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("enabled but no recipients: skipped with a warning, never a throw", async () => {
    const { svc, send } = make({
      split: splitFor(),
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "" },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.evaluated).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failing mailer costs the email, never the evaluation", async () => {
    const { svc, emitOnce } = make({
      split: splitFor(),
      emailThrows: true,
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });

    const res = await svc.evaluate({ force: true });

    expect(res.evaluated).toBe(true);
    expect(res.raised).toEqual(["profile_extraction"]);
    expect(emitOnce).toHaveBeenCalledTimes(1);
  });

  it("a NEW spend-cap breach after boot emails once; the boot sighting itself does not backfill", async () => {
    const spend1 = { count: 2, latestId: "breach-1", latestAt: new Date() };
    const first = make({
      spend: spend1,
      config: { AI_ALERT_EMAIL_ENABLED: true, AI_ALERT_EMAIL_TO: "ops@example.com" },
    });
    await first.svc.evaluate({ force: true });
    expect(first.send).not.toHaveBeenCalled();

    // Same service (same watermark): an unchanged cap stays quiet.
    await first.svc.evaluate({ force: true });
    expect(first.send).not.toHaveBeenCalled();

    // A NEW breach id after boot: exactly one email.
    first.repo.spendCapStats = vi.fn(async () => ({
      count: 3,
      latestId: "breach-2",
      latestAt: new Date(),
    }));
    const res = await first.svc.evaluate({ force: true });
    expect(res.emailed).toEqual(["spend_cap"]);
    expect(first.send).toHaveBeenCalledTimes(1);
    const msg = (first.send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(msg.purpose).toBe("ai_alert");
  });
});

describe("AiAlertsService — failure discipline", () => {
  it("an unreadable spine evaluates to unevaluated, never a throw", async () => {
    const { svc } = make({});
    svc["repo"].taskFallbackSplit = vi.fn(async () => {
      throw new Error("events table unreachable");
    });

    const res = await svc.evaluate({ force: true });

    expect(res.evaluated).toBe(false);
    expect(res.raised).toEqual([]);
  });

  it("taskPosture degrades to the empty set, never a throw", async () => {
    const { svc } = make({});
    svc["repo"].taskFallbackSplit = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(svc.taskPosture()).resolves.toEqual([]);
  });

  it("production runs debounce: the second immediate evaluate is a no-op", async () => {
    const { svc, emitOnce, repo } = make({ split: splitFor() });

    await svc.evaluate();
    await svc.evaluate();

    // First ran (raised once); second skipped by the debounce — not by verdict state,
    // so the spine was not even re-read.
    expect(emitOnce).toHaveBeenCalledTimes(1);
    expect(repo.taskFallbackSplit).toHaveBeenCalledTimes(1);
  });
});
