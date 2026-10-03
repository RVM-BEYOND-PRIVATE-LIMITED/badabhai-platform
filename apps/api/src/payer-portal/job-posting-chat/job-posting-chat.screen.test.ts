import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  JobPostingChatStateSchema,
  JobPostingDraftSchema,
  type JobPostingChatState,
  type JobPostingDraft,
} from "@badabhai/ai-contracts";
import { workerVisibleTextScreens } from "@badabhai/validators";
import {
  FIELD_POLICY,
  SCREENED_DRAFT_FIELDS,
  blankRefusedFields,
  reaskRefusedFields,
  refusedDraftFields,
  refusedNames,
} from "./job-posting-chat.screen";

/**
 * #1911 — the interview-time half of the worker-visible text screen.
 *
 * The engine states below are REAL `interview_engine.next_turn` outputs (captured from the
 * ai-service and trimmed to their keys), not hand-invented shapes. The surgered states were
 * also fed back into the real engine while this was written: a clean answer is attributed to
 * the re-asked topic, and the question the engine had picked is served on the next turn.
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

/** One value per (field, screen). Each must trip EXACTLY its screen. */
const TRIPS = {
  role_title: {
    contact_details: "CNC Operator call 9876543210",
    company_name: "Operator at Kalyani Pvt Ltd",
    link: "CNC Operator www.acme.in",
  },
  description: {
    contact_details: "Machining work. Send CV to hr@acme.example",
    company_name: "Machining for Mehta & Co on the shop floor",
    link: "Machining work, details at www.acme.in",
  },
} as const;

/** Every refused value used anywhere in this file — none may appear in a reply. */
const ALL_REFUSED = Object.values(TRIPS).flatMap((byScreen) => Object.values(byScreen));

describe("refusedDraftFields — the shared screen, on the two worker-read free-text fields", () => {
  it("screens exactly role_title and description", () => {
    expect([...SCREENED_DRAFT_FIELDS]).toEqual(["role_title", "description"]);
  });

  for (const field of SCREENED_DRAFT_FIELDS) {
    for (const [screen, value] of Object.entries(TRIPS[field])) {
      it(`${field}: ${screen} is refused, by name`, () => {
        // Fixture sanity: the value trips this screen and only it.
        expect(workerVisibleTextScreens(value)).toEqual([screen]);
        expect(refusedDraftFields({ ...CLEAN_DRAFT, [field]: value })).toEqual([
          { field, screens: [screen] },
        ]);
      });
    }
  }

  it("is the shared helper's verdict, not a copy — every screen a value trips, in its order", () => {
    const value = "Acme Pvt Ltd 9876543210 acme.in";
    expect(refusedDraftFields({ ...CLEAN_DRAFT, role_title: value })).toEqual([
      { field: "role_title", screens: workerVisibleTextScreens(value) },
    ]);
    expect(workerVisibleTextScreens(value)).toEqual(["contact_details", "company_name", "link"]);
  });

  it("passes clean trade text and skips an unanswered (null) field", () => {
    expect(refusedDraftFields(CLEAN_DRAFT)).toEqual([]);
    for (const title of ["MIG Welder — Night Shift", "VMC Setter cum Operator", "Fitter (ITI)"]) {
      expect(refusedDraftFields({ ...CLEAN_DRAFT, role_title: title }), title).toEqual([]);
    }
    expect(refusedDraftFields({ ...CLEAN_DRAFT, role_title: null, description: null })).toEqual([]);
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

  /** One entry per `Topic(...)` call in the bank list, in bank order. */
  const topics = bank
    .split("\n    Topic(\n")
    .slice(1)
    .map((chunk) => chunk.split("\n    ),\n")[0] ?? "")
    .map((call) => ({
      id: /"(\w+)"/.exec(call)?.[1],
      retry: /retry_question="([^"]+)"/.exec(call)?.[1] ?? null,
    }));
  const ids = topics.map((t) => t.id);
  const essentialsTuple =
    /^ESSENTIAL_TOPICS: tuple\[str, \.\.\.\] = \(([^)]*)\)/m.exec(engine)?.[1] ?? "";
  const essentials = [...essentialsTuple.matchAll(/"(\w+)"/g)].map((m) => m[1]);

  it("found the real bank and the real essentials, not an empty parse", () => {
    expect(ids).toHaveLength(13);
    expect(essentials).toEqual(["role_title", "location_label", "city", "vacancy"]);
  });

  it("each screened field is a bank topic, in bank order", () => {
    expect(
      ids.filter((id) => (SCREENED_DRAFT_FIELDS as readonly string[]).includes(id ?? "")),
    ).toEqual([...SCREENED_DRAFT_FIELDS]);
  });

  for (const field of SCREENED_DRAFT_FIELDS) {
    it(`${field}: essential and bank edge match the engine`, () => {
      const policy = FIELD_POLICY[field];
      expect(policy.essential).toBe(essentials.includes(field));
      expect(policy.bankEdge === "first" ? ids[0] : ids.at(-1)).toBe(field);
    });
  }

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
        const reply = reaskRefusedFields({
          draft: { ...CLEAN_DRAFT, [field]: value },
          state: state({ collected: { [field]: value } }),
          priorState: null,
          priorDraft: null,
          engineAskedId: null,
        })?.replyText;
        expect(reply, value).toBeTruthy();
        for (const refused of ALL_REFUSED) expect(reply, value).not.toContain(refused);
      }
    }
  });
});
