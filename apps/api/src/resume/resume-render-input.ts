import { DraftProfileSchema, resumeProfileCarriesValues } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import { looksLikePii } from "@badabhai/validators";
import type { ResumeExperienceLine, ResumeRenderInput } from "./resume-renderer.service";
import { resolveTradeContent, type TradeContent } from "./trade-content";
import { buildTradeCapabilityRows, type WorkerAttributeValues } from "./trade-resume-map";
import { degradeToFit, fitOwnWords } from "./resume-degradation";
import { buildEmploymentBlock, type WorkerEmploymentRecord } from "./resume-employment-rows";
import { readPreferenceFacts, type ResumePreferenceFacts } from "./resume-preference-facts";
import { selectOwnWords } from "./resume-own-words";
import { formatWorkerPhone } from "./resume-phone";
import { buildFresherRows } from "./resume-fresher-rows";
import { applyTranscriptVeto } from "./resume-transcript-veto";
import {
  bareAvailability,
  bareAvailabilityLabel,
  buildAvailabilityRows,
  buildDocumentRows,
  buildQualificationRows,
  buildVerdictLine,
  formatSalaryBand,
} from "./resume-sheet-rows";

/**
 * Pure snapshot → {@link ResumeRenderInput} mapping (NO LLM, NO I/O, NO DI).
 *
 * Extracted from the resume-render worker so BOTH the worker's-own render
 * (resume-render.processor.ts) and the EMPLOYER-facing masked disclosure
 * (disclosures/resume-disclosure.service.ts) build the renderer input the SAME way.
 * The ONLY difference between the two is the `displayName` the caller passes:
 *   - worker's own copy  → the decrypted real name (TD21);
 *   - employer disclosure → `maskInitials(realName)` (decision eafcccc, gate B-G).
 *
 * The snapshot is the stored, NAME-FREE `sourceProfileSnapshot` (a DraftProfile).
 * `displayName` is the ONLY identifying field and is supplied by the caller — it is
 * never derived from the snapshot, and this function never logs/throws on it.
 *
 * ADR-0032: `photoDataUri` follows the exact same caller-supplied contract — and it
 * is a REQUIRED parameter (no default) so both call-sites are explicit: the worker's
 * own render passes the fetched photo; the masked disclosure passes null. Deriving
 * the photo INSIDE this function is the one shape that would leak it into the
 * disclosure automatically (shared mapper, shared templates) — never do that.
 *
 * #947: `nightShiftReady` is the worker's OWN answer to "Night shift ke liye taiyaar?", read
 * from `workers.resume_night_shift_ready` by the caller. It is the one input here that does NOT
 * come from the snapshot, and deliberately so — it is a résumé PREFERENCE the worker edits
 * directly on the Edit-Resume screen, not something an interview extracted, and it lives on the
 * worker row precisely so it survives profile regeneration. It is REQUIRED and undefaulted for
 * the same reason `photoDataUri` is: #947's closing acceptance line is "value must never be
 * dropped in future", and a parameter the compiler demands is the only form of that sentence a
 * future call site cannot forget. Both call sites already load the worker row for the name, so
 * threading it costs no query.
 */
/**
 * Who is going to read this résumé.
 *
 * `"worker"` is their own copy; `"employer"` is the payer-facing masked disclosure. The two
 * already differed by `displayName` (real vs `maskInitials`) and `photoDataUri` (present vs
 * structurally null) — both enforced by convention at the call site. Naming the audience makes
 * that a parameter the compiler requires rather than a rule a future call site can forget, and
 * gives every later "workers see this, payers do not" field one place to key off.
 */
export type ResumeAudience = "worker" | "employer";

/**
 * The role pack's answers, for the `bb_trade` sheet's first section.
 *
 * OPTIONAL, UNLIKE `photoDataUri` AND `nightShiftReady`, and the difference is what each one
 * costs when a call site forgets it. Forgetting the photo LEAKS it into a payer-facing
 * disclosure; forgetting `nightShiftReady` silently discards a preference the worker set by
 * hand. Forgetting this produces ABSENCE — the capability section collapses, exactly as it does
 * for the 140-odd trades with no map yet, and every other layout is unaffected because none of
 * them carries these slots. Absence is the correct default here, so the compiler is not the
 * right place to enforce it, and making it required would rewrite 41 existing call sites to say
 * `null`.
 *
 * `attributes` is the raw `worker_attributes` map. The slug→English dictionary lives in
 * `trade-resume-map.ts` and is applied INSIDE this function, on both paths, for the same reason
 * the masking branch is inside it: a mapping done at the call site is a mapping one call site
 * can do differently.
 */
export interface TradeSheetContext {
  /** The pack the interview ran, e.g. `qp_cnc_turning`. Null disables the section. */
  readonly packId: string | null;
  readonly attributes: WorkerAttributeValues;

  /**
   * The worker's number, DECRYPTED BY THE CALLER — exactly the contract `displayName` has, and
   * for exactly the same reason: the ciphertext lives on the worker row, the key lives in the
   * PII service, and this function is pure. It prints on BOTH audiences by owner ruling
   * 2026-08-28; a sheet handed over at a factory gate is useless without a number, and the
   * payer copy is only ever produced after an unlock. Never logged, never echoed into an error.
   */
  readonly phone?: string | null;
  /**
   * The name in Devanagari. AUDIENCE-GATED INSIDE THIS FUNCTION, not at the call site.
   *
   * The design guideline (§11 #17) says Latin on the employer-facing artifact and BOTH scripts
   * on the worker's own copy. That is a rule about the artifact rather than about the caller, so
   * it is enforced here where it cannot be forgotten — the same argument that puts the name
   * masking inside this function.
   */
  readonly nameDevanagari?: string | null;
  /** The verification tier, printed verbatim. Absent collapses the masthead's right slot. */
  readonly trustBadge?: string | null;

  /**
   * ZONE 4 — the two-level work history, employer names already DECRYPTED by the caller.
   *
   * SAME CONTRACT AS `phone`, and for the same reason: the ciphertext is on the row, the key is
   * in the PII service, and this function is pure. Absent or empty is the ordinary case today —
   * nothing writes `worker_employment` yet — and it selects the fallback below rather than an
   * empty section.
   */
  readonly employments?: readonly WorkerEmploymentRecord[];
  /**
   * The render clock, for closing an open-ended employment ("Jan 2023 – Present · 3 yrs 8 mo").
   *
   * OPTIONAL, AND ITS ABSENCE IS HONEST RATHER THAN A DEFAULT. Without a clock the span still
   * prints "Jan 2023 – Present" and the months tail is simply absent, because a tenure figure is
   * a number and §8 forbids printing one nobody can source. Defaulting to `new Date()` inside
   * this function would also make it impure and its output untestable.
   */
  readonly asOf?: Date | null;

  /**
   * ZONE 5 — Qualification, documents and languages.
   *
   * CALLER-SUPPLIED FOR THE SAME REASON THE CAPABILITY BLOCK IS PACK-SUPPLIED: the résumé
   * container Phase C returns has no education, certificate or language fields, so on that path
   * this section rendered EMPTY for every worker whose interview ran. Widening Phase C is a
   * separate item against a different surface (see docs/resume-engine-r1-journal.md); this slot
   * is what lets Zone 5 render the moment any source can fill it, including the seeded fixtures
   * the block is verified against.
   *
   * PII-FREE BY CONTRACT. Education levels, certificate names, languages and document names are
   * closed-vocabulary qualification labels — never a person, a number or an address.
   */
  readonly qualification?: ResumeQualificationFacts;

  /**
   * THE WORKER'S OWN STORED TURNS, verbatim, loaded by the caller — nothing the assistant said.
   *
   * SAME CONTRACT AS `employments` AND `phone`: the rows live in `chat_messages`, this function
   * is pure, so the caller reads them and hands them in. Absent is the ordinary case for a
   * profile whose interview predates the chat store, and it collapses the own-words block rather
   * than failing the render.
   *
   * IT IS A VETO INPUT, NOT A CONTENT INPUT. Nothing here is printed because it is here — see
   * `resume-own-words.ts`. The extraction proposes a phrase; this decides whether the worker
   * actually said it. Raw transcript is the only thing that can answer that question, which is
   * why it crosses this boundary at all.
   */
  readonly workerSaid?: readonly string[];

  /** Footer: a self-contained `data:` URI from `resume-qr.ts`. Never a URL. */
  readonly qrDataUri?: string | null;
  readonly qrCaption?: string | null;
  readonly shortLink?: string | null;
  /** "Generated 27 August 2026 · Self-declared · Ref RK8M2Q" — composed by the caller. */
  readonly footerMeta?: string | null;
}

/** Zone 5's values. Every field optional; an absent one contributes no row. */
export interface ResumeQualificationFacts {
  /** "ITI — Turner" — the single leading line, never a heading of its own (§11 #2). */
  readonly educationHeadline?: string | null;
  readonly education?: readonly string[];
  readonly certifications?: readonly string[];
  readonly languages?: readonly string[];
  /**
   * Documents the worker SAYS they hold. Self-declared, rendered as a tick row.
   *
   * §5.1 ranks this ninth of eleven because it removes the most common walk-in failure before
   * it happens. It is a claim by the worker and is never a verification signal — the masthead
   * badge is the only thing that speaks to verification, and it is separate.
   */
  readonly documents?: readonly string[];
}

/** The `bb_trade` slots built once above the source branch and shared by both paths. */
type TradeCapabilitySlots = Pick<
  ResumeRenderInput,
  | "capSectionTitle"
  | "capChipRows"
  | "capTickRows"
  | "capFactRows"
  | "qualTickRows"
  | "employments"
  | "employmentsMore"
  | "phone"
  | "nameDevanagari"
  | "trustBadge"
  | "qrDataUri"
  | "qrCaption"
  | "shortLink"
  | "footerMeta"
  // Provenance rather than content, but it rides the shared slots for the same reason the rest
  // do: both source branches must carry it, and a field set on only one of them is the shape
  // that goes missing for exactly the workers nobody renders in a test.
  | "transcriptVetoes"
  | "ownWordsRejected"
>;

/**
 * Build the render input, then SHED WHATEVER WILL NOT FIT ON ONE PAGE.
 *
 * THE WRAPPER IS THE POINT. `buildUndegraded` below has two return paths — the résumé container
 * and the legacy answer-map shape — and every caller (the worker's own render worker and the
 * payer disclosure) goes through this one door. Applying the ladder at each `return` instead
 * would be two places to forget it, and the one that got forgotten would ship two-page PDFs for
 * exactly the profiles nobody tests.
 */
export function buildResumeRenderInput(
  snapshot: unknown,
  displayName: string | null,
  templateId: string | null,
  photoDataUri: string | null,
  nightShiftReady: boolean,
  audience: ResumeAudience,
  tradeSheet?: TradeSheetContext | null,
): ResumeRenderInput {
  const built = buildUndegraded(
    snapshot,
    displayName,
    templateId,
    photoDataUri,
    nightShiftReady,
    audience,
    tradeSheet,
  );
  // THE LADDER RUNS BLIND TO THE QUOTES, deliberately. If `built.ownWords` were in scope here,
  // a worker with three quotes and one line of overflow would have the ladder drop his LANGUAGES
  // row — a §5.1-ranked fact — to make room for a quote that ranks nowhere. Zeroed going in,
  // re-fitted after: ranked content settles first and the quotes take what is left.
  const { sheet, stage, dropped, trace } = degradeToFit({ ...built, ownWords: [] });
  // §8.4's quotes go in LAST, into whatever room is left after the ranked content has settled —
  // see `fitOwnWords`. `built.ownWords` holds everything that earned the right to print; this
  // decides how much of it the page can afford, and a sheet already at the budget affords none.
  return {
    ...fitOwnWords(sheet, built.ownWords ?? []),
    degradationStage: stage,
    degradationDropped: dropped,
    degradationTrace: trace,
  };
}

function buildUndegraded(
  snapshot: unknown,
  displayName: string | null,
  templateId: string | null,
  photoDataUri: string | null,
  nightShiftReady: boolean,
  audience: ResumeAudience,
  tradeSheet?: TradeSheetContext | null,
): ResumeRenderInput {
  const draft = DraftProfileSchema.parse(snapshot ?? {});

  // COMPUTED BEFORE THE BRANCH, and that placement is the point. This function has two return
  // paths — the résumé container and the legacy answer-map shape — and a worker reaches one or
  // the other depending on whether their interview ran. Building the capability block inside
  // either one would give half the workers a blank first section on a sheet whose whole purpose
  // is that section, and nothing would report it.
  //
  // AUDIENCE-BLIND, DELIBERATELY. A capability block is what the worker can do on a machine; it
  // is trade information rather than identity or negotiating position, so it crosses to the
  // payer on the same reasoning `shift` and `nightShiftReady` already do. The three things this
  // function withholds from a payer stay exactly three: the real name, the photo, the salary.
  // THE TRANSCRIPT VETO RUNS BEFORE ANY ROW IS BUILT (R8 §4), so a withdrawn claim cannot reach
  // the capability block, the headline tools, or the "already printed" set the quotes de-dupe
  // against. Placing it here rather than at each read site is the same argument the name masking
  // makes: one door, and no call site that can forget.
  const { attributes: vettedAttributes, vetoes: transcriptVetoes } = applyTranscriptVeto({
    attributes: tradeSheet?.attributes ?? {},
    workerSaid: tradeSheet?.workerSaid ?? [],
  });
  const capability = buildTradeCapabilityRows(tradeSheet?.packId, vettedAttributes);
  // THE FINISHING FORM'S ANSWERS (R6 §4), off the SAME attribute bag the capability block reads.
  // Trade-independent, so they are read once here rather than per pack — and read above the
  // branch, because both the résumé container and the legacy shape need them and neither one
  // carries them. `languages` in particular has no draft column at all (`crosswalk.ts` records
  // `draftPath: null`), so this is the only source it will ever have.
  const preferences = readPreferenceFacts(vettedAttributes);
  // ZONE 4 IS BUILT HERE FOR THE SAME REASON, and it also decides which of the two work-history
  // regions the template renders. `employments` is the designed two-level shape; `experiences`
  // is the flat, employer-less shape every profile in the database actually has today. The
  // mapper populates exactly ONE — see the suppression at each return path — so a worker can
  // never get both a dated employer block and an undated duplicate of the same job.
  const employmentBlock = buildEmploymentBlock(tradeSheet?.employments ?? [], {
    asOf: tradeSheet?.asOf ?? null,
  });
  const hasEmployments = employmentBlock.employments.length > 0;
  // ZONE 4 FOR A FRESHER (R10 §2.6). §11 #1 puts training, trade test, workshop machines and
  // project work here and forbids an empty History heading — and persona 1, an ITI pass-out,
  // measured 125 mm of blank page because nothing in the corpus asked a fresher any of it.
  //
  // ONLY WHEN THERE IS NO REAL HISTORY. A worker with employment rows gets those; this is the
  // other branch of the one-or-the-other rule Zone 4 already follows, not a third source competing
  // with them.
  const fresherRows = hasEmployments ? [] : buildFresherRows(vettedAttributes);
  const capabilitySlots = {
    capSectionTitle: capability.sectionTitle,
    capChipRows: capability.chipRows,
    capTickRows: capability.tickRows,
    capFactRows: capability.factRows,
    // Documents are a self-declared tick row and are audience-blind, exactly like the capability
    // block: "I hold an Aadhaar card and an ITI certificate" is what removes a walk-in failure
    // (§5.1 rank 9), it is not identity and it carries no number.
    // R6 §4: the caller-supplied block still wins where it has one, and the FORM is the source
    // behind it for every real worker — nothing in the 143-pack corpus asks for a document, so
    // before the finishing form this row could not render for anybody.
    qualTickRows: buildDocumentRows(tradeSheet?.qualification?.documents ?? preferences.documents),
    employments: employmentBlock.employments,
    employmentsMore: employmentBlock.employmentsMore,
    // FORMATTED HERE, INSIDE THE MAPPER, so no call site can print an unformatted number and
    // no fixture can show a grouping the product does not produce (R10 §2.4).
    phone: formatWorkerPhone(tradeSheet?.phone),
    // §11 #17 — LATIN ONLY ON THE EMPLOYER ARTIFACT. Structural, like the photo: a caller
    // cannot put the Devanagari line on a payer-facing sheet by passing it, because the rule
    // lives here rather than at the call site.
    nameDevanagari: audience === "worker" ? (tradeSheet?.nameDevanagari ?? null) : null,
    trustBadge: tradeSheet?.trustBadge ?? null,
    qrDataUri: tradeSheet?.qrDataUri ?? null,
    qrCaption: tradeSheet?.qrCaption ?? null,
    shortLink: tradeSheet?.shortLink ?? null,
    footerMeta: tradeSheet?.footerMeta ?? null,
    transcriptVetoes,
  } as const;

  // ── THE RÉSUMÉ CONTAINER WINS OUTRIGHT WHEN IT EXISTS ────────────────────────────────
  //
  // Not a merge and not a fallback chain: when the LLM-led interview produced a Phase C
  // object, the résumé is built from THAT and the legacy shape below is not consulted at all.
  // Mixing them is what this change exists to stop — every reassembly step between the model's
  // nine keys and the old container was a place a value got dropped, outvoted or reshaped.
  //
  // THE OLD PATH IS STILL REACHED, and must be: `resume_profile` is null for every profile
  // written before this shipped and for every deterministic-only extraction, and those résumés
  // have to keep rendering exactly as they do today (invariant #8). Null means "there was no
  // interview", never "the interview was empty".
  //
  // AND "EMPTY" IS A THIRD STATE THAT PRESENCE ALONE CANNOT SEE — the bug this guard exists
  // for. `/profiling/extract` answers four of its own degrades with a healthy 200 carrying an
  // EMPTY object, `is_mock` is one of them, and TD81 records that staging runs mocked. Every
  // key on `ResumeProfileSchema` is `.default()`ed, so that response parses into a container
  // that is fully-defaulted and TRUTHY. Taken as "the interview landed", this branch then
  // discarded a perfectly good answer-map profile and rendered a résumé carrying nothing but
  // the worker's name — a PDF that generates successfully and is blank.
  //
  // NOT A MERGE, AND THE DISTINCTION IS THE WHOLE POINT. The container's rule — no merge, no
  // precedence, no derivation — governs the VALUES INSIDE it, and it is untouched: when the
  // container carries anything it still wins outright and is still rendered one-for-one, so it
  // can still be diffed against the Langfuse trace. This asks the question one level up, and
  // it is a question about the container rather than about any value in it: is this a record of
  // an interview at all? An object holding nine empty fields is not, so it selects a SOURCE —
  // all of one or all of the other — and never blends the two.
  //
  // BOTH CALLERS GET THIS AUTOMATICALLY — the worker's own render and the employer-facing
  // masked disclosure share this function, differing only by the `displayName` they pass. The
  // branch is inside, so masking cannot be forgotten on the new path.
  // HOISTED ABOVE THE BRANCH so BOTH paths can use it. It is derived from `education_level` and
  // `education_field`, which the answer-map crosswalk DOES carry onto the draft
  // (`crosswalk.ts:45-46`) — so the container path had a real source for Zone 5's education row
  // all along and was reading only the caller-supplied block, which no production caller sets.
  //
  // R9 §3 — THE FOUR-COMPONENT CREDENTIAL, and it is composed from TWO surfaces on purpose.
  // The ratified sheet prints "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad": the level
  // and the trade are asked in the interview and ride the crosswalk onto the draft; the council,
  // the year and the institute are the finishing form's, because none of the three needs a model
  // and a closed council set is the only way §4.5's "never collapse NCVT and SCVT" can be
  // enforced at all. The em-dash joins the level to the trade, exactly as the sample does; the
  // middot joins everything after it. Each segment takes its own separator with it when absent,
  // so a worker who answered only the level still gets "ITI" and nothing else.
  const educationHeadline =
    [
      [
        educationLevelText(draft.education_level, preferences.educationCredential),
        draft.education_field,
      ]
        .map((v) => v?.trim())
        .filter((v): v is string => Boolean(v))
        .join(" — ") || null,
      preferences.educationDetail,
    ]
      .filter((v): v is string => Boolean(v))
      .join(" · ") || null;

  if (resumeProfileCarriesValues(draft.resume_profile)) {
    return fromResumeProfile(
      draft.resume_profile,
      displayName,
      templateId,
      photoDataUri,
      nightShiftReady,
      audience,
      capabilitySlots,
      capability.headlineTools,
      tradeSheet?.qualification,
      hasEmployments,
      { educationHeadline, certifications: draft.certifications },
      preferences,
      // THE MANDATORY UNIVERSAL ASK, reaching the container path for the first time. It rides
      // the answer map onto the draft (`profile-extraction.processor.ts` → `experience`), which
      // is why it is read here rather than inside the branch: the container has no such field.
      draft.experience.total_years,
      tradeSheet?.workerSaid ?? [],
      fresherRows,
    );
  }

  const trade = resolveTradeContent(draft.canonical_role_id, draft.canonical_trade_id);
  const legacyRole =
    trade?.display_name ?? resolveId(draft.canonical_role_id) ?? draft.role_label ?? null;
  const legacyCity =
    draft.location_preference.current_city ?? draft.location_preference.preferred_cities[0] ?? null;
  const legacyMachines = draft.machines.map(labelForTaxonomyId);
  const legacyAvailability = bareAvailability(draft.availability);
  // AUDIENCE-GATED HERE, not at the row, so the payer copy cannot acquire the worker's asking
  // price by someone adding a second call site. Same rule and same shape as the container path.
  // R10 R-1 — THE LIVE DEFECT THIS FIXES. `amount_min` was written by TWO writers with OPPOSITE
  // meanings: `profile_extractor.py:_build_legacy` put the worker's CURRENT pay in it while the
  // TypeScript projection put his EXPECTED pay there. This line prints it under the label
  // "expects", so on every profile written by the ai-service the sheet advertised a man's current
  // wage as his asking price — persona 2 saying "abhi 14 hazaar mil rahe hain, 16 chahiye" would
  // have printed `expects ₹14,000`, negotiating against him on his own résumé.
  //
  // The Python writer is corrected in the same packet (`amount_min` is now the expected figure and
  // current pay goes to `current_salary`, its own field on the rich draft). This side reads the
  // band, so a worker who answered both ends gets a range and one who answered neither gets no row
  // — §8.4's "a field with no value collapses", never a wrong number.
  const legacySalary =
    audience === "worker"
      ? formatSalaryBand(draft.salary_expectation.amount_min, draft.salary_expectation.amount_max)
      : null;

  return {
    ...capabilitySlots,
    // THE VERDICT LINE AND THE TWO LOWER SECTIONS ARE BUILT ON BOTH PATHS, and this is the
    // path most existing profiles still take. Composing them only on the résumé-container
    // branch would have left every pre-interview worker with an empty headline strip on a
    // layout whose top 22% exists to carry exactly that line.
    ...buildVerdictLine({
      role: legacyRole,
      years: draft.experience.total_years,
      // The pack's own headline row when the interview ran one, else the taxonomy machines.
      tools: capability.headlineTools.length > 0 ? capability.headlineTools : legacyMachines,
      city: legacyCity,
      availability: legacyAvailability,
      salary: null,
    }),
    availFactRows: buildAvailabilityRows({
      availability: legacyAvailability,
      // WAS HARD `null`, AND IT SHOULD NOT HAVE BEEN. `salary_expected` is a universal pack ask
      // on every interview, the crosswalk carries it onto the draft, and the extraction
      // projection scatters it into `salary_expectation.amount_min` — so the figure was captured,
      // stored, and then dropped at the last step on the branch a deterministic worker actually
      // takes. §5.1 makes salary one of the four things that reject a candidate outright.
      //
      // SUPPRESSED ON THE PAYER COPY, exactly as the container path suppresses it.
      salary: legacySalary,
      preferredLocations:
        preferences.preferredLocations.length > 0
          ? preferences.preferredLocations
          : draft.location_preference.preferred_cities,
      // WAS HARD `null` TOO, for the same class of reason: `shift_preference` is asked by
      // `qp_universal` and lands in `worker_attributes`, and this branch never read it.
      shift: preferences.shiftLine,
      willingToRelocate: preferences.willingToRelocate,
      accommodationNeeded: preferences.accommodationNeeded,
    }),
    // ZONE 5. The context WINS PER FIELD where it has one, because it is the worker's own
    // structured answer and the snapshot's is a taxonomy id the extractor guessed at. It is a
    // per-field override rather than an all-or-nothing swap: `languages` exists ONLY on the
    // context and education exists only on the snapshot for every profile written before the
    // capture surface, so an all-or-nothing rule would blank one of the two whichever way it
    // fell. `??` and not `||` — an explicitly empty list is a real answer ("no certificates")
    // and must not fall through to the snapshot's.
    qualFactRows: buildQualificationRows({
      educationHeadline: tradeSheet?.qualification?.educationHeadline ?? educationHeadline,
      education: tradeSheet?.qualification?.education ?? draft.education.map(labelForTaxonomyId),
      certifications:
        tradeSheet?.qualification?.certifications ?? draft.certifications.map(labelForTaxonomyId),
      languages: tradeSheet?.qualification?.languages ?? preferences.languages,
    }),
    // UNCHANGED ON THE LEGACY PATH. These three are new render-input fields, and the old
    // container has nothing to put in them: no work history exists outside Phase C, and the
    // deterministic résumé never printed a trade line or a salary. Empty/null keeps every
    // pre-existing résumé byte-identical to what it renders today (invariant #8).
    //
    // `trade` IS THE ONE THAT NOW HAS A SOURCE. It was null because the deterministic résumé
    // never printed a trade line and nothing on the old container could fill one — but
    // `domain_label` is on this shape too, and it is exactly "the worker's trade in plain
    // language". It is null on every deterministic-pack profile, so those résumés are
    // unchanged; it fires for a profile whose interview ran but whose container came back
    // empty, which is the case that reaches this branch with labels in hand.
    trade: draft.domain_label,
    // R10 §2.6 — the fresher's Zone 4 reaches BOTH branches. A pass-out whose interview never ran
    // is exactly the worker most likely to be on this path.
    experiences: fresherRows,
    preferredLocations: [],
    expectedSalary: null,
    templateId,
    displayName,
    photoDataUri,
    // Prefer the recruiter-readable trade title; else resolve the role id to its
    // display name (never print a raw `role_*` id — e.g. role_welder / the generic
    // role_cnc_operator have no trade content but DO resolve via the taxonomy).
    //
    // `role_label` IS THE LAST RESORT, AND ON THE LLM-LED PATH IT IS THE ONLY ONE THAT FIRES.
    // `toExtractionOutput` hardcodes both canonical ids to null — deliberately, since inventing
    // a taxonomy id would put an unvalidated value in the one place the match engine trusts
    // absolutely — so `trade` is undefined and `resolveId` returns null for EVERY OIE-path
    // profile. `{{headline}}` therefore rendered EMPTY on every resume the LLM-led interview
    // produced: the model named the role, the column held it, and the PDF had no job title.
    //
    // LAST RESORT IS THE ORDER THE 2026-08-13 CANONICAL-ID RETIREMENT KEPT, not one it missed.
    // The labels became the source wherever an id is absent — which is every interview-led
    // profile — but a reviewed taxonomy value still outranks model free text where both exist
    // (§3), and that is what keeps invariant #8 a property of this expression rather than an
    // accident of who currently writes which field.
    //
    // A free-text label, never a taxonomy id, so it can only ever reach the printed headline —
    // matching and ranking still read the canonical ids, which stay null.
    canonicalRole: trade?.display_name ?? resolveId(draft.canonical_role_id) ?? draft.role_label,
    // Issue #423 — the worker's CURRENT city is what belongs on a résumé, and it now
    // has its own field. The `preferred_cities[0]` fallback is NOT dead code: before
    // the split the current city was prepended to that list, so for every profile
    // extracted before this change it is still the only place the city exists.
    // Dropping the fallback would blank the location line on all of them.
    location:
      draft.location_preference.current_city ??
      draft.location_preference.preferred_cities[0] ??
      null,
    experienceYears: draft.experience.total_years,
    // #947 — the worker's own night-shift toggle joins the model's extracted shift on this one
    // slot. `false` contributes nothing at all, so every row still sitting on the column's
    // default renders this line byte-for-byte as it does today; see `humanizeAvailability`.
    availability: humanizeAvailability(draft.availability.status, draft.shift, nightShiftReady),
    summary: buildSummary(draft, trade),
    // Q14: canonical skill NAMES first (ids resolved to display labels — the résumé
    // must never show skill_* ids), then the worker-confirmed raw labels (deduped).
    // The snapshot labels were extraction-clamped and are pseudonymize-gated by the
    // AI service at résumé generation; this is a pure render mapping (no LLM here).
    skills: mergeSkillsWithLabels(
      draft.skills.map(labelForTaxonomyId),
      draft.skill_labels.map(labelForTaxonomyId),
    ),
    // Machines are `mach_*` ids on the snapshot — resolve each to its name (VMC, HMC).
    machines: draft.machines.map(labelForTaxonomyId),
    // #499 — education + certifications now ride on the DraftProfile snapshot
    // (closed-set canonical tokens: ITI/Diploma/Degree, NCVT/NSQF/…), so the
    // templates' "Education & Certifications" section renders instead of collapsing.
    // Old snapshots lack the keys → DraftProfileSchema defaults them to [] (invariant
    // #8). Controllers still aren't on the snapshot; they stay empty (no fabrication).
    // Responsibilities are TRADE-level copy.
    controllers: [],
    // Highest academic level + stream, carried on the DraftProfile snapshot beside
    // the education list. Rendered as a single leading line in the Education section.
    // Old snapshots lack the keys → DraftProfileSchema defaults them to null
    // (invariant #8). PII-free qualification labels.
    //
    // #963 — THE LEVEL IS HUMANISED ON THE WAY OUT; THE FIELD IS NOT. `education_level` is free
    // text the extractor writes and it can be a raw token, so it used to reach
    // the page VERBATIM and print "below_10" on a worker's résumé — it reaches the `{{#education_headline}}` region (`resume-renderer.service.ts` joins level and field into it),
    // not a scalar token of its own — see
    // `humanizeEducationLevel`. `education_field` is a stream the model writes in words
    // ("Electronics"), has no token vocabulary to translate, and reshaping it could only ever
    // re-case a value that was already right.
    educationLevel: humanizeEducationLevel(draft.education_level),
    educationField: draft.education_field,
    // Resolve any taxonomy IDs that may have leaked into education/certifications
    // from the LLM extraction path — mirrors the worker app's replaceTaxonomyIds().
    education: draft.education.map(labelForTaxonomyId),
    certifications: draft.certifications.map(labelForTaxonomyId),
    responsibilities: trade ? [...trade.responsibilities] : [],
  };
}

/**
 * ── THE LLM-LED RÉSUMÉ ────────────────────────────────────────────────────────────────
 *
 * Nine fields in, a résumé out. No taxonomy lookup, no answer map, no merge — the container
 * was written to be renderable, so this reads it and humanises at the edge.
 *
 * WHAT IS DELIBERATELY ABSENT, and it is a real cost the owner accepted (2026-08-12):
 * `machines`, `controllers`, `education`, `educationLevel`, `educationField`, `certifications`
 * and `responsibilities` are all empty here. Those come from the answer map's fifteen
 * crosswalk fields, and Phase C returns nine. The interview still captures several of them and
 * they still persist on `DraftProfile` — they are simply not rendered on this path yet. The
 * plan is to widen Phase A and the template tail so the fields arrive HERE, rather than to
 * merge two sources back together and reintroduce the bug this replaced.
 *
 * `responsibilities` is the one that cannot be recovered that way: it is trade-level copy
 * keyed by a canonical id, and this path has none by construction. It stays empty until the
 * taxonomy can resolve an LLM-led profile.
 */
function fromResumeProfile(
  rp: NonNullable<ReturnType<typeof DraftProfileSchema.parse>["resume_profile"]>,
  displayName: string | null,
  templateId: string | null,
  photoDataUri: string | null,
  nightShiftReady: boolean,
  audience: ResumeAudience,
  // PASSED IN, NOT REBUILT. The caller computes it once above the branch; recomputing here
  // would be a second place for the two paths to disagree about a worker's own skills.
  capabilitySlots: TradeCapabilitySlots,
  /** The pack's headline row values, for the Verdict Line's third segment. */
  headlineTools: string[],
  /**
   * Zone 5's values from the caller. The worker's own structured answer, never through the model.
   */
  qualification: ResumeQualificationFacts | undefined,
  /**
   * True when Zone 4 already has real employer blocks.
   *
   * THE PRECEDENCE RULE, AND IT IS ONE-WAY. `worker_employment` carries an employer, a city and
   * dates; `rp.experiences` carries a role and the worker's own words for a duration and no
   * employer at all. Rendering both would print the same job twice — once dated and once not —
   * so the richer shape wins outright and the flat one is suppressed, never merged.
   */
  hasEmployments: boolean,
  /**
   * THE FALLBACK ZONE 5 NEVER HAD. This path read only `qualification`, which no production
   * caller supplies, so education and certificates rendered empty for every worker whose
   * interview ran — even though the answer-map crosswalk carries `education_level`,
   * `education_field` and `certifications` straight onto the draft (`crosswalk.ts:45-47`).
   *
   * The caller-supplied block still WINS where it exists: it is the worker's own structured
   * answer and never passes through the model. This only fills the gap beneath it.
   *
   * Languages have no draft column to fall back to — `crosswalk.ts` records `draftPath: null` —
   * so they were empty for every worker until a capture surface existed. `preferences` below is
   * that surface, and it is the only source they will ever have.
   */
  draftQualification: { educationHeadline: string | null; certifications: readonly string[] },
  /**
   * The finishing form's closed-set answers (R6 §4) — Zone 3's terms and Zone 5's languages.
   *
   * THE FORM WINS OVER THE MODEL wherever both spoke, which is the same precedence `qualification`
   * already has and for the same reason: the worker tapped these chips himself, and `rp.shift` is
   * the model's reading of a conversation. It is per-field rather than all-or-nothing, so a worker
   * who answered only the languages page keeps the model's shift.
   */
  preferences: ResumePreferenceFacts,
  /**
   * `experience.total_years` — the MANDATORY universal ask, in the worker's own words.
   *
   * PASSED IN RATHER THAN READ HERE because `rp` is the résumé container and the container has
   * no such field; the value lives one level up on the draft. See `renderedTotalYears` for why
   * it outranks the sum this path used to print.
   */
  statedYears: number | null,
  /** The worker's own stored turns — the veto input for §8.4's quotes. Never printed as-is. */
  workerSaid: readonly string[],
  /**
   * Zone 4 for a worker with no employment rows (R10 §2.6, §11 #1).
   *
   * BUILT BY THE CALLER, like the capability block and for the same reason: it reads the attribute
   * bag, which this function does not have, and both branches need the identical rows.
   */
  fresherRows: readonly ResumeExperienceLine[],
): ResumeRenderInput {
  // CERTIFIED ONCE, AT THE TOP (#831). `role_label` and `domain_label` are each read TWICE —
  // as their own fields and again by `summaryFor` — and certifying at each read site is how the
  // two drift: a summary built from the raw value would reprint exactly what the fields below
  // just suppressed. One pass, and every consumer below reads the cleaned value.
  //
  // `experiences` needs no pass of its own: `_certified()` in the ai-service has always dropped
  // an entry whose role/duration/work carries blocked text, so stored entries are already
  // covered. It is the SCALARS that were never gated.
  const roleLabel = cleanScalar(rp.role_label);
  const domainLabel = cleanScalar(rp.domain_label);

  // THE BAND (R10 R-1). The container carries one figure — `ResumeProfileSchema.expected_salary`
  // is a single number and widening it is a frozen-contract change — so the upper end rides the
  // finishing form's attribute, exactly as `shift`, `languages` and the credential components do.
  // The precedence is the same one R6 established and for the same reason: the worker tapped it
  // himself, and the model has no field for it at all.
  const salaryText =
    audience === "worker" ? formatSalaryBand(rp.expected_salary, preferences.salaryMax) : null;
  // HUMANISED ONCE, HERE. The container stores the model's own token ("immediate",
  // "notice_period") so it stays diffable against its trace; the sheet prints a label. Both the
  // Verdict Line and the Terms row read this, and computing it twice is how they drift.
  const availabilityLabel = bareAvailabilityLabel(cleanScalar(rp.availability));

  // ONE TOTAL, COMPUTED ONCE. The Verdict Line, the `experienceYears` slot and the summary all
  // read it, and computing it at three call sites is how a sheet ends up saying "8 yrs" at the
  // top and "with 5 years of experience" three lines down.
  const totalYears = renderedTotalYears(statedYears, totalYearsFrom(rp.experiences));

  // §8.4's verbatim quotes. THE MODEL PROPOSES — these are the sentences it recorded — AND THE
  // TRANSCRIPT DISPOSES: `selectOwnWords` prints a phrase only when the worker's own stored turn
  // contains it literally. `skills` and the capability values are passed as "already printed" so
  // the block cannot re-quote a chip row back at the reader.
  const skillChips = cleanList(rp.skills);
  const ownWordsSelection = selectOwnWords({
    // `work_done` ONLY, and NOT `duration_text`. The first run quoted persona 3's "June 2021 se
    // January 2023 tak" — verbatim, his, and useless: the employer block three rows below prints
    // the same span with its employer attached. A quote earns its line by saying something the
    // sheet does not already say, and a date range never does.
    candidates: rp.experiences.map((e) => e.work_done),
    workerSaid,
    alreadyPrinted: [
      ...skillChips,
      ...(capabilitySlots.capChipRows ?? []).flatMap((r) => r.values),
      ...(capabilitySlots.capTickRows ?? []).flatMap((r) => r.values),
      ...(capabilitySlots.employments ?? []).map((e) => e.work ?? ""),
    ],
  });
  const ownWords = ownWordsSelection.phrases;

  return {
    ...capabilitySlots,
    ownWords,
    // BOTH HALVES CARRIED. See `ownWordsRejected` on `ResumeRenderInput`: taking `.phrases` and
    // discarding the rest is what made "0 vetoed" unfalsifiable in the R8 report.
    ownWordsRejected: ownWordsSelection.notVerbatim,
    // THE VERDICT LINE — §5.1 ranks it first of eleven, and it was rendering EMPTY: the strip
    // has been on the layout since the design landed and nothing ever composed the two lines,
    // so the top 22% of the sheet carried the name and then a blank rule.
    ...buildVerdictLine({
      role: roleLabel,
      years: totalYears,
      // The pack's headline row (a turner's controllers) when the interview ran one, else the
      // model's free-text skills — never invented.
      tools: headlineTools.length > 0 ? headlineTools : skillChips,
      city: cleanScalar(rp.current_city),
      availability: availabilityLabel,
      salary: salaryText,
    }),
    availFactRows: buildAvailabilityRows({
      availability: availabilityLabel,
      // SUPPRESSED ON THE PAYER COPY, exactly like the scalar below it. A worker's asking price
      // is a negotiating position handed away if a payer reads it before any conversation, and
      // moving it into a labelled row must not become a way around that.
      salary: salaryText,
      preferredLocations:
        preferences.preferredLocations.length > 0
          ? preferences.preferredLocations
          : cleanList(rp.preferred_locations),
      // The form's own answer, else the model's reading of the conversation. The form's carries
      // the employment type with it ("Rotational shifts · Permanent"), which the model has no
      // field for at all.
      shift: preferences.shiftLine ?? humanizeShift(cleanScalar(rp.shift)),
      willingToRelocate: preferences.willingToRelocate,
      accommodationNeeded: preferences.accommodationNeeded,
    }),
    // ZONE 5, FROM THE CONTEXT ONLY. Education, certifications and languages ride the answer
    // map's crosswalk fields, which Phase C does not return — so nothing on `rp` can fill them
    // and merging the other source back in is the bug this path replaced. The caller-supplied
    // block is a THIRD source rather than that merge: it is the worker's own structured answer,
    // it never passes through the model, and where it is absent the section still collapses
    // exactly as it does today.
    qualFactRows: buildQualificationRows({
      educationHeadline: qualification?.educationHeadline ?? draftQualification.educationHeadline,
      education: qualification?.education ?? [],
      certifications: qualification?.certifications ?? [...draftQualification.certifications],
      languages: qualification?.languages ?? preferences.languages,
    }),
    templateId,
    displayName,
    photoDataUri,
    // The model's job title, printed as written. Nothing resolves it against the taxonomy —
    // there is no canonical id on this path and inventing one would put an unvalidated value
    // where the match engine trusts absolutely.
    canonicalRole: roleLabel,
    trade: domainLabel,
    // WHERE THEY ARE, not where they want to work. #423 split these for exactly this reason;
    // `preferred_locations` gets its own line rather than being conflated into this one.
    location: cleanScalar(rp.current_city),
    experienceYears: totalYears,
    // `shift` IS THE ONE #831 CONFIRMED CROSSES PARTIES. This line is shared by the worker's own
    // PDF and the employer-facing masked disclosure (`buildResumeRenderInput(..., "employer")`),
    // with no audience distinction — so an uncertified value reached a payer's screen. It is
    // certified rather than audience-gated: a shift preference is legitimate matching
    // information an employer should see, and hiding it would cost the worker a real signal to
    // defend against text that should never have been stored in the first place.
    //
    // #947 RIDES THE SAME LINE AND CROSSES THE SAME WAY, DELIBERATELY. `nightShiftReady` is not
    // audience-gated either, and the paragraph above is the precedent that settles it: a shift
    // preference is legitimate matching information an employer should see. The three things
    // this function DOES withhold from a payer — the real name, the photo, the expected salary —
    // are identity or negotiating position. Willingness to work nights is neither. It is the
    // signal that wins the worker a night-shift posting, it is not PII, and it reaches the payer
    // only when the worker deliberately ticked it, so it can only ever argue in their favour.
    availability: humanizeAvailability(
      cleanScalar(rp.availability),
      cleanScalar(rp.shift),
      nightShiftReady,
    ),
    // The CLEANED labels, not `rp`'s raw ones — see the note at the top of this function.
    summary: summaryFor({ role_label: roleLabel, domain_label: domainLabel, years: totalYears }),
    // VERBATIM APART FROM BLANKS. These are the labels the model produced; no taxonomy
    // resolution, because nothing here is a `skill_*` id — `toExtractionOutput` never writes
    // canonical ids on this path, and running `labelForTaxonomyId` over free text would be a
    // no-op at best.
    //
    // THE BLANK FILTER IS NOT COSMETIC. `ResumeProfileSchema` accepts `z.string()` without a
    // min length, so `""` is a valid entry the model can emit, and the templates render each
    // item as a bordered chip or a bulleted line. An empty item therefore prints an empty chip
    // — visible, unexplained, and on the worker's résumé. Dropping it HERE rather than adding a
    // `:empty` rule per list in four templates keeps the fix in one place and out of the
    // presentation layer.
    skills: cleanList(rp.skills),
    // SUPPRESSED WHEN ZONE 4 HAS REAL EMPLOYMENTS — see `hasEmployments` above. The template
    // renders both regions into one section, so leaving these populated would print each job
    // twice: once with its employer and dates, once as a bare role with the worker's own words
    // for a duration.
    experiences: hasEmployments
      ? []
      : fresherRows.length > 0
        ? [...fresherRows]
        : rp.experiences.map((e) => ({
            role: e.role_label,
            // The worker's OWN words first. `duration_months` is a normalization of it, and
            // printing "42 months" when they said "3.5 saal" trades their voice for a number they
            // never used.
            duration: e.duration_text.trim() || monthsAsText(e.duration_months),
            work: e.work_done,
          })),
    preferredLocations: cleanList(rp.preferred_locations),
    // THE WORKER'S OWN COPY ONLY. Their asking price is useful on the résumé they carry and is
    // a negotiating position handed away if a payer reads it before any conversation. Same
    // treatment, and the same reasoning, as ADR-0032 gives the photo.
    expectedSalary: audience === "worker" ? rp.expected_salary : null,
    // See the note above: not available on this path yet.
    machines: [],
    controllers: [],
    education: [],
    certifications: [],
    educationLevel: null,
    educationField: null,
    responsibilities: [],
  };
}

/** Trimmed entries with the blanks removed — see the note at the `skills` call site. */
function cleanList(items: readonly string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0 && !looksLikePii(s));
}

/**
 * A stored container's scalar, or null when it looks like raw PII (#831).
 *
 * THE BACKSTOP, NOT THE GATE. The gate is `_certified_scalar` in the ai-service, which runs
 * every one of these fields through the pseudonymizer before the container is ever persisted.
 * This exists because that gate protects FUTURE extractions and nothing else: rows written
 * before it landed hold values no gateway ever vouched for, they are rendered from storage on
 * every download, and `fromResumeProfile` feeds BOTH the worker's PDF and the employer-facing
 * masked disclosure. A read-path check is the only thing those rows will ever see.
 *
 * `looksLikePii` DELIBERATELY, and not the stricter `looksLikeActionContextPii`. The strict one
 * also rejects 2-4 title-cased words, which is the exact shape of "New Delhi", "Night Shift"
 * and most legitimate role labels — it would blank real résumé fields, and a blanked résumé is
 * the failure #824 already cost us once. `looksLikePii` matches only email shapes and 7+ digit
 * runs, neither of which any honest value of these fields contains.
 *
 * NULL RATHER THAN A MASK, matching the ai-service: absence is a shape every template already
 * handles, and "[PHONE]" printed under `Shift` would be worse than the line not being there.
 */
function cleanScalar(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || looksLikePii(trimmed)) return null;
  return trimmed;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE TOTAL THAT PRINTS — the worker's OWN stated figure, never the sum beneath it.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG, MEASURED ON FIVE REAL EXTRACTIONS. The container path printed
 * `totalYearsFrom(rp.experiences)` — the sum of the model's per-employment `duration_months`.
 * Against workers who stated 2, 5, 8 and 12 years, that headline read "duration not stated",
 * "1 yr 8 mo", "5 yrs 4 mo" and "9 yrs 11 mo". §5.1 ranks total experience third and the Verdict
 * Line first, so this was the second-most-scanned fact on the sheet and it was wrong on every
 * worker who had one.
 *
 * WHY THE SUM UNDERCOUNTS AND ALWAYS WILL. `duration_months` is null whenever the model could
 * not turn a phrase into a number ("kuch saal") and those entries are skipped; employments
 * predating the ones he described are simply absent; and two jobs may overlap. Every one of
 * those errors runs the same direction. `experience_years` is a MANDATORY universal ask
 * (`qp_universal@2`, answer type `duration`, RFS number) whose answer is the worker's own
 * sentence about his own career, and it was sitting on the draft unread.
 *
 * THE RULE: THE STATED FIGURE WINS OUTRIGHT, and the sum only fills its absence.
 *
 * NOT `Math.max` OF THE TWO, and that was the tempting version. Taking the larger would satisfy
 * "never below his stated figure" too, but where the sum exceeds what he said it would print a
 * tenure larger than the one he claimed — resolving a genuine ambiguity UPWARD, which is exactly
 * what §8.3's asymmetry rule forbids: "a man under-described gets a trial and proves himself; a
 * man over-described gets a trial and embarrasses everyone." Preferring the stated figure
 * satisfies the floor by construction, because the figure and the floor are the same number.
 *
 * "DURATION NOT STATED" SURVIVES, FOR THE CASE IT WAS WRITTEN FOR. A worker with neither a
 * stated total nor a datable job is a genuine unknown and §11 #3 requires the sheet to say so.
 * What is gone is the case where he stated it plainly and the sheet said nobody asked.
 *
 * A STATED ZERO STILL READS AS "duration not stated", and that is a live question rather than a
 * decision made here — `yearsPhrase` maps 0 to the unknown text, pinned by a test whose comment
 * reserves "fresher" for a worker who SAID he has no experience. The fresh ITI pass-out is
 * exactly that worker. Changing it is a wording ruling; recorded in the gap table, not taken.
 */
export function renderedTotalYears(stated: number | null, summed: number | null): number | null {
  const usable = typeof stated === "number" && Number.isFinite(stated) && stated > 0;
  return usable ? stated : summed;
}

/**
 * Total years across the work history, or null.
 *
 * SUMS ONLY WHAT THE MODEL CONVERTED. An entry whose `duration_months` is null contributed a
 * duration the model could not turn into a number ("kuch saal"), and guessing one would be the
 * fabrication `ExperienceEntrySchema` keeps it nullable to avoid. Null months are skipped, so
 * the total under-reports rather than invents; if NO entry carries months, the answer is null
 * and the résumé prints no years line at all.
 *
 * Rounded to one decimal so 42 months reads as "3.5", not "3.4999999999999996".
 */
function totalYearsFrom(experiences: readonly { duration_months: number | null }[]): number | null {
  const months = experiences
    .map((e) => e.duration_months)
    .filter((m): m is number => typeof m === "number" && m > 0);
  if (months.length === 0) return null;
  return Math.round((months.reduce((a, b) => a + b, 0) / 12) * 10) / 10;
}

/** A month count as printable text, for the rare entry with months but no words of its own. */
function monthsAsText(months: number | null): string {
  if (months === null || months <= 0) return "";
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.round((months / 12) * 10) / 10;
  return `${years} year${years === 1 ? "" : "s"}`;
}

/**
 * The summary for an LLM-led profile: role, tenure, trade — each clause only when its value
 * exists, and null when none do.
 *
 * NOT FABRICATION (§11). Every clause restates something the worker said and the model
 * recorded; nothing is inferred or filled with a plausible default. A profile with neither a
 * role nor a trade gets no summary rather than a sentence about a worker we know nothing of.
 */
function summaryFor(rp: {
  role_label: string | null;
  domain_label: string | null;
  /** The SETTLED total (see `renderedTotalYears`), never re-derived — one sheet, one number. */
  years: number | null;
}): string | null {
  const role = rp.role_label?.trim();
  const domain = rp.domain_label?.trim();
  if (!role && !domain) return null;
  const head = role ?? domain!;
  const years = rp.years;
  const tenure =
    years && years > 0 ? ` with ${years} year${years === 1 ? "" : "s"} of experience` : "";
  // The trade only earns its own clause when it says something the role does not already —
  // "Cook with 3 years of experience in cooking" is worse than saying it once.
  const context =
    domain && role && domain.toLowerCase() !== role.toLowerCase() ? ` in ${domain}` : "";
  return `${head}${tenure}${context}.`;
}

/**
 * Deterministic resume summary (NO LLM):
 *  1. the worker's OWN summary, if present; else
 *  2. the trade's experienced template filled with profile facts; else
 *  3. the trade's fresher phrase; else
 *  4. the LLM-led path's own labels, if the model captured any; else
 *  5. null (nothing known → nothing fabricated).
 */
function buildSummary(
  draft: ReturnType<typeof DraftProfileSchema.parse>,
  trade: TradeContent | undefined,
): string | null {
  if (draft.experience.summary) return draft.experience.summary;
  if (!trade) return summaryFromLabels(draft);
  const years = draft.experience.total_years;
  if (years && years > 0) {
    const primaryMachine = draft.machines[0]
      ? labelForTaxonomyId(draft.machines[0])
      : "CNC/VMC machines";
    return trade.summary_template
      .replace(/\{\{\s*role\s*\}\}/g, trade.display_name)
      .replace(/\{\{\s*years\s*\}\}/g, `${years} year${years === 1 ? "" : "s"}`)
      .replace(/\{\{\s*primary_machine\s*\}\}/g, primaryMachine);
  }
  return trade.fresher_phrases[0] ?? null;
}

/**
 * Leg 4 — the summary an LLM-led profile can build when the taxonomy knows nothing about it.
 *
 * `resolveTradeContent` keys off the canonical ids, and `toExtractionOutput` hardcodes BOTH to
 * null on this path, so `trade` is undefined for every OIE-path profile and this function used
 * to `return null` outright. `{{summary}}` was blank on every LLM-led resume — alongside the
 * blank `{{headline}}` — even when the model had named the role and the trade in plain language.
 *
 * NOT FABRICATION, and the distinction is the whole point (§11). Every clause here is a value
 * the worker said and the model recorded; nothing is inferred, averaged, or filled with a
 * plausible default. A field that is null contributes NO clause rather than a hedge — which is
 * why this returns null when the model captured nothing, instead of a sentence about a worker
 * it knows nothing about.
 */
function summaryFromLabels(draft: ReturnType<typeof DraftProfileSchema.parse>): string | null {
  const role = draft.role_label?.trim();
  const domain = draft.domain_label?.trim();
  if (!role && !domain) return null;

  const years = draft.experience.total_years;
  const head = role ?? domain!;
  // The domain only earns its own clause when it says something the role does not already —
  // "Cook with 3 years of experience in cooking" is worse than saying it once.
  const context =
    domain && role && domain.toLowerCase() !== role.toLowerCase() ? ` in ${domain}` : "";
  const tenure =
    years && years > 0 ? ` with ${years} year${years === 1 ? "" : "s"} of experience` : "";
  return `${head}${tenure}${context}.`;
}

/** Null-safe id → display name (keeps `null` as `null` for optional fields). */
function resolveId(id: string | null): string | null {
  return id ? labelForTaxonomyId(id) : null;
}

/**
 * Q14: skills for render = canonical skill NAMES (already resolved from `skill_*`
 * ids by the caller) + worker-confirmed raw labels, dropping a label whose
 * normalization already matches a resolved name — e.g. label "Milling" dupes the
 * resolved "Milling". Mirrors `_skills_entries` in apps/ai-service/app/extraction.py.
 */
function mergeSkillsWithLabels(names: string[], labels: string[]): string[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const seen = new Set(names.map(norm));
  const out = [...names];
  for (const label of labels) {
    const key = norm(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Map the availability enum to a short human-readable phrase, and append the shift the model
 * captured — "Available immediately · Night shift".
 *
 * SHIFT RIDES THIS SLOT RATHER THAN GETTING ITS OWN. A new `{{shift}}` token would render on no
 * template at all: a shipped `<id>.v<n>.html` is immutable by the registry contract, so a new
 * slot means four v3 layouts plus registry entries, and an unknown token collapses to nothing in
 * the meantime. `{{availability}}` already prints on all four, and "when can you start / which
 * shift" is one answer to a recruiter.
 *
 * SHIFT ALONE IS ENOUGH TO PRINT THE LINE. `not_looking`/`unknown` still yield no availability
 * phrase, but a worker who told us they work nights has said something worth showing — before
 * this, the whole line collapsed and that answer was lost with it.
 *
 * ── #947: THE WORKER'S OWN TOGGLE IS THE THIRD CLAUSE ──────────────────────────────────
 *
 * `nightShiftReady` is NOT another reading of `shift`. It is a different statement by a
 * different author: `shift` is what the MODEL extracted from the interview ("he works nights"),
 * the toggle is what the WORKER ticked on the Edit-Resume screen ("I am ready for nights"). Only
 * the model's version ever reached the PDF, so a worker who set the toggle and whose interview
 * never happened to mention shifts got NOTHING on the one document the toggle exists to improve
 * — the defect #947 reports, and the reason the app already shows the answer but the download
 * does not.
 *
 * IT RIDES THIS SLOT FOR THE REASON ABOVE, ONLY MORE SO. The registry has now shipped v3 of all
 * four families, so a new `{{night_shift_ready}}` token would need twelve immutable layouts to
 * grow four more, and would render as nothing at all until every one of them did.
 * `{{availability}}` already prints on all twelve, and "which shift" is precisely what it
 * answers.
 *
 * ── TRUE PRINTS; FALSE PRINTS NOTHING, AND THE ASYMMETRY IS THE DESIGN ─────────────────
 *
 * `workers.resume_night_shift_ready` is `notNull().default(false)`. So "the worker answered No"
 * and "the worker has never opened the Edit-Resume screen" are THE SAME STORED BYTE, and nothing
 * in the column can tell them apart. A "Night shift ke liye taiyaar: No" line would therefore
 * stamp a refusal onto the résumé of every worker who has never seen the toggle — a claim they
 * never made, printed on the one document whose entire purpose is to be handed to an employer,
 * and the overwhelming majority of rows are in exactly that state. It would make the fix for a
 * handful of workers a regression for all the rest.
 *
 * So `false` is read as SILENCE, never as No. Only `true` — which takes a deliberate tap —
 * puts anything on the page, and what it puts there is a positive claim its author actually
 * made. This is the same judgement `AVAILABILITY_PHRASES` already makes by having no
 * `not_looking` entry: a résumé exists to be shown to employers, and stamping it with a line
 * that discourages them serves nobody. It is also what makes the change unconditionally
 * back-compatible — every row still on the column default renders `{{availability}}`
 * byte-for-byte as it does today (invariant #8).
 *
 * THE COST, STATED PLAINLY: a worker who genuinely means No cannot say so on the PDF. That is
 * the right trade. Silence is already what a résumé says about every preference nobody asserted,
 * and silence is recoverable in the first phone call; a printed refusal the worker never gave is
 * not.
 *
 * ── SAID ONCE ──────────────────────────────────────────────────────────────────────────
 *
 * `shift: "night"` is the model's weaker restatement of the toggle, so when both are present the
 * model's clause is DROPPED rather than printed beside it — "Night shift · Night shift ke liye
 * taiyaar" says one thing twice. Every OTHER shift value survives, because each says something
 * the toggle does not: `day` is what they work now, `any` includes days too, `rotational` is a
 * pattern. "Day shift · Night shift ke liye taiyaar" is not a contradiction — it is the whole
 * signal, and dropping either half would lose a real answer. Same rule as `summaryFor`'s trade
 * clause and `mergeSkillsWithLabels`: keep both sources, drop only the true duplicate.
 */
function humanizeAvailability(
  status: string | null,
  shift: string | null,
  nightShiftReady: boolean,
): string | null {
  const phrase = AVAILABILITY_PHRASES[status?.trim().toLowerCase() ?? ""] ?? null;
  // WHEN BOTH SAY NIGHTS, THE STRONGER CLAIM SURVIVES — and it is the model's, not the toggle's.
  //
  // This dropped the wrong one. `shift: "night"` asserts the worker WORKS nights; the toggle
  // asserts they are WILLING to. Suppressing the first in favour of the second replaced a fact
  // with an intention on exactly the population #947 is for — someone whose interview mentioned
  // nights AND who ticked the box — and did it on the employer disclosure too, which re-renders
  // every time. Working nights implies willingness, so the fact subsumes the intention and there
  // is nothing left for the second clause to add. Keeping the willingness line and deleting the
  // fact is a strictly weaker résumé.
  //
  // It also contradicted this file's own reasoning two functions down, where
  // `NIGHT_SHIFT_READY_PHRASE` argues at length that the toggle must NOT be worded
  // "Night shift" because that is a DIFFERENT, false claim. Both statements cannot be true: if
  // the wordings mean different things, the clauses are not duplicates; if they are duplicates,
  // the phrase could have been the shorter one. They mean different things, and the stronger wins.
  //
  // MATCHED ON THE HUMANISED OUTPUT, NOT THE RAW TOKEN. `shift` is a bare `str | None` on the
  // wire with no Literal behind it — the existing `rotational` test exists because
  // out-of-vocabulary values really arrive — so a raw `=== "night"` test missed "night shift"
  // and "nights", and those rendered "Night shift · Night shift ke liye taiyaar": the one thing
  // twice that the paragraph above promises never to print. `humanizeShift` already title-cases
  // its default arm, so "night shift" and "NIGHT SHIFT" both arrive here as "Night shift".
  const shiftPhrase = humanizeShift(shift);
  // NORMALISED, NOT COMPARED TO THE HUMANISED STRING. `humanizeShift` only uppercases the FIRST
  // character of a value it does not recognise, so "NIGHT SHIFT" and "Night Shift" come back
  // unchanged and an equality test against "Night shift" misses both. Case, surrounding space and
  // the singular/plural tail are all noise on a free-text field the model is not constrained to.
  const shiftAlreadySaysNight = NIGHT_SHIFT_TOKENS.test(
    (shift ?? "").trim().toLowerCase().replace(/\s+/g, " "),
  );
  const clauses = [
    phrase,
    shiftPhrase,
    nightShiftReady && !shiftAlreadySaysNight ? NIGHT_SHIFT_READY_PHRASE : null,
  ].filter((clause): clause is string => Boolean(clause));
  return clauses.length > 0 ? clauses.join(" · ") : null;
}

/**
 * The worker's night-shift toggle as a printable clause (#947).
 *
 * THE APP'S EXACT WORDS — `kNightShiftLabel` in the worker app's `resume_sections.dart`, which
 * is also the label on the Edit-Resume switch. The worker ticks the box under that sentence and
 * reads it back on the Resume tab under that sentence; a PDF that phrased it differently would
 * leave a low-literacy reader working out whether the download is even about them (§2).
 *
 * A WHOLE CLAUSE, NOT A BARE "Yes". The app renders it as a `label: value` row and can afford
 * one word; every `{{availability}}` slot in the twelve shipped layouts is an UNLABELLED span
 * inside a "Pune · 3 yrs · …" meta strip, so the phrase has to carry its own meaning standing
 * alone. "Yes" in that strip would be unreadable, and "Night shift" would be a DIFFERENT and
 * false claim — that they work nights, rather than that they are willing to.
 */
const NIGHT_SHIFT_READY_PHRASE = "Night shift ke liye taiyaar";

/**
 * BOTH VOCABULARIES, because two paths reach this with different ones.
 *
 * The legacy container stores `AvailabilitySchema.status` — `immediate | notice_period |
 * not_looking | unknown`. The résumé container keeps the MODEL's words verbatim, which
 * `extract_system_prompt` defines as `immediate | 15_days | 1_month | unknown`. Translating
 * either into the other on the way in would break the container's diff-against-the-trace
 * property, so the humanising happens here, at the presentation edge, and knows both sets.
 *
 * `15_days` / `1_month` are the two that used to have no home at all: nothing rendered them,
 * and the availability line silently collapsed for every worker who gave a notice period.
 *
 * Anything absent — `not_looking`, `unknown`, null, or a word the model invented — yields no
 * phrase. "Not looking" is deliberately unprintable: a résumé exists to be shown to employers,
 * and stamping it with a line that discourages them serves nobody.
 */
const AVAILABILITY_PHRASES: Readonly<Record<string, string>> = {
  immediate: "Available immediately",
  notice_period: "On notice period",
  "15_days": "Available in 15 days",
  "1_month": "Available in 1 month",
};

/**
 * The model's `shift` as a printable phrase, or null.
 *
 * The wire type is a bare `str | None` — `extract_system_prompt` asks for "day" | "night" |
 * "any" | null, but nothing constrains it, so an unrecognised value is passed through
 * title-cased rather than dropped. It is worker-derived occupational text that the
 * pseudonymizer already certified, and the renderer output-encodes every slot.
 */
function humanizeShift(shift: string | null): string | null {
  const value = shift?.trim();
  if (!value) return null;
  switch (value.toLowerCase()) {
    case "day":
      return "Day shift";
    case "night":
      return "Night shift";
    case "any":
      return "Any shift";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

/**
 * The level a worker holds, narrowed by the credential he named on the finishing form (R11 §3.1).
 *
 * THE ONE LEVEL THIS NARROWS IS `iti_diploma`, AND THAT BOUND IS THE WHOLE DESIGN. The form's
 * question is not "what is your highest qualification" — the interview already asked that — it is
 * "the option you tapped names two credentials; which is yours". Letting the answer override any
 * other level would let a graduate who also holds a diploma print "Diploma", i.e. demote him on
 * the strength of a question that was never about his highest qualification. A narrower fact may
 * refine the value it narrows and nothing else.
 *
 * ABSENT, UNKNOWN OR A DIFFERENT LEVEL ALL FALL THROUGH to the merged label, which is the honest
 * default: "ITI / Diploma" is less specific than the sample's "ITI", and less specific is not the
 * same as wrong. Guessing between the two would be — and it would be guessing on the line an
 * employer checks hardest.
 *
 * BACKWARD COMPATIBLE: every worker who answered before this existed has no
 * `education_credential` row, so his sheet renders byte-for-byte as it did (invariant #8).
 */
function educationLevelText(raw: string | null, credential: string | null): string | null {
  const level = humanizeEducationLevel(raw);
  const merged = KNOWN_EDUCATION_LEVELS.iti_diploma;
  return level === merged && credential ? credential : level;
}

/**
 * The stored `education_level` scalar as a worker-readable label, or null (#963).
 *
 * THE DEFECT: this field reached the rendered page VERBATIM — through the `{{#education_headline}}` region (`resume-renderer.service.ts` joins level and field into it)
 * — so a worker whose level is
 * `below_10` downloaded a résumé headed "below_10 — Electronics". `education_level` is free
 * text the extractor writes — `z.string().nullable()`, no enum anywhere behind it — and the
 * profiling prompt asks for a short label (10th, 12th, ITI, Diploma, Graduate) that the model
 * sometimes answers with a token instead. A DB-shaped token on the résumé of a worker who may
 * not read English is the §2 failure this whole document exists to prevent, and the same bytes
 * were reaching employers on the masked disclosure. Availability, mapped two lines above, has
 * been humanised since it was written; the level was simply never given the same treatment.
 *
 * A PORT, NOT A SECOND OPINION. This is `humanizeEducationLevel` from the worker app's
 * `lib/core/util/education_label.dart`, rule for rule and word for word, because the app's
 * Resume tab and this PDF render the SAME stored value — a worker holding both must not find
 * two different names for their own schooling. Change one and change the other.
 *
 *   1. a KNOWN token maps to a friendly label (`below_10` → "10th se kam");
 *   2. any other snake_case token is prettified (`post_graduate` → "Post Graduate");
 *   3. anything else is returned UNCHANGED.
 *
 * RULE 3 IS THE BACKWARD-COMPATIBILITY GUARANTEE, not a leftover. Nearly every stored value is
 * already a readable label and none of them contain an underscore, so they pass through
 * untouched and those résumés render byte-for-byte as they do today (invariant #8). It is also
 * the rule that protects the values a prettifier would WRECK: "ITI" would come back as "Iti" and
 * "B.Tech" as "B.tech" if this re-cased what it had no need to touch.
 *
 * CAPITALISE THE FIRST LETTER, LEAVE THE REST — matching the Dart original exactly. Lowercasing
 * the tail would be the same acronym-wrecking mistake one level down, inside a token.
 *
 * BLANK BECOMES NULL rather than "". The field's contract is `string | null` where null means
 * "print no line", and the renderer already trims-and-drops an empty string on the way into
 * `education_headline` — so this changes nothing on the page and stops one absence having two
 * representations. (The Dart original returns the empty string for the mirror-image reason: its
 * caller hands it a non-null `String`.)
 *
 * PII-free by construction: a schooling level is never identity, so this needs none of the
 * `cleanScalar` gating the container's free-text scalars get.
 */
function humanizeEducationLevel(raw: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const known = KNOWN_EDUCATION_LEVELS[value.toLowerCase()];
  if (known) return known;
  // Only reshape token-ish snake_case values — rule 3 above is what keeps "ITI" as "ITI".
  if (!value.includes("_")) return value;
  return value
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The tokens the extractor has actually been SEEN to emit, and nothing else (#963).
 *
 * Deliberately not a vocabulary of every level a worker might hold. An entry here OVERRIDES the
 * prettifier, so inventing mappings for tokens the pipeline has never produced would be guessing
 * at wording on the worker's behalf — the fabrication §11 keeps out of every other field on this
 * résumé. An unknown token falls through to rule 2 instead, which reshapes without renaming.
 * Mirrors the `known` map in the app's `education_label.dart`, `below_10th` included: the same
 * level, spelled the other way, out of the same free-text field.
 */
/**
 * The ways a free-text `shift` can already be saying `nights`.
 *
 * A NAMED PATTERN RATHER THAN AN EQUALITY TEST, because the obvious equality test is wrong in a
 * way that reads as right. `humanizeShift` uppercases only the FIRST character of a value it does
 * not recognise, so "NIGHT SHIFT" and "Night Shift" come back out unchanged and never equal the
 * "Night shift" its own `night` arm returns. `shift` is a bare `str | None` on the wire with no
 * Literal behind it — the `rotational` test in this file exists because out-of-vocabulary values
 * really do arrive — so case, surrounding space and a plural tail are all noise here.
 *
 * What it guards: printing the same fact twice on the one line an employer skims,
 * "Night shift · Night shift ke liye taiyaar".
 */
const NIGHT_SHIFT_TOKENS = /^night(\s*shift)?s?$/;

const KNOWN_EDUCATION_LEVELS: Readonly<Record<string, string>> = {
  // ── ENGLISH ON THE PDF (R10 R-3, owner ruling) ──────────────────────────────────────
  //
  // These were the pack's own Hinglish chip labels — "ITI ya diploma", "Dasvi paas", "Barhvi
  // paas" — on the argument that the résumé should say back to the worker the words he tapped.
  // R9 measured the consequence: the education row read "ITI ya diploma — Turner · NCVT · 2018 ·
  // Govt. ITI, Faridabad", one Hinglish segment inside a line whose other four are English, on a
  // sheet whose entire Zone 5 vocabulary (`worker-preferences.vocabulary.ts`) prints English
  // because "this half of the sheet is read by a hiring supervisor".
  //
  // THE RULING. Decision 4 rules English content because the employer's advertisement is in
  // English, and the PDF is the employer-facing artifact. The app stays Hinglish per #963 — and
  // §11 #17 already establishes these two surfaces differing by audience (Latin on the employer
  // copy, both scripts on the worker's own), so this is that pattern rather than a new exception.
  //
  // WHAT THIS DOES NOT DO. It does not touch `education_label.dart`, the pack's `label_text`, or
  // any stored value. The worker still taps "ITI ya diploma"; only the printed artifact changes.
  below_10: "Below 10th",
  below_10th: "Below 10th",
  "10": "10th pass",
  "12": "12th pass",
  iti_diploma: "ITI / Diploma",
  graduate: "Graduate",
};
