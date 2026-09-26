/**
 * The facts a companion turn is composed from (ADR-0044), and the pure rules over them.
 *
 * Everything here is PII-free by construction: counts, closed sets, the résumé's own glance
 * (role, tenure, tools, city — the same facts the Resume tab's history card shows) and job
 * posting titles/cities that the Jobs tab already shows the same worker. No name, no phone, no
 * employer, nothing the worker typed.
 */
import type { CompanionJobsScope, CompanionNudge, ResumeSource } from "@badabhai/types";

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

export interface CompanionFacts {
  /** Null = the worker has no résumé yet (or the read failed — see `resumeState`). */
  readonly resume: CompanionResumeFacts | null;
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
