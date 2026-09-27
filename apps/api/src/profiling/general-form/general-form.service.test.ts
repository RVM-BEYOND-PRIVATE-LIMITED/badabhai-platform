import "reflect-metadata";
import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NewWorkerAttribute } from "@badabhai/db";
import { createEvent, type EventName } from "@badabhai/event-schema";

import { SetMyPreferencesSchema } from "../../profiles/worker-preferences.dto";
import {
  EDUCATION_QUALIFICATIONS,
  PREFERENCE_KEYS,
} from "../../profiles/worker-preferences.vocabulary";
import {
  GENERAL_FORM_TERMS_FIELDS,
  GeneralFormAnswerErrorSchema,
  GeneralFormAnswerResponse,
  GeneralFormSchemaResponse,
  type GeneralFormAnswerDto,
} from "./general-form.dto";
import {
  GENERAL_FORM_SECTION_TITLES,
  GENERAL_FORM_TERMS_STORAGE_KEYS,
  GeneralFormService,
} from "./general-form.service";

/**
 * ═══ THE GENERAL FORM (ADR-0045 §3.3) ═══
 *
 * What this file holds, each a defect that would be invisible in production:
 *
 *   1. THE FORM BELONGS TO A HANDOVER. No readable handed-over stamp, no form (404) — and the
 *      handover session, not the request, is the provenance of every row.
 *   2. THE FORM'S OWN ROWS ARE PACK-LESS. A row with a pack could re-elect the trade the whole
 *      sheet renders as; a text row would enter a matching read as an option key.
 *   3. THE BRIEF IS REFUSED BY REASON, NEVER QUOTED — not in the 400, not in a log line.
 *   4. EVERY EVENT IS VALID against its registered schema — checked through the real
 *      `createEvent`, because a mocked emit that accepts anything is how a 17-key preferences
 *      event shipped a 500.
 *   5. COMPLETION IS ONCE PER HANDOVER, carries the counts the résumé will print, marks the chat
 *      session so the card stops, and refreshes an existing résumé.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RESUME = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-26T10:00:00.000Z");
const CTX = { correlationId: "corr-1", requestId: "req-1" };

const STAMP = {
  v: 1,
  lane: "skills",
  role_label: "Graphic designer",
  domain_label: "Design",
  skills: ["CorelDRAW", "Photoshop"],
  outcome: "confirmed",
  handed_over: true,
};

type StoredRow = {
  attributeKey: string;
  valueKind: string;
  valueBool: boolean | null;
  valueNumber: string | null;
  valueText: string | null;
  valueTextList: string[] | null;
  valueJson: Record<string, unknown> | null;
};

interface Options {
  /** The session the handover read returns; `null` = none. Defaults to a handed-over session. */
  session?: Record<string, unknown> | null;
  /** Rows already stored, by attribute key. */
  stored?: readonly StoredRow[];
  jobs?: readonly { startYm: string | null }[];
  credentials?: { certificates: unknown[]; educations: unknown[]; trainings: unknown[] };
  resumeId?: string;
  /** The worker's stored (encrypted) name; `null` = none stored. Defaults to one. */
  fullNameEnc?: string | null;
  /** The decrypt; defaults to a fixed plaintext name. */
  decrypt?: (token: string) => string;
}

/** The name the default harness decrypts — what the brief's name wall looks for. */
const FULL_NAME = "Ramesh Kumar Yadav";

/** The handed-over session, already marked complete by an earlier brief save. */
const MARKED_SESSION = {
  id: SESSION,
  workerId: WORKER,
  status: "ended",
  conversationState: {
    completion_reason: "general_form_handoff",
    general_road: STAMP,
    general_form_completed_at: "2026-09-20T08:00:00.000Z",
  },
};

const row = (over: Partial<StoredRow> & { attributeKey: string }): StoredRow => ({
  valueKind: "text",
  valueBool: null,
  valueNumber: null,
  valueText: null,
  valueTextList: null,
  valueJson: null,
  ...over,
});

function make(opts: Options = {}) {
  const session =
    opts.session === undefined
      ? {
          id: SESSION,
          workerId: WORKER,
          status: "ended",
          conversationState: { completion_reason: "general_form_handoff", general_road: STAMP },
        }
      : opts.session;

  // An in-memory `worker_attributes`, keyed like `wa_worker_key_uq`, so a write is visible to the
  // next read exactly as the upsert makes it.
  const store = new Map<string, StoredRow>((opts.stored ?? []).map((r) => [r.attributeKey, r]));
  const written: NewWorkerAttribute[] = [];
  const attributes = {
    upsertMany: vi.fn(async (rows: NewWorkerAttribute[]) => {
      for (const r of rows) {
        written.push(r);
        store.set(r.attributeKey, {
          attributeKey: r.attributeKey,
          valueKind: r.valueKind,
          valueBool: r.valueBool ?? null,
          valueNumber: r.valueNumber ?? null,
          valueText: r.valueText ?? null,
          valueTextList: r.valueTextList ?? null,
          valueJson: (r.valueJson as Record<string, unknown> | null) ?? null,
        });
      }
      return rows.length;
    }),
    loadKeys: vi.fn(async (_workerId: string, keys: readonly string[]) =>
      keys.flatMap((k) => (store.has(k) ? [store.get(k)!] : [])),
    ),
  };
  const chat = {
    findLatestGeneralHandoverSession: vi.fn(async (_workerId: string) => session ?? undefined),
    markGeneralFormCompleted: vi.fn(async () => true),
  };
  const employment = { loadForResume: vi.fn(async () => opts.jobs ?? []) };
  const qualifications = {
    loadForResume: vi.fn(
      async () => opts.credentials ?? { certificates: [], educations: [], trainings: [] },
    ),
  };
  // THE REAL VALIDATOR. `EventsService.emit` builds through `createEvent` and throws on an invalid
  // payload; a double that accepted anything would let a payload the registry refuses pass here.
  const emitted: {
    event_name: EventName;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }[] = [];
  const emit = vi.fn(
    async (params: {
      event_name: EventName;
      actor: never;
      subject: never;
      payload: Record<string, unknown>;
      idempotencyKey?: string;
    }) => {
      createEvent({
        event_name: params.event_name,
        actor: params.actor,
        subject: params.subject,
        payload: params.payload as never,
        source: "api",
        metadata: { environment: "test", service: "api" },
      });
      emitted.push(params);
      return {};
    },
  );
  const latestResume = vi.fn(async () =>
    opts.resumeId === undefined ? undefined : { id: opts.resumeId },
  );
  const renderQueueAdd = vi.fn(async () => ({}));
  const findById = vi.fn(async (_id: string) => ({
    id: WORKER,
    fullName: opts.fullNameEnc === undefined ? "enc:name" : opts.fullNameEnc,
  }));
  const decrypt = vi.fn(opts.decrypt ?? ((_token: string) => FULL_NAME));

  const service = new GeneralFormService(
    chat as never,
    attributes as never,
    employment as never,
    qualifications as never,
    { emit } as never,
    { latestResume, findById } as never,
    { decrypt } as never,
    { add: renderQueueAdd } as never,
  );
  return {
    service,
    store,
    written,
    attributes,
    chat,
    employment,
    qualifications,
    emit,
    emitted,
    latestResume,
    renderQueueAdd,
    findById,
    decrypt,
  };
}

const brief = (text: string): GeneralFormAnswerDto => ({
  question_key: "profile_brief",
  answer: { kind: "text", text },
});
const DECLINE_BRIEF: GeneralFormAnswerDto = {
  question_key: "profile_brief",
  answer: { kind: "declined" },
};
const workHistory = (value: boolean): GeneralFormAnswerDto => ({
  question_key: "has_work_history",
  answer: { kind: "boolean", value },
});

let errorLog: ReturnType<typeof vi.spyOn>;
let warnLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  warnLog = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every line any logger received, joined — for the never-log-the-text assertions. */
const allLogged = (): string =>
  [...errorLog.mock.calls, ...warnLog.mock.calls].map((c) => JSON.stringify(c)).join("\n");

// ─────────────────────────────────────────────────────────────────────────────────────────

describe("GeneralFormService — the handover is the form's context", () => {
  it("404 when the worker was never handed the general form", async () => {
    const { service } = make({ session: null });
    await expect(service.schema(WORKER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.answer(WORKER, workHistory(true), CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404 when the stamp is unreadable (a later build's shape) — no form this build can serve", async () => {
    const { service } = make({
      session: {
        id: SESSION,
        workerId: WORKER,
        conversationState: { general_road: { ...STAMP, v: 2 } },
      },
    });
    await expect(service.schema(WORKER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404 when the stamp says the session did NOT hand over", async () => {
    const { service } = make({
      session: {
        id: SESSION,
        workerId: WORKER,
        conversationState: { general_road: { ...STAMP, handed_over: false } },
      },
    });
    await expect(service.schema(WORKER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404 on a session that is not this worker's (defence in depth over the scoped query)", async () => {
    const { service } = make({
      session: { id: SESSION, workerId: OTHER_WORKER, conversationState: { general_road: STAMP } },
    });
    await expect(service.schema(WORKER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads the HANDOVER session for the token's worker — never the latest one", async () => {
    const { service, chat } = make();
    await service.schema(WORKER);
    expect(chat.findLatestGeneralHandoverSession).toHaveBeenCalledWith(WORKER);
  });

  it("a 404 writes nothing and emits nothing", async () => {
    const { service, attributes, emit } = make({ session: null });
    await expect(service.answer(WORKER, brief("Welder hoon"), CTX)).rejects.toThrow();
    expect(attributes.upsertMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("GeneralFormService.schema — the screens", () => {
  it("serves five sections in order, with the handover session and the stamp's role", async () => {
    const { service } = make();
    const out = await service.schema(WORKER);
    // The wire contract, strictly: a stray or missing key fails the parse.
    expect(GeneralFormSchemaResponse.parse(out)).toEqual(out);
    expect(out.session_id).toBe(SESSION);
    expect(out.role_label).toBe("Graphic designer");
    expect(out.complete).toBe(false);
    expect(out.sections.map((s) => [s.id, s.title])).toEqual([
      ["terms", GENERAL_FORM_SECTION_TITLES.terms],
      ["work_history", "Work history"],
      ["education", "Education"],
      ["certifications", "Certificates & training"],
      ["brief", "Aapke baare mein"],
    ]);
    expect(GENERAL_FORM_SECTION_TITLES.terms).toBe("Availability & terms");
  });

  it("terms: ONE preferences marker asking exactly the seven R4 fields", async () => {
    const { service } = make();
    const [terms] = (await service.schema(WORKER)).sections;
    expect(terms!.screens).toEqual([
      {
        type: "preferences",
        endpoint: "PUT /workers/me/work-preferences",
        fields: [
          "salary_expected_min",
          "salary_expected_max",
          "preferred_cities",
          "shift",
          "work_types",
          "languages",
          "availability",
        ],
      },
    ]);
  });

  it("every terms field is a key the preferences page accepts, and each has ONE storage key", () => {
    // A field the page does not know is a field the app asks and the PUT 400s on (.strict()).
    for (const field of GENERAL_FORM_TERMS_FIELDS) {
      expect(Object.keys(SetMyPreferencesSchema.shape)).toContain(field);
    }
    // Derived from the page's own storage→wire table: one storage key per field, all real.
    expect(GENERAL_FORM_TERMS_STORAGE_KEYS).toHaveLength(GENERAL_FORM_TERMS_FIELDS.length);
    for (const key of GENERAL_FORM_TERMS_STORAGE_KEYS) {
      expect(Object.keys(PREFERENCE_KEYS)).toContain(key);
    }
    expect(GENERAL_FORM_TERMS_STORAGE_KEYS).toContain("preferred_locations");
    expect(GENERAL_FORM_TERMS_STORAGE_KEYS).toContain("shift_preference");
  });

  it("work history: the yes/no question in the trade form's shape, then the employment page with dates required", async () => {
    const { service } = make();
    const section = (await service.schema(WORKER)).sections[1]!;
    expect(section.screens).toEqual([
      {
        type: "question",
        question: {
          question_key: "has_work_history",
          prompt_text: "Kya aapne pehle kahin kaam kiya hai?",
          why_text: null,
          answer_type: "boolean",
          // Haan / Nahi are CLIENT-OWNED for a boolean, as on the trade form.
          options: [],
        },
        ui: { searchable: false },
        answer: null,
        suggestion: null,
      },
      { type: "employment", endpoint: "PUT /workers/me/employment", require_start_ym: true },
    ]);
  });

  it("an explicit 'Nahi' HIDES the employment page; 'Haan' keeps it; both replay the answer", async () => {
    const no = make({
      stored: [row({ attributeKey: "has_work_history", valueKind: "boolean", valueBool: false })],
    });
    const noSection = (await no.service.schema(WORKER)).sections[1]!;
    expect(noSection.screens.map((s) => s.type)).toEqual(["question"]);
    expect(noSection.screens[0]).toMatchObject({
      answer: { status: "answered", bool: false, option_keys: [], text: null, other_text: null },
    });

    const yes = make({
      stored: [row({ attributeKey: "has_work_history", valueKind: "boolean", valueBool: true })],
    });
    const yesSection = (await yes.service.schema(WORKER)).sections[1]!;
    expect(yesSection.screens.map((s) => s.type)).toEqual(["question", "employment"]);
    expect(yesSection.screens[0]).toMatchObject({ answer: { status: "answered", bool: true } });
  });

  it("a has_work_history row of the WRONG KIND reads as unanswered — the page stays shown", async () => {
    const { service } = make({
      stored: [row({ attributeKey: "has_work_history", valueKind: "text", valueText: "no" })],
    });
    const section = (await service.schema(WORKER)).sections[1]!;
    expect(section.screens.map((s) => s.type)).toEqual(["question", "employment"]);
    expect(section.screens[0]).toMatchObject({ answer: null });
  });

  it("education: the qualifications page for `educations` only, offering the WHOLE credential vocabulary", async () => {
    const { service } = make();
    const [screen] = (await service.schema(WORKER)).sections[2]!.screens;
    expect(screen).toEqual({
      type: "qualifications",
      endpoint: "PUT /workers/me/qualifications",
      suggested_certificates: [],
      lists: ["educations"],
      education_options: Object.entries(EDUCATION_QUALIFICATIONS).map(([key, label]) => ({
        key,
        label,
      })),
    });
    // ADR-0045 §6 — the two rungs only this form offers, in ladder order at the top.
    const keys = (screen as { education_options: { key: string }[] }).education_options.map(
      (o) => o.key,
    );
    expect(keys.slice(-3)).toEqual(["graduate", "postgraduate", "doctorate"]);
  });

  it("certifications: the same page for certificates and trainings — and NO education options", async () => {
    const { service } = make();
    const [screen] = (await service.schema(WORKER)).sections[3]!.screens;
    expect(screen).toEqual({
      type: "qualifications",
      endpoint: "PUT /workers/me/qualifications",
      suggested_certificates: [],
      lists: ["certificates", "trainings"],
    });
  });

  it("brief: the text question, unanswered", async () => {
    const { service } = make();
    const [screen] = (await service.schema(WORKER)).sections[4]!.screens;
    expect(screen).toEqual({
      type: "question",
      question: {
        question_key: "profile_brief",
        prompt_text: "Apne kaam ke baare mein 1-2 line batayein",
        why_text: "Ye aapke resume mein sabse upar dikhega.",
        answer_type: "text",
        options: [],
      },
      ui: { searchable: false },
      answer: null,
      suggestion: null,
    });
  });

  it("a saved brief replays as the trade form's saved answer, and the MARKED handover reads complete", async () => {
    const { service } = make({
      session: MARKED_SESSION,
      stored: [
        row({
          attributeKey: "profile_brief",
          valueKind: "json",
          valueJson: { status: "answered", text: "Welder hoon, 5 saal" },
        }),
      ],
    });
    const out = await service.schema(WORKER);
    expect(out.complete).toBe(true);
    expect(out.sections[4]!.screens[0]).toMatchObject({
      answer: {
        status: "answered",
        option_keys: [],
        text: "Welder hoon, 5 saal",
        number: null,
        bool: null,
        other_text: null,
      },
    });
  });

  it("a declined brief replays as declined (settled, not re-asked) and the MARKED handover reads complete", async () => {
    const { service } = make({
      session: MARKED_SESSION,
      stored: [
        row({
          attributeKey: "profile_brief",
          valueKind: "json",
          valueJson: { status: "declined" },
        }),
      ],
    });
    const out = await service.schema(WORKER);
    expect(out.complete).toBe(true);
    expect(out.sections[4]!.screens[0]).toMatchObject({
      answer: { status: "declined", text: null },
    });
  });

  it("a SECOND handover (a chat redo) is NOT complete because a brief is stored from the first", async () => {
    // The brief row is per WORKER and outlives the redo; the new handover session is unmarked.
    // Reading "complete" off the row told the app to skip the brief, so nothing ever marked the
    // new session and the chat kept serving its card.
    const { service } = make({
      stored: [
        row({
          attributeKey: "profile_brief",
          valueKind: "json",
          valueJson: { status: "answered", text: "Welder hoon, 5 saal" },
        }),
      ],
    });
    const out = await service.schema(WORKER);
    expect(out.complete).toBe(false);
    // The earlier brief still PREFILLS the screen; saving it marks this handover.
    expect(out.sections[4]!.screens[0]).toMatchObject({ answer: { status: "answered" } });
  });

  it("an unreadable completion mark reads as not complete — the direction that keeps the form reachable", async () => {
    const { service } = make({
      session: {
        ...MARKED_SESSION,
        conversationState: { ...MARKED_SESSION.conversationState, general_form_completed_at: 42 },
      },
    });
    expect((await service.schema(WORKER)).complete).toBe(false);
  });

  it("a damaged brief row (the other-answer shape, a smuggled key) reads as unanswered", async () => {
    for (const valueJson of [
      { kind: "other_answer", text: "x" },
      { status: "answered", text: "x", extra: 1 },
      { status: "answered", text: "" },
    ]) {
      const { service } = make({
        stored: [row({ attributeKey: "profile_brief", valueKind: "json", valueJson })],
      });
      const out = await service.schema(WORKER);
      expect(out.complete).toBe(false);
      expect(out.sections[4]!.screens[0]).toMatchObject({ answer: null });
    }
  });
});

describe("GeneralFormService.answer — validation per key", () => {
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse();
      return GeneralFormAnswerErrorSchema.parse(body).code;
    }
    throw new Error("expected a 400");
  };

  it("has_work_history takes ONLY a boolean — text and a decline are 400 answer_kind_not_allowed", async () => {
    const { service, attributes, emit } = make();
    expect(
      await codeOf(
        service.answer(WORKER, { question_key: "has_work_history", answer: { kind: "declined" } }),
      ),
    ).toBe("answer_kind_not_allowed");
    expect(
      await codeOf(
        service.answer(WORKER, {
          question_key: "has_work_history",
          answer: { kind: "text", text: "haan" },
        }),
      ),
    ).toBe("answer_kind_not_allowed");
    expect(attributes.upsertMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("profile_brief takes text or a decline — a boolean is 400 answer_kind_not_allowed", async () => {
    const { service, attributes } = make();
    expect(
      await codeOf(
        service.answer(WORKER, {
          question_key: "profile_brief",
          answer: { kind: "boolean", value: true },
        }),
      ),
    ).toBe("answer_kind_not_allowed");
    expect(attributes.upsertMany).not.toHaveBeenCalled();
  });

  it.each([
    ["Call me 98765 43210", "brief_identifier"],
    ["UPI ramesh@okaxis", "brief_contact"],
    ["t.me/ramesh pe baat karo", "brief_link"],
    ["Tata Motors Ltd mein 5 saal", "brief_organisation"],
    ["Accha kaam 🙂", "brief_emoji"],
    ["[PERSON_1] ke saath", "brief_brackets"],
    ["....", "brief_empty"],
    ["a".repeat(161), "brief_too_long"],
  ])("a refused brief (%s) is a 400 %s that never echoes the text", async (text, code) => {
    const { service, attributes, emit } = make();
    let caught: unknown;
    try {
      await service.answer(WORKER, brief(text), CTX);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse();
    expect(GeneralFormAnswerErrorSchema.parse(body).code).toBe(code);
    // Neither the body nor the exception's own message carries a fragment of the text.
    const fragment = text.slice(0, 8);
    expect(JSON.stringify(body)).not.toContain(fragment);
    expect((caught as Error).message).not.toContain(fragment);
    expect(allLogged()).not.toContain(fragment);
    expect(attributes.upsertMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("GeneralFormService.answer — pack-less rows and the answered event", () => {
  it("has_work_history: ONE boolean row, pack-less, with the handover session as provenance", async () => {
    const { service, written, emitted } = make();
    const out = await service.answer(WORKER, workHistory(true), CTX);

    expect(written).toEqual([
      {
        workerId: WORKER,
        attributeKey: "has_work_history",
        valueKind: "boolean",
        valueBool: true,
        valueNumber: null,
        valueText: null,
        valueTextList: null,
        valueJson: null,
        source: "answer_map",
        questionKey: "has_work_history",
        packId: null,
        packVersion: null,
        sessionId: SESSION,
      },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event_name: "profile.general_form_answered",
      payload: {
        worker_id: WORKER,
        session_id: SESSION,
        question_key: "has_work_history",
        status: "answered",
        value: "yes",
        chars: null,
      },
    });
    // Per write — no idempotency key.
    expect(emitted[0]!.idempotencyKey).toBeUndefined();
    expect(GeneralFormAnswerResponse.parse(out)).toEqual({
      question_key: "has_work_history",
      status: "answered",
      complete: false,
      schema_stale: false,
    });
  });

  it("'Nahi' records value 'no'", async () => {
    const { service, emitted } = make();
    await service.answer(WORKER, workHistory(false), CTX);
    expect(emitted[0]!.payload).toMatchObject({ value: "no", chars: null });
  });

  it("schema_stale is true exactly when the answer shows or hides the employment page", async () => {
    // unanswered → Haan: the page was shown and still is.
    expect((await make().service.answer(WORKER, workHistory(true))).schema_stale).toBe(false);
    // unanswered → Nahi: the page disappears.
    expect((await make().service.answer(WORKER, workHistory(false))).schema_stale).toBe(true);
    const stored = (v: boolean) => [
      row({ attributeKey: "has_work_history", valueKind: "boolean", valueBool: v }),
    ];
    // Nahi → Haan: it comes back.
    expect(
      (await make({ stored: stored(false) }).service.answer(WORKER, workHistory(true)))
        .schema_stale,
    ).toBe(true);
    // Haan → Nahi, and a repeat Nahi.
    expect(
      (await make({ stored: stored(true) }).service.answer(WORKER, workHistory(false)))
        .schema_stale,
    ).toBe(true);
    expect(
      (await make({ stored: stored(false) }).service.answer(WORKER, workHistory(false)))
        .schema_stale,
    ).toBe(false);
  });

  it("a has_work_history answer does not complete the form and runs no completion step", async () => {
    const { service, chat, emitted, latestResume } = make({ resumeId: RESUME });
    await service.answer(WORKER, workHistory(true), CTX);
    expect(emitted.map((e) => e.event_name)).toEqual(["profile.general_form_answered"]);
    expect(chat.markGeneralFormCompleted).not.toHaveBeenCalled();
    expect(latestResume).not.toHaveBeenCalled();
  });

  it("an answered brief: ONE json row {status, text} — the SCREENED text — and chars = its length", async () => {
    const { service, written, emitted } = make();
    const out = await service.answer(WORKER, brief("  Welder hoon,\n5 saal  "), CTX);

    expect(written).toEqual([
      {
        workerId: WORKER,
        attributeKey: "profile_brief",
        valueKind: "json",
        valueBool: null,
        valueNumber: null,
        valueText: null,
        valueTextList: null,
        valueJson: { status: "answered", text: "Welder hoon, 5 saal" },
        source: "answer_map",
        questionKey: "profile_brief",
        packId: null,
        packVersion: null,
        sessionId: SESSION,
      },
    ]);
    const answered = emitted.find((e) => e.event_name === "profile.general_form_answered")!;
    expect(answered.payload).toEqual({
      worker_id: WORKER,
      session_id: SESSION,
      question_key: "profile_brief",
      status: "answered",
      value: null,
      chars: "Welder hoon, 5 saal".length,
    });
    // THE TEXT NEVER LEAVES THE ROW — not in any event, not in any log line.
    expect(JSON.stringify(emitted)).not.toContain("Welder hoon");
    expect(allLogged()).not.toContain("Welder hoon");
    expect(GeneralFormAnswerResponse.parse(out)).toEqual({
      question_key: "profile_brief",
      status: "answered",
      complete: true,
      schema_stale: false,
    });
  });

  it("a Devanagari brief is stored and measured in code points", async () => {
    const text = "मैं 5 साल से वेल्डिंग का काम कर रहा हूँ।";
    const { service, written, emitted } = make();
    await service.answer(WORKER, brief(text), CTX);
    expect(written[0]!.valueJson).toEqual({ status: "answered", text });
    expect(emitted[0]!.payload.chars).toBe([...text].length);
  });

  it("a declined brief: a json row {status: declined}, chars null, and the form is complete", async () => {
    const { service, written, emitted } = make();
    const out = await service.answer(WORKER, DECLINE_BRIEF, CTX);
    expect(written[0]).toMatchObject({
      attributeKey: "profile_brief",
      valueKind: "json",
      valueJson: { status: "declined" },
      packId: null,
      packVersion: null,
    });
    expect(emitted[0]!.payload).toMatchObject({ status: "declined", value: null, chars: null });
    expect(out).toEqual({
      question_key: "profile_brief",
      status: "declined",
      complete: true,
      schema_stale: false,
    });
  });

  it("the stored brief is never the other-answer shape the disclosure leak guard fails closed on", async () => {
    const { service, written } = make();
    await service.answer(WORKER, brief("Welder hoon"), CTX);
    expect(written[0]!.valueJson).not.toHaveProperty("kind");
  });

  it("a failed answered event does not fail the saved answer, and its log carries no text", async () => {
    const h = make();
    h.emit.mockRejectedValueOnce(new Error("events table unavailable"));
    const out = await h.service.answer(WORKER, workHistory(true), CTX);
    expect(out.status).toBe("answered");
    expect(h.written).toHaveLength(1);
    expect(errorLog).toHaveBeenCalled();
  });

  it("the has_work_history response reports THIS handover's mark as complete", async () => {
    const { service } = make({ session: MARKED_SESSION });
    expect((await service.answer(WORKER, workHistory(true))).complete).toBe(true);
  });

  it("the has_work_history response on a second handover is not complete, whatever brief is stored", async () => {
    const { service } = make({
      stored: [
        row({
          attributeKey: "profile_brief",
          valueKind: "json",
          valueJson: { status: "declined" },
        }),
      ],
    });
    expect((await service.answer(WORKER, workHistory(true))).complete).toBe(false);
  });
});

describe("GeneralFormService.answer — the brief's name wall (the employer copy prints initials only)", () => {
  it("REFUSES a brief carrying the worker's own name, as brief_name, and stores nothing", async () => {
    const h = make();
    for (const text of [
      "Ramesh 8 saal se welder hai",
      "yadav ji, electrician, 5 saal",
      "Main Ramesh Kumar, cook hoon",
    ]) {
      const err = await h.service.answer(WORKER, brief(text), CTX).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      const body = GeneralFormAnswerErrorSchema.parse((err as BadRequestException).getResponse());
      expect(body.code).toBe("brief_name");
      // Never quoted — not the brief, not the name.
      expect(JSON.stringify(body)).not.toMatch(/ramesh|yadav/i);
    }
    expect(h.attributes.upsertMany).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(allLogged()).not.toMatch(/ramesh|yadav/i);
  });

  it("decrypts the worker's own name for the match — and never logs it", async () => {
    const h = make();
    await h.service.answer(WORKER, brief("Welder hoon, 8 saal"), CTX);
    expect(h.findById).toHaveBeenCalledWith(WORKER);
    expect(h.decrypt).toHaveBeenCalledWith("enc:name");
    expect(allLogged()).not.toContain(FULL_NAME);
  });

  it("FAILS CLOSED when a stored name cannot be decrypted: brief_unscreenable, nothing stored", async () => {
    const h = make({
      decrypt: () => {
        throw new Error("bad key");
      },
    });
    const err = await h.service.answer(WORKER, brief("Welder hoon"), CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(
      GeneralFormAnswerErrorSchema.parse((err as BadRequestException).getResponse()).code,
    ).toBe("brief_unscreenable");
    expect(h.attributes.upsertMany).not.toHaveBeenCalled();
  });

  it("a worker with no stored name is screened on the cues alone", async () => {
    const h = make({ fullNameEnc: null });
    expect((await h.service.answer(WORKER, brief("Welder hoon"), CTX)).status).toBe("answered");
    expect(h.decrypt).not.toHaveBeenCalled();
    const err = await h.service
      .answer(WORKER, brief("Mera naam Suresh hai, welder"), CTX)
      .catch((e: unknown) => e);
    expect(
      GeneralFormAnswerErrorSchema.parse((err as BadRequestException).getResponse()).code,
    ).toBe("brief_name");
  });

  it("a decline needs no name and reads none", async () => {
    const h = make({
      decrypt: () => {
        throw new Error("bad key");
      },
    });
    expect((await h.service.answer(WORKER, DECLINE_BRIEF, CTX)).status).toBe("declined");
    expect(h.findById).not.toHaveBeenCalled();
  });
});

describe("GeneralFormService.answer — completion (the brief settled)", () => {
  const FULL = {
    stored: [
      row({ attributeKey: "has_work_history", valueKind: "boolean", valueBool: true }),
      row({ attributeKey: "salary_expected_max", valueKind: "number", valueNumber: "25000" }),
      row({ attributeKey: "preferred_locations", valueKind: "text_list", valueTextList: ["pune"] }),
      row({ attributeKey: "shift_preference", valueKind: "text", valueText: "day" }),
      // NOT a terms key on this form — must not be counted.
      row({ attributeKey: "documents_ready", valueKind: "text_list", valueTextList: ["aadhaar"] }),
    ],
    jobs: [{ startYm: "2019-04" }, { startYm: null }, { startYm: "2022-01" }],
    credentials: {
      certificates: [{}, {}],
      educations: [{}],
      trainings: [{}, {}, {}],
    },
  };

  it("emits profile.general_form_completed ONCE per (worker, session) with the résumé's counts", async () => {
    const { service, emitted } = make(FULL);
    await service.answer(WORKER, brief("Welder hoon"), CTX);

    const completed = emitted.filter((e) => e.event_name === "profile.general_form_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toEqual({
      worker_id: WORKER,
      session_id: SESSION,
      brief: "answered",
      has_work_history: "yes",
      employments: 3,
      employments_dated: 2,
      educations: 1,
      certificates: 2,
      trainings: 3,
      terms_keys: 3,
    });
    expect(completed[0]!.idempotencyKey).toBe(
      `profile.general_form_completed:${WORKER}:${SESSION}`,
    );
  });

  it("the key is the same on a re-submitted brief — the table dedupes the second completion", async () => {
    const { service, emitted } = make(FULL);
    await service.answer(WORKER, brief("Welder hoon"), CTX);
    await service.answer(WORKER, DECLINE_BRIEF, CTX);
    const keys = emitted
      .filter((e) => e.event_name === "profile.general_form_completed")
      .map((e) => e.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`profile.general_form_completed:${WORKER}:${SESSION}`]));
  });

  it("a declined brief completes too, and an unanswered yes/no reads 'unanswered'", async () => {
    const { service, emitted } = make();
    await service.answer(WORKER, DECLINE_BRIEF, CTX);
    const completed = emitted.find((e) => e.event_name === "profile.general_form_completed")!;
    expect(completed.payload).toMatchObject({
      brief: "declined",
      has_work_history: "unanswered",
      employments: 0,
      employments_dated: 0,
      terms_keys: 0,
    });
  });

  it("marks the handover session complete — the chat's signal to stop serving the card", async () => {
    const { service, chat } = make();
    await service.answer(WORKER, brief("Welder hoon"), CTX, NOW);
    expect(chat.markGeneralFormCompleted).toHaveBeenCalledWith(SESSION, WORKER, NOW);
  });

  it("re-renders an EXISTING résumé: forced, fail-open, and with no colon-bearing job id", async () => {
    const { service, renderQueueAdd } = make({ resumeId: RESUME });
    await service.answer(WORKER, brief("Welder hoon"), CTX);
    expect(renderQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, jobOpts] = renderQueueAdd.mock.calls[0]! as unknown as [
      string,
      Record<string, unknown>,
      { jobId?: string } | undefined,
    ];
    expect(name).toBe("render");
    expect(data).toEqual({
      resumeId: RESUME,
      workerId: WORKER,
      force: true,
      failClosed: false,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
    // BullMQ refuses a custom id containing ":" — the trade form's safety net shipped one.
    expect(jobOpts?.jobId ?? "").not.toContain(":");
  });

  it("no résumé yet, no re-render — the app's generate mints version 1", async () => {
    const { service, renderQueueAdd, latestResume } = make();
    await service.answer(WORKER, brief("Welder hoon"), CTX);
    expect(latestResume).toHaveBeenCalledWith(WORKER);
    expect(renderQueueAdd).not.toHaveBeenCalled();
  });

  it("each completion step is best-effort and independent: a failed count read still marks and re-renders", async () => {
    const h = make({ resumeId: RESUME });
    h.employment.loadForResume.mockRejectedValueOnce(new Error("decrypt key unavailable"));
    const out = await h.service.answer(WORKER, brief("Welder hoon"), CTX, NOW);
    expect(out.complete).toBe(true);
    expect(h.emitted.map((e) => e.event_name)).toEqual(["profile.general_form_answered"]);
    expect(h.chat.markGeneralFormCompleted).toHaveBeenCalledWith(SESSION, WORKER, NOW);
    expect(h.renderQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("a failed mark and a failed queue do not fail the saved brief", async () => {
    const h = make({ resumeId: RESUME });
    h.chat.markGeneralFormCompleted.mockRejectedValueOnce(new Error("db down"));
    h.renderQueueAdd.mockRejectedValueOnce(new Error("redis down"));
    const out = await h.service.answer(WORKER, brief("Welder hoon"), CTX);
    expect(out).toMatchObject({ status: "answered", complete: true });
    expect(h.emitted.map((e) => e.event_name)).toContain("profile.general_form_completed");
    expect(allLogged()).not.toContain("Welder hoon");
  });
});
