import {
  ExperienceEntrySchema,
  type ExperienceEntry,
  type LlmInterviewDraft,
  type ProfilingFill,
  type QuestionPackItem,
} from "@badabhai/ai-contracts";

import { captureAnswer } from "../answer-capture";
import { changesAnswer, recordAnswer, type AnswerMap } from "../answer-map";
import { parseDurationMonths } from "../duration-months";
import { MAX_EXPERIENCE_ENTRIES } from "../llm-turn.service";
import { certifySkillLabel, MAX_SKILLS } from "../skill-certifier";
import { EXPERIENCE_KEY, SKILLS_KEY, type ProfilingSchemaView } from "./profiling-schema";

/**
 * APPLYING WHAT THE WORKER VOLUNTEERED (ADR-0057 R4/R5, #2311) — pure, and the ONE place that
 * decides whether a model's fill is written.
 *
 * THE MODEL PROPOSES; THIS FILE DECIDES (CLAUDE.md §3). A fill is written only when every rule
 * holds, and each is a rule the deterministic interview already lives by:
 *   - THE FIELD HOLDS NO VALUE YET (R4). A fill for a field that already holds a different value
 *     is a CHANGE, which only the worker's Haan may make (#2312); it is counted, never written.
 *   - NOT THE QUESTION ON SCREEN. The deterministic capture answers that one, as it always has.
 *   - THE SAME PARSERS AS A TYPED ANSWER. The value is read through `captureAnswer` against the
 *     item, so a model value and a typed value can never disagree about what was said — and a
 *     value the parser cannot read is not written at all.
 *   - SKILLS AND JOBS WAIT FOR THE MODEL-LED STRETCH TO END. While Phase A leads, its own turn
 *     records the trade's skills and jobs; a second writer there would double them.
 * Jobs are written in the shape the schema showed them, "role; duration; work" — the role is
 * required, the months come from the interview's own duration parser, and no employer is ever a
 * field (R2: employer details are the Profile page's).
 */

/** What the fills changed, and what the worker should hear was noted. */
export interface AppliedUnderstanding {
  readonly answers: AnswerMap;
  readonly draft: LlmInterviewDraft;
  /** "Label: value" — what a bridge line acknowledges. Display text, never stored. */
  readonly noted: readonly string[];
  /** The schema keys written, in order — closed catalogue keys for the event. */
  readonly appliedKeys: readonly string[];
  /**
   * Fills that named an already-filled field with a different value: CHANGES, never written here.
   * The Haan/Nahi gate (#2312) puts them to the worker as edits.
   */
  readonly conflicts: readonly ProfilingFill[];
}

export interface ApplyFillsInput {
  readonly view: ProfilingSchemaView;
  readonly fills: readonly ProfilingFill[];
  readonly answers: AnswerMap;
  readonly draft: LlmInterviewDraft;
  /** The pack question on screen — its answer is the deterministic capture's, never a fill's. */
  readonly onScreenKey: string | null;
  /** Phase A is leading: its own turn records skills and jobs. */
  readonly phaseALeads: boolean;
  readonly turn: number;
}

export function applyFills(input: ApplyFillsInput): AppliedUnderstanding {
  let answers = input.answers;
  let draft = input.draft;
  const noted: string[] = [];
  const appliedKeys: string[] = [];
  const conflicts: ProfilingFill[] = [];

  for (const fill of input.fills) {
    // One write per scalar key per turn; the two lists may take several entries.
    const isList = fill.key === SKILLS_KEY || fill.key === EXPERIENCE_KEY;
    if (fill.key === input.onScreenKey || (!isList && appliedKeys.includes(fill.key))) continue;
    const item = input.view.items.get(fill.key);
    if (item !== undefined) {
      const values = captureAnswer(textFor(item, fill.value), item).values;
      if (values.length === 0) continue;
      if (answers[item.question_key]?.status === "answered") {
        if (values.some((value) => changesAnswer(answers, value))) conflicts.push(fill);
        continue;
      }
      for (const value of values) answers = recordAnswer(answers, value, input.turn);
      noted.push(`${labelOf(input.view, fill.key)}: ${fill.value}`);
      appliedKeys.push(fill.key);
      continue;
    }
    if (input.phaseALeads) continue;
    if (fill.key === SKILLS_KEY) {
      const next = withSkill(draft, fill.value);
      if (next === null) continue;
      draft = next;
      noted.push(`Skill: ${draft.skills[draft.skills.length - 1]}`);
      appliedKeys.push(fill.key);
      continue;
    }
    if (fill.key === EXPERIENCE_KEY) {
      const job = jobOf(fill.value);
      if (job === null || draft.experiences.length >= MAX_EXPERIENCE_ENTRIES) continue;
      draft = { ...draft, experiences: [...draft.experiences, job] };
      noted.push(`Kaam: ${job.role_label}`);
      appliedKeys.push(fill.key);
    }
  }
  return { answers, draft, noted, appliedKeys, conflicts };
}

/**
 * "Label: value" for every schema field that became answered between `before` and `after` — the
 * deterministic cross-question fill's catches as well as the model's — except the keys in
 * `exclude` (the question on screen, and fills already noted by {@link applyFills}). What a bridge
 * line acknowledges is everything the worker just told, whichever path wrote it down.
 */
export function newlyAnswered(
  before: AnswerMap,
  after: AnswerMap,
  view: ProfilingSchemaView,
  exclude: readonly string[],
): string[] {
  const noted: string[] = [];
  for (const key of view.items.keys()) {
    if (exclude.includes(key)) continue;
    const now = after[key];
    if (now?.status !== "answered" || before[key]?.status === "answered") continue;
    const shown = now.value_raw ?? (now.value_normalized == null ? "" : String(now.value_normalized));
    if (shown.trim().length > 0) noted.push(`${labelOf(view, key)}: ${shown.trim()}`);
  }
  return noted;
}

/**
 * The model's value in the words the item's parser reads. A boolean arrives as "true"/"false"
 * (the schema's own convention) and the yes/no reader wants "haan"/"nahi"; a bare number of years
 * needs its unit for the duration reader. Everything else is read as written.
 */
export function textFor(item: QuestionPackItem, value: string): string {
  const trimmed = value.trim();
  if (item.answer_type === "boolean") {
    if (/^true$/i.test(trimmed)) return "haan";
    if (/^false$/i.test(trimmed)) return "nahi";
  }
  if (item.target_field === "experience_years" && /^\d+(\.\d+)?$/.test(trimmed)) {
    return `${trimmed} saal`;
  }
  return trimmed;
}

function labelOf(view: ProfilingSchemaView, key: string): string {
  return view.rows.find((row) => row.key === key)?.label ?? key;
}

/** The draft with one more certified skill, or null when it is not one, repeats, or is past cap. */
function withSkill(draft: LlmInterviewDraft, value: string): LlmInterviewDraft | null {
  const skill = certifySkillLabel(value);
  if (skill === null || draft.skills.length >= MAX_SKILLS) return null;
  const key = skill.toLowerCase();
  if (draft.skills.some((held) => held.toLowerCase() === key)) return null;
  return { ...draft, skills: [...draft.skills, skill] };
}

/** "role; duration; work" as a job entry, or null when there is no role or it fails the contract. */
export function jobOf(value: string): ExperienceEntry | null {
  const [role = "", duration = "", ...work] = value.split(";").map((part) => part.trim());
  if (role.length === 0) return null;
  const parsed = ExperienceEntrySchema.safeParse({
    role_label: role,
    duration_text: duration,
    duration_months: duration ? parseDurationMonths(duration) : null,
    work_done: work.join("; "),
  });
  return parsed.success ? parsed.data : null;
}
