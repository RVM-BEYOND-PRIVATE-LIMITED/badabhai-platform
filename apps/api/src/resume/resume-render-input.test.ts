import { describe, expect, it } from "vitest";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * Q14 (ADR-0030 OQ#3): the PDF skills array renders canonical ids + the
 * worker-confirmed raw `skill_labels`, deduped (a label that normalizes to an
 * id with the `skill_` prefix stripped is dropped). Old snapshots without the
 * field must render byte-for-byte as before (default []).
 */
describe("buildResumeRenderInput — skill_labels (Q14)", () => {
  it("resolves skill ids to NAMES first, then confirmed raw labels", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"], skill_labels: ["MIG welding", "TIG welding"] },
      null,
      null,
      null, // photoDataUri (ADR-0032): caller-supplied; these tests render photo-less
      "worker",
    );
    // skill_milling → "Milling" (the résumé must never show a raw skill_* id).
    expect(input.skills).toEqual(["Milling", "MIG welding", "TIG welding"]);
  });

  it("drops a label that duplicates a resolved skill name", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"], skill_labels: ["Milling", "5-axis setup"] },
      null,
      null,
      null,
      "worker",
    );
    expect(input.skills).toEqual(["Milling", "5-axis setup"]);
  });

  it("old snapshot without skill_labels resolves its ids to names", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null, "worker");
    expect(input.skills).toEqual(["Milling"]);
  });

  it("labels-only snapshot (off-wedge welder) renders the labels", () => {
    const input = buildResumeRenderInput({ skill_labels: ["MIG welding"] }, null, null, null, "worker");
    expect(input.skills).toEqual(["MIG welding"]);
  });
});

/**
 * #499 — education + certifications now ride on the DraftProfile snapshot, so the
 * templates' "Education & Certifications" section renders instead of collapsing.
 * Old snapshots without the keys default to [] (invariant #8, byte-identical).
 */
describe("buildResumeRenderInput — education + certifications (#499)", () => {
  it("carries education + certifications from the snapshot into the render input", () => {
    const input = buildResumeRenderInput(
      { education: ["ITI", "Diploma"], certifications: ["NCVT"] },
      null,
      null,
      null,
      "worker",
    );
    expect(input.education).toEqual(["ITI", "Diploma"]);
    expect(input.certifications).toEqual(["NCVT"]);
  });

  it("resolves taxonomy IDs in education + certifications to labels", () => {
    const input = buildResumeRenderInput(
      { education: ["skill_milling", "role_cnc_operator"], certifications: ["mach_vmc"] },
      null,
      null,
      null,
      "worker",
    );
    // skill_milling → "Milling", role_cnc_operator → "CNC Operator", mach_vmc → "Vertical Machining Center (VMC)"
    expect(input.education).toEqual(["Milling", "CNC Operator"]);
    expect(input.certifications).toEqual(["Vertical Machining Center (VMC)"]);
  });

  it("old snapshot without the keys defaults both to [] (no fabrication)", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null, "worker");
    expect(input.education).toEqual([]);
    expect(input.certifications).toEqual([]);
  });
});

/**
 * Machines field should resolve taxonomy IDs to display labels.
 */
describe("buildResumeRenderInput — machines", () => {
  it("resolves machine ids to display names", () => {
    const input = buildResumeRenderInput(
      { machines: ["mach_vmc", "mach_cnc_lathe", "mach_hmc"] },
      null,
      null,
      null,
      "worker",
    );
    expect(input.machines).toEqual([
      "Vertical Machining Center (VMC)",
      "CNC Lathe / Turning Center",
      "Horizontal Machining Center (HMC)",
    ]);
  });

  it("prettifies unknown machine ids as fallback", () => {
    const input = buildResumeRenderInput(
      { machines: ["mach_unknown_machine"] },
      null,
      null,
      null,
      "worker",
    );
    expect(input.machines).toEqual(["Unknown Machine"]);
  });

  it("passes through non-id labels unchanged", () => {
    const input = buildResumeRenderInput(
      { machines: ["VMC", "CNC Lathe"] },
      null,
      null,
      null,
      "worker",
    );
    expect(input.machines).toEqual(["VMC", "CNC Lathe"]);
  });

  it("old snapshot without machines defaults to []", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null, "worker");
    expect(input.machines).toEqual([]);
  });
});

/**
 * education_level + education_field ride the DraftProfile snapshot beside the
 * education list, and are threaded to the render input. Old snapshots without the
 * keys default to null (invariant #8).
 */
describe("buildResumeRenderInput — education_level + education_field", () => {
  it("carries education_level + education_field from the snapshot", () => {
    const input = buildResumeRenderInput(
      { education_level: "12th", education_field: "Electronics" },
      null,
      null,
      null,
      "worker",
    );
    expect(input.educationLevel).toBe("12th");
    expect(input.educationField).toBe("Electronics");
  });

  it("old snapshot without the keys defaults both to null (no fabrication)", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null, "worker");
    expect(input.educationLevel).toBeNull();
    expect(input.educationField).toBeNull();
  });
});

/**
 * THE LLM-LED PATH'S OWN LABELS — `role_label`, `domain_label`, `shift`.
 *
 * `toExtractionOutput` hardcodes both canonical ids to null on this path (inventing a taxonomy
 * id would put an unvalidated value where the match engine trusts absolutely), so
 * `resolveTradeContent` finds nothing and `resolveId` returns null. Before these legs, an
 * OIE-path resume rendered with an EMPTY headline AND an empty summary — the model had named the
 * role and the trade in plain language, the column held both, and the PDF showed neither.
 *
 * Every assertion below is about a slot that ALREADY EXISTS on all four shipped templates. A
 * shipped `<id>.v<n>.html` is immutable by the registry contract, so nothing here adds a token.
 */
describe("buildResumeRenderInput — the LLM-led labels", () => {
  it("prints role_label as the headline when the taxonomy resolved nothing", () => {
    const input = buildResumeRenderInput({ role_label: "Tandoor Cook" }, null, null, null, "worker");
    expect(input.canonicalRole).toBe("Tandoor Cook");
  });

  it("never lets role_label outrank a resolved taxonomy role", () => {
    // The canonical id is the reviewed, matchable value; the label is free text the model wrote.
    // Where both exist the taxonomy wins, so this leg can only ever FILL A BLANK.
    //
    // THE ORDER SURVIVED THE 2026-08-13 CANONICAL-ID RETIREMENT DELIBERATELY. That change made
    // the labels the résumé's source wherever an id is ABSENT — which is every interview-led
    // profile, and the whole of the defect it fixed. It did NOT invert this: preferring model
    // free text over a reviewed value where both exist would be the AI outvoting a
    // deterministic one on a worker-facing claim (§3), and it is what keeps invariant #8
    // structural rather than coincidental — nothing in either schema stops a row from carrying
    // an id AND a label, and canonicalization exists precisely to add an id to a row lacking
    // one. With the id first, any row that has one renders as it does today, forever.
    const input = buildResumeRenderInput(
      { canonical_role_id: "role_welder", role_label: "something the model wrote" },
      null,
      null,
      null,
      "worker",
    );
    expect(input.canonicalRole).not.toBe("something the model wrote");
  });

  it("still resolves the taxonomy role when no label was captured", () => {
    // Every deterministic-pack profile is this shape — an id and no label — so the id arms
    // carry all of them and their résumés stay byte-identical (invariant #8).
    const input = buildResumeRenderInput({ canonical_role_id: "role_welder" }, null, null, null, "worker");
    expect(input.canonicalRole).toBe("Welder");
  });

  it("prints the trade in plain language when the interview named one", () => {
    // `trade` was hardcoded null on this branch because the deterministic résumé never printed
    // a trade line and the old container had nothing to fill one with. `domain_label` is that
    // source, and it reaches the `{{trade}}` slot every shipped template already carries.
    const input = buildResumeRenderInput({ domain_label: "Fabrication" }, null, null, null, "worker");
    expect(input.trade).toBe("Fabrication");
  });

  it("leaves the trade null when no interview named one", () => {
    // Deterministic-pack profiles have no `domain_label`, so their trade line stays absent
    // exactly as it is today — no invented industry (§11), no changed output (invariant #8).
    const input = buildResumeRenderInput({ canonical_role_id: "role_welder" }, null, null, null, "worker");
    expect(input.trade).toBeNull();
  });

  it("builds a summary from the labels when the trade is unknown", () => {
    const input = buildResumeRenderInput(
      { role_label: "Tandoor Cook", domain_label: "catering", experience: { total_years: 3 } },
      null,
      null,
      null,
      "worker",
    );
    expect(input.summary).toBe("Tandoor Cook with 3 years of experience in catering.");
  });

  it("says each thing once when the domain repeats the role", () => {
    const input = buildResumeRenderInput(
      { role_label: "Cooking", domain_label: "cooking" },
      null,
      null,
      null,
      "worker",
    );
    expect(input.summary).toBe("Cooking.");
  });

  it("fabricates no summary when the model captured no labels", () => {
    // THE FAIL-CLOSED LEG. A sentence about a worker we know nothing about is worse than a
    // blank section — §11, and the same rule the trade branches already follow.
    const input = buildResumeRenderInput({ experience: { total_years: 3 } }, null, null, null, "worker");
    expect(input.summary).toBeNull();
  });

  it("appends the shift to the availability line", () => {
    const input = buildResumeRenderInput(
      { shift: "night", availability: { status: "immediate" } },
      null,
      null,
      null,
      "worker",
    );
    expect(input.availability).toBe("Available immediately · Night shift");
  });

  it("prints the shift alone when the status has no phrase", () => {
    // `unknown` yields no availability phrase, but "I work nights" is still an answer the worker
    // gave. The whole line used to collapse and take it down with it.
    const input = buildResumeRenderInput({ shift: "day" }, null, null, null, "worker");
    expect(input.availability).toBe("Day shift");
  });

  it("passes through a shift value outside the prompt's vocabulary", () => {
    // The wire type is a bare `str | None` with no Literal behind it. Dropping what we did not
    // anticipate is how the four keys got lost in the first place.
    const input = buildResumeRenderInput({ shift: "rotational" }, null, null, null, "worker");
    expect(input.availability).toBe("Rotational");
  });

  it("old snapshot without the keys renders exactly as before", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null, "worker");
    expect(input.canonicalRole).toBeNull();
    expect(input.summary).toBeNull();
    expect(input.availability).toBeNull();
  });
});

/**
 * ── THE RÉSUMÉ CONTAINER ──────────────────────────────────────────────────────────────
 *
 * The fixture is a REAL Phase C response, copied from a live Langfuse trace (VMC operator,
 * Delhi, 2026-08-12). Using the actual traced object rather than a hand-written one is the
 * point of the container: these assertions are what "the résumé equals the trace" means, and a
 * synthesised fixture could drift into agreeing with the code instead of with production.
 */
describe("buildResumeRenderInput — the résumé container", () => {
  const TRACE = {
    domain_label: "CNC Machining",
    role_label: "VMC Operator",
    skills: ["VMC operation", "Part manufacturing", "G-code reading", "Machine setup"],
    experiences: [
      {
        role_label: "VMC Operator",
        duration_text: "3.5 saal",
        duration_months: 42,
        work_done: "Manufactured various parts, read drawings, performed machine setup",
      },
    ],
    shift: "any",
    current_city: "Delhi",
    preferred_locations: ["Pune"],
    availability: "immediate",
    expected_salary: 40000,
  };
  const build = (over: Record<string, unknown> = {}, audience: "worker" | "employer" = "worker") =>
    buildResumeRenderInput({ resume_profile: { ...TRACE, ...over } }, "Asha Kumari", "classic", null, audience);

  it("renders every one of the nine keys the model produced", () => {
    const input = build();
    expect(input.canonicalRole).toBe("VMC Operator");
    expect(input.trade).toBe("CNC Machining");
    expect(input.location).toBe("Delhi");
    expect(input.preferredLocations).toEqual(["Pune"]);
    expect(input.skills).toEqual(TRACE.skills);
    expect(input.expectedSalary).toBe(40000);
    expect(input.availability).toBe("Available immediately · Any shift");
    expect(input.experiences).toEqual([
      {
        role: "VMC Operator",
        duration: "3.5 saal",
        work: "Manufactured various parts, read drawings, performed machine setup",
      },
    ]);
  });

  it("derives the years the model never sent as a field", () => {
    // Phase C has no `experience_years`, and the answer map is not consulted on this path — so
    // without this derivation the résumé printed NO years while the worker had said "3.5 saal".
    // 42 months / 12 = 3.5.
    expect(build().experienceYears).toBe(3.5);
  });

  it("keeps the worker's own words for the duration, not the converted number", () => {
    // "42 months" is a normalization of "3.5 saal". Printing it trades their voice for a number
    // they never used, which is why `duration_text` leads.
    expect(build().experiences[0]!.duration).toBe("3.5 saal");
  });

  it("reports no years rather than inventing them when nothing converted", () => {
    // `duration_months` is nullable precisely because "kuch saal" is a real answer. Guessing a
    // number from it is the fabrication the parse gates exist to stop.
    const input = build({
      experiences: [{ role_label: "Helper", duration_text: "kuch saal", duration_months: null, work_done: "" }],
    });
    expect(input.experienceYears).toBeNull();
    expect(input.experiences[0]!.duration).toBe("kuch saal");
  });

  it("hides the expected salary from the payer-facing disclosure", () => {
    // THE WORKER'S ASKING PRICE. Same treatment ADR-0032 gives the photo: present on their own
    // copy, structurally absent on the disclosure, so it cannot be handed to a payer before any
    // conversation happens.
    expect(build({}, "employer").expectedSalary).toBeNull();
    expect(build({}, "worker").expectedSalary).toBe(40000);
  });

  it("still renders everything else for the payer", () => {
    // The salary is the ONLY thing the audience switch removes — a disclosure that dropped the
    // work history would defeat its own purpose.
    const input = build({}, "employer");
    expect(input.experiences).toHaveLength(1);
    expect(input.canonicalRole).toBe("VMC Operator");
  });

  it("speaks the model's availability vocabulary, which the schema's enum does not contain", () => {
    // `extract_system_prompt` asks for 15_days / 1_month; `AvailabilitySchema.status` has
    // neither. The container keeps the model's words, so the humanising has to know them — else
    // the line silently collapsed for every worker who gave a notice period.
    expect(build({ availability: "15_days", shift: null }).availability).toBe("Available in 15 days");
    expect(build({ availability: "1_month", shift: null }).availability).toBe("Available in 1 month");
  });

  it("builds a summary from the labels", () => {
    expect(build().summary).toBe("VMC Operator with 3.5 years of experience in CNC Machining.");
  });

  it("leaves the answer-map sections empty — the accepted, temporary loss", () => {
    // Education, certifications, tools and trade responsibilities come from the answer map's
    // fifteen crosswalk fields; Phase C returns nine. Owner decision 2026-08-12: prove the
    // pipeline on a narrow set, widen Phase A and the tail afterwards. Asserted so the loss is
    // VISIBLE in the suite rather than discovered on a worker's résumé.
    const input = build();
    expect(input.education).toEqual([]);
    expect(input.certifications).toEqual([]);
    expect(input.machines).toEqual([]);
    expect(input.responsibilities).toEqual([]);
    expect(input.educationLevel).toBeNull();
  });

  it("falls back to the legacy path when there is no container", () => {
    // Null means "there was no LLM-led interview", never "the interview was empty". Every
    // profile written before this shipped is in that state and must render exactly as it did
    // (invariant #8).
    const input = buildResumeRenderInput(
      { canonical_role_id: "role_welder", resume_profile: null },
      "Asha Kumari",
      "classic",
      null,
      "worker",
    );
    expect(input.experiences).toEqual([]);
    expect(input.trade).toBeNull();
    expect(input.expectedSalary).toBeNull();
    expect(input.canonicalRole).not.toBeNull();
  });

  /**
   * ── THE BLANK RÉSUMÉ ──────────────────────────────────────────────────────────────────
   *
   * A container can be PRESENT AND EMPTY, and reading that as "the interview landed" produced a
   * PDF carrying nothing but the worker's name — generated successfully, and blank.
   *
   * It is not a hypothetical shape. `/profiling/extract` answers four of its own degrades with a
   * healthy 200 carrying an empty `InterviewExtractOutput` whose `blocked` is false: an empty
   * masked transcript, its own deadline breach, a model response that failed the contract, and
   * `not meta.real_call` — every mocked environment, which per TD81 includes staging. Every key
   * on `ResumeProfileSchema` is defaulted, so that response parses into a truthy container.
   */
  describe("a present but EMPTY container", () => {
    // Exactly what `ResumeProfileSchema` yields for the ai-service's empty 200.
    const HOLLOW = {
      domain_label: null,
      role_label: null,
      skills: [],
      experiences: [],
      shift: null,
      current_city: null,
      preferred_locations: [],
      availability: null,
      expected_salary: null,
    };
    // A perfectly good answer-map profile, of the kind the worker actually answered for.
    const LEGACY = {
      canonical_role_id: "role_welder",
      skill_labels: ["MIG Welding", "Fitting"],
      experience: { total_years: 5 },
      location_preference: { current_city: "Pune", preferred_cities: ["Pune"] },
      availability: { status: "immediate" },
      education_level: "10th",
    };
    const build = (snapshot: Record<string, unknown>) =>
      buildResumeRenderInput(snapshot, "Asha Kumari", "classic", null, "worker");

    it("does not blank a résumé the answer map could fill", () => {
      // THE REGRESSION. The container is truthy, so the early return fired and discarded every
      // field below — the worker got a PDF with their name and nothing else.
      const input = build({ ...LEGACY, resume_profile: HOLLOW });
      expect(input.canonicalRole).toBe("Welder");
      expect(input.skills).toEqual(["MIG Welding", "Fitting"]);
      expect(input.experienceYears).toBe(5);
      expect(input.location).toBe("Pune");
      expect(input.availability).toBe("Available immediately");
      expect(input.educationLevel).toBe("10th");
    });

    it("renders identically to the same profile with no container at all", () => {
      // An empty container carries no information, so it must not change a single slot. This is
      // the property that makes the guard safe: the degraded response becomes a no-op rather
      // than a decision.
      expect(build({ ...LEGACY, resume_profile: HOLLOW })).toEqual(build({ ...LEGACY }));
    });

    it("is not defeated by zod defaults filling an absent key", () => {
      // The ai-service sends `InterviewExtractOutput(is_mock=True)` — a body with NO nine keys
      // at all. `{}` is what reaches the schema, and every key is `.default()`ed, so the parsed
      // container is fully-formed and truthy. Asserting on `{}` rather than on HOLLOW is what
      // pins the defaulting behaviour itself.
      expect(build({ ...LEGACY, resume_profile: {} })).toEqual(build({ ...LEGACY }));
    });

    it("still wins outright the moment it carries ANY value", () => {
      // The guard asks whether this is a record of an interview, NOT which source is richer.
      // A container holding one field is still the model's object and still wins whole — no
      // merge, no precedence, no field-by-field rescue from the legacy shape. `machines` here
      // is the proof: the legacy container has content the container path leaves empty, and it
      // stays empty.
      const input = build({ ...LEGACY, machines: ["mach_vmc"], resume_profile: { ...HOLLOW, role_label: "Fitter" } });
      expect(input.canonicalRole).toBe("Fitter");
      expect(input.skills).toEqual([]);
      expect(input.experienceYears).toBeNull();
      expect(input.educationLevel).toBeNull();
      expect(input.machines).toEqual([]);
    });

    it("renders a name-only résumé when there is genuinely nothing else", () => {
      // A worker whose answer map is ALSO empty has no résumé to render, and the honest output
      // is an empty one. The guard must not invent content to avoid a blank page — it only
      // stops a blank page that had data available all along.
      const input = build({ resume_profile: HOLLOW });
      expect(input.canonicalRole).toBeNull();
      expect(input.skills).toEqual([]);
      expect(input.displayName).toBe("Asha Kumari");
    });
  });
});

/**
 * #831 — a STORED container's scalars were never certified.
 *
 * The ai-service now gates them at the write path (`_certified_scalar` in profiling.py), but
 * that protects future extractions only. Rows written before it hold values no gateway ever
 * vouched for, they are re-rendered from storage on every download, and this builder feeds BOTH
 * the worker's own PDF and the employer-facing masked disclosure. `shift` is the field #831
 * confirmed already crosses to a payer's screen.
 */
describe("buildResumeRenderInput — uncertified scalars in a stored container (#831)", () => {
  const CLEAN = {
    domain_label: "CNC Machining",
    role_label: "VMC Operator",
    skills: ["VMC operation"],
    experiences: [],
    shift: "day",
    current_city: "Delhi",
    preferred_locations: ["Pune"],
    availability: "immediate",
    expected_salary: 40000,
  };
  const build = (over: Record<string, unknown> = {}, audience: "worker" | "employer" = "worker") =>
    buildResumeRenderInput(
      { resume_profile: { ...CLEAN, ...over } },
      "Asha Kumari",
      "classic",
      null,
      audience,
    );

  const PHONE = "call 9876543210";
  const EMAIL = "reach me at ravi@sharma.com";

  it("suppresses a phone number stored in `shift` on the EMPLOYER PDF — the confirmed leak", () => {
    const input = build({ shift: PHONE }, "employer");
    expect(input.availability ?? "").not.toContain("9876543210");
  });

  it("suppresses it on the WORKER's own PDF too — this is not an audience rule", () => {
    // Audience-gating `shift` would have hidden a legitimate matching signal from employers
    // while still printing the phone number on the worker's own copy. Certification is the
    // property that actually holds, and it holds for both readers.
    const input = build({ shift: PHONE }, "worker");
    expect(input.availability ?? "").not.toContain("9876543210");
  });

  it("suppresses PII in every scalar the container carries", () => {
    const input = build({
      role_label: PHONE,
      domain_label: EMAIL,
      current_city: PHONE,
      availability: EMAIL,
      shift: PHONE,
    });
    expect(input.canonicalRole).toBeNull();
    expect(input.trade).toBeNull();
    expect(input.location).toBeNull();
    expect(input.availability).toBeNull();
    // The summary reads role/domain too — it must not reprint what the fields just suppressed.
    expect(input.summary ?? "").not.toContain("9876543210");
    expect(input.summary ?? "").not.toContain("ravi@sharma.com");
  });

  it("drops only the offending entry from preferred_locations and skills", () => {
    const input = build({
      preferred_locations: ["Pune", PHONE, "Nashik"],
      skills: ["VMC operation", EMAIL],
    });
    expect(input.preferredLocations).toEqual(["Pune", "Nashik"]);
    expect(input.skills).toEqual(["VMC operation"]);
  });

  it("THE FALSE-POSITIVE GUARD: ordinary values are untouched", () => {
    // A guard that ate real answers would be its own outage — a blanked résumé is exactly what
    // #824 cost us. `looksLikePii` matches email shapes and 7+ digit runs ONLY, which is why
    // the stricter `looksLikeActionContextPii` (which also rejects 2-4 title-cased words, i.e.
    // "New Delhi" and most role labels) is deliberately NOT used here.
    const input = build({
      role_label: "VMC Operator",
      domain_label: "CNC Machining",
      current_city: "New Delhi",
      preferred_locations: ["Navi Mumbai", "Pune"],
      shift: "night",
      availability: "immediate",
    });
    expect(input.canonicalRole).toBe("VMC Operator");
    expect(input.trade).toBe("CNC Machining");
    expect(input.location).toBe("New Delhi");
    expect(input.preferredLocations).toEqual(["Navi Mumbai", "Pune"]);
    expect(input.availability).toBe("Available immediately · Night shift");
  });

  it("a 4-digit pay-like number in a scalar is NOT treated as a phone", () => {
    // The digit-run threshold is 7+, so ordinary numerals in free text survive.
    const input = build({ role_label: "Operator grade 3", current_city: "Sector 21" });
    expect(input.canonicalRole).toBe("Operator grade 3");
    expect(input.location).toBe("Sector 21");
  });
});
