/**
 * Facts + intent → the lines and chips of one companion turn (ADR-0044). Pure: no I/O, no clock,
 * no logging, so every turn the worker can see is reproducible byte for byte in a unit test.
 *
 * CHIPS NEVER EXCEED THE PERSONA'S FOUR (`persona.json` `maxChips`). The recap carries at most two
 * job chips so the Jobs-tab and "Resume badlein" chips always fit beside them; the jobs reply
 * carries up to three job chips and the Jobs-tab chip.
 */
import type { CompanionIntent, CompanionNudge } from "@badabhai/types";
import {
  COMPANION_APPLIED_KEY,
  COMPANION_APPLIED_LABEL,
  COMPANION_JOBS_TAB_KEY,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_JOB_LABEL_SEPARATOR,
  COMPANION_JOB_TITLE_MAX,
  COMPANION_NEW_JOBS_KEY,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_RESUME_KEY,
  COMPANION_RESUME_LABEL,
  companionJobKey,
} from "./companion-keys";
import {
  ALL_SET,
  APPLIED_LIST_TAIL,
  APPLIED_MANY,
  APPLIED_NONE,
  APPLIED_ONE,
  FALLBACK,
  GLANCE,
  JOBS_LIST_TAIL,
  JOBS_NONE_TAIL,
  JOBS_UNAVAILABLE,
  LEAD,
  MISSING_FIELD_LABELS,
  NEW_JOBS_CAPPED,
  NEW_JOBS_MANY,
  NEW_JOBS_NONE,
  NEW_JOBS_ONE,
  NO_SKILLS,
  NUDGE_LINES,
  RESUME_BUILDING,
  RESUME_RENDER_FAILED,
  RESUME_UPDATE_FAILED,
  RESUME_UPDATING,
  ROAD,
  fillSlots,
  guaranteeLine,
  render,
  type RenderedLine,
} from "./companion-replies";
import { allClear, chooseNudge, type CompanionFacts, type CompanionJob } from "./companion-facts";

export interface WireOption {
  readonly option_key: string;
  readonly label_text: string;
  readonly is_none_of_above: false;
}

/** A line shown to the worker, with its read-aloud twin when one exists. */
export interface ComposedLine {
  readonly text: string;
  readonly tts: string | null;
}

export interface ComposedTurn {
  readonly lines: readonly ComposedLine[];
  readonly options: readonly WireOption[];
  /** The nudge line this turn served, for the event. Null when none was served. */
  readonly nudge: CompanionNudge | null;
  readonly jobChipsCount: number;
}

/** The recap may carry at most this many job chips (four chips total with Jobs tab + résumé). */
export const RECAP_JOB_CHIPS_MAX = 2;
/** The jobs reply may carry at most this many (four total with the Jobs-tab chip). */
export const JOBS_REPLY_CHIPS_MAX = 3;

const opt = (key: string, label: string): WireOption => ({
  option_key: key,
  label_text: label,
  is_none_of_above: false,
});

const RESUME_CHIP = opt(COMPANION_RESUME_KEY, COMPANION_RESUME_LABEL);
const JOBS_TAB_CHIP = opt(COMPANION_JOBS_TAB_KEY, COMPANION_JOBS_TAB_LABEL);
const NEW_JOBS_CHIP = opt(COMPANION_NEW_JOBS_KEY, COMPANION_NEW_JOBS_LABEL);
const APPLIED_CHIP = opt(COMPANION_APPLIED_KEY, COMPANION_APPLIED_LABEL);

const line = (rendered: RenderedLine): ComposedLine => ({ text: rendered.text, tts: rendered.tts });

/**
 * A job chip: the title (cut to one row), then the separator, then the city when there is one.
 * The separator is removed from the title first so the app's split back into title + city can
 * never mis-cut a posting whose own title happened to contain it.
 */
export function jobChip(job: CompanionJob): WireOption {
  const cleaned = job.title.replace(/\s+/g, " ").split(COMPANION_JOB_LABEL_SEPARATOR).join(" - ").trim();
  const title =
    cleaned.length > COMPANION_JOB_TITLE_MAX
      ? `${cleaned.slice(0, COMPANION_JOB_TITLE_MAX - 1).trimEnd()}…`
      : cleaned;
  const city = job.city?.trim();
  return opt(companionJobKey(job.jobPostingId), city ? `${title}${COMPANION_JOB_LABEL_SEPARATOR}${city}` : title);
}

/** "{years} saal tajurba", printing a fractional tenure with one decimal. */
function tenure(years: number): string {
  const shown = Number.isInteger(years) ? String(years) : years.toFixed(1);
  return `${shown} saal tajurba`;
}

function resumeLines(facts: CompanionFacts): ComposedLine[] {
  const out: ComposedLine[] = [];
  const resume = facts.resume;
  switch (facts.resumeState) {
    case "unknown":
      // The read failed. Unknown is not "none yet": say nothing rather than guess.
      return out;
    case "ready":
      if (resume === null) break;
      out.push(line(render(ROAD[resume.source ?? "unknown"])));
      if (resume.renderStatus === "rendered") {
        const parts = [
          resume.tradeLabel,
          resume.experienceYears !== null ? tenure(resume.experienceYears) : null,
          resume.machines.slice(0, 2).join(", ") || null,
          resume.city,
        ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
        if (parts.length > 0) out.push(line(render(GLANCE, { facts: parts.join(", ") })));
      }
      break;
    case "failed":
      out.push(line(render(RESUME_RENDER_FAILED)));
      break;
    case "building":
    case "none":
      break;
  }
  if (facts.pendingUpdate === "in_progress") out.push(line(render(RESUME_UPDATING)));
  else if (facts.resumeState === "building") out.push(line(render(RESUME_BUILDING)));
  if (facts.pendingUpdate === "failed") out.push(line(render(RESUME_UPDATE_FAILED)));
  return out;
}

function appliedLine(count: number | null): ComposedLine | null {
  if (count === null) return null;
  if (count === 0) return line(render(APPLIED_NONE));
  if (count === 1) return line(render(APPLIED_ONE));
  return line(render(APPLIED_MANY, { n: count }));
}

function jobsLine(facts: CompanionFacts): ComposedLine {
  const jobs = facts.jobs;
  if (jobs.scope === "unavailable") return line(render(JOBS_UNAVAILABLE));
  if (jobs.scope === "no_skills") return line(render(NO_SKILLS));
  const count = jobs.count ?? 0;
  const d = jobs.windowDays;
  if (count === 0) return line(render(NEW_JOBS_NONE, { d }));
  if (jobs.capped) return line(render(NEW_JOBS_CAPPED, { d, n: count }));
  if (count === 1) return line(render(NEW_JOBS_ONE, { d }));
  return line(render(NEW_JOBS_MANY, { d, n: count }));
}

function nudgeLine(nudge: CompanionNudge | null, facts: CompanionFacts): ComposedLine | null {
  if (nudge === null) return allClear(facts) ? line(render(ALL_SET)) : null;
  if (nudge === "resume_pending") return null; // the building/updating line already says it
  if (nudge === "complete_profile") {
    const label = facts.missingField === null ? undefined : MISSING_FIELD_LABELS[facts.missingField];
    if (label === undefined) return null;
    const pair = NUDGE_LINES.complete_profile;
    return {
      text: fillSlots(pair.latin, { field: label.latin }),
      tts: fillSlots(pair.dev, { field: label.dev }),
    };
  }
  return line(render(NUDGE_LINES[nudge]));
}

function newJobsCount(facts: CompanionFacts): number {
  return facts.jobs.scope === "profile" ? (facts.jobs.count ?? 0) : 0;
}

/** The jobs-first chip: the jobs reply when something matched, else straight to the Jobs tab. */
function jobsEntryChip(facts: CompanionFacts): WireOption {
  return newJobsCount(facts) > 0 && facts.jobs.jobs.length > 0 ? NEW_JOBS_CHIP : JOBS_TAB_CHIP;
}

function hasApplied(facts: CompanionFacts): boolean {
  return (facts.appliedCount ?? 0) > 0;
}

/** "Ab tak kya hua" — the opening, a greeting, a résumé question. */
export function composeDigest(facts: CompanionFacts): ComposedTurn {
  const nudge = chooseNudge(facts);
  const lines: ComposedLine[] = [line(render(LEAD)), ...resumeLines(facts)];
  const applied = appliedLine(facts.appliedCount);
  if (applied) lines.push(applied);
  lines.push(jobsLine(facts));
  const nudgeText = nudgeLine(nudge, facts);
  if (nudgeText) lines.push(nudgeText);

  const jobChips =
    facts.jobs.scope === "profile" ? facts.jobs.jobs.slice(0, RECAP_JOB_CHIPS_MAX).map(jobChip) : [];
  const options: WireOption[] =
    jobChips.length > 0
      ? [...jobChips, JOBS_TAB_CHIP, RESUME_CHIP]
      : [JOBS_TAB_CHIP, ...(hasApplied(facts) ? [APPLIED_CHIP] : []), RESUME_CHIP];
  return {
    lines,
    options,
    // A complete_profile nudge whose field has no label served no line, so it is not recorded.
    nudge: nudge === "complete_profile" && nudgeText === null ? null : nudge,
    jobChipsCount: jobChips.length,
  };
}

/** "Naye jobs dikhao" — the count line, then up to three job chips and the Jobs tab. */
export function composeJobs(facts: CompanionFacts): ComposedTurn {
  const lines: ComposedLine[] = [jobsLine(facts)];
  const jobChips =
    facts.jobs.scope === "profile" ? facts.jobs.jobs.slice(0, JOBS_REPLY_CHIPS_MAX).map(jobChip) : [];
  if (jobChips.length > 0) lines.push(line(render(JOBS_LIST_TAIL)));
  else if (facts.jobs.scope === "profile") lines.push(line(render(JOBS_NONE_TAIL)));
  const options = jobChips.length > 0 ? [...jobChips, JOBS_TAB_CHIP] : [JOBS_TAB_CHIP, RESUME_CHIP];
  return { lines, options, nudge: null, jobChipsCount: jobChips.length };
}

/** "Kitne jobs par apply kiya" — the count, and the way to the full list. */
export function composeApplied(facts: CompanionFacts): ComposedTurn {
  const lines: ComposedLine[] = [];
  let nudge: CompanionNudge | null = null;
  const applied = appliedLine(facts.appliedCount);
  if (applied) lines.push(applied);
  if (facts.appliedCount === 0) {
    // This reply carries NO job chips, so never "neeche diye jobs": point at the new-jobs chip
    // when something matched, else at the Jobs tab.
    if (newJobsCount(facts) > 0) {
      nudge = "apply_new";
      lines.push(line(render(NUDGE_LINES.apply_new)));
    } else {
      lines.push(line(render(JOBS_NONE_TAIL)));
    }
  } else {
    lines.push(line(render(APPLIED_LIST_TAIL)));
  }
  const options =
    facts.appliedCount === 0
      ? [jobsEntryChip(facts), RESUME_CHIP]
      : [APPLIED_CHIP, jobsEntryChip(facts), RESUME_CHIP];
  return { lines, options, nudge, jobChipsCount: 0 };
}

/** "Job milegi?" — the persona's honest refusal, verbatim, with no read-aloud twin. */
export function composeGuarantee(facts: CompanionFacts): ComposedTurn {
  return {
    lines: [{ text: guaranteeLine(), tts: null }],
    options: [jobsEntryChip(facts), RESUME_CHIP],
    nudge: null,
    jobChipsCount: 0,
  };
}

/** Anything not understood: what the companion can help with, as chips. */
export function composeFallback(facts: CompanionFacts): ComposedTurn {
  return {
    lines: [line(render(FALLBACK))],
    options: [jobsEntryChip(facts), ...(hasApplied(facts) ? [APPLIED_CHIP] : []), RESUME_CHIP],
    nudge: null,
    jobChipsCount: 0,
  };
}

export function composeFor(
  intent: Exclude<CompanionIntent, "resume_menu">,
  facts: CompanionFacts,
): ComposedTurn {
  switch (intent) {
    case "digest":
      return composeDigest(facts);
    case "jobs":
      return composeJobs(facts);
    case "applied":
      return composeApplied(facts);
    case "guarantee":
      return composeGuarantee(facts);
    case "fallback":
      return composeFallback(facts);
  }
}

/** The shown reply: one bubble, one line per fact. */
export function replyText(turn: ComposedTurn): string {
  return turn.lines.map((l) => l.text).join("\n");
}

/** The read-aloud script, or undefined when any line has no twin (then the app speaks `reply`). */
export function replyTts(turn: ComposedTurn): string | undefined {
  if (turn.lines.some((l) => l.tts === null)) return undefined;
  return turn.lines.map((l) => l.tts as string).join(" ");
}
