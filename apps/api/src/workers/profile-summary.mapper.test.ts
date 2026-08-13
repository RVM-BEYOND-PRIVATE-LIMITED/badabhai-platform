import { describe, expect, it } from "vitest";
import { toProfileSummary, type ProfileSummarySource } from "./profile-summary.mapper";

/**
 * `GET /workers/me/profile-summary` — the worker's own Profile tab.
 *
 * The mapper had NO tests. It is a pure function over a defensively-narrowed row, which is
 * exactly the shape that rots quietly: every read is meant to degrade to null rather than throw
 * a 500 at a worker, and nothing was checking that any of them did.
 */
const BASE: ProfileSummarySource = {
  profileStatus: "confirmed",
  canonicalTradeId: null,
  canonicalRoleId: null,
  skills: [],
  machines: [],
  experience: {},
  salaryExpectation: {},
  locationPreference: {},
  availability: {},
  rawProfile: {},
  confirmedAt: null,
  hasPhoto: false,
};

const from = (over: Partial<ProfileSummarySource> = {}) => toProfileSummary({ ...BASE, ...over });

describe("toProfileSummary — the trade headline", () => {
  /**
   * THE DEFECT. Both resolvers key off the canonical ids, and the LLM-led interview
   * structurally cannot write one, so this was null for every interview-led worker — and the
   * app's header falls back to the generic "Aapki profile" when it is. The worker had named
   * their trade in the interview and their own profile would not say it back to them.
   */
  it("falls back to the interview's role label when nothing canonicalized", () => {
    const s = from({ rawProfile: { role_label: "tandoor cook", domain_label: "catering" } });
    expect(s.trade.display_name).toBe("tandoor cook");
  });

  it("falls back to the domain label when only the trade was named", () => {
    // The coarser answer, and still far better than the generic header.
    expect(from({ rawProfile: { domain_label: "catering" } }).trade.display_name).toBe("catering");
  });

  it("never lets a label outrank a resolved taxonomy role", () => {
    // ID-FIRST, the same rule the two résumé builders apply to these exact two values: the
    // taxonomy value is reviewed, the label is model free text, so the label arm can only ever
    // FILL A BLANK. It is also what keeps invariant #8 structural — a row carrying an id
    // renders as it does today whatever a future writer puts in `role_label`.
    const s = from({
      canonicalRoleId: "role_vmc_operator",
      rawProfile: { role_label: "something the model wrote" },
    });
    expect(s.trade.display_name).not.toBe("something the model wrote");
    expect(s.trade.display_name).toBeTruthy();
  });

  it("is null when the worker named neither", () => {
    // No fabrication (§11): a profile with no role, no trade and no labels has no headline, and
    // the app shows its own neutral copy rather than an invented job title.
    expect(from().trade.display_name).toBeNull();
  });

  it("still reports the canonical ids verbatim", () => {
    // The label fills the DISPLAY slot only — the ids on the wire stay exactly what the row
    // holds, because matching and canonicalization read them.
    const s = from({ rawProfile: { role_label: "tandoor cook" } });
    expect(s.trade.canonical_role_id).toBeNull();
    expect(s.trade.canonical_trade_id).toBeNull();
  });
});

describe("toProfileSummary — labels never move a business number", () => {
  /**
   * THE FENCE. `strength` must stay identical to `countFields` in the extraction processor, and
   * `missing_fields` drives what the product asks the worker to complete. Both score
   * CANONICALIZATION, and a free-text label is precisely the state canonicalization has not
   * resolved yet — counting it would tell a worker their profile is stronger than the match
   * engine can actually use (§3).
   */
  it("does not raise strength", () => {
    expect(from({ rawProfile: { role_label: "tandoor cook", domain_label: "catering" } }).strength)
      .toBe(from().strength);
  });

  it("still reports role and trade as missing", () => {
    const s = from({ rawProfile: { role_label: "tandoor cook", domain_label: "catering" } });
    expect(s.missing_fields).toContain("role");
    expect(s.missing_fields).toContain("trade");
  });
});

describe("toProfileSummary — the raw_profile blob is read, never spread", () => {
  it("reads only the four allow-listed keys", () => {
    // The privacy contract of `readRawProfileString`. `experience.summary` is free text that can
    // carry employer PII, and the résumé container carries the whole interview — neither may
    // reach this wire because the blob happens to hold them.
    const s = from({
      rawProfile: {
        role_label: "tandoor cook",
        education_level: "10th",
        education_field: "Arts",
        experience: { summary: "worked at SECRET EMPLOYER PVT LTD" },
        resume_profile: { current_city: "Delhi", expected_salary: 25000 },
        phone: "9999999999",
      },
    });
    expect(s.trade.display_name).toBe("tandoor cook");
    expect(s.education_level).toBe("10th");
    expect(s.education_field).toBe("Arts");
    expect(JSON.stringify(s)).not.toContain("SECRET EMPLOYER");
    expect(JSON.stringify(s)).not.toContain("9999999999");
  });

  it("degrades instead of throwing on a malformed blob", () => {
    // A worker must never get a 500 because a row is shaped oddly.
    for (const rawProfile of [null, undefined, "a string", 42, [], { role_label: 7 }]) {
      const s = from({ rawProfile });
      expect(s.trade.display_name).toBeNull();
      expect(s.education_level).toBeNull();
    }
  });

  it("treats a blank label as absent", () => {
    // "" is a value the model can emit; a blank headline is worse than the app's own copy.
    expect(from({ rawProfile: { role_label: "   ", domain_label: "" } }).trade.display_name)
      .toBeNull();
  });
});

describe("toProfileSummary — invariant #8: pre-interview profiles are untouched", () => {
  it("renders a canonicalized profile exactly as it did before the label arm", () => {
    // Deterministic-pack profiles carry ids and no labels, so the new arm is unreachable for
    // every one of them.
    const s = from({
      canonicalRoleId: "role_vmc_operator",
      canonicalTradeId: "trade_cnc_machining",
      skills: ["skill_milling"],
      experience: { total_years: 5 },
      rawProfile: {},
    });
    expect(s.trade.display_name).toBeTruthy();
    expect(s.experience_years).toBe(5);
    expect(s.skills).toEqual(["Milling"]);
  });

  it("maps an absent profile to the no-profile summary", () => {
    const s = toProfileSummary(null);
    expect(s.profile_status).toBe("none");
    expect(s.trade.display_name).toBeNull();
    expect(s.strength).toBe(0);
  });
});
