/**
 * The facts a companion turn is composed from (ADR-0044), and the pure rules over them.
 *
 * Everything here is PII-free by construction: counts, closed sets, the résumé's own glance
 * (role, tenure, tools, city — the same facts the Resume tab's history card shows) and job
 * posting titles/cities that the Jobs tab already shows the same worker. No name, no phone, no
 * employer, nothing the worker typed.
 */
import type { CompanionJobsScope, CompanionNudge, ResumeSource } from "@badabhai/types";
import type { ResumeHistoryItem } from "../resume/resume.dto";

/** The worker's current résumé, as `ResumeService.history()` reports its newest item. */
export interface CompanionResumeFacts {
  readonly resumeId: string;
  readonly source: ResumeSource | null;
  /** 'pending' | 'rendered' | 'failed' */
  readonly renderStatus: string;
  /** When this row was generated; null only when the stored value does not parse. */
  readonly generatedAt: Date | null;
  readonly tradeLabel: string | null;
  readonly experienceYears: number | null;
  readonly machines: readonly string[];
  readonly city: string | null;
}

/**
 * What the recap may honestly SAY about the current résumé — decided once, from the row and the
 * clock, so the lines and the nudge can never disagree.
 *
 *   - `ready`    — the document exists and its render did not fail: rendered, or `pending` for
 *                  longer than the grace (the Resume tab already shows its text; only the PDF is
 *                  late, and "being made" would be claimed for ever — the render kill-switch and
 *                  the pre-#1399 rows park at `pending` with nothing re-enqueueing them);
 *   - `building` — a first build in flight: `pending` inside the grace, or no row yet inside the
 *                  grace after the confirmation (the confirm enqueues it);
 *   - `failed`   — the render ended at `failed`: there is no PDF, and the Resume tab says NAHI
 *                  BANI, so "bana hai" would contradict it;
 *   - `none`     — no row, long after the confirmation: nothing true to say about it;
 *   - `unknown`  — the history read FAILED: say nothing rather than guess.
 */
export type CompanionResumeState = "ready" | "building" | "failed" | "none" | "unknown";

/** An ISO instant from the wire DTO, or null when it does not parse. */
export function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The worker's CURRENT résumé (the history's newest item) as companion facts, or null when there is
 * none. ONE mapping for the recap and the download answer (ADR-0055), so the two can never disagree
 * about which résumé is current or what state it is in.
 */
export function currentResumeFacts(
  current: ResumeHistoryItem | undefined,
): CompanionResumeFacts | null {
  if (current === undefined) return null;
  return {
    resumeId: current.resume_id,
    source: current.source ?? null,
    renderStatus: current.render_status,
    generatedAt: parseInstant(current.generated_at),
    tradeLabel: current.trade_label,
    experienceYears: current.experience_years,
    machines: current.machines ?? [],
    city: current.city,
  };
}

/**
 * What a DOWNLOAD request may honestly be told (ADR-0055) — decided from the recap's own state:
 *
 *   - `ready`       — the résumé is `ready` AND its PDF is drawn (`rendered`): the one case
 *                     `GET /resume/:id/download` hands a file over, so the only one offered a chip.
 *                     A `pending` row past the grace is `ready` for the recap (its text shows) but
 *                     has no PDF — the download route answers 409 — so it is not ready here;
 *   - `building`    — a first build in flight: "abhi ban raha hai" is true;
 *   - `unavailable` — failed, none, unknown, or a PDF that never came: nothing to hand over, and
 *                     nothing promised about when.
 */
export type CompanionResumeDownload = "ready" | "building" | "unavailable";

export function resumeDownloadOf(
  state: CompanionResumeState,
  resume: CompanionResumeFacts | null,
): CompanionResumeDownload {
  if (state === "ready" && resume?.renderStatus === "rendered") return "ready";
  if (state === "building") return "building";
  return "unavailable";
}

export function resumeStateOf(args: {
  readonly resume: CompanionResumeFacts | null;
  readonly unavailable: boolean;
  readonly confirmedAt: Date | null;
  readonly now: Date;
  readonly graceMs: number;
}): CompanionResumeState {
  if (args.unavailable) return "unknown";
  const recent = (at: Date | null): boolean =>
    at !== null && args.now.getTime() - at.getTime() < args.graceMs;
  const resume = args.resume;
  if (resume === null) return recent(args.confirmedAt) ? "building" : "none";
  if (resume.renderStatus === "failed") return "failed";
  if (resume.renderStatus === "pending" && recent(resume.generatedAt)) return "building";
  return "ready";
}

export interface CompanionJob {
  readonly jobPostingId: string;
  readonly title: string;
  readonly city: string | null;
}

export interface CompanionJobsFacts {
  /** `profile`: matched on wanted skills. `no_skills`: nothing to match. `unavailable`: read failed. */
  readonly scope: CompanionJobsScope;
  /** Matching postings in the window, capped at `countCap` (null unless `scope === "profile"`). */
  readonly count: number | null;
  /** True when more than `count` matched — the copy says "{count} se zyada". */
  readonly capped: boolean;
  /** Newest first, already screened, at most the chip allowance. */
  readonly jobs: readonly CompanionJob[];
  readonly windowDays: number;
}

/**
 * Whether the worker's trade is one of the form-based profiles the platform serves.
 *
 * THE 21 DECLARED TRADE KINDS ARE THE SERVED SET (`TRADE_FORM_KINDS_ALL`), and `worker_profiles.source`
 * is the durable record of which road produced the profile: `form` = a trade form (one of those
 * kinds), `chat` = the general chat road (not a served trade). NULL is a pre-0107 row — unknown,
 * never asserted as outside (a false "aapki profile industrial manufacturing mein nahi aati" is
 * worse than today's generic jobs line).
 *
 * This deliberately reads the ROAD, not `canonical_role_id`: only five form kinds have an exact
 * taxonomy role (`trade-canonical.ts`), so a fitter or welder carries a form kind and a null role.
 * The road is what every form-based trade has in common.
 */
export type IndustrialTradeScope = "served" | "outside" | "unknown";

export function industrialTradeScope(profile: { readonly source?: string | null }): IndustrialTradeScope {
  if (profile.source === "form") return "served";
  if (profile.source === "chat") return "outside";
  return "unknown";
}

export interface CompanionFacts {
  /** Null = the worker has no résumé yet (or the read failed — see `resumeState`). */
  readonly resume: CompanionResumeFacts | null;
  /** Whether the worker's trade is one of the form-based trades we serve (`industrialTradeScope`). */
  readonly tradeScope: IndustrialTradeScope;
  /** What may be said about `resume`; `unknown` when the résumé read failed. */
  readonly resumeState: CompanionResumeState;
  /** An accepted chat update that has not landed (ADR-0043), or null. */
  readonly pendingUpdate: "in_progress" | "failed" | null;
  /** How many jobs the worker applied to, or null when the read failed. */
  readonly appliedCount: number | null;
  readonly jobs: CompanionJobsFacts;
  /** The first profile gap a worker can fill, from the closed label map, or null. */
  readonly missingField: string | null;
}

/**
 * THE ONE NUDGE, ordered, first match wins — a business rule, so it is code and never a model.
 *
 *   1. a résumé still being built or updated — tell them to wait for it (the building line);
 *   2. never applied, and matching jobs are ON THIS TURN as chips — the first application is the
 *      one that matters, and "neeche diye jobs" must point at jobs that are actually below;
 *   3. matching jobs exist — apply to them;
 *   4. a fillable profile gap — fill it;
 *   5. nothing — no nudge line (the "all set" line may be served instead; see `allClear`).
 *
 * A failed update or a failed render is NOT a nudge: it is reported as a fact in the résumé
 * section, and it keeps the "all set" line away.
 */
export function chooseNudge(facts: CompanionFacts): CompanionNudge | null {
  if (facts.resumeState === "building" || (facts.resumeState !== "unknown" && facts.pendingUpdate === "in_progress")) {
    return "resume_pending";
  }
  const newJobs = facts.jobs.scope === "profile" ? (facts.jobs.count ?? 0) : 0;
  if (facts.appliedCount === 0 && newJobs > 0 && facts.jobs.jobs.length > 0) return "apply_first";
  if (newJobs > 0) return "apply_new";
  if (facts.missingField !== null) return "complete_profile";
  return null;
}

/**
 * "Abhi sab theek hai" is a CONCLUSION, and a low-literacy reader takes the last line as the
 * answer. So it is served only when every section of the turn was read and reported nothing to
 * act on: a finished résumé with no update failing, a known applied count, and a jobs read that
 * matched on the worker's skills. Anything less gets no closing line at all.
 */
export function allClear(facts: CompanionFacts): boolean {
  return (
    facts.resumeState === "ready" &&
    facts.pendingUpdate === null &&
    facts.appliedCount !== null &&
    facts.jobs.scope === "profile"
  );
}
