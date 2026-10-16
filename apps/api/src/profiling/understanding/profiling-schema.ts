import type {
  ExperienceEntry,
  LlmInterviewDraft,
  ProfilingSchemaRow,
  QuestionPackItem,
} from "@badabhai/ai-contracts";
import type { ProfilingFieldKind } from "@badabhai/types";

import type { AnswerMap } from "../answer-map";
import { chatServableItems } from "../facts/worker-fact.ownership";

/**
 * THE SESSION'S PROFILING SCHEMA, as `profiling_turn_understand` reads it (ADR-0057 §3.1, #2311).
 *
 * PURE: the live envelope in, the rows the model is shown out — plus the maps that turn a model's
 * key or ref back into the thing it names. Built from the REDIS ENVELOPE, because mid-session
 * nothing is persisted: the answer map holds the pack answers and the model-led draft holds the
 * trade's skills and jobs.
 *
 * WHAT IS IN IT (R2: only what the chat itself captures):
 *   - every chat-servable pack item the engine can still select, keyed by its `question_key`;
 *   - the draft's skills and jobs, as two `list` rows whose entries carry per-request refs
 *     (`s1`, `x1`, …) — never a database id, never derivable from the worker's words.
 * WHAT IS NOT: the worker's own name (G2 — the model never sees it), and every Profile-page fact,
 * which goes by NAME ONLY in {@link PAGE_OWNED_FACTS}, for the model to say it heard one.
 */

/** The schema key of the draft's skills list. */
export const SKILLS_KEY = "skills";
/** The schema key of the draft's job list. */
export const EXPERIENCE_KEY = "experience";

/**
 * The Profile-page facts (ADR-0057 R2), by name only. The model may report hearing one; the chat
 * never captures or edits it, and the worker is pointed to the Profile page instead.
 */
export const PAGE_OWNED_FACTS = [
  "expected_salary",
  "preferred_cities",
  "shift",
  "education",
  "certificates",
  "employer_details",
] as const;

/** The contract's bounds, restated where they are applied (the request is parsed against them). */
const MAX_ROWS = 64;
const MAX_ENTRIES = 20;
const MAX_OPTIONS = 40;
const LABEL_MAX = 80;
const VALUE_MAX = 500;

/** The rows, plus the way back from what the model names to what it means. */
export interface ProfilingSchemaView {
  readonly rows: readonly ProfilingSchemaRow[];
  /** `question_key` → the pack item it names. */
  readonly items: ReadonlyMap<string, QuestionPackItem>;
  /** `s1` → index into `draft.skills`. */
  readonly skillRefs: ReadonlyMap<string, number>;
  /** `x1` → index into `draft.experiences`. */
  readonly experienceRefs: ReadonlyMap<string, number>;
}

/**
 * Build the schema from the items the engine can still select (`progressItems` — the narrowed
 * pair, so a suppressed trade question is never offered), the answer map and the draft.
 */
export function buildProfilingSchema(
  selectableItems: readonly QuestionPackItem[],
  answers: AnswerMap,
  draft: LlmInterviewDraft,
): ProfilingSchemaView {
  const rows: ProfilingSchemaRow[] = [];
  const items = new Map<string, QuestionPackItem>();
  for (const item of chatServableItems(selectableItems)) {
    if (items.has(item.question_key) || rows.length >= MAX_ROWS - 2) continue;
    items.set(item.question_key, item);
    rows.push(packRow(item, answers));
  }

  const skillRefs = new Map<string, number>();
  const skills = draft.skills.slice(0, MAX_ENTRIES).map((skill, index) => {
    const ref = `s${index + 1}`;
    skillRefs.set(ref, index);
    return { ref, value: clip(skill, VALUE_MAX) };
  });
  rows.push(listRow(SKILLS_KEY, "Skills", skills));

  const experienceRefs = new Map<string, number>();
  const jobs = draft.experiences.slice(0, MAX_ENTRIES).map((job, index) => {
    const ref = `x${index + 1}`;
    experienceRefs.set(ref, index);
    return { ref, value: clip(jobLine(job), VALUE_MAX) };
  });
  rows.push(listRow(EXPERIENCE_KEY, "Kaam ka itihaas (role; samay; kaam)", jobs));

  return { rows, items, skillRefs, experienceRefs };
}

/** A job as the model reads it — and the shape it writes a new one in: "role; duration; work". */
export function jobLine(job: ExperienceEntry): string {
  return [job.role_label, job.duration_text, job.work_done]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("; ");
}

function packRow(item: QuestionPackItem, answers: AnswerMap): ProfilingSchemaRow {
  const record = answers[item.question_key];
  const status =
    record === undefined
      ? "missing"
      : record.status === "answered" || record.status === "declined"
        ? record.status
        : "unanswered";
  const value = record?.status === "answered" ? displayValue(record) : null;
  const kind = kindOf(item);
  return {
    key: item.question_key,
    label: clip(item.prompt_text, LABEL_MAX) || item.question_key,
    kind,
    options:
      kind === "single_select" || kind === "multi_select"
        ? item.options.slice(0, MAX_OPTIONS).map((option) => clip(option.label_text, LABEL_MAX))
        : [],
    value: value === null ? null : clip(value, VALUE_MAX) || null,
    status,
    entries: [],
  };
}

function listRow(
  key: string,
  label: string,
  entries: readonly { ref: string; value: string }[],
): ProfilingSchemaRow {
  const kept = entries.filter((entry) => entry.value.length > 0);
  return {
    key,
    label,
    kind: "list",
    options: [],
    value: null,
    status: kept.length > 0 ? "answered" : "missing",
    entries: kept,
  };
}

/**
 * The kind the model must write a value in. The target field decides where the answer type is too
 * coarse: years are a `duration` and a city a `city`, though both are typed as text or number.
 */
function kindOf(item: QuestionPackItem): ProfilingFieldKind {
  if (item.target_field === "experience_years") return "duration";
  if (item.target_field === "current_city") return "city";
  switch (item.answer_type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "single_select":
      return "single_select";
    case "multi_select":
      return "multi_select";
    default:
      return "text";
  }
}

/** The stored answer as display text: the worker's own words where kept, else the value. */
function displayValue(record: {
  readonly value_raw: string | null;
  readonly value_normalized?: unknown;
}): string | null {
  if (record.value_raw !== null && record.value_raw.trim().length > 0) return record.value_raw;
  const value = record.value_normalized;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd();
}
