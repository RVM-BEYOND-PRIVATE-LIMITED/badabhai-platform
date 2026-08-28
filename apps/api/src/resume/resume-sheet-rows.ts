import type { ResumeFactRow, ResumeListRow } from "./resume-renderer.service";

/**
 * The `bb_trade` sheet's composed lines and label/value rows. PURE — no I/O, no clock, no DI.
 *
 * SEPARATE FROM `resume-render-input.ts` BECAUSE IT IS PRESENTATION, not mapping. That file
 * decides which SOURCE a worker's résumé is built from and what each field means; this one
 * decides how those settled values read on a page. The split is what lets the composition rules
 * below be tested against literal strings rather than against a parsed DraftProfile.
 */

/** Joins segments the way the design does, dropping empties WITH their separator. */
function joinSegments(parts: readonly (string | null | undefined)[], sep = " · "): string | null {
  const kept = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return kept.length > 0 ? kept.join(sep) : null;
}

/**
 * THE VERDICT LINE (design guideline §6.2) — two lines that must resolve the fit question inside
 * a four-second scan, and the single highest-ranked element on the sheet (§5.1).
 *
 *   {role + function}  ·  {total years}  ·  {up to 3 controllers or machines}
 *   {city}  ·  available {availability}  ·  expects {salary}
 *
 * NEVER RENDER AN EMPTY SEGMENT. The guideline states it as a rule and it is the whole reason
 * this is a function rather than a template string: a missing city must take its separator with
 * it, never leave "· available in 15 days" opening with a dangling dot. Sparse profiles are the
 * common case, so most renders exercise this.
 */
export function buildVerdictLine(facts: {
  role: string | null;
  /** Total years. Null means UNKNOWN, which is rendered as such — never guessed. */
  years: number | null;
  /** Controllers first, then machines. Capped at three by the guideline. */
  tools: string[];
  city: string | null;
  /** Already humanised: "15 days", "Immediate". */
  availability: string | null;
  /** Already formatted with its currency, e.g. "₹24,000 – ₹28,000 / month". */
  salary: string | null;
  /**
   * Machine AXES, as printed labels ("3-axis", "4-axis") — R10 §2.5, rule 4.
   *
   * A FOURTH SEGMENT, and the renderer's slot contract has documented it since the sheet shipped
   * ("role · years · controllers · axis") while `buildVerdictLine` composed only three. Anyone
   * reading that contract would have believed axes already printed.
   *
   * NO TURNER SOURCE TODAY, and that is not a gap in this function. `qp_cnc_turning` has no axis
   * question — axes are a MILLING fact, and the ratified sample is a milling sheet. Building the
   * segment now is what makes a milling `TRADE_RESUME_MAPS` entry a data change rather than a
   * code change (see the §3.1 estimate). For a turner it stays empty and takes its separator with
   * it, exactly like every other absent segment here.
   */
  axes?: readonly string[];
}): { headlineLine: string | null; subheadLine: string | null } {
  return {
    headlineLine: joinSegments([
      facts.role,
      yearsPhrase(facts.years),
      toolsPhrase(facts.tools),
      axesPhrase(facts.axes ?? []),
    ]),
    subheadLine: joinSegments([
      facts.city,
      availabilityPhrase(facts.availability),
      facts.salary ? `expects ${facts.salary}` : null,
    ]),
  };
}

/**
 * "8 yrs", "1 yr 6 mo", or "duration not stated".
 *
 * "DURATION NOT STATED" IS THE HONEST RENDERING OF AN UNKNOWN, and §11 #3 makes it mandatory:
 * never estimated, never rounded, never silently omitted. It must also never become "fresher" —
 * §6.2 reserves that word for a worker who SAID they have no experience, and inferring it from
 * an absent number would put a claim on the page that the worker never made and that costs them
 * the job. Omitting the segment entirely would be just as wrong: an employer reading a résumé
 * with no tenure on it assumes the worst, so the sheet says plainly that nobody asked.
 */
function yearsPhrase(years: number | null): string {
  if (years === null || !Number.isFinite(years) || years <= 0) return "duration not stated";
  const whole = Math.floor(years);
  const months = Math.round((years - whole) * 12);
  const y = whole > 0 ? `${whole} ${whole === 1 ? "yr" : "yrs"}` : null;
  const m = months > 0 ? `${months} mo` : null;
  return joinSegments([y, m], " ") ?? "duration not stated";
}

/**
 * "3 & 4-axis" — the ratified sheet's compression, and it is not cosmetic.
 *
 * ADJACENT AXIS COUNTS SHARE THE WORD. A miller who runs both prints "3 & 4-axis" rather than
 * "3-axis, 4-axis": the second reads as two separate capabilities and costs a third of the
 * segment's width to say the same thing on a line that has four segments to fit.
 *
 * COMPRESSION IS BY SHARED SUFFIX, not by arithmetic. "3-axis" and "5-axis" compress to
 * "3 & 5-axis" too — they are not adjacent, and inventing an "adjacency" rule would mean deciding
 * that a 4-axis capability is implied, which is a claim the worker never made. Anything that does
 * not share a suffix is joined plainly.
 */
function axesPhrase(axes: readonly string[]): string | null {
  const kept = axes.map((a) => a.trim()).filter(Boolean);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  // The shared tail after the leading count, e.g. "-axis" in "3-axis".
  const suffixOf = (v: string) => /^(\d+)(\D.*)$/.exec(v);
  const parsed = kept.map(suffixOf);
  const first = parsed[0];
  if (first && parsed.every((p) => p !== null && p[2] === first[2])) {
    return `${parsed.map((p) => p![1]).join(" & ")}${first[2]}`;
  }
  return kept.join(", ");
}

/** Up to three, guideline §4.3 (controllers max 3). More than three stops being scannable. */
function toolsPhrase(tools: string[]): string | null {
  const kept = tools
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
  return kept.length > 0 ? kept.join(", ") : null;
}

/**
 * "available immediately" / "available in 15 days".
 *
 * The preposition is chosen from the value rather than concatenated blindly: "available in
 * Immediate" is the kind of line that makes a printed sheet look machine-generated, which is
 * exactly the impression a worker's own résumé cannot afford.
 */
function availabilityPhrase(availability: string | null): string | null {
  const value = availability?.trim();
  if (!value) return null;
  return /^immediate/i.test(value) ? "available immediately" : `available in ${value}`;
}

/**
 * The BARE availability, e.g. "Immediate" or "30 days".
 *
 * SEPARATE FROM `AVAILABILITY_PHRASES`, which yields whole sentences ("Available in 15 days")
 * for an unlabelled `{{availability}}` span in the twelve older layouts. The trade sheet needs
 * the value on its own twice over — once after the label "Available from", where the sentence
 * would read "Available from Available in 15 days", and once inside the Verdict Line, where it
 * would read "available in Available in 15 days". Deriving it from the structured status is
 * exact; stripping a prefix off the sentence would be guesswork about a string.
 *
 * `not_looking` AND `unknown` RETURN NULL, deliberately. A résumé exists to be shown to
 * employers and a line that discourages them serves nobody — the same judgement
 * `AVAILABILITY_PHRASES` already makes by having no `not_looking` entry.
 */
export function bareAvailability(input: {
  status: string;
  notice_period_days?: number | null;
}): string | null {
  switch (input.status) {
    case "immediate":
      return "Immediate";
    case "notice_period":
      return input.notice_period_days && input.notice_period_days > 0
        ? `${input.notice_period_days} days`
        : "Notice period";
    default:
      return null;
  }
}

/**
 * The résumé container's `availability` as a printable BARE label — "Immediate", "15 days".
 *
 * THE TOKEN IS NOT THE LABEL, and printing it is the #963 defect again. `resume_profile
 * .availability` deliberately keeps the model's own closed vocabulary ("immediate",
 * "notice_period", "15_days") so a stored container can still be diffed against its Langfuse
 * trace — that is a STORAGE decision, and reaching the page unchanged made a worker's Terms row
 * read "Available from immediate", exactly as `education_level` once printed "below_10". §8
 * stage 5 renders a closed-vocabulary LABEL; humanising at the edge is where that belongs.
 *
 * AN UNRECOGNISED TOKEN IS NORMALISED, NOT DROPPED, and never invented: underscores become
 * spaces and the first letter is capitalised, which is the same treatment `humanizeShift` gives
 * a value it does not know. The wire type is a bare `str | None`, so out-of-vocabulary values do
 * arrive; dropping one would silently cost a worker a real answer, and expanding one would be a
 * claim. `not_looking` is the single exception — a résumé exists to be shown to employers and a
 * line that discourages them serves nobody, the same judgement `AVAILABILITY_PHRASES` makes by
 * having no entry for it.
 */
export function bareAvailabilityLabel(token: string | null | undefined): string | null {
  const raw = token?.trim().toLowerCase();
  if (!raw || raw === "not_looking" || raw === "unknown") return null;
  const known: Readonly<Record<string, string>> = {
    immediate: "Immediate",
    notice_period: "Notice period",
    "15_days": "15 days",
    "1_month": "1 month",
  };
  if (known[raw]) return known[raw];
  const spaced = raw.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * "₹24,000 / month", or null.
 *
 * A POINT FIGURE, AND THE GUIDELINE ASKS FOR A BAND (§4.4: "Bands, never a point figure — a
 * point figure invites anchoring against the worker"). The band field does not exist yet:
 * `expected_salary` is a single number on the résumé container, so a band could only be
 * MANUFACTURED from it — and inventing a range around a number the worker gave is exactly the
 * kind of derived claim this pipeline forbids. Printing what they actually said is the honest
 * interim; the fix is `salary_expected_band` upstream, not arithmetic here.
 *
 * Indian digit grouping (24,000 → ₹24,000; 240000 → ₹2,40,000), because the reader is in India
 * and a Western grouping reads as a different number at a glance.
 */
export function formatMonthlySalary(amount: number | null | undefined): string | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(amount)} / month`;
}

/** Just the rupee figure, for the lower end of a band where "/ month" prints once at the end. */
function rupees(amount: number): string {
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(amount)}`;
}

/**
 * "₹24,000 – ₹28,000 / month", or "₹24,000 / month" when only one end was stated (R10 R-1).
 *
 * §4.4 IS EXPLICIT THAT A POINT FIGURE INVITES ANCHORING against the worker, and the ratified
 * sheet prints a range. But a range cannot be DERIVED: manufacturing "x − 10% to x + 10%" around
 * a stated number puts two figures on a man's résumé that he never said, which is the derived
 * claim §8 forbids. So the band is ASKED, and this prints exactly what was asked — a band when
 * both ends exist, a point figure when only one does, and nothing when neither does.
 *
 * A MAX AT OR BELOW THE MIN COLLAPSES TO THE MIN rather than printing "₹20,000 – ₹18,000". That
 * is a data error, not a negotiating position, and the honest rendering of a contradictory pair is
 * the half the worker is certain about — which is the lower end, the figure he said he wants.
 * Printing the max alone would be the one direction R-2's gate forbids.
 */
export function formatSalaryBand(
  min: number | null | undefined,
  max: number | null | undefined,
): string | null {
  const lo = typeof min === "number" && Number.isFinite(min) && min > 0 ? min : null;
  const hi = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : null;
  if (lo === null) return formatMonthlySalary(hi);
  if (hi === null || hi <= lo) return formatMonthlySalary(lo);
  return `${rupees(lo)} – ${rupees(hi)} / month`;
}

/**
 * AVAILABILITY & TERMS — the block every competitor omits, and §5.1 ranks it sixth of eleven,
 * above the entire work history. Two of the four things that actually reject a blue-collar
 * candidate are here, which is why the guideline's zone map puts this section ABOVE History.
 */
export function buildAvailabilityRows(facts: {
  availability: string | null;
  salary: string | null;
  preferredLocations: string[];
  willingToRelocate?: boolean;
  shift: string | null;
  /** §4.4 — many listings advertise food and accommodation, so it is a real matching signal. */
  accommodationNeeded?: boolean;
}): ResumeFactRow[] {
  const rows: ResumeFactRow[] = [];
  push(rows, "Available from", facts.availability);
  push(rows, "Salary expected", facts.salary);
  push(
    rows,
    "Preferred locations",
    joinSegments([
      facts.preferredLocations
        .map((l) => l.trim())
        .filter(Boolean)
        .join(", ") || null,
      // ONLY THE POSITIVE CLAIM. A worker who did not say they would relocate has said nothing,
      // and printing "Will not relocate" would turn silence into a refusal they never gave —
      // the same rule the night-shift toggle already follows.
      facts.willingToRelocate ? "Willing to relocate" : null,
    ]),
  );
  push(rows, "Shift", facts.shift);
  push(rows, "Accommodation", facts.accommodationNeeded ? "Required" : null);
  return rows;
}

/**
 * QUALIFICATION, DOCUMENTS & LANGUAGES.
 *
 * §11 #2 GOVERNS THE MISSING-CREDENTIAL CASE and it is the one that matters most here: a worker
 * with twelve years on the machine and no ITI is frequently the most valuable person on the
 * platform and the worst-looking résumé under conventional rules. Education renders as a single
 * quiet line when it exists and simply does not appear when it does not. Nothing flags its
 * absence, and nothing may.
 */
export function buildQualificationRows(facts: {
  educationHeadline: string | null;
  education: readonly string[];
  certifications: readonly string[];
  languages: readonly string[];
}): ResumeFactRow[] {
  const rows: ResumeFactRow[] = [];
  push(rows, "Education", joinSegments([facts.educationHeadline, ...facts.education]));
  push(rows, "Certificates", joinSegments(facts.certifications));
  push(rows, "Languages spoken", joinSegments(facts.languages));
  return rows;
}

/**
 * "Documents ready" — the self-declared tick row (§5.1 rank 9).
 *
 * A LIST ROW RATHER THAN A FACT ROW, because the design ticks each one: a supervisor scans for
 * the specific document he needs at the gate, and a comma-joined sentence makes him read it.
 *
 * SELF-DECLARED, AND NOTHING HERE SAYS OTHERWISE. This row is the worker's claim that he can
 * bring a document, never a statement that anyone has seen it — verification lives in the
 * masthead badge and nowhere else. It returns an EMPTY ARRAY rather than a row with no values,
 * so a worker who declared nothing gets no row at all: an empty "Documents ready" line reads as
 * "has no documents", which is a claim he never made.
 */
export function buildDocumentRows(documents: readonly string[]): ResumeListRow[] {
  const values = documents.map((d) => d.trim()).filter(Boolean);
  return values.length > 0 ? [{ label: "Documents ready", values }] : [];
}

function push(rows: ResumeFactRow[], label: string, value: string | null): void {
  const trimmed = value?.trim();
  if (trimmed) rows.push({ label, value: trimmed });
}
