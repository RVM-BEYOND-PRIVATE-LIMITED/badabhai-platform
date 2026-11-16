import { describe, expect, it } from "vitest";
import { UNLOCK_OUTCOMES, type UnlockOutcome } from "@badabhai/types";
import {
  decideOutcomeWrite,
  followupCutoff,
  isFollowupDue,
  type DueFacts,
} from "./unlock-outcome-rules";

/**
 * #2753 item 10 — the follow-up's pure rules: when an opened contact is due, and what one answer
 * does to the stored row. The SQL twin of the due rule runs on Postgres in unlock-outcomes.db.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-16T10:00:00.000Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY + extraMs);
const facts = (over: Partial<DueFacts> = {}): DueFacts => ({
  grantedAt: ago(10),
  outcome: null,
  answeredAt: null,
  ...over,
});

describe("followupCutoff", () => {
  it("is `afterDays` whole days of 24 hours before now", () => {
    expect(followupCutoff(NOW, 7).toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(followupCutoff(NOW, 1).toISOString()).toBe("2026-11-15T10:00:00.000Z");
  });
});

describe("isFollowupDue — the boundary day", () => {
  it("granted exactly 7 days ago is due; a millisecond later is not yet", () => {
    expect(isFollowupDue(facts({ grantedAt: ago(7) }), NOW, 7)).toBe(true);
    expect(isFollowupDue(facts({ grantedAt: ago(7, 1) }), NOW, 7)).toBe(false);
    expect(isFollowupDue(facts({ grantedAt: ago(7, -1) }), NOW, 7)).toBe(true);
  });

  it("follows the setting: 3 days makes a 4-day-old grant due, 14 does not", () => {
    expect(isFollowupDue(facts({ grantedAt: ago(4) }), NOW, 3)).toBe(true);
    expect(isFollowupDue(facts({ grantedAt: ago(4) }), NOW, 14)).toBe(false);
  });

  it("a row that never opened (no grant time) is never due", () => {
    expect(isFollowupDue(facts({ grantedAt: null }), NOW, 7)).toBe(false);
  });
});

describe("isFollowupDue — answered or not", () => {
  it("no answer: due", () => {
    expect(isFollowupDue(facts(), NOW, 7)).toBe(true);
  });

  it.each(["hired", "not_hired", "not_reached"] as const)(
    "answered %s: never due again, however old the answer",
    (outcome) => {
      expect(isFollowupDue(facts({ outcome, answeredAt: ago(9) }), NOW, 7)).toBe(false);
      expect(isFollowupDue(facts({ outcome, answeredAt: ago(1) }), NOW, 7)).toBe(false);
    },
  );

  it("still_talking: due again once the answer is itself the wait old (the boundary counts)", () => {
    expect(isFollowupDue(facts({ outcome: "still_talking", answeredAt: ago(2) }), NOW, 7)).toBe(
      false,
    );
    expect(isFollowupDue(facts({ outcome: "still_talking", answeredAt: ago(7, 1) }), NOW, 7)).toBe(
      false,
    );
    expect(isFollowupDue(facts({ outcome: "still_talking", answeredAt: ago(7) }), NOW, 7)).toBe(
      true,
    );
    expect(isFollowupDue(facts({ outcome: "still_talking", answeredAt: ago(8) }), NOW, 7)).toBe(
      true,
    );
  });

  it("still_talking on a grant that is not yet due is not due (both clocks must have run)", () => {
    expect(
      isFollowupDue(
        facts({ grantedAt: ago(3), outcome: "still_talking", answeredAt: ago(8) }),
        NOW,
        7,
      ),
    ).toBe(false);
  });
});

describe("decideOutcomeWrite — one row per unlock, history on the spine", () => {
  it("the first answer is an insert", () => {
    for (const outcome of UNLOCK_OUTCOMES) {
      expect(decideOutcomeWrite(null, outcome, "company")).toBe("insert");
    }
  });

  it("a different outcome replaces the stored one (still_talking → hired)", () => {
    expect(
      decideOutcomeWrite({ outcome: "still_talking", answeredBy: "company" }, "hired", "company"),
    ).toBe("change");
    expect(
      decideOutcomeWrite({ outcome: "hired", answeredBy: "company" }, "not_hired", "company"),
    ).toBe("change");
  });

  it("the same outcome from the other answerer is a change (desk not_reached, then the company)", () => {
    expect(
      decideOutcomeWrite({ outcome: "not_reached", answeredBy: "desk" }, "not_reached", "company"),
    ).toBe("change");
  });

  it("still_talking again restarts the wait (refresh, no event); any other repeat is nothing", () => {
    expect(
      decideOutcomeWrite(
        { outcome: "still_talking", answeredBy: "company" },
        "still_talking",
        "company",
      ),
    ).toBe("refresh");
    for (const outcome of ["hired", "not_hired", "not_reached"] as UnlockOutcome[]) {
      expect(decideOutcomeWrite({ outcome, answeredBy: "company" }, outcome, "company")).toBe(
        "none",
      );
    }
    expect(
      decideOutcomeWrite({ outcome: "not_reached", answeredBy: "desk" }, "not_reached", "desk"),
    ).toBe("none");
  });
});
