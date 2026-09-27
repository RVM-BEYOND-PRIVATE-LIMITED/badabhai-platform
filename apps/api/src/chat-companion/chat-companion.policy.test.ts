import { describe, expect, it, vi } from "vitest";
import { ChatCompanionPolicy } from "./chat-companion.policy";
import { TRADE_FORM_KINDS } from "../profiling/trade-form-router";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CONFIRMED_AT = new Date("2026-09-20T10:00:00.000Z");

function make(opts: {
  enabled?: boolean;
  profile?: { profileStatus: string; confirmedAt: Date | null } | undefined | "throw";
  live?: { startedAt: Date; lastMessageAt: Date | null } | null | "throw";
  /** #1775 — the session the trade form is served from. Default null: the worker has none. */
  latest?: { status: string; endedAt: Date | null; formKind: string | null } | null | "throw";
  /** #1775 — the session the general form is served from. Default null: no general handover. */
  general?:
    | { status: string; endedAt: Date | null; generalFormCompletedAt: string | null }
    | null
    | "throw";
  /** #1775 — whether a résumé was generated after the handover. Default false. */
  resumeAfter?: boolean | "throw";
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
    latestSessionFormKind: vi.fn(async (_workerId: string) => {
      if (opts.latest === "throw") throw new Error("db down");
      return opts.latest ?? null;
    }),
    latestGeneralHandover: vi.fn(async (_workerId: string) => {
      if (opts.general === "throw") throw new Error("db down");
      return opts.general ?? null;
    }),
    resumeGeneratedAfter: vi.fn(async (_workerId: string, _after: Date) => {
      if (opts.resumeAfter === "throw") throw new Error("db down");
      return opts.resumeAfter === true;
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
    expect(repo.latestSessionFormKind).not.toHaveBeenCalled();
    expect(repo.latestGeneralHandover).not.toHaveBeenCalled();
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
    for (const broken of [
      { latest: "throw" as const },
      { general: "throw" as const },
      {
        latest: {
          status: "ended",
          endedAt: new Date(CONFIRMED_AT.getTime() + 60_000),
          formKind: TRADE_FORM_KINDS[0],
        },
        resumeAfter: "throw" as const,
      },
    ]) {
      expect(
        await make({ profile: confirmed, live: null, ...broken }).policy.resolve(WORKER),
      ).toEqual({
        mode: "interview",
      });
    }
  });
});

describe("ChatCompanionPolicy — a form handover still pending after the confirmation (#1775)", () => {
  const KIND = TRADE_FORM_KINDS[0];
  const after = (n: number): Date => new Date(CONFIRMED_AT.getTime() + n * 60_000);
  /** The trade form's session: the redo that said "Haan", ended 10 minutes after the confirm. */
  const tradeHandover = { status: "ended", endedAt: after(10), formKind: KIND };
  /** The general form's session: the redo that said "Nahi" at the skills gate. */
  const generalHandover = { status: "ended", endedAt: after(10), generalFormCompletedAt: null };

  it("an unfinished TRADE handover: interview, judged on that session's close time", async () => {
    const { policy, repo } = make({ profile: confirmed, live: null, latest: tradeHandover });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(repo.latestSessionFormKind).toHaveBeenCalledWith(WORKER);
    expect(repo.resumeGeneratedAfter).toHaveBeenCalledWith(WORKER, tradeHandover.endedAt);
  });

  it("the trade form FINISHED — a résumé generated after the handover, no new confirmation: companion", async () => {
    // The building screen regenerates the résumé on the OLD confirmed profile; nothing re-confirms.
    const { policy } = make({
      profile: confirmed,
      live: null,
      latest: tradeHandover,
      resumeAfter: true,
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
  });

  it("a later session the trade form now reads from (no form_kind): companion — that form is no longer served", async () => {
    const { policy, repo } = make({
      profile: confirmed,
      live: null,
      latest: { status: "abandoned", endedAt: after(90), formKind: null },
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
    expect(repo.resumeGeneratedAfter).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an undeclared form kind (the form API cannot serve it)",
      { ...tradeHandover, formKind: "no_such_form" },
    ],
    [
      "a trade handover that closed BEFORE the confirmation",
      { ...tradeHandover, endedAt: after(-10) },
    ],
    [
      "a trade handover closed AT the confirmation instant",
      { ...tradeHandover, endedAt: after(0) },
    ],
    // Each guard alone: an active row is rule 3's even with a stray close time, and a closed row
    // with no close time cannot be placed after the confirmation.
    ["a session still active (rule 3's to judge)", { ...tradeHandover, status: "active" }],
    ["a closed session with no close time", { ...tradeHandover, endedAt: null }],
  ])("%s: companion", async (_name, latest) => {
    const { policy, repo } = make({ profile: confirmed, live: null, latest });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
    expect(repo.resumeGeneratedAfter).not.toHaveBeenCalled();
  });

  it("an unfinished GENERAL handover: interview", async () => {
    const { policy, repo } = make({ profile: confirmed, live: null, general: generalHandover });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(repo.latestGeneralHandover).toHaveBeenCalledWith(WORKER);
  });

  it("the general brief saved (completion mark): companion, without a résumé read", async () => {
    const { policy, repo } = make({
      profile: confirmed,
      live: null,
      general: { ...generalHandover, generalFormCompletedAt: "2026-09-21T08:00:00.000Z" },
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
    expect(repo.resumeGeneratedAfter).not.toHaveBeenCalled();
  });

  it("an unreadable general mark reads as NOT finished (the chat's fail-soft reader): interview", async () => {
    const { policy } = make({
      profile: confirmed,
      live: null,
      general: { ...generalHandover, generalFormCompletedAt: "yesterday" },
    });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
  });

  it("a general handover followed by a generated résumé: companion", async () => {
    const { policy } = make({
      profile: confirmed,
      live: null,
      general: generalHandover,
      resumeAfter: true,
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
  });

  it("an ordinary confirmed worker with no handover: companion, and no résumé read", async () => {
    const { policy, repo } = make({
      profile: confirmed,
      live: null,
      latest: { status: "ended", endedAt: after(10), formKind: null },
    });
    expect((await policy.resolve(WORKER)).mode).toBe("companion");
    expect(repo.resumeGeneratedAfter).not.toHaveBeenCalled();
  });

  it("a live redo still decides first: interview without reading the handovers", async () => {
    const { policy, repo } = make({
      profile: confirmed,
      live: { startedAt: after(1), lastMessageAt: null },
      latest: tradeHandover,
    });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(repo.latestSessionFormKind).not.toHaveBeenCalled();
    expect(repo.latestGeneralHandover).not.toHaveBeenCalled();
  });

  it("no confirmed profile: interview without reading the handovers", async () => {
    const { policy, repo } = make({ profile: { profileStatus: "extracted", confirmedAt: null } });
    expect(await policy.resolve(WORKER)).toEqual({ mode: "interview" });
    expect(repo.latestSessionFormKind).not.toHaveBeenCalled();
  });
});
