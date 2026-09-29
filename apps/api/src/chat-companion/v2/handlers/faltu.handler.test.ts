import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { V2_FALTU_COOLDOWN, V2_FALTU_REDIRECT } from "../../companion-replies";
import { FaltuHandler } from "./faltu.handler";
import type { HandlerInput } from "./handler";

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-29T10:00:00.000Z");

function input(now: Date = NOW): HandlerInput {
  return {
    workerId: WORKER,
    profile: {} as never,
    text: "",
    ctx: { correlationId: "c-1", requestId: "r-1" } as never,
    now,
  };
}

function setup(opts: { count?: number | null; cooldown?: string | null } = {}) {
  const faltu = {
    countStrike: vi.fn(async (_workerId: string, _utcDay: string) =>
      opts.count === undefined ? 1 : opts.count,
    ),
    startCooldown: vi.fn(async (_workerId: string, _now: Date) =>
      opts.cooldown === undefined ? "2026-09-29T10:30:00.000Z" : opts.cooldown,
    ),
    cooldownUntil: vi.fn(async () => null),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const config = {
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
  } as unknown as ServerConfig;
  return { handler: new FaltuHandler(config, faltu as never, events as never), faltu, events };
}

const strikeEvents = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls.map((c) => c[0] as { event_name: string; payload: Record<string, unknown> });

describe("FaltuHandler (ADR-0046 P2, O11)", () => {
  it("strike 1 and 2: the redirect line with the open chips, and a counted strike event", async () => {
    for (const count of [1, 2]) {
      const h = setup({ count });
      const { turn, outcome } = await h.handler.handle(input());
      expect(turn.reply).toBe(V2_FALTU_REDIRECT.latin);
      expect(outcome).toBe("served");
      // Never a dead end: the open task chips ride along, and free text is NOT blocked yet.
      expect(turn.cooldown_until).toBeUndefined();
      expect(turn.suggested_options.length).toBeGreaterThan(0);

      const [event] = strikeEvents(h.events);
      expect(event!.event_name).toBe("chat.companion_faltu_strike");
      expect(event!.payload).toEqual({ strike_count: count, cooldown_started: false });
      expect(h.faltu.startCooldown).not.toHaveBeenCalled();
    }
  });

  it("strike 3: the cool-down starts, the cool-down line carries cooldown_until, chips stay open", async () => {
    const h = setup({ count: 3 });
    const { turn, outcome } = await h.handler.handle(input());
    expect(outcome).toBe("cooldown");
    expect(turn.reply).toBe(V2_FALTU_COOLDOWN.latin);
    expect(turn.cooldown_until).toBe("2026-09-29T10:30:00.000Z");
    expect(turn.suggested_options.length).toBeGreaterThan(0);
    expect(h.faltu.startCooldown).toHaveBeenCalledWith(WORKER, NOW);
    expect(strikeEvents(h.events)[0]!.payload).toEqual({ strike_count: 3, cooldown_started: true });
  });

  it("beyond the threshold every strike re-serves the cool-down line (the flag already exists)", async () => {
    const h = setup({ count: 4 });
    const { turn, outcome } = await h.handler.handle(input());
    expect(outcome).toBe("cooldown");
    expect(turn.reply).toBe(V2_FALTU_COOLDOWN.latin);
  });

  it("counts under the UTC DAY key the input's clock names — the counter resets with the day", async () => {
    const nextDay = new Date("2026-09-30T00:05:00.000Z");
    const h = setup({ count: 1 });
    await h.handler.handle(input(NOW));
    await h.handler.handle(input(nextDay));
    expect(h.faltu.countStrike.mock.calls.map((c) => c[1])).toEqual(["2026-09-29", "2026-09-30"]);
  });

  it("a Redis refusal counts NO strike: redirect served, no event, no cool-down", async () => {
    const h = setup({ count: null });
    const { turn, outcome } = await h.handler.handle(input());
    expect(outcome).toBe("served");
    expect(turn.reply).toBe(V2_FALTU_REDIRECT.latin);
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.faltu.startCooldown).not.toHaveBeenCalled();
  });

  it("threshold crossed but the cool-down flag refused: redirect, and the event tells the truth", async () => {
    const h = setup({ count: 3, cooldown: null });
    const { turn, outcome } = await h.handler.handle(input());
    // No cool-down exists, so no cool-down line and no cooldown_until — fail open.
    expect(outcome).toBe("served");
    expect(turn.reply).toBe(V2_FALTU_REDIRECT.latin);
    expect(turn.cooldown_until).toBeUndefined();
    expect(strikeEvents(h.events)[0]!.payload).toEqual({ strike_count: 3, cooldown_started: false });
  });

  it("a failed event emit never costs the worker the answer (and logs no text)", async () => {
    const h = setup({ count: 1 });
    h.events.emit.mockRejectedValue(new Error("spine down"));
    const { turn } = await h.handler.handle(input());
    expect(turn.reply).toBe(V2_FALTU_REDIRECT.latin);
  });
});
