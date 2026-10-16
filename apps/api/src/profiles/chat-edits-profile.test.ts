import { describe, expect, it } from "vitest";
import type { InterviewExtractOutput } from "@badabhai/ai-contracts";

import type { ChatEditsStamp } from "../profiling/understanding/chat-edits.stamp";
import { withChatEdits } from "./chat-edits-profile";

/** ADR-0057 R9 (#2313) — the two transcript-read inputs, corrected by what the worker confirmed. */

const OLD_JOB = { role_label: "Fitter", duration_text: "5 saal", duration_months: 60, work_done: "assembly" };
const NEW_JOB = { ...OLD_JOB, duration_text: "2 saal", duration_months: 24 };

const PHASE_C: InterviewExtractOutput = {
  domain_label: "fabrication",
  role_label: "Fitter",
  skills: ["Welding", "Grinding"],
  experiences: [OLD_JOB],
  shift: null,
  current_city: "Pune",
  preferred_locations: ["Pune"],
  availability: "immediate",
  expected_salary: null,
  blocked: false,
  is_mock: false,
  ai_metadata: null,
};

const ACCEPTED = { current_city: { value: "Pune" }, experience_years: { value: 5 } } as const;

function stamp(over: Partial<ChatEditsStamp> = {}): ChatEditsStamp {
  return {
    v: 1,
    ledger: [{ field_key: "experience", op: "edit", target_field: null }],
    skills: null,
    experiences: [NEW_JOB],
    deleted_fields: [],
    ...over,
  };
}

describe("withChatEdits", () => {
  it("returns both inputs untouched with no stamp", () => {
    const out = withChatEdits(null, ACCEPTED, PHASE_C);
    expect(out.accepted).toBe(ACCEPTED);
    expect(out.interview).toBe(PHASE_C);
    expect(out.corrected).toBe(0);
  });

  it("replaces only the list the worker changed", () => {
    const out = withChatEdits(stamp(), ACCEPTED, PHASE_C);
    expect(out.interview?.experiences).toEqual([NEW_JOB]);
    expect(out.interview?.skills).toEqual(PHASE_C.skills);
    const skills = withChatEdits(stamp({ skills: ["Welding"], experiences: null }), ACCEPTED, PHASE_C);
    expect(skills.interview?.skills).toEqual(["Welding"]);
    expect(skills.interview?.experiences).toEqual([OLD_JOB]);
  });

  it("clears Phase C's value for a pack field the worker changed, so the answer map's stands", () => {
    const out = withChatEdits(
      stamp({
        ledger: [{ field_key: "current_city", op: "edit", target_field: "current_city" }],
        experiences: null,
      }),
      ACCEPTED,
      PHASE_C,
    );
    expect(out.interview?.current_city).toBeNull();
    expect(out.interview?.availability).toBe("immediate");
    // A changed field keeps the parse overlay: the answer map holds the value and outranks it.
    expect(out.accepted).toEqual(ACCEPTED);
  });

  it("drops a removed field from the parse overlay, so the transcript cannot fill it back", () => {
    const out = withChatEdits(
      stamp({
        ledger: [{ field_key: "current_city", op: "delete", target_field: "current_city" }],
        experiences: null,
        deleted_fields: ["current_city"],
      }),
      ACCEPTED,
      null,
    );
    expect(out.accepted).toEqual({ experience_years: { value: 5 } });
    expect(out.interview).toBeNull();
  });

  it("never mutates what it was given", () => {
    const phaseC = structuredClone(PHASE_C);
    withChatEdits(stamp({ skills: [] }), ACCEPTED, phaseC);
    expect(phaseC).toEqual(PHASE_C);
  });
});
