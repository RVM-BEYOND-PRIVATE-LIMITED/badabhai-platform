import { randomUUID } from "node:crypto";

import type {
  AnswerType,
  ExperienceEntry,
  InputMode,
  LlmInterviewDraft,
  ProfilingEdit,
  QuestionPackItem,
  QuestionPackOption,
} from "@badabhai/ai-contracts";
import { parseAffirmation } from "@badabhai/profiling-lexicon";
import type { ProfilingEditOp } from "@badabhai/types";

import { captureAnswer, withinFieldBound } from "../answer-capture";
import {
  changesAnswer,
  forgetAnswer,
  recordAnswer,
  type AnswerMap,
  type CapturedValue,
} from "../answer-map";
import { parseDurationMonths } from "../duration-months";
import { isBareYesNo } from "../free-chat/free-chat.router";
import {
  EDIT_APPLIED_PAIR,
  EDIT_KEPT_PAIR,
  EDIT_REMOVED_PAIR,
} from "../next-question";
import { certifySkillLabel } from "../skill-certifier";
import {
  EXPERIENCE_KEY,
  jobLine,
  ROLE_KEY,
  SKILLS_KEY,
  type ProfilingSchemaView,
} from "./profiling-schema";

export { ROLE_KEY } from "./profiling-schema";
import {
  MAX_PROPOSAL_ROWS,
  type EditGateState,
  type EditRow,
  type EditTarget,
} from "./edit-gate.state";
import { jobOf, textFor } from "./understanding-apply";

export {
  editGateOpen,
  MAX_PROPOSAL_ROWS,
  narrowEditGate,
  type EditGateState,
  type EditRow,
  type EditTarget,
} from "./edit-gate.state";

/**
 * THE HAAN/NAHI GATE ON A FILLED FIELD (ADR-0057 §3.4, R4/R6/R10, #2312) — pure.
 *
 * THE MODEL PROPOSES; THIS FILE DECIDES (CLAUDE.md §3). A change to a value the worker already gave
 * is never written on the model's word, nor on a typed parser's guess: it becomes a PROPOSAL, put
 * to the worker as "<field>: <old> se <new> kar doon?" with Haan / Nahi, and only their Haan writes
 * it. Every row is checked against the session's own catalogue first — the key names a field this
 * interview holds, the ref names an entry it holds, the new value reads through that field's own
 * parser and actually differs — and a row that fails any check is dropped, never guessed at.
 *
 * WHERE A PROPOSAL COMES FROM, all three read the same way:
 *   - the model's `edits[]` (a change or a removal the worker asked for);
 *   - a model fill that names a field already holding a DIFFERENT value (#2311 counted these);
 *   - the deterministic one-candidate correction (#2307) — silent while the layer is unarmed, put
 *     to the worker once it is armed.
 *
 * WHAT IT WRITES ON HAAN, through the same functions a typed answer goes through: `recordAnswer`
 * (the old value kept as `superseded` history) or `forgetAnswer` plus a fresh ask budget (a removed
 * field is askable again); for the draft's lists, the skill certifier and the job parser. A job
 * change re-sums the total experience from the jobs (owner ruling 2026-10-16, the #1505 rule).
 *
 * THE TRADE IS NOT CHANGED HERE (owner ruling 2026-10-16). It has its own confirmation in Phase A,
 * and a change asked later is answered with the Profile-page pointer instead of a proposal.
 */


/** The warning a removal carries, on the card and in the line. */
export const EDIT_DELETE_WARNING = "Ye wapas nahi aayega.";

/**
 * Short worker-facing names for the fields the interview asks most, so the card reads
 * "Experience: 5 saal se 2 saal" rather than repeating the whole question. Any other field is
 * named by its own question's first clause (without the "?") — reviewed pack copy, never invented.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  experience_years: "Experience",
  current_city: "Sheher",
  availability: "Kab join kar sakte hain",
  relocation: "Doosre sheher ja sakte hain",
};
const SKILL_LABEL = "Skill";
const JOB_LABEL = "Kaam";

// ---------------------------------------------------------------------------
// Building a proposal
// ---------------------------------------------------------------------------

export interface ProposalInput {
  readonly view: ProfilingSchemaView;
  readonly answers: AnswerMap;
  readonly draft: LlmInterviewDraft;
  /** The model's change rows. */
  readonly edits: readonly ProfilingEdit[];
  /** Model fills that named a filled field with a different value — edits with a value. */
  readonly conflicts: readonly { readonly key: string; readonly value: string }[];
  /** The deterministic one-candidate correction (#2307), held back instead of written. */
  readonly correction: readonly CapturedValue[] | null;
  /** Phase A is leading: its own turn owns the draft's lists. */
  readonly phaseALeads: boolean;
}

export interface ProposalOutcome {
  /** The rows to put to the worker — empty when nothing survived. */
  readonly rows: readonly EditRow[];
  /** A field named as wrong with no new value — asked for when no row survived. */
  readonly awaiting: EditTarget | null;
  /** The worker asked to change the trade: answered with the Profile-page pointer. */
  readonly rolePointer: { readonly op: ProfilingEditOp } | null;
}

/** The rows (and the ask) the worker's change requests come to, after every check. */
export function buildEditProposal(input: ProposalInput): ProposalOutcome {
  const rows: EditRow[] = [];
  let awaiting: EditTarget | null = null;
  let rolePointer: ProposalOutcome["rolePointer"] = null;
  const push = (row: EditRow | null): void => {
    if (row === null || rows.length >= MAX_PROPOSAL_ROWS) return;
    if (rows.some((held) => held.key === row.key && held.index === row.index)) return;
    rows.push(row);
  };

  if (input.correction !== null && input.correction.length > 0) {
    const first = input.correction[0] as CapturedValue;
    const item = input.view.items.get(first.questionKey);
    if (item !== undefined) push(packEdit(item, input.answers, input.correction, null));
  }
  for (const fill of input.conflicts) {
    push(rowOf({ op: "edit", key: fill.key, ref: null, value: fill.value }, input));
  }
  for (const edit of input.edits) {
    if (isRoleKey(edit.key, input.view)) {
      rolePointer ??= { op: edit.op };
      continue;
    }
    if (edit.op === "edit" && edit.value === null) {
      awaiting ??= targetOf(edit, input);
      continue;
    }
    push(rowOf(edit, input));
  }
  return { rows, awaiting: rows.length > 0 ? null : awaiting, rolePointer };
}

/** The trade, under any name the schema shows it by. */
function isRoleKey(key: string, view: ProfilingSchemaView): boolean {
  return key === ROLE_KEY || view.items.get(key)?.target_field === "trade";
}

function rowOf(edit: ProfilingEdit, input: ProposalInput): EditRow | null {
  const item = input.view.items.get(edit.key);
  if (item !== undefined) {
    const record = input.answers[item.question_key];
    if (record?.status !== "answered") return null; // nothing to change; an empty field is a fill
    const before = answerDisplay(item, record.value_normalized, record.value_raw);
    if (before === null) return null;
    if (edit.op === "delete") {
      return { key: item.question_key, op: "delete", index: null, label: fieldLabel(item), before, after: null, value: null };
    }
    if (edit.value === null) return null;
    const values = captureAnswer(textFor(item, edit.value), item).values;
    return packEdit(item, input.answers, values, edit.value);
  }
  if (input.phaseALeads) return null;
  if (edit.key === SKILLS_KEY) return skillRow(edit, input.view, input.draft);
  if (edit.key === EXPERIENCE_KEY) return jobRow(edit, input.view, input.draft);
  return null;
}

/** A pack field's change, from the values its own parser read — or null when nothing changes. */
function packEdit(
  item: QuestionPackItem,
  answers: AnswerMap,
  values: readonly CapturedValue[],
  text: string | null,
): EditRow | null {
  const record = answers[item.question_key];
  if (record?.status !== "answered" || values.length === 0) return null;
  if (!values.some((value) => changesAnswer(answers, value))) return null;
  const before = answerDisplay(item, record.value_normalized, record.value_raw);
  const first = values[0] as CapturedValue;
  const after = answerDisplay(item, first.valueNormalized, first.valueRaw);
  if (before === null || after === null) return null;
  return {
    key: item.question_key,
    op: "edit",
    index: null,
    label: fieldLabel(item),
    before,
    after,
    // The words the parser read, so Haan re-reads exactly what the card showed.
    value: clip(text ?? first.valueRaw ?? after),
  };
}

function skillRow(
  edit: ProfilingEdit,
  view: ProfilingSchemaView,
  draft: LlmInterviewDraft,
): EditRow | null {
  const index = edit.ref === null ? undefined : view.skillRefs.get(edit.ref);
  const held = index === undefined ? undefined : draft.skills[index];
  if (index === undefined || held === undefined) return null;
  if (edit.op === "delete") {
    return { key: SKILLS_KEY, op: "delete", index, label: SKILL_LABEL, before: held, after: null, value: null };
  }
  const skill = edit.value === null ? null : certifySkillLabel(edit.value);
  if (skill === null) return null;
  const lowered = skill.toLowerCase();
  // The same skill, or one the worker already holds under another entry: nothing to change.
  if (draft.skills.some((other) => other.toLowerCase() === lowered)) return null;
  return { key: SKILLS_KEY, op: "edit", index, label: SKILL_LABEL, before: held, after: skill, value: skill };
}

function jobRow(
  edit: ProfilingEdit,
  view: ProfilingSchemaView,
  draft: LlmInterviewDraft,
): EditRow | null {
  const index = edit.ref === null ? undefined : view.experienceRefs.get(edit.ref);
  const held = index === undefined ? undefined : draft.experiences[index];
  if (index === undefined || held === undefined) return null;
  const before = jobLine(held);
  if (before.length === 0) return null;
  if (edit.op === "delete") {
    return { key: EXPERIENCE_KEY, op: "delete", index, label: JOB_LABEL, before, after: null, value: null };
  }
  const merged = edit.value === null ? null : mergedJob(held, edit.value);
  if (merged === null) return null;
  const after = jobLine(merged);
  if (after === before) return null;
  return { key: EXPERIENCE_KEY, op: "edit", index, label: JOB_LABEL, before, after, value: after };
}

/**
 * A job with the parts the worker changed. The value is "role; duration; work" — the shape the
 * schema shows a job in — and an EMPTY part keeps the job's own. A value with no ";" is one part:
 * a duration when the interview's duration parser reads it ("2 saal"), else the role.
 */
export function mergedJob(job: ExperienceEntry, value: string): ExperienceEntry | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.includes(";")
    ? trimmed.split(";").map((part) => part.trim())
    : parseDurationMonths(trimmed) !== null
      ? ["", trimmed, ""]
      : [trimmed, "", ""];
  const [role = "", duration = "", ...work] = parts;
  const line = [
    role || job.role_label,
    duration || job.duration_text,
    work.join("; ").trim() || job.work_done,
  ].join("; ");
  const next = jobOf(line);
  if (next === null) return null;
  // A part the worker left alone keeps the months the job already resolved to.
  return duration.length === 0 ? { ...next, duration_months: job.duration_months } : next;
}

function targetOf(edit: ProfilingEdit, input: ProposalInput): EditTarget | null {
  const item = input.view.items.get(edit.key);
  if (item !== undefined) {
    const record = input.answers[item.question_key];
    if (record?.status !== "answered") return null;
    const before = answerDisplay(item, record.value_normalized, record.value_raw);
    return before === null ? null : { key: item.question_key, index: null, label: fieldLabel(item), before };
  }
  if (input.phaseALeads || edit.ref === null) return null;
  if (edit.key === SKILLS_KEY) {
    const index = input.view.skillRefs.get(edit.ref);
    const held = index === undefined ? undefined : input.draft.skills[index];
    return index === undefined || held === undefined
      ? null
      : { key: SKILLS_KEY, index, label: SKILL_LABEL, before: held };
  }
  if (edit.key === EXPERIENCE_KEY) {
    const index = input.view.experienceRefs.get(edit.ref);
    const held = index === undefined ? undefined : input.draft.experiences[index];
    return index === undefined || held === undefined
      ? null
      : { key: EXPERIENCE_KEY, index, label: JOB_LABEL, before: jobLine(held) };
  }
  return null;
}

/**
 * The worker's answer to "sahi <field> bataiye", read for the field asked — the row it comes to,
 * or null (the ask lapses and the turn is read like any other). A pack field reads it through its
 * own parser and a skill through the certifier; a job needs the model, so it is read as a change
 * request by the caller's understanding call instead.
 */
export function rowForAnswer(
  target: EditTarget,
  text: string,
  view: ProfilingSchemaView,
  answers: AnswerMap,
  draft: LlmInterviewDraft,
): EditRow | null {
  const item = view.items.get(target.key);
  if (item !== undefined) {
    return packEdit(item, answers, captureAnswer(text, item).values, text);
  }
  if (target.key === SKILLS_KEY && target.index !== null) {
    const ref = refOf(view.skillRefs, target.index);
    return ref === null ? null : skillRow({ op: "edit", key: SKILLS_KEY, ref, value: text }, view, draft);
  }
  return null;
}

function refOf(refs: ReadonlyMap<string, number>, index: number): string | null {
  for (const [ref, at] of refs) if (at === index) return ref;
  return null;
}

// ---------------------------------------------------------------------------
// Applying a proposal (Haan)
// ---------------------------------------------------------------------------

export interface ApplyInput {
  readonly rows: readonly EditRow[];
  readonly items: readonly QuestionPackItem[];
  readonly answers: AnswerMap;
  readonly draft: LlmInterviewDraft;
  readonly askCounts: Readonly<Record<string, number>>;
  readonly turn: number;
}

export interface ApplyOutcome {
  readonly answers: AnswerMap;
  readonly draft: LlmInterviewDraft;
  readonly askCounts: Readonly<Record<string, number>>;
  readonly applied: readonly EditRow[];
  /** Rows whose field no longer says what the card showed: not written. */
  readonly stale: readonly EditRow[];
}

/**
 * Write a confirmed proposal. Each row re-checks that its field still says `before`; one that does
 * not is `stale` and left alone (fail closed — the worker confirmed a change to a value that is no
 * longer there). List removals run last and from the highest index down, so the indexes the card
 * was built on stay true while the other rows are written.
 */
export function applyEditProposal(input: ApplyInput): ApplyOutcome {
  let answers = input.answers;
  let draft = input.draft;
  let askCounts = input.askCounts;
  const applied: EditRow[] = [];
  const stale: EditRow[] = [];
  const itemByKey = new Map(input.items.map((item) => [item.question_key, item] as const));

  const ordered = [
    ...input.rows.filter((row) => row.index === null || row.op === "edit"),
    ...input.rows
      .filter((row) => row.index !== null && row.op === "delete")
      .sort((a, b) => (b.index ?? 0) - (a.index ?? 0)),
  ];
  let jobsChanged = false;
  for (const row of ordered) {
    if (row.index === null) {
      const item = itemByKey.get(row.key);
      const record = answers[row.key];
      const now =
        item === undefined || record?.status !== "answered"
          ? null
          : answerDisplay(item, record.value_normalized, record.value_raw);
      if (item === undefined || now !== row.before) {
        stale.push(row);
        continue;
      }
      if (row.op === "delete") {
        answers = forgetAnswer(answers, row.key);
        // A REMOVED FIELD IS ASKABLE AGAIN: its ask budget goes with its answer.
        const { [row.key]: _spent, ...rest } = askCounts;
        askCounts = rest;
      } else {
        const values = row.value === null ? [] : captureAnswer(textFor(item, row.value), item).values;
        if (values.length === 0) {
          stale.push(row);
          continue;
        }
        for (const value of values) answers = recordAnswer(answers, value, input.turn);
      }
      applied.push(row);
      continue;
    }
    if (row.key === SKILLS_KEY) {
      if (draft.skills[row.index] !== row.before) {
        stale.push(row);
        continue;
      }
      draft = {
        ...draft,
        skills:
          row.op === "delete"
            ? draft.skills.filter((_skill, at) => at !== row.index)
            : draft.skills.map((skill, at) => (at === row.index && row.value !== null ? row.value : skill)),
      };
      applied.push(row);
      continue;
    }
    if (row.key === EXPERIENCE_KEY) {
      const held = draft.experiences[row.index];
      const replacement = row.op === "edit" && held !== undefined && row.value !== null ? mergedJob(held, row.value) : null;
      if (held === undefined || jobLine(held) !== row.before || (row.op === "edit" && replacement === null)) {
        stale.push(row);
        continue;
      }
      draft = {
        ...draft,
        experiences:
          row.op === "delete"
            ? draft.experiences.filter((_job, at) => at !== row.index)
            : draft.experiences.map((job, at) => (at === row.index && replacement !== null ? replacement : job)),
      };
      jobsChanged = true;
      applied.push(row);
      continue;
    }
    stale.push(row);
  }
  if (jobsChanged) answers = withSummedYears(answers, draft, input.items, input.turn);
  return { answers, draft, askCounts, applied, stale };
}

/**
 * The total experience, re-summed from the jobs after a job changed (owner ruling 2026-10-16: the
 * #1505 rule the handover already applies). Written only when EVERY job resolves to months and the
 * sum is inside the field's bound; otherwise the total the worker gave stands, never a partial sum.
 */
function withSummedYears(
  answers: AnswerMap,
  draft: LlmInterviewDraft,
  items: readonly QuestionPackItem[],
  turn: number,
): AnswerMap {
  const years = jobsTotalYears(draft.experiences);
  const item = items.find((candidate) => candidate.target_field === "experience_years");
  if (years === null || item === undefined || !withinFieldBound("experience_years", years)) return answers;
  return recordAnswer(
    answers,
    {
      questionKey: item.question_key,
      targetField: "experience_years",
      valueRaw: `${years}`,
      valueNormalized: years,
      evidence: null,
    },
    turn,
  );
}

/**
 * Whole years across every job, or null when there is no job or one has no duration the interview
 * can read (#1505 F2: `duration_months` first, the API's own parse as the fallback). A partial sum
 * understates a worker's experience — the one direction that costs them jobs — so it is never one.
 */
export function jobsTotalYears(experiences: readonly ExperienceEntry[]): number | null {
  const months = experiences.map((job) => job.duration_months ?? parseDurationMonths(job.duration_text));
  if (months.length === 0 || !months.every((m): m is number => typeof m === "number")) return null;
  return Math.round(months.reduce((sum, m) => sum + m, 0) / 12);
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

/** The Haan chip's key — what tells the proposal's chips from any other Haan on screen. */
const EDIT_CONFIRM_YES_KEY = "edit_confirm_yes";

/** The two chips. Keys share no prefix with any routed chip set (see `TRADE_CONFIRM_OPTIONS`). */
export const EDIT_CONFIRM_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: EDIT_CONFIRM_YES_KEY,
    label_text: "Haan",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "edit_confirm_no",
    label_text: "Nahi",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

/**
 * What the worker's reply to a proposal means. `other` — anything that is not ONLY a yes or a no —
 * lapses the proposal and is read like any other message (ADR-0057 §3.4): "nahi, 3 saal" corrects
 * the value, it does not cancel the change.
 */
export function readEditConfirmReply(text: string): "yes" | "no" | "other" {
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();
  const chip = EDIT_CONFIRM_OPTIONS.find(
    (option) => option.option_key === trimmed || option.label_text.toLowerCase() === lowered,
  );
  if (chip) return chip.value ? "yes" : "no";
  if (!isBareYesNo(trimmed)) return "other";
  const read = parseAffirmation(trimmed);
  return read === null ? "other" : read.value ? "yes" : "no";
}

/**
 * The confirmation line (owner copy of 2026-10-16). One row: "Experience: 5 saal se 2 saal kar
 * doon?" / "Skill: Grinding hata doon? Ye wapas nahi aayega." Several: "Ye badlaav kar doon?" over
 * one line per row. One "?" only: a "?" or "!" inside a value is stripped, as the trade gate does.
 */
export function editConfirmReply(rows: readonly EditRow[]): string {
  const [only] = rows;
  if (rows.length === 1 && only !== undefined) {
    return only.op === "delete"
      ? `${only.label}: ${spoken(only.before)} hata doon? ${EDIT_DELETE_WARNING}`
      : `${only.label}: ${spoken(only.before)} se ${spoken(only.after ?? "")} kar doon?`;
  }
  const lines = rows.map((row) =>
    row.op === "delete"
      ? `• ${row.label}: ${spoken(row.before)} hatana (wapas nahi aayega)`
      : `• ${row.label}: ${spoken(row.before)} se ${spoken(row.after ?? "")}`,
  );
  return ["Ye badlaav kar doon?", ...lines].join("\n");
}

/** "Theek hai, sahi Experience bataiye." — the ask for a field named as wrong without a value. */
export function editAskLead(target: EditTarget): string {
  return `Theek hai, sahi ${spoken(target.label)} bataiye.`;
}

/** The line that leads the question put back once the gate closes. */
export function editResolvedLead(applied: readonly EditRow[], confirmed: boolean): string {
  if (!confirmed || applied.length === 0) return EDIT_KEPT_PAIR[0];
  return applied.every((row) => row.op === "delete") ? EDIT_REMOVED_PAIR[0] : EDIT_APPLIED_PAIR[0];
}

/** The optional `edit_proposal` the app draws as a tile (#2314) — the text and chips carry it too. */
export interface EditProposalWire {
  readonly proposal_id: string;
  readonly rows: readonly {
    readonly field_label: string;
    readonly op: ProfilingEditOp;
    readonly before: string;
    readonly after: string | null;
    readonly warning?: string;
  }[];
}

export function editProposalWire(proposal: NonNullable<EditGateState["proposal"]>): EditProposalWire {
  return {
    proposal_id: proposal.id,
    rows: proposal.rows.map((row) => ({
      field_label: row.label,
      op: row.op,
      before: row.before,
      after: row.op === "delete" ? null : row.after,
      ...(row.op === "delete" ? { warning: EDIT_DELETE_WARNING } : {}),
    })),
  };
}

/** What the gate puts on screen: the line, its chips, and (for a proposal) the tile. */
export interface EditGateTurn {
  readonly reply: string;
  readonly options: readonly QuestionPackOption[];
  readonly answerType: AnswerType | null;
  readonly inputMode: InputMode;
  readonly editProposal?: EditProposalWire;
}

/**
 * The gate's question, rebuilt from its state — ONE derivation for the turn that opens it, its
 * replay and a reopened session, so the three cannot drift. A proposal is the before → after line
 * with Haan / Nahi (`options_only`, the trade gate's shape) and the tile; an ask is "sahi <field>
 * bataiye" over the field's own question and chips, with the keyboard open.
 */
export function editGateTurn(
  gate: EditGateState,
  items: readonly QuestionPackItem[],
): EditGateTurn | null {
  if (gate.proposal !== null) {
    return {
      reply: editConfirmReply(gate.proposal.rows),
      options: [...EDIT_CONFIRM_OPTIONS],
      answerType: "single_select",
      inputMode: "options_only",
      editProposal: editProposalWire(gate.proposal),
    };
  }
  if (gate.awaiting === null) return null;
  const item = items.find((candidate) => candidate.question_key === gate.awaiting?.key);
  return item === undefined
    ? { reply: editAskLead(gate.awaiting), options: [], answerType: "text", inputMode: "text" }
    : {
        reply: `${editAskLead(gate.awaiting)} ${item.prompt_text}`,
        options: [...item.options],
        answerType: item.answer_type,
        inputMode: "text",
      };
}

/** Is this the proposal's Haan / Nahi on screen (the chips, not merely their words)? */
export function showsEditConfirm(options: readonly { readonly option_key: string }[]): boolean {
  return options.some((option) => option.option_key === EDIT_CONFIRM_YES_KEY);
}

/** A new proposal's id — the tile's key, and the events'. */
export function newProposalId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function fieldLabel(item: QuestionPackItem): string {
  const short = item.target_field === null ? undefined : FIELD_LABELS[item.target_field];
  if (short !== undefined) return short;
  // The question's FIRST CLAUSE, without its "?": "Koi training ki hai? Uska naam bataiye." names
  // the field "Koi training ki hai" — one "?" per confirmation line, the persona rule.
  const [clause = ""] = item.prompt_text.split(/[?？!！.।]/u).filter((part) => part.trim().length > 0);
  return clip(clause.trim(), 200) || item.question_key;
}

/**
 * An answer as the worker should read it: Haan / Nahi for a yes/no, the option's own label for a
 * chosen option, "N saal" for years — else the stored value, else the worker's words.
 */
function answerDisplay(item: QuestionPackItem, normalized: unknown, raw: string | null): string | null {
  const shown = displayOf(item, normalized) ?? (raw !== null && raw.trim().length > 0 ? raw.trim() : null);
  return shown === null ? null : clip(shown, 500) || null;
}

function displayOf(item: QuestionPackItem, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Haan" : "Nahi";
  if (item.target_field === "experience_years" && typeof value === "number") return `${value} saal`;
  if (Array.isArray(value)) {
    const parts = value.map((part) => optionLabel(item, part) ?? String(part)).filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return optionLabel(item, value) ?? String(value);
  }
  return null;
}

function optionLabel(item: QuestionPackItem, value: unknown): string | null {
  const option = item.options.find(
    (candidate) => candidate.value === value || candidate.option_key === value || candidate.label_text === value,
  );
  return option?.label_text ?? null;
}

/** A value inside a line: no "?" or "!" of its own, one line, whitespace collapsed. */
function spoken(text: string): string {
  return text.replace(/[?？!！]/gu, "").replace(/\s+/gu, " ").trim();
}

function clip(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd();
}
