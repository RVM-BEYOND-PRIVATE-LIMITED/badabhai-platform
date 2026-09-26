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
  readonly tradeLabel: string | null;
  readonly experienceYears: number | null;
  readonly machines: readonly string[];
  readonly city: string | null;
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
  /** Null = the worker has no résumé yet. */
  readonly resume: CompanionResumeFacts | null;
  /**
   * The résumé read FAILED — so `resume: null` means "unknown", not "none yet". The recap then
   * says nothing about the résumé rather than claim it is still being built.
   */
  readonly resumeUnavailable: boolean;
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
 *   2. never applied, and matching jobs exist — the first application is the one that matters;
 *   3. matching jobs exist — apply to them;
 *   4. a fillable profile gap — fill it;
 *   5. nothing — no nudge line (the "all set" line is served instead).
 *
 * A failed update is NOT a nudge: it is reported as a fact in the résumé section.
 */
export function chooseNudge(facts: CompanionFacts): CompanionNudge | null {
  const resumeBuilding =
    !facts.resumeUnavailable &&
    (facts.resume === null || facts.resume.renderStatus === "pending" || facts.pendingUpdate === "in_progress");
  if (resumeBuilding) return "resume_pending";
  const newJobs = facts.jobs.scope === "profile" ? (facts.jobs.count ?? 0) : 0;
  if (facts.appliedCount === 0 && newJobs > 0) return "apply_first";
  if (newJobs > 0) return "apply_new";
  if (facts.missingField !== null) return "complete_profile";
  return null;
}
