import { describe, expect, it, vi } from "vitest";
import { ChatCompanionPolicy } from "./chat-companion.policy";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CONFIRMED_AT = new Date("2026-09-20T10:00:00.000Z");

function make(opts: {
  enabled?: boolean;
  profile?: { profileStatus: string; confirmedAt: Date | null } | undefined | "throw";
  liveStartedAt?: Date | null | "throw";
}) {
  const workers = {
    latestProfile: vi.fn(async () => {
      if (opts.profile === "throw") throw new Error("db down");
      return opts.profile;
    }),
  };
  const repo = {
    latestActiveSessionStartedAt: vi.fn(async () => {
      if (opts.liveStartedAt === "throw") throw new Error("db down");
      return opts.liveStartedAt ?? null;
    }),
  };
  const policy = new ChatCompanionPolicy(
    { CHAT_COMPANION_ENABLED: opts.enabled ?? true } as never,
    workers as never,
    repo as never,
  );
  return { policy, workers, repo };
}

const confirmed = { profileStatus: "confirmed", confirmedAt: CONFIRMED_AT };

describe("ChatCompanionPolicy — who gets the companion (ADR-0044)", () => {
  it("flag OFF: interview, and nothing is read", async () => {
    const { policy, workers, repo } = make({ enabled: false, profile: confirmed });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(workers.latestProfile).not.toHaveBeenCalled();
    expect(repo.latestActiveSessionStartedAt).not.toHaveBeenCalled();
  });

  it("a confirmed profile and NO chat session at all (the form road): companion", async () => {
    const { policy } = make({ profile: confirmed, liveStartedAt: null });
    const mode = await policy.resolve(WORKER);
    expect(mode.mode).toBe("companion");
  });

  it("the early finish: a live session that STARTED BEFORE the confirmation does not block", async () => {
    const { policy } = make({
      profile: confirmed,
      liveStartedAt: new Date(CONFIRMED_AT.getTime() - 30 * 60_000),
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
  });

  it("a deliberate new interview — a live session started AFTER the confirmation — keeps running", async () => {
    const { policy } = make({
      profile: confirmed,
      liveStartedAt: new Date(CONFIRMED_AT.getTime() + 60_000),
    });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it.each([
    ["no profile row", undefined],
    ["a draft", { profileStatus: "draft", confirmedAt: null }],
    ["extracting", { profileStatus: "extracting", confirmedAt: null }],
    // A redo interview's newer extracted row outranks the older confirmed one (CURRENT_PROFILE_ORDER),
    // so the worker is mid-redo: today's path, with its "build my profile" button.
    ["a newer extracted row (redo in progress)", { profileStatus: "extracted", confirmedAt: null }],
    ["confirmed without a confirmation time", { profileStatus: "confirmed", confirmedAt: null }],
  ] as const)("%s: interview", async (_name, profile) => {
    const { policy } = make({ profile: profile as never, liveStartedAt: null });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("any read error fails to interview — today's chat, never a broken tab", async () => {
    expect(await make({ profile: "throw" }).policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(await make({ profile: confirmed, liveStartedAt: "throw" }).policy.resolve(WORKER)).toEqual({
      mode: "interview",
    });
  });
});
