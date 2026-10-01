import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { EVENT_REGISTRY, isEventName } from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import { WorkersService } from "../../workers/workers.service";
import {
  answersOf,
  emptyGeneralRoad,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "../conversation-state";
import { DE_ESCALATION_REPLY_TEXT } from "../next-question";
import { ProfilingOrchestrator, type TurnResult } from "../orchestrator.service";
import { RESUME_IDENTITY_OPTIONS } from "../resume-import/resume-identity";
import { INTAKE_COPY, INTAKE_HANDOFF_TEXT, type IdentityGaps } from "./identity-intake";
import { IdentityIntakeService } from "./identity-intake.service";

/**
 * ═══ THE IDENTITY INTAKE, THROUGH THE ORCHESTRATOR (ADR-0048, #1858) ═══
 *
 * `identity-intake.test.ts` pins the rulings on the pure machine. This file proves the WIRING, with
 * a REAL `IdentityIntakeService` over a REAL `WorkersService` — only the database, the key, the
 * queue and Redis are faked — so the writes, the events and the log lines asserted here are the
 * ones production makes. What is at risk, and what each block is shaped around:
 *
 *   1. THE STEPS: open → first name → surname → state → city → handoff, only the gaps, re-ask once
 *      then skip, a two-word first answer skipping the surname, each write landing ONCE.
 *   2. THE CAS: a record write that fails leaves the conversation where it was; a lost CAS
 *      re-issues the same idempotent write; a duplicate submit replays without writing.
 *   3. THE INTERVIEW BEHIND IT IS UNCHANGED: no turn spent, identical first-turn numbering and
 *      reply, the city never asked twice, the general road armed exactly as today, and the résumé
 *      "is this you?" turn served as the handoff.
 *   4. PRIVACY: no intake line in the model's history, identify never sees one, and no name or
 *      place in any event payload or log line.
 */

const SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "44444444-4444-4444-8444-444444444444";
const T0 = new Date("2026-09-30T10:00:00.000Z");
const CTX = { correlationId: "55555555-5555-4555-8555-555555555555", requestId: "req_intake" };
const ALL_GAPS: IdentityGaps = { hasName: false, hasState: false, hasCity: false };

/** Every value a worker types in this file — none may reach an event or a log line. */
const TYPED_VALUES = ["Ramesh", "Kumar", "Maharashtra", "Pune", "Sitamarhi"];

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 2,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

const TRADE = item({
  question_key: "primary_trade",
  target_kind: "rfs",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
  is_mandatory: true,
});
const CITY = item({
  question_key: "current_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Abhi aap kaunse sheher mein hain?",
  is_mandatory: true,
});
const SHIFT = item({
  question_key: "shift_preference",
  prompt_text: "Aap din ki shift chahte hain ya raat ki?",
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 4,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRADE, CITY, SHIFT],
};

const LINE = {
  importId: IMPORT,
  roleKind: "cnc_grinding",
  experienceText: "2 saal ka tajurba",
  summaryText: "CNC grinder par kaam",
};

interface WorldOpts {
  /** A staged résumé identity line — the handoff then serves "is this you?". */
  identity?: typeof LINE | null;
  /** `workers.current_city` as the city-seed reads it. */
  storedCity?: string | null;
  /** The general road's flags (ADR-0045), as `SkillsTurnService.armed()` reads them. */
  skillsArmed?: boolean;
  /** The name write throws — a DB outage mid-intake. */
  nameWriteThrows?: boolean;
  /** Lose the next N CAS writes without anything having changed. */
  loseCas?: number;
  /** The held first name will not unseal (a rotated key). */
  decryptThrows?: boolean;
  /** Build the orchestrator WITHOUT the intake service — a build-skewed pod. */
  withoutIntake?: boolean;
}

function makeWorld(opts: WorldOpts = {}) {
  const store = new Map<string, TranscriptBuffer>();
  let casToLose = opts.loseCas ?? 0;

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through JSON and the REAL narrower, as `ChatTranscriptBuffer.load` does.
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
      if (casToLose > 0) {
        casToLose--;
        return false;
      }
      const current = store.get(id)?.profiling?.rev ?? 0;
      if (current !== expectedRev) return false;
      store.set(id, {
        ...next,
        profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 },
      });
      return true;
    }),
  };
  const registry = {
    loadUniversal: vi.fn(async () => UNIVERSAL_PACK),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };
  const identify = { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) };
  const chat = { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    leads: (envelope: ProfilingEnvelope) => envelope.llmStage !== "done",
    take: vi.fn(async (..._args: unknown[]) => null),
  };
  const resume = {
    pendingForChat: vi.fn(async () => null),
    forImport: vi.fn(async () => new Map()),
    identityForChat: vi.fn(async () => opts.identity ?? null),
    routeForImport: vi.fn(async () => null),
  };
  const skills = {
    armed: () => opts.skillsArmed === true,
    take: vi.fn(async (..._args: unknown[]) => {
      throw new Error("skills stage reached — the history it was handed is what is under test");
    }),
  };

  // THE KEY: a reversible token, so a test can prove the plaintext never sits beside it.
  const vault = new Map<string, string>();
  const pii = {
    encrypt: vi.fn((plaintext: string) => {
      const token = `v1:tok_${vault.size + 1}`;
      vault.set(token, plaintext);
      return token;
    }),
    decrypt: vi.fn((token: string) => {
      if (opts.decryptThrows) throw new Error("bad key");
      const plain = vault.get(token);
      if (plain === undefined) throw new Error("unknown token");
      return plain;
    }),
  };
  const workerRow: { fullName: string | null } = { fullName: null };
  const workersRepo = {
    findById: vi.fn(async () => ({ id: WORKER, fullName: workerRow.fullName })),
    findCurrentCity: vi.fn(async () => opts.storedCity ?? null),
    updateFullName: vi.fn(async (_id: string, token: string) => {
      if (opts.nameWriteThrows) throw new Error("connection terminated unexpectedly");
      workerRow.fullName = token;
      return { id: WORKER };
    }),
    updateLocation: vi.fn(async (_id: string, _patch: unknown) => ({ id: WORKER })),
    latestResume: vi.fn(async () => undefined),
  };
  const workersService = new WorkersService(
    workersRepo as never,
    pii as never,
    events as never,
    {} as never,
    {} as ServerConfig,
    { add: vi.fn() } as never,
  );
  const intake = new IdentityIntakeService(workersService, pii as never, events as never);

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    resume as never,
    workersRepo as never,
    undefined,
    undefined,
    skills as never,
    opts.withoutIntake ? undefined : intake,
  );

  const open = (gaps: IdentityGaps = ALL_GAPS) =>
    orchestrator.openIdentityIntake({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
      gaps,
    });
  const say = (
    text: string,
    extra: { submissionId?: string; armGeneralRoad?: boolean } = {},
  ): Promise<TurnResult> =>
    orchestrator.takeTurn({
      sessionId: SESSION,
      workerId: WORKER,
      text,
      now: T0,
      submissionId: extra.submissionId ?? null,
      voiceNoteId: null,
      ...(extra.armGeneralRoad === true ? { armGeneralRoad: true } : {}),
      knownName: async () => null,
      ctx: CTX as never,
    });
  const saved = () => store.get(SESSION);
  const emitted = (name: string) =>
    events.emit.mock.calls
      .map(
        ([params]) => params as { event_name: string; payload: unknown; idempotencyKey?: string },
      )
      .filter((e) => e.event_name === name);

  return {
    orchestrator,
    store,
    buffer,
    events,
    llm,
    identify,
    resume,
    skills,
    workersRepo,
    pii,
    vault,
    open,
    say,
    saved,
    emitted,
  };
}

/** Run the whole intake with the answers given, one per step, returning the last turn. */
async function runIntake(world: ReturnType<typeof makeWorld>, answers: string[], armed = false) {
  await world.open();
  let last: TurnResult | null = null;
  for (const text of answers) last = await world.say(text, { armGeneralRoad: armed });
  return last as TurnResult;
}

const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown, ...rest: unknown[]) => {
      logged.push([message, ...rest].map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("opening (the session's first bubble)", () => {
  it("serves the first missing question, writes ONLY the assistant line, and spends no turn", async () => {
    const world = makeWorld();
    const opened = await world.open();

    expect(opened).toMatchObject({
      reply: INTAKE_COPY.first_name.prompt,
      kind: "ask",
      questionKey: "worker_first_name",
      answerType: "text",
      options: [],
      whyText: INTAKE_COPY.first_name.why,
      unavailable: false,
    });
    const buffer = world.saved()!;
    expect(buffer.turnCount).toBe(0);
    expect(buffer.messages).toEqual([
      {
        role: "assistant",
        text: INTAKE_COPY.first_name.prompt,
        at: T0.toISOString(),
        voiceNoteId: null,
        intake: true,
      },
    ]);
    expect(buffer.profiling?.identityIntake).toMatchObject({
      state: "pending",
      step: "first_name",
      remaining: ["last_name", "state", "city"],
    });
    // The intake is not an interview ask: the 28-ask budget is untouched.
    expect(buffer.profiling?.engineAsks).toBe(0);
    expect(world.events.emit).not.toHaveBeenCalled();
  });

  it("asks a RETURNING worker nothing — no gap, no intake, nothing written (D9)", async () => {
    const world = makeWorld();
    expect(await world.open({ hasName: true, hasState: true, hasCity: true })).toBeNull();
    expect(world.saved()).toBeUndefined();
  });

  it("asks only what is missing: a named worker with no city opens on the city", async () => {
    const world = makeWorld();
    const opened = await world.open({ hasName: true, hasState: true, hasCity: false });
    expect(opened?.questionKey).toBe("worker_city");
    const handoff = await world.say("Sitamarhi");
    expect(handoff.reply).toBe(INTAKE_HANDOFF_TEXT);
    expect(world.workersRepo.updateFullName).not.toHaveBeenCalled();
    expect(world.workersRepo.updateLocation).toHaveBeenCalledWith(WORKER, {
      currentCity: "Sitamarhi",
    });
  });

  it("opens nothing on a session that already has an envelope (a retried request)", async () => {
    const world = makeWorld();
    await world.open();
    expect(await world.open()).toBeNull();
    expect(world.saved()?.messages).toHaveLength(1);
  });

  it("opens nothing without the intake service — the construction every older test uses", async () => {
    const world = makeWorld({ withoutIntake: true });
    expect(await world.open()).toBeNull();
    expect(world.saved()).toBeUndefined();
  });

  it("seeds a city already on the worker's record at open, as a fresh envelope would (D7)", async () => {
    const world = makeWorld({ storedCity: "Pune" });
    await world.open({ hasName: false, hasState: false, hasCity: true });
    const envelope = world.saved()!.profiling!;
    expect(answersOf(envelope).current_city?.value_normalized).toBe("Pune");
    expect(envelope.prefilledKeys).toEqual(["current_city"]);
  });
});

describe("the steps", () => {
  it("first name → surname → state → city → the opener, writing each fact ONCE", async () => {
    const world = makeWorld();
    await world.open();

    const surname = await world.say("mera naam Ramesh hai");
    expect(surname).toMatchObject({
      questionKey: "worker_last_name",
      reply: INTAKE_COPY.last_name.prompt,
    });
    // D2 — the first name is HELD, sealed, and not yet written.
    expect(world.workersRepo.updateFullName).not.toHaveBeenCalled();
    const held = world.saved()!.profiling!.identityIntake!;
    expect(held.firstNameEnc).toMatch(/^v1:tok_/);
    expect(JSON.stringify(world.saved()!.profiling)).not.toContain("Ramesh");

    const state = await world.say("kumar");
    expect(state).toMatchObject({ questionKey: "worker_state", reply: INTAKE_COPY.state.prompt });
    expect(world.workersRepo.updateFullName).toHaveBeenCalledTimes(1);
    const token = world.workersRepo.updateFullName.mock.calls[0]![1];
    expect(world.vault.get(token)).toBe("Ramesh Kumar");
    // The seal is cleared the moment the name is written.
    expect(world.saved()!.profiling!.identityIntake!.firstNameEnc).toBeNull();

    const city = await world.say("Maharashtra");
    expect(city).toMatchObject({ questionKey: "worker_city", reply: INTAKE_COPY.city.prompt });
    expect(world.workersRepo.updateLocation).not.toHaveBeenCalled();

    const handoff = await world.say("Pune");
    expect(handoff).toMatchObject({ reply: INTAKE_HANDOFF_TEXT, questionKey: null, kind: "ask" });
    expect(world.workersRepo.updateLocation).toHaveBeenCalledTimes(1);
    expect(world.workersRepo.updateLocation).toHaveBeenCalledWith(WORKER, {
      currentCity: "Pune",
      currentState: "Maharashtra",
    });

    const buffer = world.saved()!;
    expect(buffer.profiling!.identityIntake).toMatchObject({ state: "settled", step: null });
    // NO TURN SPENT: eight intake lines plus the opening, and the counter never moved.
    expect(buffer.turnCount).toBe(0);
    expect(buffer.messages).toHaveLength(9);
    expect(buffer.messages.every((m) => m.intake === true)).toBe(true);

    expect(world.emitted("worker.name_recorded")).toHaveLength(1);
    expect(world.emitted("worker.location_recorded")).toHaveLength(1);
    expect(world.emitted("profile.identity_intake_answered").map((e) => e.payload)).toEqual([
      {
        worker_id: WORKER,
        session_id: SESSION,
        step: "first_name",
        outcome: "answered",
        recognized: null,
      },
      {
        worker_id: WORKER,
        session_id: SESSION,
        step: "last_name",
        outcome: "answered",
        recognized: null,
      },
      {
        worker_id: WORKER,
        session_id: SESSION,
        step: "state",
        outcome: "answered",
        recognized: true,
      },
      {
        worker_id: WORKER,
        session_id: SESSION,
        step: "city",
        outcome: "answered",
        recognized: true,
      },
    ]);
  });

  it("a two-word first answer is the full name — the surname is never asked (D3)", async () => {
    const world = makeWorld();
    await world.open();
    const next = await world.say("mera naam ramesh kumar hai");
    expect(next.questionKey).toBe("worker_state");
    expect(world.vault.get(world.workersRepo.updateFullName.mock.calls[0]![1])).toBe(
      "Ramesh Kumar",
    );
    const steps = world
      .emitted("profile.identity_intake_answered")
      .map((e) => (e.payload as { step: string }).step);
    expect(steps).toEqual(["first_name"]);
  });

  it("invalid → re-ask → skip: two non-answers settle a step as SKIPPED and move on (D1)", async () => {
    const world = makeWorld();
    await world.open();

    const retry = await world.say("pata nahi");
    expect(retry).toMatchObject({
      questionKey: "worker_first_name",
      reply: INTAKE_COPY.first_name.retry,
    });
    const skipped = await world.say("nahi pata");
    // A skipped first name asks no surname.
    expect(skipped).toMatchObject({ questionKey: "worker_state", reply: INTAKE_COPY.state.prompt });
    expect(world.workersRepo.updateFullName).not.toHaveBeenCalled();
    expect(world.emitted("profile.identity_intake_answered").map((e) => e.payload)).toEqual([
      {
        worker_id: WORKER,
        session_id: SESSION,
        step: "first_name",
        outcome: "skipped",
        recognized: null,
      },
    ]);
  });

  it("a skipped surname writes the first name ALONE (D2)", async () => {
    const world = makeWorld();
    await world.open();
    await world.say("Ramesh");
    await world.say("pata nahi");
    const state = await world.say("nahi pata");
    expect(state.questionKey).toBe("worker_state");
    expect(world.vault.get(world.workersRepo.updateFullName.mock.calls[0]![1])).toBe("Ramesh");
  });

  it("a question back gets the why, then the question; abuse gets the fixed line — and identify sees neither", async () => {
    const world = makeWorld();
    await world.open({ hasName: true, hasState: false, hasCity: true });
    const why = await world.say("job milegi kya?");
    expect(why.reply).toBe(`${INTAKE_COPY.state.why} ${INTAKE_COPY.state.prompt}`);
    expect(why.questionKey).toBe("worker_state");
    const world2 = makeWorld();
    await world2.open({ hasName: true, hasState: false, hasCity: true });
    const calm = await world2.say("chutiya");
    expect(calm.reply).toBe(DE_ESCALATION_REPLY_TEXT);
    expect(calm.questionKey).toBe("worker_state");
    expect(world.identify.identify).not.toHaveBeenCalled();
    expect(world2.identify.identify).not.toHaveBeenCalled();
  });

  it("a refusal is never written as a name: two of them SKIP the step and keep the gap (D1)", async () => {
    const world = makeWorld();
    await world.open();
    const retry = await world.say("nahi batana");
    expect(retry).toMatchObject({
      questionKey: "worker_first_name",
      reply: INTAKE_COPY.first_name.retry,
    });
    // A DIFFERENT second refusal: the same text again inside the retry-storm window is a
    // duplicate submit, which Layer A replays without taking a turn at all.
    const next = await world.say("skip");
    expect(next.questionKey).toBe("worker_state");
    // The record keeps its gap, so the worker's next new session asks again (D9).
    expect(world.workersRepo.updateFullName).not.toHaveBeenCalled();
    expect(world.emitted("profile.identity_intake_answered").map((e) => e.payload)).toEqual([
      {
        worker_id: WORKER,
        session_id: SESSION,
        step: "first_name",
        outcome: "skipped",
        recognized: null,
      },
    ]);
  });

  it("'naam kyu chahiye?' is served the why, then the question — never read as a name", async () => {
    const world = makeWorld();
    await world.open();
    const why = await world.say("naam kyu chahiye?");
    expect(why).toMatchObject({
      questionKey: "worker_first_name",
      reply: `${INTAKE_COPY.first_name.why} ${INTAKE_COPY.first_name.prompt}`,
    });
    expect(world.workersRepo.updateFullName).not.toHaveBeenCalled();
    expect(world.saved()!.profiling!.identityIntake!.firstNameEnc).toBeNull();
  });

  it("a Devanagari name is sealed, held and written BYTE-EXACT — no vowel sign cut off", async () => {
    const world = makeWorld();
    await world.open();
    await world.say("सीता");
    const held = world.saved()!.profiling!.identityIntake!.firstNameEnc!;
    expect(world.vault.get(held)).toBe("सीता");
    await world.say("शर्मा");
    const token = world.workersRepo.updateFullName.mock.calls[0]![1];
    expect(world.vault.get(token)).toBe("सीता शर्मा");
  });

  it("a surname answer that repeats the first name writes it ONCE", async () => {
    const world = makeWorld();
    await world.open();
    await world.say("Ramesh");
    await world.say("Ramesh Kumar");
    expect(world.vault.get(world.workersRepo.updateFullName.mock.calls[0]![1])).toBe(
      "Ramesh Kumar",
    );
  });

  it("a held first name that will not unseal writes NO name, and the intake still moves on", async () => {
    const world = makeWorld({ decryptThrows: true });
    await world.open();
    await world.say("Ramesh");
    const state = await world.say("Kumar");
    expect(state.questionKey).toBe("worker_state");
    expect(world.workersRepo.updateFullName).not.toHaveBeenCalled();
  });
});

describe("the CAS and the write", () => {
  it("a failed record write is UNAVAILABLE with nothing advanced — and the retry succeeds", async () => {
    const world = makeWorld({ nameWriteThrows: true });
    await world.open();
    await world.say("Ramesh");
    const before = world.saved()!;

    const failed = await world.say("Kumar");
    expect(failed.unavailable).toBe(true);
    const after = world.saved()!;
    expect(after.profiling!.rev).toBe(before.profiling!.rev);
    expect(after.profiling!.identityIntake!.step).toBe("last_name");
    expect(after.messages).toHaveLength(before.messages.length);
    expect(
      world
        .emitted("profile.identity_intake_answered")
        .map((e) => (e.payload as { step: string }).step),
    ).toEqual(["first_name"]);
    // Nothing that names the worker reached the log line that reports it.
    expect(logged.join("\n")).toMatch(/identity intake write failed/);
  });

  it("a LOST CAS re-runs the decision and re-issues the SAME idempotent write", async () => {
    const world = makeWorld();
    await world.open();
    await world.say("Ramesh");
    world.buffer.saveWithCas.mockClear();
    // The next write is lost once, with nothing having changed underneath it.
    const winner = world.buffer.saveWithCas.getMockImplementation()!;
    let lose = 1;
    world.buffer.saveWithCas.mockImplementation(async (...args) => {
      if (lose-- > 0) return false;
      return winner(...args);
    });

    const state = await world.say("Kumar");
    expect(state.questionKey).toBe("worker_state");
    expect(world.buffer.saveWithCas).toHaveBeenCalledTimes(2);
    // Written twice (the same UPDATE), recorded under ONE key, so the spine holds one row.
    const named = world.emitted("worker.name_recorded");
    expect(named).toHaveLength(2);
    expect(new Set(named.map((e) => e.idempotencyKey))).toEqual(
      new Set([`worker.name_recorded:identity_intake:${SESSION}`]),
    );
    // The funnel row is written ONLY for the decision that landed.
    expect(
      world
        .emitted("profile.identity_intake_answered")
        .filter((e) => (e.payload as { step: string }).step === "last_name"),
    ).toHaveLength(1);
  });

  it("a duplicate submit REPLAYS the reply and writes nothing twice", async () => {
    const world = makeWorld();
    await world.open();
    await world.say("Ramesh", { submissionId: "66666666-6666-4666-8666-666666666666" });
    const first = await world.say("Kumar", {
      submissionId: "77777777-7777-4777-8777-777777777777",
    });
    const again = await world.say("Kumar", {
      submissionId: "77777777-7777-4777-8777-777777777777",
    });

    expect(again.replayed).toBe(true);
    expect(again.reply).toBe(first.reply);
    expect(again.questionKey).toBe("worker_state");
    expect(world.workersRepo.updateFullName).toHaveBeenCalledTimes(1);
    expect(world.saved()!.profiling!.identityIntake!.step).toBe("state");
  });

  it("fails CLOSED on a pending intake with no service — never down the model path", async () => {
    const world = makeWorld();
    await world.open();
    const skewed = makeWorld({ withoutIntake: true });
    skewed.store.set(SESSION, world.saved()!);
    const turn = await skewed.say("Ramesh");
    expect(turn.unavailable).toBe(true);
    expect(skewed.identify.identify).not.toHaveBeenCalled();
    expect(skewed.llm.take).not.toHaveBeenCalled();
  });
});

describe("flag OFF — a session the intake never opened takes today's turn, byte for byte", () => {
  it("the same replies and the same buffer as an orchestrator built with no intake at all", async () => {
    // With the flag off `openIdentityIntake` is never called, so this is every flag-off session:
    // the service is wired, the envelope's `identityIntake` is null, and nothing may differ from
    // the construction that predates the intake.
    const wired = makeWorld({ storedCity: "Pune" });
    const bare = makeWorld({ storedCity: "Pune", withoutIntake: true });
    for (const text of ["main welder hoon, 5 saal", "din ki", "pata nahi"]) {
      expect(await wired.say(text)).toEqual(await bare.say(text));
    }
    // Byte for byte, less the one wall-clock field: `turnLatency` buckets how long each turn took.
    const serialized = (world: ReturnType<typeof makeWorld>) => {
      const saved = world.saved()!;
      const { turnLatency: _clock, ...profiling } = saved.profiling!;
      return JSON.stringify({ ...saved, profiling });
    };
    expect(serialized(wired)).toBe(serialized(bare));

    const buffer = wired.saved()!;
    expect(buffer.profiling!.identityIntake).toBeNull();
    for (const line of buffer.messages) expect("intake" in line).toBe(false);
    expect(wired.emitted("profile.identity_intake_answered")).toEqual([]);
    expect(wired.pii.encrypt).not.toHaveBeenCalled();
  });
});

describe("the interview behind it is today's interview", () => {
  it("the first real turn is numbered, answered and replied to exactly as without the intake", async () => {
    // WITH the intake: the city arrives through it.
    const withIntake = makeWorld();
    await runIntake(withIntake, ["Ramesh Kumar", "Maharashtra", "Pune"]);
    const a = await withIntake.say("main welder hoon, 5 saal");

    // WITHOUT: the same city is already on the worker's record, the way `/name` put it there.
    const without = makeWorld({ storedCity: "Pune", withoutIntake: true });
    const b = await without.say("main welder hoon, 5 saal");

    expect(withIntake.saved()!.turnCount).toBe(1);
    expect(without.saved()!.turnCount).toBe(1);
    for (const field of [
      "reply",
      "kind",
      "questionKey",
      "progress",
      "unansweredEssentials",
    ] as const) {
      expect(a[field], field).toEqual(b[field]);
    }
    expect(answersOf(withIntake.saved()!.profiling!)).toEqual(
      answersOf(without.saved()!.profiling!),
    );
  });

  it("the city is asked ONCE — the intake's answer settles the pack's current_city", async () => {
    const asked = async (cityAnswer: string | null) => {
      const world = makeWorld();
      await world.open({ hasName: true, hasState: true, hasCity: false });
      if (cityAnswer === null) {
        await world.say("pata nahi");
        await world.say("nahi pata");
      } else {
        await world.say(cityAnswer);
      }
      const keys: (string | null)[] = [];
      for (const text of ["welder", "welder hoon", "din ki"])
        keys.push((await world.say(text)).questionKey);
      return { keys, envelope: world.saved()!.profiling! };
    };
    const answered = await asked("Pune");
    expect(answered.envelope.prefilledKeys).toContain("current_city");
    expect(answered.keys).not.toContain("current_city");
    // The control: skip the city in the intake and the pack DOES ask it — the test can fail.
    const skipped = await asked(null);
    expect(skipped.keys).toContain("current_city");
  });

  it("hands off to the résumé 'is this you?' turn, unflagged and UNARMED (D6, D7)", async () => {
    const world = makeWorld({ identity: LINE, skillsArmed: true });
    const handoff = await runIntake(world, ["Ramesh Kumar", "Maharashtra", "Pune"], true);

    expect(handoff.reply).toMatch(/Kya ye aap hi hain\?$/);
    expect(handoff.options.map((o) => o.option_key)).toEqual(
      RESUME_IDENTITY_OPTIONS.map((o) => o.option_key),
    );
    const buffer = world.saved()!;
    expect(buffer.profiling!.resumeIdentity).toEqual({ importId: IMPORT, state: "pending" });
    expect(buffer.profiling!.engineAsks).toBe(1);
    // The résumé turn's own line, stored as it always was — the worker's answer before it is the intake's.
    expect(buffer.messages.at(-1)).toMatchObject({ role: "assistant", text: handoff.reply });
    expect(buffer.messages.at(-1)!.intake).toBeUndefined();
    expect(buffer.messages.at(-2)!.intake).toBe(true);
    // A session that opens on a résumé turn keeps today's (unarmed) interview.
    expect(buffer.profiling!.generalRoad).toEqual(emptyGeneralRoad());

    // …and the worker's "haan" is captured as the identity answer on turn ONE.
    await world.say("resume_identity_yes");
    expect(world.saved()!.turnCount).toBe(1);
    expect(world.saved()!.profiling!.resumeIdentity).toEqual({
      importId: IMPORT,
      state: "settled",
    });
  });

  it("a handoff onto the opener ARMS the general road exactly as a first message does (D7)", async () => {
    const armed = makeWorld({ skillsArmed: true });
    await runIntake(armed, ["Ramesh Kumar", "Maharashtra", "Pune"], true);
    expect(armed.saved()!.profiling!.generalRoad.armed).toBe(true);

    // The voice form never passes the arm, so a session it continues stays unarmed.
    const unarmed = makeWorld({ skillsArmed: true });
    await runIntake(unarmed, ["Ramesh Kumar", "Maharashtra", "Pune"], false);
    expect(unarmed.saved()!.profiling!.generalRoad.armed).toBe(false);
  });

  it("openTurn RE-SERVES a pending intake question with no write; the résumé opening waits", async () => {
    const world = makeWorld({ identity: LINE });
    await world.open();
    await world.say("pata nahi");
    const before = world.saved()!;

    const reopened = await world.orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(reopened).toMatchObject({
      reply: INTAKE_COPY.first_name.retry,
      questionKey: "worker_first_name",
      replayed: true,
    });
    expect(world.saved()).toEqual(before);
    expect(
      await world.orchestrator.openResumeConfirm({
        sessionId: SESSION,
        workerId: WORKER,
        now: T0,
        ctx: CTX as never,
      }),
    ).toBeNull();

    const view = await world.orchestrator.viewSession(SESSION, T0);
    expect(view?.served).toMatchObject({
      questionKey: "worker_first_name",
      promptText: INTAKE_COPY.first_name.retry,
      answerType: "text",
    });
  });

  it("a SETTLED intake is a conversation too — no résumé opening is served beneath it", async () => {
    // The handoff served the opener (no résumé yet); the worker then uploads one and reopens the
    // app. `turnCount` is still 0, so without the intake gate the start path would write an
    // opening beneath the thread. The turn path owns that offer now, on his next message.
    const world = makeWorld();
    await runIntake(world, ["Ramesh Kumar", "Maharashtra", "Pune"]);
    world.resume.identityForChat.mockResolvedValue(LINE as never);
    const before = world.saved();
    expect(
      await world.orchestrator.openResumeConfirm({
        sessionId: SESSION,
        workerId: WORKER,
        now: T0,
        ctx: CTX as never,
      }),
    ).toBeNull();
    expect(world.saved()).toEqual(before);
  });
});

describe("privacy — nothing the worker typed into the intake reaches a reader of meaning", () => {
  it("the model's history on the first real turn carries NO intake line", async () => {
    const world = makeWorld();
    await runIntake(world, ["Ramesh", "Kumar", "Maharashtra", "Pune"]);
    // Neither identify nor the model ran during the intake.
    expect(world.identify.identify).not.toHaveBeenCalled();
    expect(world.llm.take).not.toHaveBeenCalled();

    await world.say("main welder hoon");
    expect(world.llm.take).toHaveBeenCalledTimes(1);
    const history = world.llm.take.mock.calls[0]![2];
    expect(history).toEqual([]);
  });

  it("the skills stage's history carries NO intake line either", async () => {
    const world = makeWorld();
    await runIntake(world, ["Ramesh Kumar", "Maharashtra", "Pune"]);
    await world.say("main software developer hoon");
    // Put the session on the skills lane, then take a turn: the history handed to the stage is
    // the same `transcriptOf` the model's is, and must have dropped every intake line.
    const buffer = world.saved()!;
    world.store.set(SESSION, {
      ...buffer,
      profiling: {
        ...buffer.profiling!,
        llmStage: "skills",
        generalRoad: {
          ...emptyGeneralRoad(),
          armed: true,
          lane: "skills",
          laneReason: "outside_declared_roles",
        },
      },
    });
    await expect(world.say("React aur Node")).rejects.toThrow(/skills stage reached/);
    const history = world.skills.take.mock.calls[0]![2] as { role: string; text: string }[];
    expect(history.map((line) => line.text)).toEqual([
      "main software developer hoon",
      expect.any(String),
    ]);
    for (const value of TYPED_VALUES) {
      expect(JSON.stringify(history)).not.toContain(value);
    }
  });

  it("no name or place reaches ANY event payload or log line", async () => {
    const world = makeWorld({ identity: LINE });
    await runIntake(world, ["mera naam Ramesh hai", "Kumar", "Maharashtra", "Pune"]);

    const calls = world.events.emit.mock.calls.map(([params]) => params as Record<string, unknown>);
    expect(calls.length).toBeGreaterThan(0);
    for (const params of calls) {
      const name = params.event_name as string;
      expect(isEventName(name), name).toBe(true);
      // Every payload validates against the registry it is checked against in production.
      expect(
        EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY].payload.safeParse(params.payload)
          .success,
        name,
      ).toBe(true);
    }
    const wire = JSON.stringify(calls);
    const logs = logged.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const value of TYPED_VALUES) {
      expect(wire, `event carries ${value}`).not.toContain(value);
      expect(logs, `log carries ${value}`).not.toContain(value);
    }
  });
});
