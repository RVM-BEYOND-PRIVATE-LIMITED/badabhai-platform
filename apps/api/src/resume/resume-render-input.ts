import { DraftProfileSchema, resumeProfileCarriesValues } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import { looksLikePii } from "@badabhai/validators";
import type { ResumeRenderInput } from "./resume-renderer.service";
import { resolveTradeContent, type TradeContent } from "./trade-content";

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

export function buildResumeRenderInput(
  snapshot: unknown,
  displayName: string | null,
  templateId: string | null,
  photoDataUri: string | null,
  audience: ResumeAudience,
): ResumeRenderInput {
  const draft = DraftProfileSchema.parse(snapshot ?? {});

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
  if (resumeProfileCarriesValues(draft.resume_profile)) {
    return fromResumeProfile(draft.resume_profile, displayName, templateId, photoDataUri, audience);
  }

  const trade = resolveTradeContent(draft.canonical_role_id, draft.canonical_trade_id);
  return {
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
    experiences: [],
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
      draft.location_preference.current_city ?? draft.location_preference.preferred_cities[0] ?? null,
    experienceYears: draft.experience.total_years,
    availability: humanizeAvailability(draft.availability.status, draft.shift),
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
    educationLevel: draft.education_level,
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
  audience: ResumeAudience,
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

  return {
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
    // DERIVED FROM THE WORK HISTORY, because Phase C has no `experience_years` field and the
    // answer map is not consulted here. The months the model recorded per job are the only
    // statement about tenure that exists on this path — without this the résumé printed no
    // years at all while the worker had plainly said "3.5 saal".
    experienceYears: totalYearsFrom(rp.experiences),
    // `shift` IS THE ONE #831 CONFIRMED CROSSES PARTIES. This line is shared by the worker's own
    // PDF and the employer-facing masked disclosure (`buildResumeRenderInput(..., "employer")`),
    // with no audience distinction — so an uncertified value reached a payer's screen. It is
    // certified rather than audience-gated: a shift preference is legitimate matching
    // information an employer should see, and hiding it would cost the worker a real signal to
    // defend against text that should never have been stored in the first place.
    availability: humanizeAvailability(cleanScalar(rp.availability), cleanScalar(rp.shift)),
    // The CLEANED labels, not `rp`'s raw ones — see the note at the top of this function.
    summary: summaryFor({ ...rp, role_label: roleLabel, domain_label: domainLabel }),
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
    experiences: rp.experiences.map((e) => ({
      role: e.role_label,
      // The worker's OWN words first. `duration_months` is a normalization of it, and printing
      // "42 months" when they said "3.5 saal" trades their voice for a number they never used.
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
  experiences: readonly { duration_months: number | null }[];
}): string | null {
  const role = rp.role_label?.trim();
  const domain = rp.domain_label?.trim();
  if (!role && !domain) return null;
  const head = role ?? domain!;
  const years = totalYearsFrom(rp.experiences);
  const tenure = years && years > 0 ? ` with ${years} year${years === 1 ? "" : "s"} of experience` : "";
  // The trade only earns its own clause when it says something the role does not already —
  // "Cook with 3 years of experience in cooking" is worse than saying it once.
  const context = domain && role && domain.toLowerCase() !== role.toLowerCase() ? ` in ${domain}` : "";
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
  const context = domain && role && domain.toLowerCase() !== role.toLowerCase() ? ` in ${domain}` : "";
  const tenure = years && years > 0 ? ` with ${years} year${years === 1 ? "" : "s"} of experience` : "";
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
 */
function humanizeAvailability(status: string | null, shift: string | null): string | null {
  const phrase = AVAILABILITY_PHRASES[status?.trim().toLowerCase() ?? ""] ?? null;
  const shiftPhrase = humanizeShift(shift);
  if (!phrase) return shiftPhrase;
  return shiftPhrase ? `${phrase} · ${shiftPhrase}` : phrase;
}

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
