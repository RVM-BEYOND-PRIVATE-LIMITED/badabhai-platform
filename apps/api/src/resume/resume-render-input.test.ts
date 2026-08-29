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
      false,
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
      false,
      "worker",
    );
    expect(input.skills).toEqual(["Milling", "5-axis setup"]);
  });

  it("old snapshot without skill_labels resolves its ids to names", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"] },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.skills).toEqual(["Milling"]);
  });

  it("labels-only snapshot (off-wedge welder) renders the labels", () => {
    const input = buildResumeRenderInput(
      { skill_labels: ["MIG welding"] },
      null,
      null,
      null,
      false,
      "worker",
    );
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
      false,
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
      false,
      "worker",
    );
    // skill_milling → "Milling", role_cnc_operator → "CNC Operator", mach_vmc → "Vertical Machining Center (VMC)"
    expect(input.education).toEqual(["Milling", "CNC Operator"]);
    expect(input.certifications).toEqual(["Vertical Machining Center (VMC)"]);
  });

  it("old snapshot without the keys defaults both to [] (no fabrication)", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"] },
      null,
      null,
      null,
      false,
      "worker",
    );
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
      false,
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
      false,
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
      false,
      "worker",
    );
    expect(input.machines).toEqual(["VMC", "CNC Lathe"]);
  });

  it("old snapshot without machines defaults to []", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"] },
      null,
      null,
      null,
      false,
      "worker",
    );
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
      false,
      "worker",
    );
    expect(input.educationLevel).toBe("12th");
    expect(input.educationField).toBe("Electronics");
  });

  it("old snapshot without the keys defaults both to null (no fabrication)", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"] },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.educationLevel).toBeNull();
    expect(input.educationField).toBeNull();
  });
});

/**
 * #963 — THE RAW SCALAR MUST NOT REACH THE PAGE.
 *
 * `education_level` is free text the extractor writes (`z.string().nullable()`, no enum), and
 * the known token today is `below_10`. It was passed through verbatim into
 * the page unchanged, so a worker downloaded a résumé headed "below_10" — a DB-ish token on
 * the one document a low-literacy worker is meant to hand to an employer (§2). Availability
 * two lines above had been humanised since it was written; this field never was.
 *
 * THE EXPECTED STRINGS ARE THE APP'S, NOT THIS FILE'S. Every assertion below mirrors
 * `humanizeEducationLevel` in the worker app's `lib/core/util/education_label.dart`, which
 * already fixed the Resume tab. Two humanisers over one stored value must not disagree, so if
 * one of these expectations ever needs changing, the Dart is where it changes first.
 *
 * Nothing here adds a template token. NOT because `{{education_level}}` already exists — it
 * exists in ZERO of the twelve layouts, and a v4 written on the strength of that claim would
 * render a permanently blank slot, since the renderer binds unknown scalars to "" in silence.
 * The level reaches the page through the `{{#education_headline}}` region (`resume-renderer.service.ts` joins level and field into it),
 * which this change feeds a humanised string instead of a raw one. The shipped layouts
 * already. This changes only what is bound into it.
 */
describe("buildResumeRenderInput — education_level is humanised (#963, English per R10 R-3)", () => {
  const levelOf = (education_level: string) =>
    buildResumeRenderInput({ education_level }, null, null, null, false, "worker").educationLevel;

  it("renders the known token as the label the app already shows", () => {
    // THE REPORTED DEFECT, exactly. "below_10" is what the PDF printed.
    expect(levelOf("below_10")).toBe("Below 10th");
  });

  it("maps the other spelling of the same level", () => {
    // `below_10th` is the same answer out of the same free-text field. The app's map carries
    // both; a port that carried one would humanise a worker's level or not depending on which
    // way the model happened to spell it that day.
    expect(levelOf("below_10th")).toBe("Below 10th");
  });

  it("matches the token whatever case the model emitted it in", () => {
    // Nothing constrains the case of a free-text scalar, and a token that missed the map by a
    // capital letter would fall through to the prettifier and print "Below 10" — still not a
    // sentence anyone says.
    expect(levelOf("BELOW_10")).toBe("Below 10th");
  });

  it("prettifies a snake_case token nobody has mapped", () => {
    // RESHAPES WITHOUT RENAMING. The map holds only tokens the pipeline has actually produced;
    // inventing wording for the rest would be fabricating on the worker's behalf (§11). The
    // prettifier is the safe general answer — it can only ever make the same words readable.
    expect(levelOf("post_graduate")).toBe("Post Graduate");
  });

  it("leaves an already-readable label as written, and only trims it", () => {
    // INVARIANT #8 IS THE POINT OF THE FIRST THREE ARMS: nearly every stored value is already a
    // readable label, none of them contain an underscore, and their résumés must render exactly
    // as they do today. They are also what a more eager prettifier would WRECK — "ITI" would
    // come back "Iti" and "B.Tech" as "B.tech" if this re-cased what it had no need to touch.
    //
    // THE FOURTH ARM IS WHAT MAKES THIS AN ASSERTION RATHER THAN A TAUTOLOGY. The three above
    // pass with or without the humaniser — that is precisely what "unchanged" means — so the
    // trimmed value is what proves the humaniser is actually in the path at all.
    expect(levelOf("12th")).toBe("12th");
    expect(levelOf("ITI")).toBe("ITI");
    expect(levelOf("B.Tech")).toBe("B.Tech");
    expect(levelOf("  Diploma  ")).toBe("Diploma");
  });

  it("treats a blank level as no level, not as an empty line", () => {
    // The field's contract is `string | null` where null means "print nothing". A whitespace
    // string is the same absence spelled differently, and the renderer drops it on the way into
    // `education_headline` either way — normalising here keeps one absence to one shape.
    expect(levelOf("   ")).toBeNull();
  });

  it("does not touch education_field", () => {
    // The stream is a word the model writes ("Electronics"), not a token vocabulary. There is
    // nothing to translate, and reshaping it could only ever re-case a value already correct.
    const input = buildResumeRenderInput(
      { education_level: "below_10", education_field: "Electronics" },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.educationLevel).toBe("Below 10th");
    expect(input.educationField).toBe("Electronics");
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
    const input = buildResumeRenderInput(
      { role_label: "Tandoor Cook" },
      null,
      null,
      null,
      false,
      "worker",
    );
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
      false,
      "worker",
    );
    expect(input.canonicalRole).not.toBe("something the model wrote");
  });

  it("still resolves the taxonomy role when no label was captured", () => {
    // Every deterministic-pack profile is this shape — an id and no label — so the id arms
    // carry all of them and their résumés stay byte-identical (invariant #8).
    const input = buildResumeRenderInput(
      { canonical_role_id: "role_welder" },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.canonicalRole).toBe("Welder");
  });

  it("prints the trade in plain language when the interview named one", () => {
    // `trade` was hardcoded null on this branch because the deterministic résumé never printed
    // a trade line and the old container had nothing to fill one with. `domain_label` is that
    // source, and it reaches the `{{trade}}` slot every shipped template already carries.
    const input = buildResumeRenderInput(
      { domain_label: "Fabrication" },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.trade).toBe("Fabrication");
  });

  it("leaves the trade null when no interview named one", () => {
    // Deterministic-pack profiles have no `domain_label`, so their trade line stays absent
    // exactly as it is today — no invented industry (§11), no changed output (invariant #8).
    const input = buildResumeRenderInput(
      { canonical_role_id: "role_welder" },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.trade).toBeNull();
  });

  it("builds a summary from the labels when the trade is unknown", () => {
    const input = buildResumeRenderInput(
      { role_label: "Tandoor Cook", domain_label: "catering", experience: { total_years: 3 } },
      null,
      null,
      null,
      false,
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
      false,
      "worker",
    );
    expect(input.summary).toBe("Cooking.");
  });

  it("fabricates no summary when the model captured no labels", () => {
    // THE FAIL-CLOSED LEG. A sentence about a worker we know nothing about is worse than a
    // blank section — §11, and the same rule the trade branches already follow.
    const input = buildResumeRenderInput(
      { experience: { total_years: 3 } },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.summary).toBeNull();
  });

  it("appends the shift to the availability line", () => {
    const input = buildResumeRenderInput(
      { shift: "night", availability: { status: "immediate" } },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.availability).toBe("Available immediately · Night shift");
  });

  it("prints the shift alone when the status has no phrase", () => {
    // `unknown` yields no availability phrase, but "I work nights" is still an answer the worker
    // gave. The whole line used to collapse and take it down with it.
    const input = buildResumeRenderInput({ shift: "day" }, null, null, null, false, "worker");
    expect(input.availability).toBe("Day shift");
  });

  it("passes through a shift value outside the prompt's vocabulary", () => {
    // The wire type is a bare `str | None` with no Literal behind it. Dropping what we did not
    // anticipate is how the four keys got lost in the first place.
    const input = buildResumeRenderInput(
      { shift: "rotational" },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.availability).toBe("Rotational");
  });

  it("old snapshot without the keys renders exactly as before", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"] },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.canonicalRole).toBeNull();
    expect(input.summary).toBeNull();
    expect(input.availability).toBeNull();
  });
});

/**
 * ── #947: THE WORKER'S OWN NIGHT-SHIFT TOGGLE ──────────────────────────────────────────
 *
 * `workers.resume_night_shift_ready` is what the worker themselves ticked on the Edit-Resume
 * screen. The app shows it on the Resume tab; the PDF never carried it. The only "Night shift"
 * the PDF could print came from `shift` — the MODEL's reading of the interview — so a worker
 * who set the toggle and whose interview never mentioned shifts downloaded a résumé that said
 * nothing about the one preference they had gone out of their way to state.
 *
 * IT RIDES `{{availability}}`, WHICH ADDS NO TOKEN. A shipped `<id>.v<n>.html` is immutable by
 * the registry contract and v3 of all four families has now shipped, so a new
 * `{{night_shift_ready}}` slot would mean four more layouts and would render as nothing until
 * every one of them landed. `{{availability}}` prints on all twelve today.
 *
 * AND `false` PRINTS NOTHING — the trap the column sets, and the assertion this block exists
 * for. The column is `notNull().default(false)`, so "answered No" and "never opened the screen"
 * are the same stored byte; a "…: No" line would stamp a refusal onto the résumé of every
 * worker who has never seen the toggle. Only `true` speaks.
 */
describe("buildResumeRenderInput — the worker's night-shift toggle (#947)", () => {
  it("puts the worker's own answer on the résumé when they ticked it", () => {
    // THE REPORTED DEFECT. Nothing in this snapshot mentions a shift — the model never
    // extracted one — so before this the toggle had no way onto the page at all.
    const input = buildResumeRenderInput(
      { availability: { status: "immediate" } },
      null,
      null,
      null,
      true,
      "worker",
    );
    expect(input.availability).toBe("Available immediately · Night shift ke liye taiyaar");
  });

  it("humanises EVERY education level the universal pack can store (#963)", () => {
    // NOT a hand-picked sample: `qp_universal`'s education question offers exactly these five
    // `value_text`s, `answer-capture` stores the value_text, and the extraction processor copies
    // it onto the draft verbatim — so this is the complete set that can reach a PDF from the
    // deterministic path, which every worker walks. Only `below_10` used to be mapped, and the
    // prettifier could not rescue the rest: it leaves underscore-free values alone, so `10`, `12`
    // and `graduate` printed raw, and it title-cased `iti_diploma` into "Iti Diploma" — the
    // acronym-wrecking its own rule 3 exists to prevent.
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["below_10", "Below 10th"],
      ["10", "10th pass"],
      ["12", "12th pass"],
      ["iti_diploma", "ITI / Diploma"],
      ["graduate", "Graduate"],
    ];
    for (const [raw, label] of expected) {
      const input = buildResumeRenderInput(
        { education_level: raw },
        null,
        null,
        null,
        false,
        "worker",
      );
      expect(input.educationLevel).toBe(label);
    }
  });

  it("prints the toggle alone when nothing else fills the line", () => {
    // Same rule the model's `shift` already gets: an answer the worker gave is worth showing
    // even when the availability status yields no phrase of its own. The whole line used to
    // collapse and take it down with it.
    const input = buildResumeRenderInput({}, null, null, null, true, "worker");
    expect(input.availability).toBe("Night shift ke liye taiyaar");
  });

  it("says it once when the model extracted the same thing — keeping the STRONGER claim", () => {
    // Both clauses are about nights, so only one prints. Which one is the point: `shift: "night"`
    // says the worker WORKS nights, the toggle says they are WILLING to, and working nights
    // implies willingness. Dropping the fact to keep the intention — which is what this did
    // first — writes a strictly weaker résumé for exactly the population #947 exists for, and
    // does it on the payer disclosure too, which re-renders on every download.
    const input = buildResumeRenderInput(
      { shift: "night", availability: { status: "immediate" } },
      null,
      null,
      null,
      true,
      "worker",
    );
    expect(input.availability).toBe("Available immediately · Night shift");
  });

  it("still says it once when the model spelled nights differently", () => {
    // `shift` is a bare string on the wire with no Literal behind it — the `rotational` test in
    // this file exists because out-of-vocabulary values really arrive. A dedup comparing the RAW
    // token missed every one of these and printed "… · Night shift ke liye taiyaar" beside a
    // clause already saying nights: the one-fact-twice this rule exists to prevent.
    //
    // ASSERTED AS ABSENCE, NOT AS AN EXACT LINE, and deliberately. `humanizeShift` passes a value
    // it does not recognise through with only its first letter uppercased, so "NIGHT SHIFT" still
    // renders "NIGHT SHIFT". Whether the résumé should shout is a separate question about
    // `humanizeShift` that neither #947 nor #963 asks, and pinning the shouting here would make
    // this test fail the day someone fixes it. What must hold is that the toggle does not add a
    // second clause saying the same thing.
    for (const raw of ["night", "nights", "night shift", "NIGHT SHIFT", " Night Shift "]) {
      const input = buildResumeRenderInput(
        { shift: raw, availability: { status: "immediate" } },
        null,
        null,
        null,
        true,
        "worker",
      );
      expect(input.availability).not.toContain("Night shift ke liye taiyaar");
      expect(input.availability).toContain("Available immediately");
    }
  });

  it("prints BOTH when the model says a different shift — they are different facts", () => {
    // The mirror of the rule above, and the reason it is a dedup rather than a precedence chain.
    // "works days, willing to work nights" is two pieces of information and an employer needs
    // both; collapsing either would lose a signal the worker actually gave.
    const input = buildResumeRenderInput(
      { shift: "day", availability: { status: "immediate" } },
      null,
      null,
      null,
      true,
      "worker",
    );
    expect(input.availability).toBe(
      "Available immediately · Day shift · Night shift ke liye taiyaar",
    );
  });

  it("keeps the model's shift when it says something the toggle does not", () => {
    // NOT A CONTRADICTION — the whole signal. "I work days, and I am ready for nights" is two
    // separate answers by two different authors, and dropping either half would lose a real one.
    const input = buildResumeRenderInput({ shift: "day" }, null, null, null, true, "worker");
    expect(input.availability).toBe("Day shift · Night shift ke liye taiyaar");
  });

  it("NEVER prints a No the worker did not say", () => {
    // THE DEFAULT-FALSE TRAP, AND THE DESIGN CALL THIS BLOCK DEFENDS. `false` is not an answer:
    // the column is `notNull().default(false)`, so it is also what every worker who has never
    // opened the Edit-Resume screen carries, and they are the overwhelming majority. Printing
    // "Night shift ke liye taiyaar: No" for them would stamp a refusal they never gave onto the
    // one document whose entire purpose is to be handed to an employer — turning a fix for a
    // handful of workers into a regression for all the rest. So false says nothing, exactly as
    // `AVAILABILITY_PHRASES` says nothing for `not_looking`.
    //
    // This arm passes both before and after the change BY DESIGN — it pins the judgement, not
    // the feature. What breaks it is reverting the judgement: emitting a "Yes/No" line instead.
    const input = buildResumeRenderInput(
      { shift: "night", availability: { status: "immediate" } },
      null,
      null,
      null,
      false,
      "worker",
    );
    expect(input.availability).toBe("Available immediately · Night shift");
    expect(input.availability).not.toMatch(/taiyaar|\bNo\b/i);
  });

  it("reaches the LLM-led container path too, not just the legacy one", () => {
    // TWO PATHS, ONE TOGGLE. `resume_profile` wins outright when it carries values, and every
    // interview-led résumé takes that branch — a fix wired only into the legacy mapper would
    // miss exactly the workers being onboarded now.
    const input = buildResumeRenderInput(
      { resume_profile: { role_label: "VMC Operator", availability: "immediate" } },
      null,
      null,
      null,
      true,
      "worker",
    );
    expect(input.availability).toBe("Available immediately · Night shift ke liye taiyaar");
  });

  it("crosses to the payer's masked copy — a work preference is not identity", () => {
    // AUDIENCE CALL, MADE ON PURPOSE. `fromResumeProfile` already settled the same question for
    // the model's `shift`: a shift preference is legitimate matching information an employer
    // should see, and hiding it would cost the worker a real signal. This is the better-sourced
    // version of that signal. The salary assertion is the contrast — the audience gate is still
    // withholding what it is meant to withhold on the very same call.
    const input = buildResumeRenderInput(
      {
        resume_profile: {
          role_label: "VMC Operator",
          availability: "immediate",
          expected_salary: 40000,
        },
      },
      "A. K.",
      "classic",
      null,
      true,
      "employer",
    );
    expect(input.availability).toBe("Available immediately · Night shift ke liye taiyaar");
    expect(input.expectedSalary).toBeNull();
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
    buildResumeRenderInput(
      { resume_profile: { ...TRACE, ...over } },
      "Asha Kumari",
      "classic",
      null,
      false,
      audience,
    );

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
      experiences: [
        { role_label: "Helper", duration_text: "kuch saal", duration_months: null, work_done: "" },
      ],
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
    expect(build({ availability: "15_days", shift: null }).availability).toBe(
      "Available in 15 days",
    );
    expect(build({ availability: "1_month", shift: null }).availability).toBe(
      "Available in 1 month",
    );
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
      false,
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
      buildResumeRenderInput(snapshot, "Asha Kumari", "classic", null, false, "worker");

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

    it("still wins outright for every field it can express (R15 §1 narrowed this)", () => {
      // ── THE INVARIANT, RESTATED, BECAUSE R15 §1 CROSSED THE LINE THIS TEST USED TO DRAW ──
      //
      // It read: "a container holding one field wins whole — no merge, no precedence, no
      // field-by-field rescue from the legacy shape", and it offered `machines` and
      // `educationLevel` as the proof. That is stronger than the rule it was protecting, and it
      // was ALREADY FALSE when it was written: R9's `qualFactRows` reads the draft's
      // `educationHeadline` and `certifications` on this very branch. The two fields named here
      // simply happened to be ones R9 had not reached.
      //
      // WHAT THE RULE ACTUALLY PROTECTS is the bug this path replaced: reassembling the model's
      // object out of the old answer map, field by field, so that a value the model DID produce
      // gets outvoted or reshaped by a second source. That is untouched and is what the first
      // three assertions below pin — `role_label` and `skills` are container keys, the container
      // has them, and the legacy shape is not consulted for either even though it holds richer
      // content.
      //
      // WHAT R15 §1 CHANGED is the case where the container has NO WAY TO EXPRESS THE FIELD.
      // `ResumeProfileSchema` has nine keys; `machines`, `education`, `certifications`,
      // `education_level` and `education_field` are not among them and never will be, so there
      // is no model value to outvote and "the container wins" decided nothing — it just left
      // the slot empty. On `classic.v3` that collapsed an interview-led worker's whole
      // Education & Certifications section while the identical draft rendered it for a worker
      // whose interview never ran.
      //
      // `experienceYears` WAS ALREADY THIS EXACT CASE, granted an exception by name in R8 §1.
      // R15 §1 stops treating it as an exception and states the rule it was an instance of: a
      // container key wins outright; a slot the container cannot represent falls through to the
      // draft. Q16 asks whether the 2026-08-12 narrow-field-set ruling still holds in general —
      // that stays open, and does not need answering for a field the container cannot carry.
      const input = build({
        ...LEGACY,
        machines: ["mach_vmc"],
        resume_profile: { ...HOLLOW, role_label: "Fitter" },
      });
      // THE CONTAINER STILL WINS WHOLE where it can speak: `role_label` is set and beats the
      // legacy role, and `skills` is an EMPTY container key that is still respected rather than
      // rescued from the legacy shape's two entries.
      expect(input.canonicalRole).toBe("Fitter");
      expect(input.skills, "an empty container key is an answer, not a gap").toEqual([]);
      // AND THE SLOTS IT CANNOT EXPRESS NOW FALL THROUGH, instead of printing nothing.
      expect(input.educationLevel).toBe("10th");
      expect(input.machines).toEqual(["Vertical Machining Center (VMC)"]);
      expect(input.experienceYears).toBe(LEGACY.experience.total_years);
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
      false,
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

describe("Zone 5 on the résumé-container path (R5 §1.3)", () => {
  /** The path a worker whose interview ran actually takes. */
  const container = (over: Record<string, unknown> = {}) =>
    buildResumeRenderInput(
      {
        resume_profile: { role_label: "CNC Turner", availability: "immediate" },
        education_level: "iti_diploma",
        certifications: ["NCVT — Turner — 2015"],
        ...over,
      },
      "Ramesh Kumar",
      "bb_trade",
      null,
      false,
      "worker",
    );

  const row = (input: ReturnType<typeof buildResumeRenderInput>, label: string) =>
    (input.qualFactRows ?? []).find((r) => r.label === label);

  it("renders education from the draft the crosswalk already fills", () => {
    // This section rendered EMPTY for every worker whose interview ran. Not because the data
    // was missing — `education_level` rides the answer map onto the draft — but because this
    // path read only a caller-supplied block that no production caller sets.
    expect(row(container(), "Education")?.value).toContain("ITI");
  });

  it("renders certificates the same way", () => {
    expect(row(container(), "Certificates")?.value).toContain("NCVT");
  });

  it("leaves languages empty, because there is no column to read", () => {
    // Stated as a test so it reads as a known gap rather than a bug. `crosswalk.ts` records
    // `draftPath: null` for languages — it needs a capture surface, not a mapper change.
    expect(row(container(), "Languages spoken")).toBeUndefined();
  });

  it("lets a caller-supplied block WIN over the draft", () => {
    // The caller block is the worker's own structured answer and never passes through the
    // model, so it outranks anything derived. The fallback only fills the gap beneath it.
    const input = buildResumeRenderInput(
      {
        resume_profile: { role_label: "CNC Turner", availability: "immediate" },
        education_level: "iti_diploma",
      },
      "Ramesh Kumar",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: {},
        qualification: { educationHeadline: "ITI — Turner — NCVT" },
      },
    );
    expect(row(input, "Education")?.value).toBe("ITI — Turner — NCVT");
  });

  it("collapses the section when the worker declared nothing", () => {
    const input = container({ education_level: null, certifications: [] });
    expect(row(input, "Education")).toBeUndefined();
    expect(row(input, "Certificates")).toBeUndefined();
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * R8 §1 — the total that prints is the worker's own stated figure.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED ON THE R7 PERSONA RUN, not reasoned about. Against workers who stated 2, 5, 8 and 12
 * years, the container path's summed headline read "duration not stated", "1 yr 8 mo",
 * "5 yrs 4 mo" and "9 yrs 11 mo". §5.1 ranks total experience third and the Verdict Line first.
 */
describe("R8 §1 — total years prefers the mandatory ask over the sum beneath it", () => {
  const containerWith = (months: (number | null)[]) => ({
    role_label: "CNC Setter cum Operator",
    experiences: months.map((m, i) => ({
      role_label: `Job ${i}`,
      duration_text: "",
      duration_months: m,
      work_done: "turning",
    })),
  });

  it("prints the STATED figure, not the sum of the model's months", () => {
    const input = buildResumeRenderInput(
      { experience: { total_years: 8 }, resume_profile: containerWith([36, 16, 12]) },
      "Ramesh Yadav",
      "bb_trade",
      null,
      false,
      "worker",
    );
    // The sum is 64 months = 5.3 years; he said eight.
    expect(input.experienceYears).toBe(8);
    expect(input.headlineLine).toContain("8 yrs");
    expect(input.headlineLine).not.toContain("5 yrs");
  });

  it("prints the STATED figure even when NO employment carries months at all", () => {
    // Persona 2's exact shape: `duration_months: null` on his only job, and the headline read
    // "duration not stated" for a man whose second sentence was "Do saal ho gaye".
    const input = buildResumeRenderInput(
      { experience: { total_years: 2 }, resume_profile: containerWith([null]) },
      "Vikas Chauhan",
      "bb_trade",
      null,
      false,
      "worker",
    );
    expect(input.experienceYears).toBe(2);
    expect(input.headlineLine).not.toContain("duration not stated");
  });

  it("falls back to the sum ONLY when nothing was stated", () => {
    const input = buildResumeRenderInput(
      { experience: {}, resume_profile: containerWith([36]) },
      "Ramesh Yadav",
      "bb_trade",
      null,
      false,
      "worker",
    );
    expect(input.experienceYears).toBe(3);
  });

  it("still says 'duration not stated' when there is genuinely no source", () => {
    // §11 #3 survives intact. What is gone is the case where he answered and the sheet said
    // nobody asked — not the case where nobody did.
    const input = buildResumeRenderInput(
      { experience: {}, resume_profile: containerWith([null]) },
      "Ramesh Yadav",
      "bb_trade",
      null,
      false,
      "worker",
    );
    expect(input.experienceYears).toBeNull();
    expect(input.headlineLine).toContain("duration not stated");
  });

  it("does NOT let the sum raise a total above what the worker claimed", () => {
    // §8.3's asymmetry rule cuts both ways. `Math.max` would satisfy the "never below" floor and
    // print six years for a man who said five — resolving an ambiguity upward, which is the one
    // direction the guideline forbids.
    const input = buildResumeRenderInput(
      { experience: { total_years: 5 }, resume_profile: containerWith([48, 24]) },
      "Ramesh Yadav",
      "bb_trade",
      null,
      false,
      "worker",
    );
    expect(input.experienceYears).toBe(5);
  });

  it("keeps the headline and the summary telling the SAME story", () => {
    // Two call sites once computed the tenure independently. A sheet reading "8 yrs" at the top
    // and "with 5 years of experience" three lines down is worse than either number alone.
    const input = buildResumeRenderInput(
      { experience: { total_years: 8 }, resume_profile: containerWith([36, 16, 12]) },
      "Ramesh Yadav",
      "bb_trade",
      null,
      false,
      "worker",
    );
    expect(input.summary).toContain("8 years");
  });
});
