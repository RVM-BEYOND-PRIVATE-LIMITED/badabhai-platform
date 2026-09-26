import { describe, expect, it, vi } from "vitest";
import { ChatCompanionPolicy } from "./chat-companion.policy";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CONFIRMED_AT = new Date("2026-09-20T10:00:00.000Z");

function make(opts: {
  enabled?: boolean;
  profile?: { profileStatus: string; confirmedAt: Date | null } | undefined | "throw";
  live?: { startedAt: Date; lastMessageAt: Date | null } | null | "throw";
}) {
  const workers = {
    latestProfile: vi.fn(async () => {
      if (opts.profile === "throw") throw new Error("db down");
      return opts.profile;
    }),
  };
  const repo = {
    latestActiveSession: vi.fn(async () => {
      if (opts.live === "throw") throw new Error("db down");
      return opts.live ?? null;
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
    expect(repo.latestActiveSession).not.toHaveBeenCalled();
  });

  it("a confirmed profile and NO chat session at all (the form road): companion", async () => {
    const { policy } = make({ profile: confirmed, live: null });
    const mode = await policy.resolve(WORKER);
    expect(mode.mode).toBe("companion");
  });

  const minutes = (n: number): Date => new Date(CONFIRMED_AT.getTime() + n * 60_000);

  it("the early finish: a live session whose every clock predates the confirmation does not block", async () => {
    for (const lastMessageAt of [null, minutes(-5)]) {
      const { policy } = make({ profile: confirmed, live: { startedAt: minutes(-30), lastMessageAt } });
      expect((await policy.resolve(WORKER)).mode).toBe("companion");
    }
  });

  it("a deliberate new interview — a live session minted AFTER the confirmation — keeps running", async () => {
    const { policy } = make({ profile: confirmed, live: { startedAt: minutes(1), lastMessageAt: null } });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("a pre-confirmation session that moved after the confirmation keeps running (legacy leftover)", async () => {
    // Before #1744 a redo after an early finish REATTACHED to the old session (#1197): started
    // before the confirmation, checkpointed after it. #1744 closes that session at confirmation,
    // so a redo now mints a fresh one — but a leftover confirmed before the fix can still be live,
    // and its start time alone would call this worker a companion worker.
    const { policy } = make({
      profile: confirmed,
      live: { startedAt: minutes(-30), lastMessageAt: minutes(20) },
    });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("the boundary is strict: activity AT the confirmation instant is not after it", async () => {
    const { policy } = make({ profile: confirmed, live: { startedAt: minutes(-30), lastMessageAt: minutes(0) } });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
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
    const { policy } = make({ profile: profile as never, live: null });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("any read error fails to interview — today's chat, never a broken tab", async () => {
    expect(await make({ profile: "throw" }).policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(await make({ profile: confirmed, live: "throw" }).policy.resolve(WORKER)).toEqual({
      mode: "interview",
    });
  });
});
