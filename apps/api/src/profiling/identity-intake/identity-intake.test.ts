import { describe, expect, it } from "vitest";
import { checkPersonaTokens, personaCorpus } from "@badabhai/profiling-lexicon";
import { IDENTITY_INTAKE_STEPS } from "@badabhai/event-schema";

import { emptyProfilingEnvelope, narrowProfilingEnvelope } from "../conversation-state";
import { DE_ESCALATION_REPLY_TEXT } from "../next-question";
import {
  advanceIntake,
  composeFullName,
  IDENTITY_INTAKE_REPLIES,
  identityGapsOf,
  INTAKE_COPY,
  INTAKE_HANDOFF_TEXT,
  INTAKE_QUESTION_KEYS,
  intakeLineText,
  MAX_INTAKE_ASKS_PER_STEP,
  nameWords,
  openIntake,
  planIntake,
  readIntakeAnswer,
  reservedIntakeLine,
  type IdentityIntakeState,
  type IntakeReading,
} from "./identity-intake";

/**
 * ═══ THE IDENTITY INTAKE'S DECISIONS, AS A PURE MACHINE (ADR-0048) ═══
 *
 * The orchestrator suite beside this one proves the wiring — the writes, the CAS, the handoff,
 * what reaches the model. This one pins the rulings themselves, one row each, against the module
 * that encodes them: what is asked (D9), how an answer is read (D3, D5), when a step gives up
 * (D1), and what is held versus written (D2).
 */

const ALL_GAPS = { hasName: false, hasState: false, hasCity: false };
const answer = (value: string, fullName = false): IntakeReading => ({
  kind: "answer",
  value,
  fullName,
});
const declined: IntakeReading = { kind: "non_answer", why: "declined" };

function pendingAt(step: IdentityIntakeState["step"], over: Partial<IdentityIntakeState> = {}) {
  const steps = planIntake(ALL_GAPS);
  const index = steps.indexOf(step as (typeof steps)[number]);
  return {
    state: "pending",
    step,
    remaining: steps.slice(index + 1),
    asks: { [step as string]: 1 },
    firstNameEnc: null,
    heldState: null,
    ...over,
  } as IdentityIntakeState;
}

describe("what is asked (D9) — only the gaps, in the fixed order", () => {
  it("asks all four, name first and state before city, for a worker with nothing on record", () => {
    expect(planIntake(ALL_GAPS)).toEqual(["first_name", "last_name", "state", "city"]);
  });

  it("asks NOTHING of a worker whose record is complete — he is never asked again", () => {
    expect(planIntake({ hasName: true, hasState: true, hasCity: true })).toEqual([]);
    expect(openIntake([])).toBeNull();
  });

  it("asks only what is missing: a named worker with no city is asked the city alone", () => {
    expect(planIntake({ hasName: true, hasState: true, hasCity: false })).toEqual(["city"]);
    expect(planIntake({ hasName: false, hasState: true, hasCity: true })).toEqual([
      "first_name",
      "last_name",
    ]);
  });

  it("reads the row as PRESENCE — a blank column is a gap, a value is not", () => {
    expect(identityGapsOf({ fullName: "v1:token", currentState: "  ", currentCity: null })).toEqual(
      { hasName: true, hasState: false, hasCity: false },
    );
  });

  it("opens on the first planned step, counted as asked once, holding nothing", () => {
    expect(openIntake(["state", "city"])).toEqual({
      state: "pending",
      step: "state",
      remaining: ["city"],
      asks: { state: 1 },
      firstNameEnc: null,
      heldState: null,
    });
  });
});

describe("reading a name (D3) — the closed cue list, then the /name validators", () => {
  it.each([
    ["Ramesh", "Ramesh", false],
    ["mera naam Ramesh hai", "Ramesh", false],
    ["Mera Naam RAMESH hai", "RAMESH", false],
    ["my name is ramesh", "Ramesh", false],
    ["I am Ramesh ji", "Ramesh", false],
    ["main Ramesh", "Ramesh", false],
    ["Ramesh.", "Ramesh", false],
    ["ramesh kumar", "Ramesh Kumar", true],
    ["mera naam Ramesh Kumar hai", "Ramesh Kumar", true],
    ["Ram-Prasad D'Souza", "Ram-Prasad D'Souza", true],
    // The sentence a name is most often said inside, Hinglish and Devanagari.
    ["main Ramesh hoon", "Ramesh", false],
    ["Mai Ramesh Kumar hun", "Ramesh Kumar", true],
    ["Ramesh hu", "Ramesh", false],
    ["I'm Ramesh", "Ramesh", false],
    ["I’m Ramesh", "Ramesh", false],
    ["my name Ramesh", "Ramesh", false],
    ["मेरा नाम रमेश है", "रमेश", false],
    ["मैं रमेश हूँ", "रमेश", false],
  ])("reads %j as %j (full name: %s)", (text, value, fullName) => {
    expect(readIntakeAnswer("first_name", text)).toEqual({ kind: "answer", value, fullName });
  });

  it("strips the surname sentence too", () => {
    expect(readIntakeAnswer("last_name", "mera surname Kumar hai")).toEqual(answer("Kumar"));
    expect(readIntakeAnswer("last_name", "my surname is Kumar")).toEqual(answer("Kumar"));
  });

  it("KNOWN LIMIT — a trade said in the name sentence survives the strip (surnames are trade words)", () => {
    expect(readIntakeAnswer("first_name", "Mai welder hu")).toEqual({
      kind: "answer",
      value: "Welder",
      fullName: false,
    });
  });

  it("strips cue words WHOLE-WORD only — a name that merely contains one is left alone", () => {
    // "Mainak" contains "main", "Jitendra" contains "ji", "Shaira" contains "hai", "Hunar" holds
    // "hun", "Humera" holds "hu", "Maithili" holds "mai", "Imran" holds "im".
    expect(nameWords("Mainak Jitendra Shaira")).toEqual(["Mainak", "Jitendra", "Shaira"]);
    expect(nameWords("Hunar Humera Maithili Imran")).toEqual([
      "Hunar",
      "Humera",
      "Maithili",
      "Imran",
    ]);
  });

  it("title-cases like the /name screen did — raising a first letter, never lowering one", () => {
    expect(readIntakeAnswer("last_name", "sharma")).toEqual(answer("Sharma"));
    expect(readIntakeAnswer("last_name", "McDONALD")).toEqual(answer("McDONALD"));
  });

  it("never marks a SURNAME as a full name, however many words it has", () => {
    expect(readIntakeAnswer("last_name", "Singh Rathore")).toEqual(answer("Singh Rathore"));
  });

  it.each([
    ["only cue words", "mera naam hai", "unreadable"],
    ["digits only", "98765", "unreadable"],
    ["punctuation", "...", "empty"],
    ["a single character", "k", "empty"],
    ["a decline", "pata nahi", "declined"],
  ])("refuses %s", (_label, text, why) => {
    expect(readIntakeAnswer("first_name", text)).toEqual({ kind: "non_answer", why });
  });

  it("refuses a name longer than the /name bound (80) rather than truncating it", () => {
    expect(readIntakeAnswer("first_name", "A".repeat(81))).toEqual({
      kind: "non_answer",
      why: "unreadable",
    });
  });

  it.each([
    // Every one ENDS in a vowel sign (a combining mark, not a letter) — the character an
    // edge-punctuation trim that keeps only letters and digits would silently cut off.
    ["first_name", "सीता", "सीता", false],
    ["last_name", "शर्मा", "शर्मा", false],
    ["last_name", "वर्मा", "वर्मा", false],
    ["first_name", "गीता कुमारी", "गीता कुमारी", true],
    ["first_name", "सीता।", "सीता", false],
  ] as const)("keeps a Devanagari %s %j whole: %j", (step, text, value, fullName) => {
    expect(readIntakeAnswer(step, text)).toEqual({ kind: "answer", value, fullName });
  });
});

describe("a reply that is not a name or a place (D1) — re-asked, never written", () => {
  it.each([
    // Refusals, and the "no surname" a worker without one gives.
    ["first_name", "nahi", "declined"],
    ["first_name", "no", "declined"],
    ["first_name", "skip", "declined"],
    ["first_name", "nahi batana", "declined"],
    ["first_name", "baad mein", "declined"],
    ["first_name", "I dont want to tell", "declined"],
    ["first_name", "नहीं", "declined"],
    ["last_name", "surname nahi hai", "declined"],
    ["last_name", "koi nahi", "declined"],
    ["last_name", "no surname", "declined"],
    ["state", "nahi", "declined"],
    ["city", "nahi batana", "declined"],
    // A question back in words the job-prospect detector does not know gets the why.
    ["first_name", "naam kyu chahiye?", "question_back"],
    ["first_name", "kyun chahiye", "question_back"],
    ["first_name", "why", "question_back"],
    ["city", "kyu chahiye?", "question_back"],
    // Acknowledgements, greetings, and a stray sentence word the cue list does not strip.
    ["first_name", "haan", "unreadable"],
    ["first_name", "haan ji", "unreadable"],
    ["first_name", "ok", "unreadable"],
    ["first_name", "hi", "unreadable"],
    ["first_name", "mera Ramesh", "unreadable"],
    ["state", "haan", "unreadable"],
  ] as const)("%s %j is a non-answer (%s)", (step, text, why) => {
    expect(readIntakeAnswer(step, text)).toEqual({ kind: "non_answer", why });
  });

  it("matches WHOLE words only — a name or place merely containing one is an answer", () => {
    // "Noronha" holds "no", "Hina" holds "hi", "Okhla" holds "ok", "Nainital" holds "nai".
    expect(readIntakeAnswer("first_name", "Hina Noronha")).toEqual(answer("Hina Noronha", true));
    expect(readIntakeAnswer("city", "Okhla")).toEqual(answer("Okhla"));
    expect(readIntakeAnswer("city", "Nai Dilli")).toEqual(answer("Nai Dilli"));
  });

  it("settles a step as SKIPPED after two of them, exactly as two 'pata nahi' do", () => {
    const first = advanceIntake(
      pendingAt("first_name"),
      readIntakeAnswer("first_name", "nahi batana"),
    );
    expect(first.reply).toEqual({ kind: "ask", step: "first_name", line: "retry" });
    const second = advanceIntake(first.next, readIntakeAnswer("first_name", "skip"));
    expect(second.settled).toEqual([{ step: "first_name", outcome: "skipped", recognized: null }]);
    expect(second.name).toBeNull();
    expect(second.holdFirstName).toBeNull();
  });
});

describe("reading a place (D5) — verbatim, bounded by the /name validators", () => {
  it("keeps an unrecognised place EXACTLY as typed, trimmed", () => {
    expect(readIntakeAnswer("city", "  Sitamarhi ")).toEqual(answer("Sitamarhi"));
    expect(readIntakeAnswer("state", "bihar")).toEqual(answer("bihar"));
  });

  it("refuses digits, a decline and nothing", () => {
    expect(readIntakeAnswer("city", "411001")).toEqual({ kind: "non_answer", why: "unreadable" });
    expect(readIntakeAnswer("city", "pata nahi")).toEqual({ kind: "non_answer", why: "declined" });
    expect(readIntakeAnswer("state", " ")).toEqual({ kind: "non_answer", why: "empty" });
  });
});

describe("advancing (D1, D2) — re-ask once, then settle; hold the first name; write once", () => {
  it("re-asks a non-answer ONCE on the same step, spending nothing else", () => {
    const t = advanceIntake(pendingAt("first_name"), declined);
    expect(t.reply).toEqual({ kind: "ask", step: "first_name", line: "retry" });
    expect(t.next.step).toBe("first_name");
    expect(t.next.asks.first_name).toBe(2);
    expect(t.settled).toEqual([]);
    expect(t.name).toBeNull();
  });

  it("chooses the re-ask line by WHY: a question back gets the why, abuse the fixed line", () => {
    const q = advanceIntake(pendingAt("city"), { kind: "non_answer", why: "question_back" });
    expect(q.reply).toEqual({ kind: "ask", step: "city", line: "clarify" });
    const a = advanceIntake(pendingAt("city"), { kind: "non_answer", why: "abusive" });
    expect(a.reply).toEqual({ kind: "ask", step: "city", line: "de_escalate" });
  });

  it(`settles as SKIPPED on the ${MAX_INTAKE_ASKS_PER_STEP}nd non-answer and moves on`, () => {
    const t = advanceIntake(pendingAt("state", { asks: { state: 2 } }), declined);
    expect(t.settled).toEqual([{ step: "state", outcome: "skipped", recognized: null }]);
    expect(t.reply).toEqual({ kind: "ask", step: "city", line: "prompt" });
    expect(t.next.asks.city).toBe(1);
  });

  it("a skipped FIRST name asks no surname and writes no name", () => {
    const t = advanceIntake(pendingAt("first_name", { asks: { first_name: 2 } }), declined);
    expect(t.next.step).toBe("state");
    expect(t.next.remaining).toEqual(["city"]);
    expect(t.name).toBeNull();
    expect(t.holdFirstName).toBeNull();
  });

  it("holds a one-word first name for sealing and asks the surname (D2)", () => {
    const t = advanceIntake(pendingAt("first_name"), answer("Ramesh"));
    expect(t.holdFirstName).toBe("Ramesh");
    expect(t.name).toBeNull();
    expect(t.reply).toEqual({ kind: "ask", step: "last_name", line: "prompt" });
    // Nothing plaintext in the state that goes to Redis — the seal is the service's to set.
    expect(JSON.stringify(t.next)).not.toContain("Ramesh");
  });

  it("a two-word first answer IS the full name, and the surname is never asked (D3)", () => {
    const t = advanceIntake(pendingAt("first_name"), answer("Ramesh Kumar", true));
    expect(t.name).toEqual({ kind: "full", value: "Ramesh Kumar" });
    expect(t.next.step).toBe("state");
    expect(t.settled.map((s) => s.step)).toEqual(["first_name"]);
  });

  it("the surname step names the HELD first name — answered or skipped (D2)", () => {
    const held = pendingAt("last_name", { firstNameEnc: "v1:sealed" });
    expect(advanceIntake(held, answer("Kumar")).name).toEqual({ kind: "held", surname: "Kumar" });
    const skipped = advanceIntake({ ...held, asks: { last_name: 2 } }, declined);
    expect(skipped.name).toEqual({ kind: "held", surname: null });
    expect(skipped.settled).toEqual([{ step: "last_name", outcome: "skipped", recognized: null }]);
    // The seal does not outlive the step that used it.
    expect(skipped.next.firstNameEnc).toBeNull();
  });

  it("holds the state and writes the location ONCE, at the city", () => {
    const atState = advanceIntake(pendingAt("state"), answer("Maharashtra"));
    expect(atState.location).toBeNull();
    expect(atState.next.heldState).toBe("Maharashtra");
    expect(atState.settled).toEqual([{ step: "state", outcome: "answered", recognized: true }]);

    const atCity = advanceIntake(atState.next, answer("Sitamarhi"));
    expect(atCity.location).toEqual({ state: "Maharashtra", city: "Sitamarhi" });
    expect(atCity.settled).toEqual([{ step: "city", outcome: "answered", recognized: false }]);
    expect(atCity.reply).toEqual({ kind: "handoff" });
    expect(atCity.next).toMatchObject({ state: "settled", step: null, heldState: null });
  });

  it("writes the state alone when the city is not a gap, and the city alone when state was skipped", () => {
    const stateOnly = advanceIntake(openIntake(["state"])!, answer("Bihar"));
    expect(stateOnly.location).toEqual({ state: "Bihar" });
    const cityOnly = advanceIntake(pendingAt("city", { heldState: null }), answer("Pune"));
    expect(cityOnly.location).toEqual({ city: "Pune" });
  });

  it("writes NO location when both location steps were skipped", () => {
    const t = advanceIntake(pendingAt("city", { asks: { city: 2 } }), declined);
    expect(t.location).toBeNull();
  });

  it("refuses to advance an intake that is not pending — a caller bug, never a silent no-op", () => {
    const settled = { ...pendingAt("city"), state: "settled", step: null } as IdentityIntakeState;
    expect(() => advanceIntake(settled, answer("Pune"))).toThrow();
  });
});

describe("composing the name (D2)", () => {
  it("joins the held first name and the surname", () => {
    expect(composeFullName("Ramesh", "Kumar")).toBe("Ramesh Kumar");
  });

  it("writes the first name ALONE when the surname was skipped", () => {
    expect(composeFullName("Ramesh", null)).toBe("Ramesh");
  });

  it("writes NOTHING when the first name cannot be read back — never a surname as a whole name", () => {
    expect(composeFullName(null, "Kumar")).toBeNull();
  });

  it("falls back to the first name when the two together break the 80-character bound", () => {
    expect(composeFullName("A".repeat(50), "B".repeat(40))).toBe("A".repeat(50));
  });

  it("never writes the first name twice when the surname answer repeats it", () => {
    expect(composeFullName("Ramesh", "Ramesh Kumar")).toBe("Ramesh Kumar");
    expect(composeFullName("Ramesh", "ramesh kumar")).toBe("Ramesh kumar");
    expect(composeFullName("सीता", "सीता शर्मा")).toBe("सीता शर्मा");
    // The whole answer WAS the first name again: nothing new to add.
    expect(composeFullName("Ramesh", "Ramesh")).toBe("Ramesh");
    // Only a LEADING repeat is the first name; a surname that merely contains it is kept.
    expect(composeFullName("Ram", "Ramdas")).toBe("Ram Ramdas");
  });
});

describe("the served lines", () => {
  it("re-serves the prompt, then the retry once the step has been asked twice", () => {
    expect(reservedIntakeLine(pendingAt("city"), "city")).toBe("prompt");
    expect(reservedIntakeLine(pendingAt("city", { asks: { city: 2 } }), "city")).toBe("retry");
  });

  it("maps every line kind to its words, with the engine's own de-escalation line", () => {
    for (const step of IDENTITY_INTAKE_STEPS) {
      expect(intakeLineText(step, "prompt")).toBe(INTAKE_COPY[step].prompt);
      expect(intakeLineText(step, "retry")).toBe(INTAKE_COPY[step].retry);
      expect(intakeLineText(step, "clarify")).toBe(
        `${INTAKE_COPY[step].why} ${INTAKE_COPY[step].prompt}`,
      );
      expect(intakeLineText(step, "de_escalate")).toBe(DE_ESCALATION_REPLY_TEXT);
    }
  });

  it("keys every step with a pack-shaped slug that no pack question can collide with", () => {
    for (const key of Object.values(INTAKE_QUESTION_KEYS)) {
      expect(key).toMatch(/^worker_[a-z_]{1,33}$/);
    }
  });
});

describe("the intake's copy is name-free and on-persona (D4)", () => {
  it.each(IDENTITY_INTAKE_REPLIES.map((text) => [text]))("%s", (text) => {
    // No placeholder: every line is a shared, pre-rendered clip.
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(checkPersonaTokens(text)).toEqual([]);
    expect(text).not.toContain("!");
    expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(text.split(/ +/).length).toBeLessThanOrEqual(20);
    for (const informal of personaCorpus().bannedInformal) {
      expect(` ${text.toLowerCase()} `).not.toContain(` ${informal} `);
    }
  });

  it("lists every served string once, the handoff included", () => {
    expect(new Set(IDENTITY_INTAKE_REPLIES).size).toBe(IDENTITY_INTAKE_REPLIES.length);
    expect(IDENTITY_INTAKE_REPLIES).toContain(INTAKE_HANDOFF_TEXT);
  });
});

describe("the envelope field survives Redis, and fails toward 'never opened'", () => {
  const roundTrip = (identityIntake: unknown) =>
    narrowProfilingEnvelope(
      JSON.parse(JSON.stringify({ ...emptyProfilingEnvelope(), rev: 3, identityIntake })),
    )?.identityIntake;

  it("carries a pending intake byte for byte", () => {
    const pending = pendingAt("last_name", { firstNameEnc: "v1:sealed", asks: { first_name: 2 } });
    expect(roundTrip(pending)).toEqual(pending);
  });

  it("narrows a pending intake on an unknown step, or garbage, to null", () => {
    expect(roundTrip({ ...pendingAt("city"), step: "pincode" })).toBeNull();
    expect(roundTrip("pending")).toBeNull();
    expect(roundTrip(undefined)).toBeNull();
  });

  it("carries nothing forward from a SETTLED intake — no seal, no held state", () => {
    expect(
      roundTrip({ state: "settled", step: "city", firstNameEnc: "v1:x", heldState: "Bihar" }),
    ).toEqual({
      state: "settled",
      step: null,
      remaining: [],
      asks: {},
      firstNameEnc: null,
      heldState: null,
    });
  });

  it("drops unknown steps and clamps counts", () => {
    expect(
      roundTrip({
        ...pendingAt("state"),
        remaining: ["city", "pincode"],
        asks: { state: -4, pincode: 9 },
      }),
    ).toMatchObject({ remaining: ["city"], asks: { state: 0 } });
  });
});
