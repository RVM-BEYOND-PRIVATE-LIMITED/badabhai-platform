import { describe, expect, it } from "vitest";

import {
  identityPrompt,
  readIdentityReply,
  roleDisplay,
  RESUME_IDENTITY_OPTIONS,
} from "./resume-identity";

describe("resume-identity — the approved Hinglish bubble and its two chips", () => {
  it("renders the approved copy with role, tajurba and summary", () => {
    expect(
      identityPrompt({
        importId: "import-1",
        roleKind: "cnc_grinding",
        experienceText: "2 saal 7 mahine ka tajurba",
        summaryText: "CNC cylindrical grinder par kaam",
      }),
    ).toBe(
      "Resume se ye mila: CNC Grinding Operator, 2 saal 7 mahine ka tajurba. " +
        "CNC cylindrical grinder par kaam Kya ye aap hi hain?",
    );
  });

  it("omits null parts instead of printing them", () => {
    expect(
      identityPrompt({
        importId: "import-1",
        roleKind: null,
        experienceText: null,
        summaryText: "CNC cylindrical grinder par kaam",
      }),
    ).toBe("Resume se ye mila. CNC cylindrical grinder par kaam Kya ye aap hi hain?");
  });

  it("resolves the role through the registry, never the raw kind id", () => {
    expect(roleDisplay("welder")).toBe("Welder");
    expect(roleDisplay("bus_driver")).toBeNull();
    expect(roleDisplay(null)).toBeNull();
  });

  it("ships exactly two chips with distinct keys from the batch-confirm", () => {
    expect(RESUME_IDENTITY_OPTIONS.map((o) => o.option_key)).toEqual([
      "resume_identity_yes",
      "resume_identity_no",
    ]);
    expect(RESUME_IDENTITY_OPTIONS.map((o) => o.label_text)).toEqual([
      "Haan, ye main hoon",
      "Nahi, ye main nahi hoon",
    ]);
  });

  it("reads chips, free-text haan/nahi, and fails closed on unclear", () => {
    expect(readIdentityReply("resume_identity_yes")).toBe("accept");
    expect(readIdentityReply("resume_identity_no")).toBe("decline");
    expect(readIdentityReply("Haan, ye main hoon")).toBe("accept");
    expect(readIdentityReply("Nahi, ye main nahi hoon")).toBe("decline");
    // Unreadable is never an accept: attaching a résumé on an unparsed sentence
    // is the worst failure available to this turn ("5 saal" is the lexicon's own
    // null case — a non-answer it refuses to guess on).
    expect(readIdentityReply("5 saal")).toBe("unclear");
  });
});
