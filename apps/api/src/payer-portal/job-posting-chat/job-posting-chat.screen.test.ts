import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  JobPostingChatStateSchema,
  JobPostingDraftSchema,
  type JobPostingChatState,
  type JobPostingDraft,
} from "@badabhai/ai-contracts";
import { workerVisibleTextScreens, type WorkerVisibleScreen } from "@badabhai/validators";
import {
  BANK_TOPIC_ORDER,
  FIELD_POLICY,
  SCREENED_DRAFT_FIELDS,
  SCREENED_LIST_FIELDS,
  blankRefusedFields,
  reaskRefusedFields,
  refusedDraftFields,
  refusedNames,
  restoreWrapUpTarget,
  WRAP_UP_TOPIC,
  type ScreenedDraftField,
} from "./job-posting-chat.screen";

/**
 * #1911 / #1921 — the interview-time half of the worker-visible text screen.
 *
 * The engine states below are REAL `interview_engine.next_turn` outputs (captured from the
 * ai-service and trimmed to their keys), not hand-invented shapes. The surgered states were
 * also fed back into the real engine while this was written: a clean answer is attributed to
 * the re-asked topic, and the question the engine had picked is served on the next turn.
 * apps/ai-service/tests/test_job_posting_chat_reask_contract.py drives the engine with them.
 */

/** The bank's topic order (question_bank.py `_TOPICS`) — the order of `missing_fields`. */
const BANK = [
  "role_title",
  "skills",
  "location_label",
  "city",
  "vacancy",
  "pay_range",
  "pay_type",
  "experience",
  "shift",
  "needed_by",
  "benefits",
  "requirements",
  "description",
];
/** Every topic but the description, as asked in a full interview (the opener asks the title). */
const ASKED_TO_REQUIREMENTS = [
  "location_label",
  "vacancy",
  "skills",
  "pay_range",
  "pay_type",
  "experience",
  "shift",
  "needed_by",
  "benefits",
  "requirements",
];
const ONE_EACH = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 1]));

const state = (s: Partial<JobPostingChatState>): JobPostingChatState =>
  JobPostingChatStateSchema.parse(s);
const draft = (d: Partial<JobPostingDraft>): JobPostingDraft => JobPostingDraftSchema.parse(d);

/** A complete, clean draft (the wrap-up turn of a real interview). */
const CLEAN_DRAFT = draft({
  role_title: "CNC Operator",
  skills: ["Fanuc control"],
  location_label: "Pune, Chakan",
  vacancy_band: "2-5",
  pay_min: 20000,
  pay_max: 25000,
  shift: "day",
  benefits: ["PF", "ESI"],
  requirements: ["ITI"],
  description: "Machining on the shop floor",
  city: "Pune",
  pay_type: "in_hand",
  min_experience_years: 1,
  max_experience_years: 2,
  needed_by: "immediate",
  confidence: 1,
  missing_fields: [],
});

/** One value per (field, screen). Each must trip EXACTLY its screen. A list's are chips. */
const TRIPS = {
  role_title: {
    contact_details: "CNC Operator call 9876543210",
    company_name: "Operator at Kalyani Pvt Ltd",
    link: "CNC Operator www.acme.in",
  },
  benefits: {
    contact_details: "call HR 9876543210",
    company_name: "Canteen by Kalyani Pvt Ltd",
    // The #1921 report: "Canteen, details www.acme.in" splits into this chip.
    link: "details www.acme.in",
  },
  requirements: {
    contact_details: "Contact hr@acme.example",
    company_name: "Licence from Sharma & Co",
    link: "apply at acme.in",
  },
  description: {
    contact_details: "Machining work. Send CV to hr@acme.example",
    company_name: "Machining for Mehta & Co on the shop floor",
    link: "Machining work, details at www.acme.in",
  },
} as const satisfies Record<ScreenedDraftField, Record<WorkerVisibleScreen, string>>;

/** Every refused value used anywhere in this file — none may appear in a reply. */
const ALL_REFUSED = Object.values(TRIPS).flatMap((byScreen) => Object.values(byScreen));

const isList = (field: ScreenedDraftField): field is "benefits" | "requirements" =>
  (SCREENED_LIST_FIELDS as readonly string[]).includes(field);

/** `CLEAN_DRAFT` with `value` in `field`: a text field's value, or one more chip in a list. */
const withValue = (field: ScreenedDraftField, value: string): JobPostingDraft =>
  isList(field)
    ? { ...CLEAN_DRAFT, [field]: [...CLEAN_DRAFT[field], value] }
    : { ...CLEAN_DRAFT, [field]: value };

/** The bank's own options for benefits (question_bank.py), served with its re-ask. */
const BENEFIT_CHIPS = ["PF + ESI", "Canteen", "Transport", "Accommodation"];

describe("refusedDraftFields — the shared screen, on the four worker-read free-text fields", () => {
  it("screens role_title, the benefits and requirements chips, and description, in bank order", () => {
    expect([...SCREENED_DRAFT_FIELDS]).toEqual([
      "role_title",
      "benefits",
      "requirements",
      "description",
    ]);
    expect([...SCREENED_LIST_FIELDS]).toEqual(["benefits", "requirements"]);
  });

  for (const field of SCREENED_DRAFT_FIELDS) {
    for (const [screen, value] of Object.entries(TRIPS[field])) {
      it(`${field}: ${screen} is refused, by name`, () => {
        // Fixture sanity: the value trips this screen and only it.
        expect(workerVisibleTextScreens(value)).toEqual([screen]);
        expect(refusedDraftFields(withValue(field, value))).toEqual([{ field, screens: [screen] }]);
      });
    }
  }

  it("a list is refused when ANY chip trips, and reports every screen its chips trip, in order", () => {
    // Fixture sanity: the clean chips pass on their own.
    for (const chip of [...CLEAN_DRAFT.benefits, ...CLEAN_DRAFT.requirements]) {
      expect(workerVisibleTextScreens(chip), chip).toEqual([]);
    }
    expect(
      refusedDraftFields({
        ...CLEAN_DRAFT,
        benefits: ["PF", TRIPS.benefits.link, "Canteen", TRIPS.benefits.contact_details],
      }),
    ).toEqual([{ field: "benefits", screens: ["contact_details", "link"] }]);
  });

  it("reports both lists, and every field, in bank order", () => {
    const refused = refusedDraftFields({
      ...CLEAN_DRAFT,
      role_title: TRIPS.role_title.company_name,
      benefits: [TRIPS.benefits.link],
      requirements: ["ITI", TRIPS.requirements.contact_details],
      description: TRIPS.description.link,
    });
    expect(refused).toEqual([
      { field: "role_title", screens: ["company_name"] },
      { field: "benefits", screens: ["link"] },
      { field: "requirements", screens: ["contact_details"] },
      { field: "description", screens: ["link"] },
    ]);
  });

  it("is the shared helper's verdict, not a copy — every screen a value trips, in its order", () => {
    const value = "Acme Pvt Ltd 9876543210 acme.in";
    expect(refusedDraftFields({ ...CLEAN_DRAFT, role_title: value })).toEqual([
      { field: "role_title", screens: workerVisibleTextScreens(value) },
    ]);
    expect(workerVisibleTextScreens(value)).toEqual(["contact_details", "company_name", "link"]);
  });

  it("passes clean trade text and skips an unanswered (null or empty) field", () => {
    expect(refusedDraftFields(CLEAN_DRAFT)).toEqual([]);
    for (const title of ["MIG Welder — Night Shift", "VMC Setter cum Operator", "Fitter (ITI)"]) {
      expect(refusedDraftFields({ ...CLEAN_DRAFT, role_title: title }), title).toEqual([]);
    }
    const chips = ["PF + ESI", "Free bus", "B.Com/M.Com", "Night shift allowance"];
    expect(refusedDraftFields({ ...CLEAN_DRAFT, benefits: chips, requirements: chips })).toEqual(
      [],
    );
    expect(
      refusedDraftFields({
        ...CLEAN_DRAFT,
        role_title: null,
        description: null,
        benefits: [],
        requirements: [],
      }),
    ).toEqual([]);
  });

  it("reports both fields, title first, when both trip", () => {
    const refused = refusedDraftFields({
      ...CLEAN_DRAFT,
      role_title: TRIPS.role_title.link,
      description: TRIPS.description.contact_details,
    });
    expect(refused.map((r) => r.field)).toEqual(["role_title", "description"]);
  });
});

/**
 * THE ENGINE FACTS `FIELD_POLICY` MIRRORS, read from the ai-service's Python SOURCE.
 *
 * The re-ask edits the engine's state from here, so it is only right while the bank and the
 * engine still look the way `FIELD_POLICY` says. CI runs this suite when apps/api changes and
 * the Python suite when apps/ai-service changes, so each side pins the other:
 * apps/ai-service/tests/test_job_posting_chat_reask_contract.py checks the same facts from
 * there, and drives the real engine with re-ask-shaped states.
 */
describe("FIELD_POLICY mirrors the ai-service bank and engine (read from Python source)", () => {
  const dir = join(__dirname, "..", "..", "..", "..", "ai-service", "app", "job_posting_chat");
  const read = (file: string) => readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
  const bank = read("question_bank.py");
  const engine = read("interview_engine.py");
  const answers = read("answers.py");

  /** The quoted strings in a Python tuple's source text. */
  const quoted = (source: string): string[] =>
    [...source.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");

  /** One entry per `Topic(...)` call in the bank list, in bank order. */
  const topics = bank
    .split("\n    Topic(\n")
    .slice(1)
    .map((chunk) => chunk.split("\n    ),\n")[0] ?? "")
    .map((call) => {
      // The positional arguments, one per line: id, label, question. Comments are dropped
      // first, because they quote example answers.
      const positional = [...call.replace(/^\s*#.*$/gm, "").matchAll(/^\s+"([^"\n]*)",$/gm)].map(
        (m) => m[1],
      );
      return {
        id: /"(\w+)"/.exec(call)?.[1],
        question: positional[2] ?? null,
        retry: /retry_question="([^"]+)"/.exec(call)?.[1] ?? null,
        options: quoted(/options=\(([^)]*)\)/.exec(call)?.[1] ?? ""),
      };
    });
  const ids = topics.map((t) => t.id);
  const topic = (id: string) => topics.find((t) => t.id === id);
  const essentialsTuple =
    /^ESSENTIAL_TOPICS: tuple\[str, \.\.\.\] = \(([^)]*)\)/m.exec(engine)?.[1] ?? "";
  const essentials = quoted(essentialsTuple);
  const crossTopic = quoted(
    /^_CROSS_TOPIC: tuple\[str, \.\.\.\] = \(([^)]*)\)/m.exec(answers)?.[1] ?? "",
  );

  it("found the real bank and the real essentials, not an empty parse", () => {
    expect(ids).toHaveLength(13);
    expect(essentials).toEqual(["role_title", "location_label", "city", "vacancy"]);
    expect(topic("benefits")?.question).toMatch(/^Which benefits/);
    expect(topic("vacancy")?.options).toEqual(["1", "2-5", "6-10", "11-25", "25+"]);
    expect(crossTopic).toContain("vacancy");
  });

  it("BANK_TOPIC_ORDER is the bank's topic order, which orders missing_fields", () => {
    expect([...BANK_TOPIC_ORDER]).toEqual(ids);
  });

  it("each screened field is a bank topic, in bank order", () => {
    expect(
      ids.filter((id) => (SCREENED_DRAFT_FIELDS as readonly string[]).includes(id ?? "")),
    ).toEqual([...SCREENED_DRAFT_FIELDS]);
  });

  for (const field of SCREENED_DRAFT_FIELDS) {
    it(`${field}: essential flag and re-ask chips match the bank and the engine`, () => {
      const policy = FIELD_POLICY[field];
      expect(policy.essential).toBe(essentials.includes(field));
      expect([...policy.chips]).toEqual(topic(field)?.options);
    });
  }

  it("no screened field is read in passing, so one turn can newly refuse only the field on screen", () => {
    for (const field of SCREENED_DRAFT_FIELDS) expect(crossTopic).not.toContain(field);
  });

  it("the benefits re-ask is the bank's own question, verbatim; neither list has a retry", () => {
    expect(FIELD_POLICY.benefits.question).toBe(topic("benefits")?.question);
    expect(topic("benefits")?.retry).toBeNull();
    expect(topic("requirements")?.retry).toBeNull();
  });

  it("the wrap-up topic is the bank's last topic and must-ask, so a drained bank has asked it", () => {
    const mustAsk = quoted(
      /^MUST_ASK_TOPICS: tuple\[str, \.\.\.\] = \(([^)]*)\)/m.exec(engine)?.[1] ?? "",
    );
    expect(mustAsk).toContain("benefits");
    expect(mustAsk).toContain(WRAP_UP_TOPIC);
    expect(ids.at(-1)).toBe(WRAP_UP_TOPIC);
  });

  it("a reopened title is prepended to unanswered_essentials because it is the first essential", () => {
    expect(essentials[0]).toBe("role_title");
  });

  it("the title re-ask is the bank's own retry wording, verbatim; the description has none", () => {
    const retry = (id: string) => topics.find((t) => t.id === id)?.retry;
    expect(FIELD_POLICY.role_title.question).toBe(retry("role_title"));
    expect(retry("description")).toBeNull();
  });
});

describe("reaskRefusedFields — a refused value is forgotten and re-asked", () => {
  it("returns null for a clean turn, so the engine's turn is kept as it is", () => {
    expect(
      reaskRefusedFields({
        draft: CLEAN_DRAFT,
        state: state({ answered_topics: ["role_title"] }),
        priorState: null,
        priorDraft: null,
        engineAskedId: null,
      }),
    ).toBeNull();
  });

  describe("the opener's answer is a refused title (turn 1)", () => {
    // next_turn(None, "Operator at Kalyani Pvt Ltd"): the opener's question is attributed,
    // the title is recorded, and the engine serves the location question.
    const engineState = state({
      turn_count: 1,
      answered_topics: ["role_title"],
      asked_question_ids: ["location_label"],
      collected: { role_title: TRIPS.role_title.company_name },
      ask_counts: { location_label: 1 },
      unanswered_essentials: ["location_label", "city", "vacancy"],
    });
    const engineDraft = draft({
      role_title: TRIPS.role_title.company_name,
      confidence: 0.08,
      missing_fields: BANK.filter((t) => t !== "role_title"),
    });
    const r = reaskRefusedFields({
      draft: engineDraft,
      state: engineState,
      priorState: null,
      priorDraft: null,
      engineAskedId: "location_label",
    });

    it("re-asks the title with a plain reason that names the field and never the text", () => {
      expect(r?.askedField).toBe("role_title");
      expect(r?.refused).toEqual([{ field: "role_title", screens: ["company_name"] }]);
      expect(r?.replyText).toBe(
        "Workers see the job title, so it can't include a company name. " +
          "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
      );
      expect(r?.replyText).not.toContain("Kalyani");
    });

    it("drops the title from the draft and lists it as missing again, first", () => {
      expect(r?.draft.role_title).toBeNull();
      expect(r?.draft.missing_fields).toEqual(BANK);
      expect(JSON.stringify(r?.draft)).not.toContain("Kalyani");
    });

    it("reopens the topic in the engine state, so the next message answers it", () => {
      expect(r?.state).toEqual({
        ...engineState,
        answered_topics: [],
        collected: {},
        // The location question was never shown: un-served, so it is asked next.
        asked_question_ids: ["role_title"],
        ask_counts: {},
        unanswered_essentials: ["role_title", "location_label", "city", "vacancy"],
      });
      expect(JSON.stringify(r?.state)).not.toContain("Kalyani");
    });

    it("does not mutate the engine's objects", () => {
      expect(engineState.collected).toEqual({ role_title: TRIPS.role_title.company_name });
      expect(engineState.asked_question_ids).toEqual(["location_label"]);
      expect(engineDraft.role_title).toBe(TRIPS.role_title.company_name);
    });
  });

  describe("the wrap-up turn's description is refused", () => {
    const prior = state({
      turn_count: 11,
      answered_topics: ["role_title", ...ASKED_TO_REQUIREMENTS, "city"],
      asked_question_ids: [...ASKED_TO_REQUIREMENTS, "description"],
      ask_counts: ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]),
      collected: { role_title: "CNC Operator" },
    });
    const engineState = state({
      ...prior,
      turn_count: 12,
      answered_topics: [...prior.answered_topics, "description"],
      collected: { ...prior.collected, description: TRIPS.description.link },
    });
    const r = reaskRefusedFields({
      draft: { ...CLEAN_DRAFT, description: TRIPS.description.link },
      state: engineState,
      priorState: prior,
      // The description is answered for the first time this turn: nothing earlier to keep.
      priorDraft: { ...CLEAN_DRAFT, description: null, missing_fields: ["description"] },
      engineAskedId: null,
    });

    it("re-asks the description and puts it back last, keeping its ask count", () => {
      expect(r?.askedField).toBe("description");
      expect(r?.kept).toEqual([]);
      expect(r?.replyText).toBe(
        "Workers see the job description, so it can't include website links. " +
          "Could you describe the day-to-day work again?",
      );
      expect(r?.state.answered_topics).not.toContain("description");
      expect(r?.state.collected).toEqual({ role_title: "CNC Operator" });
      expect(r?.state.asked_question_ids.at(-1)).toBe("description");
      expect(r?.state.ask_counts.description).toBe(1);
      expect(r?.state.turn_count).toBe(12);
      // Not essential: the essentials list is untouched.
      expect(r?.state.unanswered_essentials).toEqual([]);
    });

    it("drops the description from the draft and lists it as missing, last", () => {
      expect(r?.draft.description).toBeNull();
      expect(r?.draft.missing_fields).toEqual(["description"]);
      expect(r?.draft.role_title).toBe("CNC Operator");
    });
  });

  describe("both fields refused at once", () => {
    // A session stored before #1911 kept a refused title, and now wraps up on a refused
    // description.
    const prior = state({
      turn_count: 11,
      answered_topics: ["role_title", ...ASKED_TO_REQUIREMENTS, "city"],
      asked_question_ids: [...ASKED_TO_REQUIREMENTS, "description"],
      ask_counts: ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]),
      collected: { role_title: TRIPS.role_title.company_name },
    });
    const engineState = state({
      ...prior,
      turn_count: 12,
      answered_topics: [...prior.answered_topics, "description"],
      collected: { ...prior.collected, description: TRIPS.description.contact_details },
    });
    const r = reaskRefusedFields({
      draft: {
        ...CLEAN_DRAFT,
        role_title: TRIPS.role_title.company_name,
        description: TRIPS.description.contact_details,
      },
      state: engineState,
      priorState: prior,
      // The stored draft still holds the refused title, so there is nothing clean to keep.
      priorDraft: {
        ...CLEAN_DRAFT,
        role_title: TRIPS.role_title.company_name,
        description: null,
        missing_fields: ["description"],
      },
      engineAskedId: null,
    });

    it("names both fields and every reason, and asks the title first", () => {
      expect(r?.askedField).toBe("role_title");
      expect(r?.kept).toEqual([]);
      expect(r?.replyText).toBe(
        "Workers see the job title and job description, so they can't include contact " +
          "details or a company name. " +
          "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
      );
    });

    it("drops both from the draft, each at its bank edge in missing_fields", () => {
      expect(r?.draft.role_title).toBeNull();
      expect(r?.draft.description).toBeNull();
      expect(r?.draft.missing_fields).toEqual(["role_title", "description"]);
    });

    it("owes the description again as NEVER ASKED, so the engine serves it after the title", () => {
      expect(r?.state.collected).toEqual({});
      expect(r?.state.answered_topics).not.toContain("role_title");
      expect(r?.state.answered_topics).not.toContain("description");
      expect(r?.state.asked_question_ids).toEqual([...ASKED_TO_REQUIREMENTS, "role_title"]);
      expect("description" in (r?.state.ask_counts ?? {})).toBe(false);
      expect(r?.state.unanswered_essentials).toEqual(["role_title"]);
    });
  });

  describe("a refused overwrite keeps the clean value the field held before this turn", () => {
    // After the wrap-up the description is still the last asked question, so the engine lets
    // ANY later message overwrite it. Here the payer adds a line with a link.
    const EARLIER = CLEAN_DRAFT.description!;
    const prior = state({
      turn_count: 12,
      answered_topics: ["role_title", ...ASKED_TO_REQUIREMENTS, "city", "description"],
      asked_question_ids: [...ASKED_TO_REQUIREMENTS, "description"],
      ask_counts: ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]),
      collected: { role_title: "CNC Operator", description: EARLIER },
    });
    const engineState = state({
      ...prior,
      turn_count: 13,
      collected: { ...prior.collected, description: TRIPS.description.link },
    });
    const refusedDraft = { ...CLEAN_DRAFT, description: TRIPS.description.link };
    const r = reaskRefusedFields({
      draft: refusedDraft,
      state: engineState,
      priorState: prior,
      priorDraft: CLEAN_DRAFT,
      engineAskedId: null,
    });

    it("puts the earlier description back in the draft and the state, still answered", () => {
      expect(r?.kept).toEqual(["description"]);
      expect(r?.draft.description).toBe(EARLIER);
      expect(r?.draft.missing_fields).toEqual([]);
      expect(r?.state.collected).toEqual({ role_title: "CNC Operator", description: EARLIER });
      expect(r?.state.answered_topics).toContain("description");
      expect(JSON.stringify(r)).not.toContain("acme");
    });

    it("still asks again, says the earlier text is kept, and names the word that keeps it", () => {
      expect(r?.askedField).toBe("description");
      expect(r?.state.asked_question_ids.at(-1)).toBe("description");
      expect(r?.state.ask_counts.description).toBe(1);
      expect(r?.replyText).toBe(
        "Workers see the job description, so it can't include website links. " +
          "Your earlier job description is still in the draft. " +
          'Could you describe the day-to-day work again? Reply "no" to keep the earlier one.',
      );
    });

    it("keeps nothing unless the stored state AND the stored draft both hold a clean value", () => {
      const noStoredDraft = reaskRefusedFields({
        draft: refusedDraft,
        state: engineState,
        priorState: prior,
        priorDraft: null,
        engineAskedId: null,
      });
      expect(noStoredDraft?.kept).toEqual([]);
      expect(noStoredDraft?.draft.description).toBeNull();
      expect(noStoredDraft?.state.collected).not.toHaveProperty("description");

      // A value stored before #1911 that the screen refuses is never "kept".
      const refusedBefore = reaskRefusedFields({
        draft: refusedDraft,
        state: engineState,
        priorState: state({
          ...prior,
          collected: { ...prior.collected, description: TRIPS.description.company_name },
        }),
        priorDraft: { ...CLEAN_DRAFT, description: TRIPS.description.company_name },
        engineAskedId: null,
      });
      expect(refusedBefore?.kept).toEqual([]);
      expect(refusedBefore?.draft.description).toBeNull();
      expect(JSON.stringify(refusedBefore?.state)).not.toContain("Mehta");
    });

    it("an EMPTY field goes on screen before a kept one, and the kept one stays answered", () => {
      // A pre-#1911 session with a refused title adds a line with a link to its description.
      const priorWithTitle = state({
        ...prior,
        collected: { role_title: TRIPS.role_title.company_name, description: EARLIER },
      });
      const both = reaskRefusedFields({
        draft: { ...refusedDraft, role_title: TRIPS.role_title.company_name },
        state: state({
          ...engineState,
          collected: { ...priorWithTitle.collected, description: TRIPS.description.link },
        }),
        priorState: priorWithTitle,
        priorDraft: { ...CLEAN_DRAFT, role_title: TRIPS.role_title.company_name },
        engineAskedId: null,
      });
      expect(both?.askedField).toBe("role_title");
      expect(both?.kept).toEqual(["description"]);
      expect(both?.replyText).toBe(
        "Workers see the job title and job description, so they can't include a company name " +
          "or website links. Your earlier job description is still in the draft. " +
          "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
      );
      expect(both?.draft).toMatchObject({ role_title: null, description: EARLIER });
      expect(both?.draft.missing_fields).toEqual(["role_title"]);
      expect(both?.state.collected).toEqual({ description: EARLIER });
      expect(both?.state.answered_topics).toContain("description");
      expect(both?.state.answered_topics).not.toContain("role_title");
      // The description stays asked and counted: it is answered, so it is not owed again.
      expect(both?.state.asked_question_ids).toEqual([
        ...ASKED_TO_REQUIREMENTS,
        "description",
        "role_title",
      ]);
      expect(both?.state.ask_counts.description).toBe(1);
      expect(both?.state.unanswered_essentials).toEqual(["role_title"]);
    });
  });

  describe("un-serving the engine's own question", () => {
    // A pre-#1911 session that kept a refused title; this turn the engine served `shift`.
    const asked = ["location_label", "vacancy", "skills", "pay_range", "pay_type", "experience"];
    const prior = state({
      turn_count: 6,
      answered_topics: ["role_title", ...asked.slice(0, -1), "city"],
      asked_question_ids: asked,
      ask_counts: ONE_EACH(asked),
      collected: { role_title: TRIPS.role_title.link },
    });
    const refusedDraft = { ...CLEAN_DRAFT, role_title: TRIPS.role_title.link };

    it("a question the engine served for the FIRST time is removed and its count dropped", () => {
      const engineState = state({
        ...prior,
        turn_count: 7,
        answered_topics: [...prior.answered_topics, "experience"],
        asked_question_ids: [...asked, "shift"],
        ask_counts: ONE_EACH([...asked, "shift"]),
      });
      const r = reaskRefusedFields({
        draft: refusedDraft,
        state: engineState,
        priorState: prior,
        priorDraft: null,
        engineAskedId: "shift",
      });
      expect(r?.state.asked_question_ids).toEqual([...asked, "role_title"]);
      expect(r?.state.ask_counts).toEqual(ONE_EACH(asked));
    });

    it("a RE-ask the engine served goes back to its prior count, in place", () => {
      // The vacancy question was asked once and not answered; the engine re-served it.
      const engineState = state({
        ...prior,
        turn_count: 7,
        ask_counts: { ...ONE_EACH(asked), vacancy: 2 },
      });
      const r = reaskRefusedFields({
        draft: refusedDraft,
        state: engineState,
        priorState: prior,
        priorDraft: null,
        engineAskedId: "vacancy",
      });
      expect(r?.state.ask_counts.vacancy).toBe(1);
      expect(r?.state.asked_question_ids).toEqual([...asked, "role_title"]);
    });

    it("the clarify path's re-serve (which counts nothing) is left as it was, and the streak resets", () => {
      const engineState = state({ ...prior, turn_count: 7, clarify_count: 1 });
      const r = reaskRefusedFields({
        draft: refusedDraft,
        state: engineState,
        priorState: prior,
        priorDraft: null,
        engineAskedId: "experience",
      });
      expect(r?.state.ask_counts).toEqual(ONE_EACH(asked));
      expect(r?.state.asked_question_ids).toEqual([...asked, "role_title"]);
      expect(r?.state.clarify_count).toBe(0);
    });
  });

  it("blankRefusedFields nulls a refused value and lists it as missing, with no state to reopen", () => {
    const refusedDraft = { ...CLEAN_DRAFT, role_title: TRIPS.role_title.link };
    const refused = refusedDraftFields(refusedDraft);
    const blanked = blankRefusedFields(refusedDraft, refused);
    expect(blanked).toEqual({ ...CLEAN_DRAFT, role_title: null, missing_fields: ["role_title"] });
    expect(refusedNames(refused)).toBe("role_title:link");
    expect(
      refusedNames(refusedDraftFields({ ...refusedDraft, description: "Acme Pvt Ltd 9876543210" })),
    ).toBe("role_title:link,description:contact_details+company_name");
  });

  it("blankRefusedFields drops only the refused chips, and lists an emptied list as missing in bank order", () => {
    const refusedDraft = {
      ...CLEAN_DRAFT,
      benefits: [TRIPS.benefits.contact_details, "PF", TRIPS.benefits.link],
      requirements: [TRIPS.requirements.company_name],
      missing_fields: ["needed_by", "description"],
    };
    const refused = refusedDraftFields(refusedDraft);
    expect(refusedNames(refused)).toBe("benefits:contact_details+link,requirements:company_name");
    expect(blankRefusedFields(refusedDraft, refused)).toEqual({
      ...refusedDraft,
      benefits: ["PF"],
      requirements: [],
      missing_fields: ["needed_by", "requirements", "description"],
    });
  });

  it("names every screen's reason class, and never echoes any refused value", () => {
    const r = reaskRefusedFields({
      draft: { ...CLEAN_DRAFT, role_title: "Acme Pvt Ltd 9876543210 acme.in" },
      state: state({}),
      priorState: null,
      priorDraft: null,
      engineAskedId: null,
    });
    expect(r?.replyText).toContain("contact details, a company name or website links");

    for (const field of SCREENED_DRAFT_FIELDS) {
      for (const value of Object.values(TRIPS[field])) {
        const draft = withValue(field, value);
        const turn = reaskRefusedFields({
          draft,
          state: state({ collected: { [field]: draft[field] } }),
          priorState: null,
          priorDraft: null,
          engineAskedId: null,
        });
        expect(turn?.replyText, value).toBeTruthy();
        for (const refused of ALL_REFUSED) {
          expect(turn?.replyText, value).not.toContain(refused);
          expect(JSON.stringify(turn?.draft), value).not.toContain(refused);
          expect(JSON.stringify(turn?.state), value).not.toContain(refused);
        }
      }
    }
  });
});

/**
 * #1921 — THE CHIP LISTS. The engine asks `benefits` and `requirements` once and UNIONS every
 * answer into the list in `collected`. So a refused chip leaves the stored list as well as the
 * draft (or the next rebuild brings it back), the clean chips stay in both, and the topic goes
 * back on screen so the payer can restate what was dropped.
 */
describe("reaskRefusedFields — a refused chip is dropped from its list, and the list asked again", () => {
  // The real interview up to the benefits question (see the header): every topic before it
  // answered, the benefits question on screen.
  const ASKED_TO_BENEFITS = ASKED_TO_REQUIREMENTS.slice(0, -1);
  const ANSWERED_TO_NEEDED_BY = [
    "role_title",
    "location_label",
    "city",
    "vacancy",
    "skills",
    "pay_range",
    "pay_type",
    "experience",
    "shift",
    "needed_by",
  ];
  const prior = state({
    turn_count: 9,
    answered_topics: ANSWERED_TO_NEEDED_BY,
    asked_question_ids: ASKED_TO_BENEFITS,
    ask_counts: ONE_EACH(ASKED_TO_BENEFITS),
    collected: { role_title: "CNC Operator" },
  });
  const priorDraft = draft({
    ...CLEAN_DRAFT,
    benefits: [],
    requirements: [],
    description: null,
    missing_fields: ["benefits", "requirements", "description"],
  });

  /** next_turn(prior, <the chips, comma-joined>): recorded, and the requirements question served. */
  const benefitsTurn = (chips: string[]) => ({
    state: state({
      ...prior,
      turn_count: 10,
      answered_topics: [...ANSWERED_TO_NEEDED_BY, "benefits"],
      asked_question_ids: [...ASKED_TO_BENEFITS, "requirements"],
      ask_counts: ONE_EACH([...ASKED_TO_BENEFITS, "requirements"]),
      collected: { ...prior.collected, benefits: chips },
    }),
    draft: draft({
      ...priorDraft,
      benefits: chips,
      missing_fields: ["requirements", "description"],
    }),
  });

  describe("clean chips and a refused one in the same answer", () => {
    // "PF, ESI, details www.acme.in" — the #1921 report's shape.
    const engine = benefitsTurn(["PF", "ESI", TRIPS.benefits.link]);
    const r = reaskRefusedFields({
      draft: engine.draft,
      state: engine.state,
      priorState: prior,
      priorDraft,
      engineAskedId: "requirements",
    });

    it("drops only the refused chip, from the draft AND the stored list the engine unions into", () => {
      expect(r?.refused).toEqual([{ field: "benefits", screens: ["link"] }]);
      expect(r?.draft.benefits).toEqual(["PF", "ESI"]);
      // Chips are left, so the list is not missing.
      expect(r?.draft.missing_fields).toEqual(["requirements", "description"]);
      expect(r?.state.collected.benefits).toEqual(["PF", "ESI"]);
      expect(JSON.stringify(r)).not.toContain("acme");
    });

    it("asks the list again, says the rest is kept, and names the word that keeps it", () => {
      expect(r?.askedField).toBe("benefits");
      expect(r?.kept).toEqual(["benefits"]);
      expect(r?.replyText).toBe(
        "Workers see the benefits, so they can't include website links. " +
          "The rest of the benefits are still in the draft. " +
          'Which other benefits are included? Reply "no" if there are none.',
      );
    });

    it("offers the bank options a tap would still add, then the keep word as a tap", () => {
      // "PF + ESI" is recorded as "PF" and "ESI", both kept, so tapping it would add nothing.
      expect(r?.chips).toEqual(["Canteen", "Transport", "Accommodation", "No"]);
      // The tap is the word the hint names: the engine records nothing for it.
      const hinted = /Reply "(\w+)"/.exec(r?.replyText ?? "")?.[1];
      expect(r?.chips.at(-1)?.toLowerCase()).toBe(hinted);
    });

    it("keeps the list answered, un-serves the requirements question, and puts benefits back last", () => {
      expect(r?.state).toEqual({
        ...engine.state,
        collected: { ...prior.collected, benefits: ["PF", "ESI"] },
        // The requirements question was never shown: un-served, so it is asked next.
        asked_question_ids: ASKED_TO_BENEFITS,
        ask_counts: ONE_EACH(ASKED_TO_BENEFITS),
      });
      expect(r?.state.answered_topics).toContain("benefits");
    });

    it("does not mutate the engine's objects", () => {
      expect(engine.state.collected.benefits).toEqual(["PF", "ESI", TRIPS.benefits.link]);
      expect(engine.draft.benefits).toEqual(["PF", "ESI", TRIPS.benefits.link]);
      expect(engine.state.asked_question_ids.at(-1)).toBe("requirements");
    });

    it("a dropped chip is not resurrected: a later answer that adds one drops only the new refused chip", () => {
      // The payer answers the re-ask; the engine unions into the CLEAN stored list.
      const next = reaskRefusedFields({
        draft: draft({ ...r!.draft, benefits: ["PF", "ESI", TRIPS.benefits.company_name] }),
        state: state({
          ...r!.state,
          turn_count: 11,
          asked_question_ids: [...ASKED_TO_BENEFITS, "requirements"],
          ask_counts: ONE_EACH([...ASKED_TO_BENEFITS, "requirements"]),
          collected: {
            ...r!.state.collected,
            benefits: ["PF", "ESI", TRIPS.benefits.company_name],
          },
        }),
        priorState: r!.state,
        priorDraft: r!.draft,
        engineAskedId: "requirements",
      });
      expect(next?.refused).toEqual([{ field: "benefits", screens: ["company_name"] }]);
      expect(next?.state.collected.benefits).toEqual(["PF", "ESI"]);
      expect(JSON.stringify(next)).not.toContain("acme");
      expect(JSON.stringify(next)).not.toContain("Kalyani");

      // And a clean answer to it ("Free bus") is a clean turn: the engine's own.
      expect(
        reaskRefusedFields({
          draft: draft({ ...r!.draft, benefits: ["PF", "ESI", "Free bus"] }),
          state: state({ ...r!.state, collected: { benefits: ["PF", "ESI", "Free bus"] } }),
          priorState: r!.state,
          priorDraft: r!.draft,
          engineAskedId: "requirements",
        }),
      ).toBeNull();
    });
  });

  for (const field of SCREENED_LIST_FIELDS) {
    for (const [screen, value] of Object.entries(TRIPS[field])) {
      it(`${field}: a chip that trips ${screen} is dropped, the clean ones kept, never echoed`, () => {
        const chips = ["ITI", value, "Free bus"];
        const r = reaskRefusedFields({
          draft: draft({ ...CLEAN_DRAFT, [field]: chips }),
          state: state({ answered_topics: [field], collected: { [field]: chips } }),
          priorState: null,
          priorDraft: null,
          engineAskedId: null,
        });
        expect(r?.refused).toEqual([{ field, screens: [screen] }]);
        expect(r?.draft[field]).toEqual(["ITI", "Free bus"]);
        expect(r?.state.collected[field]).toEqual(["ITI", "Free bus"]);
        expect(r?.state.answered_topics).toEqual([field]);
        expect(r?.askedField).toBe(field);
        expect(r?.replyText).toContain(`Workers see the ${field}, so they can't include`);
        // Clean chips are left, so the list is asked for more, with the keep word as a tap.
        expect(r?.chips).toEqual(field === "benefits" ? [...BENEFIT_CHIPS, "No"] : ["No"]);
        expect(JSON.stringify(r)).not.toContain(value);
      });
    }
  }

  describe("the add-question's chips leave out an option the kept list already holds", () => {
    const chipsFor = (kept: string[]) =>
      reaskRefusedFields({
        draft: draft({ ...CLEAN_DRAFT, benefits: [...kept, TRIPS.benefits.link] }),
        state: state({
          answered_topics: ["benefits"],
          collected: { benefits: [...kept, TRIPS.benefits.link] },
        }),
        priorState: null,
        priorDraft: null,
        engineAskedId: null,
      })?.chips;

    it("matches as the engine dedupes: trimmed and case-insensitive", () => {
      expect(chipsFor(["pf", " ESI ", "CANTEEN"])).toEqual(["Transport", "Accommodation", "No"]);
    });

    it("keeps an option a tap would still add to, and a near-miss of an option", () => {
      // Tapping "PF + ESI" would still add ESI; "Canteen facility" is not "Canteen".
      expect(chipsFor(["PF", "Canteen facility"])).toEqual([...BENEFIT_CHIPS, "No"]);
    });

    it("is only the keep word once every option is held", () => {
      expect(chipsFor(["PF", "ESI", "Canteen", "Transport", "Accommodation"])).toEqual(["No"]);
    });
  });

  describe("every chip refused: the list is emptied and asked from the top", () => {
    const engine = benefitsTurn([TRIPS.benefits.link, TRIPS.benefits.contact_details]);
    const r = reaskRefusedFields({
      draft: engine.draft,
      state: engine.state,
      priorState: prior,
      priorDraft,
      engineAskedId: "requirements",
    });

    it("asks the bank's own benefits question, with its chips, and no keep hint or tap", () => {
      expect(r?.kept).toEqual([]);
      expect(r?.askedField).toBe("benefits");
      expect(r?.replyText).toBe(
        "Workers see the benefits, so they can't include contact details or website links. " +
          "Which benefits are included — PF, ESI, canteen, transport or accommodation?",
      );
      expect(r?.chips).toEqual(BENEFIT_CHIPS);
    });

    it("empties the list in the draft and lists it as missing again, in bank order", () => {
      expect(r?.draft.benefits).toEqual([]);
      expect(r?.draft.missing_fields).toEqual(["benefits", "requirements", "description"]);
    });

    it("reopens the topic: unanswered, nothing stored, on screen with its ask count", () => {
      expect(r?.state).toEqual({
        ...engine.state,
        answered_topics: ANSWERED_TO_NEEDED_BY,
        collected: prior.collected,
        asked_question_ids: ASKED_TO_BENEFITS,
        ask_counts: ONE_EACH(ASKED_TO_BENEFITS),
      });
      expect(JSON.stringify(r)).not.toContain("acme");
      expect(JSON.stringify(r)).not.toContain("9876543210");
    });
  });

  describe("both lists refused at once", () => {
    // A session stored before #1921 kept a refused benefits chip; this turn the payer answers
    // the requirements question with a refused chip only. The engine serves the description.
    const legacyBenefits = ["PF", "ESI", TRIPS.benefits.link];
    const before = state({
      ...prior,
      turn_count: 10,
      answered_topics: [...ANSWERED_TO_NEEDED_BY, "benefits"],
      asked_question_ids: ASKED_TO_REQUIREMENTS,
      ask_counts: ONE_EACH(ASKED_TO_REQUIREMENTS),
      collected: { ...prior.collected, benefits: legacyBenefits },
    });
    const beforeDraft = draft({
      ...priorDraft,
      benefits: legacyBenefits,
      missing_fields: ["requirements", "description"],
    });
    const turn = (requirements: string[]) =>
      reaskRefusedFields({
        draft: draft({ ...beforeDraft, requirements, missing_fields: ["description"] }),
        state: state({
          ...before,
          turn_count: 11,
          answered_topics: [...before.answered_topics, "requirements"],
          asked_question_ids: [...ASKED_TO_REQUIREMENTS, "description"],
          ask_counts: ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]),
          collected: { ...before.collected, requirements },
        }),
        priorState: before,
        priorDraft: beforeDraft,
        engineAskedId: "description",
      });

    it("the EMPTIED list goes on screen; the other keeps its clean chips and stays answered", () => {
      const r = turn([TRIPS.requirements.contact_details]);
      expect(r?.refused.map((x) => x.field)).toEqual(["benefits", "requirements"]);
      expect(r?.kept).toEqual(["benefits"]);
      expect(r?.askedField).toBe("requirements");
      expect(r?.replyText).toBe(
        "Workers see the benefits and requirements, so they can't include contact details or " +
          "website links. The rest of the benefits are still in the draft. " +
          "What must candidates have — a qualification, certificate or licence?",
      );
      expect(r?.chips).toEqual([]);
      expect(r?.draft).toMatchObject({ benefits: ["PF", "ESI"], requirements: [] });
      expect(r?.draft.missing_fields).toEqual(["requirements", "description"]);
      expect(r?.state.collected).toEqual({ ...prior.collected, benefits: ["PF", "ESI"] });
      expect(r?.state.answered_topics).toContain("benefits");
      expect(r?.state.answered_topics).not.toContain("requirements");
      // The description question was un-served; requirements is on screen.
      expect(r?.state.asked_question_ids).toEqual(ASKED_TO_REQUIREMENTS);
      expect(r?.state.ask_counts).toEqual(ONE_EACH(ASKED_TO_REQUIREMENTS));
    });

    it("when both keep chips, bank order puts benefits on screen and requirements stays answered", () => {
      const r = turn(["ITI", TRIPS.requirements.link]);
      expect(r?.kept).toEqual(["benefits", "requirements"]);
      expect(r?.askedField).toBe("benefits");
      expect(r?.replyText).toBe(
        "Workers see the benefits and requirements, so they can't include website links. " +
          "The rest of the benefits and requirements are still in the draft. " +
          'Which other benefits are included? Reply "no" if there are none.',
      );
      expect(r?.state.collected).toMatchObject({ benefits: ["PF", "ESI"], requirements: ["ITI"] });
      expect(r?.state.asked_question_ids).toEqual([
        ...ASKED_TO_REQUIREMENTS.filter((id) => id !== "benefits"),
        "benefits",
      ]);
      expect(JSON.stringify(r)).not.toContain("acme");
    });
  });

  describe("a refused title in the same turn", () => {
    // A session stored before #1911 kept a refused title; this turn the payer answers the
    // benefits question with a refused chip among clean ones.
    const titledPrior = state({
      ...prior,
      collected: { role_title: TRIPS.role_title.company_name },
    });
    const titledPriorDraft = draft({ ...priorDraft, role_title: TRIPS.role_title.company_name });
    const engine = benefitsTurn(["PF", "ESI", TRIPS.benefits.link]);
    const r = reaskRefusedFields({
      draft: draft({ ...engine.draft, role_title: TRIPS.role_title.company_name }),
      state: state({
        ...engine.state,
        collected: { ...titledPrior.collected, benefits: ["PF", "ESI", TRIPS.benefits.link] },
      }),
      priorState: titledPrior,
      priorDraft: titledPriorDraft,
      engineAskedId: "requirements",
    });

    it("the emptied title goes on screen; the benefits keep their clean chips and stay answered", () => {
      expect(r?.askedField).toBe("role_title");
      expect(r?.kept).toEqual(["benefits"]);
      expect(r?.replyText).toBe(
        "Workers see the job title and benefits, so they can't include a company name or " +
          "website links. The rest of the benefits are still in the draft. " +
          "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
      );
      expect(r?.chips).toEqual([]);
      expect(r?.draft).toMatchObject({ role_title: null, benefits: ["PF", "ESI"] });
      expect(r?.draft.missing_fields).toEqual(["role_title", "requirements", "description"]);
      expect(r?.state.collected).toEqual({ benefits: ["PF", "ESI"] });
      expect(r?.state.answered_topics).toEqual([
        ...ANSWERED_TO_NEEDED_BY.filter((t) => t !== "role_title"),
        "benefits",
      ]);
      expect(r?.state.asked_question_ids).toEqual([...ASKED_TO_BENEFITS, "role_title"]);
      expect(r?.state.ask_counts).toEqual(ONE_EACH(ASKED_TO_BENEFITS));
      expect(r?.state.unanswered_essentials).toEqual(["role_title"]);
      expect(JSON.stringify(r)).not.toContain("Kalyani");
      expect(JSON.stringify(r)).not.toContain("acme");
    });

    it("an emptied list NOT on screen is owed again as never asked", () => {
      // Every chip refused, alongside the refused title: the title is asked first.
      const both = reaskRefusedFields({
        draft: draft({
          ...engine.draft,
          role_title: TRIPS.role_title.company_name,
          benefits: [TRIPS.benefits.link],
        }),
        state: state({
          ...engine.state,
          collected: { ...titledPrior.collected, benefits: [TRIPS.benefits.link] },
        }),
        priorState: titledPrior,
        priorDraft: titledPriorDraft,
        engineAskedId: "requirements",
      });
      expect(both?.askedField).toBe("role_title");
      expect(both?.kept).toEqual([]);
      expect(both?.state.collected).toEqual({});
      expect(both?.state.answered_topics).not.toContain("benefits");
      expect(both?.state.asked_question_ids).toEqual([
        ...ASKED_TO_BENEFITS.filter((id) => id !== "benefits"),
        "role_title",
      ]);
      expect("benefits" in (both?.state.ask_counts ?? {})).toBe(false);
      expect(both?.draft.missing_fields).toEqual([
        "role_title",
        "benefits",
        "requirements",
        "description",
      ]);
    });
  });

  describe("a refused description in the same turn (the wrap-up)", () => {
    // A session stored before #1921 kept only refused benefits chips; after the wrap-up the
    // payer adds a line with a link to the description they already gave.
    const EARLIER = CLEAN_DRAFT.description!;
    const wrapped = state({
      turn_count: 12,
      answered_topics: ["role_title", ...ASKED_TO_REQUIREMENTS, "city", "description"],
      asked_question_ids: [...ASKED_TO_REQUIREMENTS, "description"],
      ask_counts: ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]),
      collected: {
        role_title: "CNC Operator",
        benefits: [TRIPS.benefits.contact_details],
        description: EARLIER,
      },
    });
    const wrappedDraft = draft({ ...CLEAN_DRAFT, benefits: [TRIPS.benefits.contact_details] });
    const r = reaskRefusedFields({
      draft: draft({ ...wrappedDraft, description: TRIPS.description.link }),
      state: state({
        ...wrapped,
        turn_count: 13,
        collected: { ...wrapped.collected, description: TRIPS.description.link },
      }),
      priorState: wrapped,
      priorDraft: wrappedDraft,
      engineAskedId: null,
    });

    it("the emptied list goes on screen and the description keeps its earlier text", () => {
      expect(r?.askedField).toBe("benefits");
      expect(r?.kept).toEqual(["description"]);
      expect(r?.replyText).toBe(
        "Workers see the benefits and job description, so they can't include contact details " +
          "or website links. Your earlier job description is still in the draft. " +
          "Which benefits are included — PF, ESI, canteen, transport or accommodation?",
      );
      expect(r?.chips).toEqual(BENEFIT_CHIPS);
      expect(r?.draft).toMatchObject({ benefits: [], description: EARLIER });
      expect(r?.draft.missing_fields).toEqual(["benefits"]);
      expect(r?.state.collected).toEqual({ role_title: "CNC Operator", description: EARLIER });
      expect(r?.state.answered_topics).not.toContain("benefits");
      expect(r?.state.answered_topics).toContain("description");
      expect(r?.state.asked_question_ids).toEqual([
        ...ASKED_TO_REQUIREMENTS.filter((id) => id !== "benefits"),
        "description",
        "benefits",
      ]);
      expect(r?.state.ask_counts).toEqual(ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]));
      expect(JSON.stringify(r)).not.toContain("acme");
      expect(JSON.stringify(r)).not.toContain("9876543210");
    });
  });
});

describe("restoreWrapUpTarget — after the wrap-up the description takes the next message", () => {
  // The engine's wrap-up after a benefits re-ask at the wrap-up was answered with "Canteen"
  // (apps/ai-service/tests/test_job_posting_chat_reask_contract.py drives the real engine).
  const asked = ASKED_TO_REQUIREMENTS.filter((id) => id !== "benefits");
  const wrapped = state({
    turn_count: 14,
    answered_topics: ["role_title", ...ASKED_TO_REQUIREMENTS, "city", "description"],
    asked_question_ids: [...asked, "description", "benefits"],
    ask_counts: ONE_EACH([...ASKED_TO_REQUIREMENTS, "description"]),
    collected: {
      role_title: "CNC Operator",
      benefits: ["Canteen"],
      description: CLEAN_DRAFT.description,
    },
  });

  it("puts the description back last on a wrap-up whose last asked topic is a list", () => {
    const r = restoreWrapUpTarget(wrapped, null);
    expect(r.asked_question_ids).toEqual([...asked, "benefits", "description"]);
    // Only the order moves: the same ids, so what is owed and readiness are unchanged.
    expect(r).toEqual({ ...wrapped, asked_question_ids: r.asked_question_ids });
    expect([...r.asked_question_ids].sort()).toEqual([...wrapped.asked_question_ids].sort());
    // A new object; the engine's is untouched.
    expect(wrapped.asked_question_ids.at(-1)).toBe("benefits");
  });

  it("does the same for requirements", () => {
    const listLast = state({
      ...wrapped,
      asked_question_ids: [
        ...ASKED_TO_REQUIREMENTS.filter((id) => id !== "requirements"),
        "description",
        "requirements",
      ],
    });
    expect(restoreWrapUpTarget(listLast, null).asked_question_ids.at(-1)).toBe("description");
  });

  it("leaves the state as it is when a question is on screen", () => {
    // The re-ask turn itself: the list must stay last so the payer's answer reaches it.
    expect(restoreWrapUpTarget(wrapped, "benefits")).toBe(wrapped);
    expect(restoreWrapUpTarget(wrapped, "requirements")).toBe(wrapped);
  });

  it("leaves the state as it is when the last asked topic is not a list", () => {
    const descriptionLast = state({
      ...wrapped,
      asked_question_ids: [...ASKED_TO_REQUIREMENTS, "description"],
    });
    expect(restoreWrapUpTarget(descriptionLast, null)).toBe(descriptionLast);
    const titleLast = state({ ...wrapped, asked_question_ids: [...asked, "role_title"] });
    expect(restoreWrapUpTarget(titleLast, null)).toBe(titleLast);
    const empty = state({});
    expect(restoreWrapUpTarget(empty, null)).toBe(empty);
  });

  it("leaves the state as it is when the description was never asked (the ask ceiling)", () => {
    const ceiling = state({ ...wrapped, asked_question_ids: ASKED_TO_REQUIREMENTS });
    expect(restoreWrapUpTarget(ceiling, null)).toBe(ceiling);
  });
});
