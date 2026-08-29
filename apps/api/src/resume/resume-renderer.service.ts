import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import type { DegradationStep } from "./resume-degradation";
import type { TranscriptVeto } from "./resume-transcript-veto";
import { RESUME_FONT_CONTRACT } from "./resume-fonts";
import { getResumeTemplate } from "./templates/registry";

/**
 * Structured input for a single resume render. ALL fields are derived from the
 * name-free `sourceProfileSnapshot` EXCEPT `displayName`, which is the worker's
 * real full name (decrypted SERVER-SIDE by the caller). The name is placed onto
 * the PDF only — it must NEVER be logged or echoed into an error here. Fields map
 * 1:1 to the template slot contract (templates/README.md).
 */
/**
 * One job on the résumé, already humanised for print.
 *
 * `duration` is the worker's OWN words ("3.5 saal") rather than a computed month count —
 * `duration_months` is nullable precisely because "kuch saal" is a real answer, and printing a
 * number the worker never said is the fabrication the parse gates exist to stop.
 */
export interface ResumeExperienceLine {
  role: string;
  duration: string;
  work: string;
}

export interface ResumeRenderInput {
  /** Which layout (templates/registry.ts). Unknown/empty → the generic fallback. */
  templateId: string | null;
  /** The worker's real full name, or null → render a name-less resume. */
  displayName: string | null;
  /** Role title → `{{headline}}` (e.g. "VMC Operator"). */
  canonicalRole: string | null;
  /** `{{location}}` (e.g. the first preferred city). */
  location: string | null;
  /** `{{experience_years}}`. */
  experienceYears: number | null;
  /**
   * `{{availability}}` (human-readable) — the ONE line carrying every "when, and which shift"
   * answer the résumé has: the availability status, the model's extracted shift, and the
   * worker's own night-shift toggle (#947), composed into clauses joined with " · ".
   *
   * THEY SHARE A SLOT BECAUSE A SHIPPED LAYOUT IS IMMUTABLE (registry contract). Twelve
   * `<id>.v<n>.html` files carry `{{availability}}`; none carries a shift or night-shift token,
   * and an unknown token collapses to nothing — so this is the only slot a shift statement can
   * reach without four new layouts. `buildResumeRenderInput` owns the composition; the renderer
   * prints whatever string arrives.
   */
  availability: string | null;
  /** `{{summary}}` — short professional summary. */
  summary: string | null;
  /** Repeat regions `{{#skills}}` / `{{#machines}}` / `{{#controllers}}` / … */
  skills: string[];
  machines: string[];
  controllers: string[];
  /**
   * Highest academic level (e.g. "12th") and stream. NEITHER IS A TEMPLATE TOKEN — this
   * comment named `{{education_level}}` for a long time and no such token has ever existed in
   * any layout; both values are joined into the `{{#education_headline}}` region below. Left
   * corrected rather than copied onward, because a v4 layout written on the strength of the
   * old wording would render an empty slot and never error.
   * (`{{education_field}}`, e.g. "Electronics"). Rendered as a single leading
   * line in the Education section when present. DISTINCT from the `education`
   * list (ITI/diploma mentions) + `certifications`. Null → the slot collapses
   * to empty and its wrapper region is dropped. PII-free qualification labels.
   */
  educationLevel: string | null;
  educationField: string | null;
  education: string[];
  certifications: string[];
  /**
   * Role-typical responsibilities for the worker's chosen trade (TD24a, from
   * `trade-content.ts`). Trade-LEVEL copy (what a recruiter expects for that role),
   * never a fabricated personal claim. Empty when the trade is unknown.
   */
  responsibilities: string[];
  /**
   * The worker's trade in plain language (`{{trade}}`), e.g. "CNC Machining".
   *
   * Distinct from {@link canonicalRole}, which is the job title. The LLM-led interview names
   * both and they answer different questions — "VMC Operator" is what they do, "CNC Machining"
   * is the industry it sits in. Null on every deterministic-only profile, where no such label
   * exists and nothing may invent one.
   */
  trade: string | null;
  /**
   * THE WORK HISTORY — the one thing no pack question can produce.
   *
   * A pack asks its fixed question once, so a worker with three jobs has three answers to
   * "what did you do" and the answer map has room for one. This list exists only because the
   * LLM-led interview reads the whole conversation.
   *
   * STRUCTURED, NOT PRE-JOINED PROSE. The renderer's slot engine grew object regions for this
   * — `{{#experiences}}…{{role}}…{{duration}}…{{work}}…{{/experiences}}` — so a layout decides
   * how a job entry looks. Flattening to one string here would hard-code that choice into the
   * mapper and put presentation in the wrong layer.
   *
   * NEVER AN EMPLOYER NAME. `ExperienceEntrySchema.strict()` refuses one at the contract
   * boundary (§2), so there is no field here to render even if a model tried.
   */
  experiences: ResumeExperienceLine[];
  /**
   * Where the worker WANTS to work (`{{#preferred_locations}}`), as distinct from
   * {@link location}, which is where they are. #423 split these because conflating them turned
   * "I live in Pune" into "I want to work in Pune"; printing them as one line would undo that.
   */
  preferredLocations: string[];
  /**
   * `{{expected_salary}}` — rupees per month, or null to omit the line.
   *
   * NULL ON THE EMPLOYER DISCLOSURE, STRUCTURALLY, exactly as {@link photoDataUri} is. This is
   * the worker's asking price: showing it on their own résumé is useful, and showing it to a
   * payer before any conversation hands away their negotiating position. The caller's
   * `audience` decides, so the restriction cannot be forgotten at a call site.
   */
  expectedSalary: number | null;
  /**
   * ADR-0032 — the worker's profile photo as a self-contained `data:` URI, or
   * null/absent → render photo-less (the `{{#photo}}` region collapses).
   * CALLER-SUPPLIED like {@link displayName} and under the same rule: only the
   * worker's OWN render (resume-render.processor.ts) ever passes it; the masked
   * disclosure passes null STRUCTURALLY. Never derived from the snapshot; never
   * logged or echoed into an error.
   */
  photoDataUri?: string | null;

  /**
   * PROVENANCE (§7.4): which degradation stage produced this sheet, and what it removed.
   *
   * 0 means nothing was dropped. Stamped so a produced PDF reproduces exactly — the same
   * snapshot at a different stage is a different artifact, and without this the difference is
   * invisible. It belongs beside `skin`, `template_version` and `taxonomy_version`; none of
   * those columns exists yet, so today this rides on the render input and into the HTML's
   * `<meta>` rather than into a table. Recorded in the journal as the follow-up it is.
   */
  degradationStage?: number;
  degradationDropped?: readonly string[];
  /**
   * Per-step cost of the ladder that produced this sheet. DIAGNOSTIC ONLY — nothing renders it.
   * It exists so the ladder's granularity can be read off the emitted matrix: a step that gained
   * far more than the sheet was over took a whole block where a trim would have done.
   */
  degradationTrace?: readonly DegradationStep[];

  /**
   * Chip claims the worker's own transcript withdrew, each with the sentence that withdrew it.
   *
   * DIAGNOSTIC AND AUDITABLE, never rendered. A veto REMOVES a claim from a man's résumé, so
   * every one has to be readable by a human after the fact — which is why the triggering phrase
   * rides along rather than just a count. The render worker logs them; nothing on the page shows
   * that anything was withdrawn, because the sheet's job is to state what is true, not to
   * annotate what was corrected.
   */
  transcriptVetoes?: readonly TranscriptVeto[];

  /**
   * Sentences the model proposed for the own-words block that the transcript would NOT vouch for.
   *
   * DIAGNOSTIC ONLY, never rendered — and it exists because its ABSENCE was itself a defect. The
   * R8 harness reported "candidates vetoed: 0" for two personas and that zero was never measured:
   * `selectOwnWords` computes `notVerbatim` and the call site took `.phrases` and dropped it. A
   * zero read as "the model quoted this worker faithfully" when sixteen composed sentences had in
   * fact been thrown away — a check that could not observe what it claimed, which is the same
   * shape as the two HIGH findings the R8 re-verification turned up.
   *
   * COUNT AND TEXT, not a count alone. What was rejected is the evidence for whether the
   * extraction is composing; a bare number cannot tell a prompt regression from a quiet model.
   */
  ownWordsRejected?: readonly string[];

  // ==========================================================================
  // THE LOCKED TRADE SHEET (`bb_trade.v1`).
  //
  // EVERY FIELD BELOW IS OPTIONAL, and that is what makes this additive: the twelve shipped
  // `classic`/`modern`/`minimal`/`fallback` layouts carry none of these tokens, an unknown token
  // collapses to empty, and every existing caller compiles and renders byte-identically.
  //
  // ROWS, NOT FIELDS. The trade sheet's sections are lists of {label, value} rather than a slot
  // per fact, so "does this row appear at all" is one decision in `resume-render-input.ts` — the
  // same place the one-page caps live — instead of a CSS `:empty` trick that has to behave in
  // WeasyPrint. A label with nothing after it is not a formatting nit on a sheet a worker hands
  // to a supervisor; it reads as a claim they failed to answer.
  // ==========================================================================

  /**
   * `{{phone}}` — the worker's number, on BOTH audiences (owner ruling 2026-08-28).
   *
   * DELIBERATELY NOT SUPPRESSED FOR THE EMPLOYER COPY, unlike {@link expectedSalary} and
   * {@link photoDataUri}. A printed sheet handed over at a factory gate is useless without a
   * number on it. Decrypted server-side by the caller exactly like {@link displayName}, and under
   * the same rule: never logged, never echoed into an error.
   */
  phone?: string | null;
  /** `{{name_devanagari}}` — auto-transliterated. Needs a Devanagari font in the API image. */
  nameDevanagari?: string | null;
  /**
   * `{{trust_badge}}` — the masthead's right-hand slot.
   *
   * EMPTY UNTIL BadaBhai Verified. The owner ruling is two tiers, and an unverified sheet shows
   * the wordmark ALONE — never "self-declared", which reads as a warning label on a worker who
   * has done nothing wrong. No `verified` flag exists in the schema yet, so this is null today.
   */
  trustBadge?: string | null;
  /** `{{headline_line}}` — role · years · controllers · axis, composed by the mapper. */
  headlineLine?: string | null;
  /** `{{subhead_line}}` — city · availability · salary, composed by the mapper. */
  subheadLine?: string | null;

  /**
   * `{{cap_section_title}}` — the FIRST section's heading, which is per-trade.
   *
   * A turner's sheet says "Machines, controllers & capability"; a welder's says "Processes,
   * positions & capability"; a car mechanic's says "Vehicles, systems & tools". Every OTHER
   * section heading is a literal in the template, because the guideline's zone map fixes them
   * and a mapper must not be able to rename "Work history".
   *
   * Rendered into a `data-title` ATTRIBUTE, not a text node, so the section still collapses:
   * `.sec:empty` matches an element that carries attributes but no children, and a
   * `display: none` element emits no `::before`. A text slot here would keep the container
   * non-empty forever and print a bare heading over nothing.
   */
  capSectionTitle?: string | null;

  /** `{{#cap_chip_rows}}` — machines / controllers / materials, as pill rows. */
  capChipRows?: ResumeListRow[];
  /** `{{#cap_tick_rows}}` — setting operations, measuring instruments, as ticked rows. */
  capTickRows?: ResumeListRow[];
  /** `{{#cap_fact_rows}}` — programming, drawings, tolerance, sector. */
  capFactRows?: ResumeFactRow[];
  /** `{{#avail_fact_rows}}` — available from, salary, preferred locations, shift. */
  availFactRows?: ResumeFactRow[];
  /** `{{#qual_fact_rows}}` — education, certificates, languages. */
  qualFactRows?: ResumeFactRow[];
  /** `{{#qual_tick_rows}}` — documents the worker says they hold. */
  qualTickRows?: ResumeListRow[];

  /** `{{#employments}}` — the two-level work history. See {@link ResumeEmployment}. */
  employments?: ResumeEmployment[];
  /**
   * `{{employments_more}}` — the overflow tail, e.g. "2 earlier employers · 22 months total
   * · 2015–2017".
   *
   * The guideline caps the page at four employers rendered in full and requires the remainder to
   * collapse to ONE counted line. Never a second page, and never a silent drop: a worker with
   * nine employers must still see that the other five were counted, or the sheet is lying about
   * his tenure by omission.
   */
  employmentsMore?: string | null;
  /**
   * `{{#own_words}}` — verbatim Hinglish the worker actually said, each rendered in quotes.
   *
   * NEVER PARAPHRASED, NEVER TRANSLATED, NEVER COMPOSED. ADR-0013 makes the renderer
   * deterministic template-fill, and this is the one place the worker's own voice reaches the
   * page — which is exactly why it must arrive as a stored transcript fragment rather than as
   * anything a model wrote. An empty list collapses the whole section.
   */
  ownWords?: string[];

  /** `{{#qr}}` — a self-contained `data:` URI. No template may fetch a QR from a service. */
  qrDataUri?: string | null;
  qrCaption?: string | null;
  shortLink?: string | null;
  /** `{{footer_meta}}` — "Generated 27 August 2026 · Ref RK8M2Q". */
  footerMeta?: string | null;
}

/**
 * The longest display name that fits on ONE line at 20pt beside the phone, MEASURED in
 * WeasyPrint against the real sheet on 2026-08-28 — not estimated.
 *
 * A CHARACTER COUNT IS A PROXY FOR A WIDTH, and it is the only proxy available: CSS cannot
 * measure text and WeasyPrint runs no JavaScript, so a real fitter is impossible. The proxy is
 * safe in the direction that matters because the smaller size is the guideline's FLOOR — a
 * mis-measured wide name drops to 18pt and wraps, which §11 #9 explicitly permits; it can never
 * be shrunk below the floor and it is never truncated.
 */
const NAME_ONE_LINE_MAX = 27;

/** `"fit"` for a name past {@link NAME_ONE_LINE_MAX}, else `""`. */
function nameFitClass(displayName: string | null | undefined): string {
  return (displayName?.trim().length ?? 0) > NAME_ONE_LINE_MAX ? "fit" : "";
}

/** A labelled list row — `{{label}}` plus a `{{#values}}` region of plain strings. */
/**
 * `key` and `rank` are PROVENANCE, not content: the renderer never reads either.
 *
 * They exist so the degradation ladder can order rows by §5.1 decisiveness without re-deriving
 * the trade map, and they are optional because rows built outside a trade map (the legacy
 * qualification path) have neither. Anything that reached the template through them would be a
 * bug — `bb-trade-template.test.ts` pins the slot list.
 */
export type ResumeListRow = {
  label: string;
  values: string[];
  key?: string;
  rank?: number;
};
/** A labelled single-value row. */
export type ResumeFactRow = {
  label: string;
  value: string;
  key?: string;
  rank?: number;
};
/** One role stint inside an employment. `when` is its OWN date range, never the employer's. */
export type ResumeRoleStint = {
  role: string;
  when: string;
};
/**
 * One employer, with the role stints held there.
 *
 * TWO LEVELS BECAUSE A PROMOTION IS ONE JOB. A worker who joined as an operator and became a
 * setter at the same company has one continuous tenure and two titles; flattening that into two
 * entries reads to an employer as job-hopping, which is the opposite of what happened.
 *
 * `employer` IS WORKER-TYPED AND UNTRUSTED — it is captured by a pack question and written
 * straight to Postgres, and it never passes through the AI service. The renderer output-encodes
 * it like every other slot.
 */
export interface ResumeEmployment {
  /**
   * The employment row id (#1353/#1354) — the ONLY client-supplied identifier
   * `PUT /workers/me/employment/:employmentId/description-source` accepts, and
   * without it that route is unreachable from the resume screen. Undefined only
   * for pre-#1353 seeded/test fixtures; every real record carries one.
   */
  id?: string;
  employer: string;
  /** " · Gurugram, Haryana", pre-composed so an absent city leaves no stray separator. */
  location_suffix?: string;
  /**
   * " — CNC Turner", pre-composed on the same terms.
   *
   * Set ONLY when the employment has exactly one role stint carrying no dates of its own, in
   * which case `roles` is empty and the title rides the employer line — which is what the zone
   * map asks for ("employer · role and function · city · months") and what keeps a four-employer
   * sheet on one page. A promotion (two or more stints) never uses this: it renders dated
   * function lines, per §11 #14.
   */
  role_inline?: string;
  /** "Jan 2023 – Present · 3 yrs 6 mo" — the EMPLOYMENT's span. */
  when: string;
  work: string;
  /**
   * The same line built from the worker's OWN words, when a rewrite is what `work` holds.
   *
   * NOT A TEMPLATE SLOT -- no layout prints it, and none should. It exists so a CLIENT can show
   * a worker what the printed sentence was rewritten from and let them refuse it (#1354), which
   * is the only mitigation the section-8 override in #1350 actually has: no test can assert the
   * absence of a plausible-but-false sentence, and only the worker knows whether one is true.
   */
  work_own_words?: string;
  roles: ResumeRoleStint[];
}

/**
 * Renders a resume PDF in NODE via the WeasyPrint CLI as a LOCAL subprocess.
 *
 * SECURITY: rendering MUST happen here in Node, NEVER in the AI service — placing
 * the worker's real name on the PDF here keeps the "name never reaches the AI
 * service" guarantee intact (ADR-0007). Every slot value is output-encoded into the
 * HTML (the name is attacker-controlled, R11/R13) to prevent HTML/template
 * injection, and is NEVER written to a log line or an error string.
 *
 * The HTML comes from the versioned layout skeletons (`templates/`, the layer-1
 * registry); this service is the "later layer" that binds data → slots → HTML/PDF.
 *
 * Degrade-to-null mirrors ai.service: any failure (binary missing, timeout,
 * non-zero exit) returns null = "no PDF this run"; the processor decides what to
 * do with that. This lets local dev (no WeasyPrint installed, e.g. Windows) and a
 * disabled kill-switch both run cleanly.
 */
@Injectable()
export class ResumeRenderer {
  // A shipped template file is immutable (registry contract), so cache by filename.
  private static readonly templateCache = new Map<string, string>();

  constructor(private readonly pdf: PdfRenderer) {}

  /**
   * Resolve the template by id (unknown/empty → fallback, never throws) and bind
   * the data into its slots. Every interpolated value is HTML-escaped — the
   * display name is user-controlled, so output encoding here prevents injecting
   * markup into the rendered PDF.
   */
  buildResumeHtml(input: ResumeRenderInput): string {
    const template = getResumeTemplate(input.templateId);
    const skeleton = this.loadTemplate(template.file);
    return ResumeRenderer.fillSlots(skeleton, input);
  }

  /** Load a template skeleton from disk (cached). Copied into dist by nest-cli assets. */
  private loadTemplate(file: string): string {
    const cached = ResumeRenderer.templateCache.get(file);
    if (cached) return cached;
    const html = readFileSync(join(__dirname, "templates", file), "utf8");
    ResumeRenderer.templateCache.set(file, html);
    return html;
  }

  /**
   * Mustache-ish slot fill (the documented subset): single `{{token}}` and repeat
   * regions `{{#list}}…{{.}}…{{/list}}`. EVERY injected value is output-encoded;
   * the template's own markup is left intact. Unknown tokens / empty lists collapse
   * to nothing, so no `{{…}}` leaks into the PDF.
   */
  private static fillSlots(skeleton: string, input: ResumeRenderInput): string {
    const scalars: Record<string, string> = {
      full_name: input.displayName ?? "",
      headline: input.canonicalRole ?? "",
      location: input.location ?? "",
      experience_years: input.experienceYears != null ? String(input.experienceYears) : "",
      availability: input.availability ?? "",
      summary: input.summary ?? "",
      trade: input.trade ?? "",
      // Grouped with the rupee sign in the template, not here — a bare number is what a layout
      // wants to format. Empty string collapses the line, which is what null must mean.
      expected_salary: input.expectedSalary != null ? String(input.expectedSalary) : "",
      // --- bb_trade.v1 scalars. Absent on every other layout, where they collapse. ---
      phone: input.phone ?? "",
      // §11 #9 auto-fit. See NAME_ONE_LINE_MAX — a name past the measured one-line width drops
      // to the 18pt FLOOR rather than wrapping at 20pt, and is never truncated at any length.
      name_class: nameFitClass(input.displayName),
      name_devanagari: input.nameDevanagari ?? "",
      trust_badge: input.trustBadge ?? "",
      headline_line: input.headlineLine ?? "",
      subhead_line: input.subheadLine ?? "",
      cap_section_title: input.capSectionTitle ?? "",
      qr_caption: input.qrCaption ?? "",
      short_link: input.shortLink ?? "",
      footer_meta: input.footerMeta ?? "",
    };
    // OBJECT REGIONS — `{{#name}}…{{field}}…{{/name}}`, one repeat per item, each inner token
    // resolved from THAT item. The engine only had string regions (`{{.}}`), which is why
    // `experiences[]` could not be rendered at all: a job entry is four fields, and flattening
    // it to one string would have put the layout decision in the mapper.
    //
    // A MISSING KEY RESOLVES TO EMPTY, never to the scalar of the same name — the per-item
    // lookup below is total, so an inner `{{location}}` inside `{{#experiences}}` yields "" and
    // cannot silently pick up the worker's city from the outer scope.
    // `unknown` rather than `string`, because a row's value may itself be a LIST — that is what
    // makes `{{#cap_chip_rows}}` contain `{{#values}}` and `{{#employments}}` contain `{{#roles}}`.
    // The recursive renderer decides per key: an array of objects is a nested object region, an
    // array of strings a `{{.}}` region, anything else a scalar.
    const objectLists: Record<string, ReadonlyArray<Record<string, unknown>>> = {
      experiences: input.experiences.map((e) => ({
        role: e.role,
        duration: e.duration,
        work: e.work,
      })),
      // Empty arrays are correct and cheap: the region collapses to nothing, so a layout that
      // does not carry these tokens is unaffected and one that does renders no empty rows.
      cap_chip_rows: input.capChipRows ?? [],
      cap_tick_rows: input.capTickRows ?? [],
      cap_fact_rows: input.capFactRows ?? [],
      avail_fact_rows: input.availFactRows ?? [],
      qual_fact_rows: input.qualFactRows ?? [],
      qual_tick_rows: input.qualTickRows ?? [],
      employments: (input.employments ?? []).map((e) => ({
        employer: e.employer,
        location_suffix: e.location_suffix ?? "",
        role_inline: e.role_inline ?? "",
        when: e.when,
        work: e.work,
        roles: e.roles,
      })),
    };
    // Level + field as ONE leading line ("12th — Electronics"), rendered as a
    // 0-or-1-item region so it collapses cleanly when both are null and never
    // prints an empty/"null" line. Distinct from the `education` list below.
    const educationHeadline = [input.educationLevel, input.educationField]
      .map((v) => v?.trim())
      .filter((v): v is string => Boolean(v))
      .join(" — ");
    const lists: Record<string, string[]> = {
      machines: input.machines,
      skills: input.skills,
      controllers: input.controllers,
      education_headline: educationHeadline ? [educationHeadline] : [],
      education: input.education,
      certifications: input.certifications,
      responsibilities: input.responsibilities,
      preferred_locations: input.preferredLocations,
      own_words: input.ownWords ?? [],
      // A 0-OR-1 REGION, NOT A SCALAR, and the distinction is §11 #1. This element is the only
      // child of `.sec-work` that sits outside both work-history repeats, so as a scalar slot it
      // kept the container non-empty on EVERY render and the section heading could never
      // collapse — an ITI fresher with no work history got a bare "WORK HISTORY" rule.
      employments_more: input.employmentsMore ? [input.employmentsMore] : [],
      // ADR-0032: 0-or-1-item region — the documented conditional mechanism. A
      // data: URI survives escapeHtml intact (base64 + the mime prefix contain no
      // escapable characters), and templates without {{#photo}} are unaffected.
      photo: input.photoDataUri ? [input.photoDataUri] : [],
      // Same 0-or-1 mechanism as `photo`, and for the same reason: a `data:` URI survives
      // escapeHtml intact (base64 plus the mime prefix contain nothing escapable), and a layout
      // without the region is unaffected.
      qr: input.qrDataUri ? [input.qrDataUri] : [],
    };

    let out = skeleton;
    // 0) OBJECT REGIONS FIRST, before anything else touches a `{{token}}`. The inner tokens are
    //    resolved and escaped here; if step 3 ran first it would consume them as scalars and
    //    every job entry would render the same worker-level value.
    for (const [name, items] of Object.entries(objectLists)) {
      out = ResumeRenderer.fillObjectRegion(out, name, items);
    }
    // 1) Known repeat regions: repeat the inner block per item, escaping `{{.}}`.
    for (const [name, items] of Object.entries(lists)) {
      out = ResumeRenderer.fillStringRegion(out, name, items);
    }
    // 2) Any remaining (unknown) repeat region collapses to nothing.
    out = out.replace(/{{#[a-z_]+}}[\s\S]*?{{\/[a-z_]+}}/g, "");
    // 3) Scalar tokens (replacer fn → safe against `$` in values; unknown → "").
    out = out.replace(/{{\s*([a-z_]+)\s*}}/g, (_m, key: string) =>
      ResumeRenderer.escapeHtml(scalars[key] ?? ""),
    );
    return out;
  }

  /**
   * THE region matcher. One hardcoded literal, shared by both region fillers.
   *
   * WHY IT IS A LITERAL AND NOT BUILT FROM THE SLOT NAME. Every region used to be matched by a
   * regex composed at call time — `new RegExp("{{#" + name + "}}…")`. Semgrep's
   * `detect-non-literal-regexp` flags exactly that (sg.run/gr65), and the rule is right about
   * this code for a reason that has nothing to do with ReDoS: a `name` carrying regex
   * metacharacters stops being a name and becomes a PATTERN. A slot called `a.*b` would compile
   * to a wildcard, match a region it does not own, and splice one worker's list into another
   * section of the sheet. Escaping the name would fix that and still leave a composed regex; a
   * literal removes the whole class instead, which is the standing rule here — the check that
   * a name is a name belongs in something `tsc` and the regex engine enforce, not in a
   * sanitiser someone can forget to call.
   *
   * The name is now CAPTURED and compared with `===`, so the only thing that can select a
   * region is exact equality against a key that is actually present in the data.
   *
   * `\1` IS A CORRECTNESS UPGRADE, not just plumbing: the closing tag must repeat the opening
   * name, so `{{#a}}…{{/b}}` can no longer be treated as a region at all.
   *
   * NON-GREEDY on purpose: the inner match stops at the FIRST matching close. That is correct
   * for regions with distinct names (an `{{#employments}}` block containing `{{#roles}}`) and is
   * why a region may never contain another region OF THE SAME NAME — the closing tags would pair
   * up wrongly and duplicate half the page.
   *
   * Used ONLY with `String.prototype.replace`, which resets `lastIndex` around every call, so
   * sharing one `/g` literal across call sites carries no cross-call state.
   */
  private static readonly REGION_RE = /{{#([a-z_]+)}}([\s\S]*?){{\/\1}}/g;

  /**
   * One object region, `{{#name}}…{{/name}}`, repeated once per item.
   */
  private static fillObjectRegion(
    html: string,
    name: string,
    items: ReadonlyArray<Record<string, unknown>>,
  ): string {
    return html.replace(ResumeRenderer.REGION_RE, (whole, key: string, inner: string) =>
      key === name ? items.map((item) => ResumeRenderer.renderItem(inner, item)).join("") : whole,
    );
  }

  /**
   * Render ONE item's block: nested regions first, then this item's own scalars.
   *
   * THE ORDER IS THE WHOLE POINT. An employment carries `when` ("Jan 2023 – Present · 3 yrs 6 mo")
   * and so does each role stint nested inside it. If scalars ran first, the employment's `when`
   * would be substituted into every role line before the roles region ever saw it, and a worker
   * promoted inside one company would show the company's dates on both stints. Recursing first
   * means the inner `{{when}}` is consumed by the role that owns it.
   *
   * An UNKNOWN key still resolves to empty rather than falling back to an outer scalar of the same
   * name — the same total-lookup guarantee the single-level engine documented, preserved here.
   */
  private static renderItem(inner: string, item: Record<string, unknown>): string {
    let out = inner;
    for (const [key, value] of Object.entries(item)) {
      if (!Array.isArray(value)) continue;
      const first: unknown = value[0];
      out =
        typeof first === "object" && first !== null
          ? ResumeRenderer.fillObjectRegion(out, key, value as Record<string, unknown>[])
          : ResumeRenderer.fillStringRegion(out, key, value);
    }
    return out.replace(/{{\s*([a-z_]+)\s*}}/g, (_t, key: string) =>
      ResumeRenderer.escapeScalar(item[key]),
    );
  }

  /** A `{{#name}}…{{.}}…{{/name}}` region over plain strings. */
  private static fillStringRegion(html: string, name: string, items: readonly unknown[]): string {
    return html.replace(ResumeRenderer.REGION_RE, (whole, key: string, inner: string) =>
      key === name
        ? items
            .map((it) => inner.replace(/{{\.}}/g, () => ResumeRenderer.escapeScalar(it)))
            .join("")
        : whole,
    );
  }

  /** Strings and numbers render; anything else (undefined, object, null) is empty. */
  private static escapeScalar(value: unknown): string {
    if (typeof value === "string") return ResumeRenderer.escapeHtml(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      return ResumeRenderer.escapeHtml(String(value));
    }
    return "";
  }

  /**
   * Render the PDF. Returns null (degraded) when the kill-switch is off, the
   * binary is missing, the process times out, the buffer guard trips, or it exits
   * non-zero — the shared {@link PdfRenderer} owns that. NEVER logs the HTML/name.
   *
   * THROWS, deliberately, when the image cannot resolve the sheet's fonts. That is
   * the one failure this method refuses to degrade over, because degrading produces a
   * PDF rather than withholding one: a Devanagari name line of empty boxes, or the
   * whole sheet in DejaVu Serif, both at exit 0. The processor turns the throw into
   * the same visible "no PDF this run" it already handles.
   */
  async renderPdf(input: ResumeRenderInput): Promise<Buffer | null> {
    await this.pdf.assertFontsResolve(RESUME_FONT_CONTRACT);
    return this.pdf.renderHtmlToPdf(this.buildResumeHtml(input), "resume");
  }

  /** Minimal HTML output encoder for user-controlled values. */
  private static escapeHtml(value: string): string {
    return PdfRenderer.escapeHtml(value);
  }
}
