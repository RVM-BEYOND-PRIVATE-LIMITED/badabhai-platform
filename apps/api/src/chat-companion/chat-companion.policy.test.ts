import { describe, expect, it, vi } from "vitest";
import { ChatCompanionPolicy } from "./chat-companion.policy";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CONFIRMED_AT = new Date("2026-09-20T10:00:00.000Z");

function make(opts: {
  enabled?: boolean;
  profile?: { profileStatus: string; confirmedAt: Date | null } | undefined | "throw";
  live?: { startedAt: Date; lastMessageAt: Date | null } | null | "throw";
  /** #1775 — what `latestFormHandoverClosedAfter` returns. Default null: no handover. */
  handover?: { formKind: string | null; generalFormCompletedAt: string | null } | null | "throw";
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
    latestFormHandoverClosedAfter: vi.fn(async (_workerId: string, _after: Date) => {
      if (opts.handover === "throw") throw new Error("db down");
      return opts.handover ?? null;
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
    expect(repo.latestFormHandoverClosedAfter).not.toHaveBeenCalled();
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

  it("a pre-confirmation session that moved after the confirmation keeps running", async () => {
    // Before #1744 a redo after an early finish REATTACHED to the old session: started before the
    // confirmation, checkpointed after it. #1744 supersedes that leftover only at an explicit
    // redo's POST; a build that does not send `redo: true`, or a failed supersede, still
    // reattaches, and then its start time alone would call this worker a companion worker.
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
    expect(
      await make({ profile: confirmed, live: null, handover: "throw" }).policy.resolve(WORKER),
    ).toEqual({ mode: "interview" });
  });
});

describe("ChatCompanionPolicy — an unfinished form handover after the confirmation (#1775)", () => {
  const trade = { formKind: "cnc_turner", generalFormCompletedAt: null };
  const general = { formKind: null, generalFormCompletedAt: null };

  it("asks for handovers closed AFTER the current profile's confirmation, for this worker", async () => {
    const { policy, repo } = make({ profile: confirmed, live: null });
    await policy.resolve(WORKER);
    expect(repo.latestFormHandoverClosedAfter).toHaveBeenCalledWith(WORKER, CONFIRMED_AT);
  });

  it.each([
    ["a redo that handed over to the TRADE form (no per-session finish mark)", trade],
    ["a redo that handed over to the GENERAL form, brief not saved", general],
    [
      "a general handover whose completion mark cannot be read (fails soft: not finished)",
      { formKind: null, generalFormCompletedAt: "yesterday" },
    ],
  ])("%s: interview — the chat keeps the way back to the form", async (_name, handover) => {
    const { policy } = make({ profile: confirmed, live: null, handover });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("the general form FINISHED (the brief's completion mark): companion again", async () => {
    const { policy } = make({
      profile: confirmed,
      live: null,
      handover: { formKind: null, generalFormCompletedAt: "2026-09-21T08:00:00.000Z" },
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
  });

  it("a trade handover is never 'finished' by a stray general mark — only the confirmation retires it", async () => {
    const { policy } = make({
      profile: confirmed,
      live: null,
      handover: { formKind: "cnc_turner", generalFormCompletedAt: "2026-09-21T08:00:00.000Z" },
    });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("an ordinary confirmed worker with no handover after the confirmation: companion, unchanged", async () => {
    const { policy } = make({ profile: confirmed, live: null, handover: null });
    const mode = await policy.resolve(WORKER);
    expect(mode.mode).toBe("companion");
  });

  it("a live redo still decides first: interview without reading the handovers", async () => {
    const { policy, repo } = make({
      profile: confirmed,
      live: { startedAt: new Date(CONFIRMED_AT.getTime() + 60_000), lastMessageAt: null },
    });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(repo.latestFormHandoverClosedAfter).not.toHaveBeenCalled();
  });

  it("no confirmed profile: interview without reading the handovers", async () => {
    const { policy, repo } = make({ profile: { profileStatus: "extracted", confirmedAt: null } });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(repo.latestFormHandoverClosedAfter).not.toHaveBeenCalled();
  });
});
