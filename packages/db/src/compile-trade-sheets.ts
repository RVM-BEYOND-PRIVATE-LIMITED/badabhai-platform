/**
 * `pnpm db:compile:sheets` — the CEO pack sheet compiler (#2997).
 *
 * A form is always a pure function of its sheet plus the one reviewed side file,
 * `data/question-packs/_sheet-overrides.json`. Typing 977 questions into JSON by hand
 * is where the mistakes would come from; reading them mechanically is not.
 *
 *   pnpm db:compile:sheets          # dry run: parse 44 sheets, print the diff, write nothing
 *   pnpm db:compile:sheets --write  # write one file per form into data/question-packs/packs/
 *
 * FIELD MAPPING (the contract, spelled once so the test can hold it):
 *   tier advanced -> min_tier "hard"; easy and medium unchanged.
 *   pick one -> single_select; pick any -> multi_select; free text -> text.
 *   mandatory -> is_core + is_mandatory; core -> is_core.
 *   every question is target_kind "attribute" with target_field equal to its key.
 *   Reason told to the worker -> why_text.
 *   option key: the stored value when it is a slug; a reviewed pin from the overrides
 *     file when it is a number (recorded there so it never changes between runs).
 *   the experience question (first on every sheet): value_number ONLY — a value_text
 *     beside it turns every later "at least" into a string compare that is false
 *     forever (guide section 4, "the value_text trap").
 *   every other number band: value_text holding the number as text, as live
 *     tolerance_band does. The escape chip is is_none_of_above with value "unknown".
 *   conditions, in the contract shape {op,left,right} only: "at most 0" -> lte,
 *     "at least N" -> gte, "is one of a, b" -> in, "A OR B" -> any. A gate on a
 *     multi-select answer compiles the same way: `in` already means "any overlap"
 *     for a multi-select on the left (apps/api/src/profiling/predicate.ts).
 *   experience and level questions (first two on every sheet): max_asks 2 with a
 *     retry_text from the overrides file; every other question: max_asks 1.
 *
 * FAIL-Closed rules: the parser throws on any sheet line it does not recognise, on
 * any question the overrides file does not cover, and on any numeric band without a
 * recorded option key. --write refuses a version listed in _published-versions.jsonl
 * and never overwrites an existing file with different bytes.
 *
 * PRIVACY: reviewed interview copy and occupation references. No worker data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PackItemRecord, PackOptionRecord, PackRecord } from "./question-pack-corpus";

const SCRIPT = "compile:sheets";

const PACK_REL = join(
  "..",
  "..",
  "..",
  "docs",
  "reference",
  "BadaBhai_Manufacturing_Taxonomy_and_Question_Pack_v2.md",
);
const OVERRIDES_REL = join("..", "data", "question-packs", "_sheet-overrides.json");
const PACKS_REL = join("..", "data", "question-packs", "packs");
const PUBLISHED_REL = join("..", "data", "question-packs", "_published-versions.jsonl");

// ===========================================================================
// Overrides file shape
// ===========================================================================

export interface ExperienceOption {
  label: string;
  key: string;
  value: number;
}

export interface SheetFormOverride {
  /** Sheet code, e.g. "T17". Must agree with the sheet the form id came from. */
  sheet: string;
  /** Version number to write on the compiled form. */
  version: number;
  /** Sheet question key -> kept live key, for the 7 deepened forms (#3008 §3). */
  keyRenames?: Record<string, string>;
  retryExperience: string;
  retryLevel: string;
  why: string;
  scope: string;
  budget: string;
  reviewNote: string;
  /**
   * Reviewed option keys for NUMBER bands only: question key -> stored value ->
   * option key. Slug values use themselves; the escape chip uses "unknown".
   */
  optionKeys?: Record<string, Record<string, string>>;
}

export interface SheetOverrides {
  /** The six fixed experience bands, identical on all 44 sheets. */
  experienceOptions: ExperienceOption[];
  /** pack_id -> override. One entry per compiled form, no extras. */
  forms: Record<string, SheetFormOverride>;
}

export function loadSheetOverrides(path: string): SheetOverrides {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as SheetOverrides;
  if (!Array.isArray(parsed.experienceOptions) || parsed.experienceOptions.length === 0) {
    throw new Error(`${SCRIPT}: overrides ${path} needs a non-empty experienceOptions list`);
  }
  if (typeof parsed.forms !== "object" || parsed.forms === null) {
    throw new Error(`${SCRIPT}: overrides ${path} needs a forms map`);
  }
  return parsed;
}

// ===========================================================================
// Sheet parsing — strict, throws on anything unrecognised
// ===========================================================================

export interface SheetChip {
  label: string;
  value: string;
  escape: boolean;
}

export interface SheetCondition {
  field: string;
  op: "lte" | "gte" | "in";
  const: number | string[];
}

export interface SheetQuestion {
  n: number;
  key: string;
  tier: "easy" | "medium" | "advanced";
  pick: "one" | "any" | "free";
  flag: "mandatory" | "core" | null;
  asks: string;
  reason: string;
  chips: SheetChip[] | null;
  conditions: SheetCondition[] | null;
  line: number;
}

export interface TradeSheet {
  code: string;
  title: string;
  tradeKey: string;
  department: string;
  kind: string;
  status: string;
  formId: string;
  familyId: string;
  declaredQuestions: number;
  questions: SheetQuestion[];
}

const SHEET_HEADING_RE = /^## (T\d+) · (.+)$/;
const HEADING_RE = /^#{1,4} /;
const QUESTIONS_RE = /^### Questions \((\d+)\)$/;
const QUESTION_RE = /^(\d+)\. \*\*`([a-z_]+)`\*\* \(([^)]+)\)$/;
const PAREN_RE =
  /^tier: (easy|medium|advanced); (?:pick (one|any)(; (mandatory|core))?|free text(; core)?)$/;
const TABLE_ROW_RE = /^\| ([^|]+) \| (.*) \|$/;
const ASKS_RE = /^ {3}- Asks: "(.*)"$/;
const REASON_RE = /^ {3}- Reason told to the worker: "(.*)"$/;
const CHIPS_PREFIX = "   - Chips (label → stored value): ";
const ASKED_PREFIX = "   - Asked only when: ";
const CHIP_RE = /^(.*) → `([^`]+)`( \(escape chip\))?$/;
const STORED_VALUE_RE = /^[a-z_0-9.]+$/;
const NUMERIC_RE = /^[0-9.]+$/;
const KNOWN_IGNORABLE_RE = /^\*\*(Words that|Chips that add a second match skill|Résumé headline)/;

function fail(sheet: string, line: number, detail: string): never {
  throw new Error(`${SCRIPT}: sheet ${sheet} line ${line}: ${detail}`);
}

function parseConditionExpr(expr: string, sheet: string, line: number): SheetCondition {
  let m = expr.match(/^`([a-z_]+)` is at most 0$/);
  if (m?.[1]) return { field: m[1], op: "lte", const: 0 };
  m = expr.match(/^`([a-z_]+)` is at least (\d+)$/);
  if (m?.[1] && m[2] !== undefined) return { field: m[1], op: "gte", const: Number(m[2]) };
  m = expr.match(/^`([a-z_]+)` is one of ([a-z_0-9, ]+)$/);
  if (m?.[1] && m[2] !== undefined) {
    return { field: m[1], op: "in", const: m[2].split(", ") };
  }
  return fail(sheet, line, `unrecognised condition ${JSON.stringify(expr)}`);
}

/** Split the pack into its 44 trade sheets. */
export function parseTradeSheets(packText: string): TradeSheet[] {
  const lines = packText.split(/\r?\n/);
  const sheets: TradeSheet[] = [];
  let cur: TradeSheet | null = null;
  let inQuestions = false;

  const finishQuestionCheck = (s: TradeSheet): void => {
    if (s.questions.length !== s.declaredQuestions) {
      throw new Error(
        `${SCRIPT}: sheet ${s.code} declares ${s.declaredQuestions} questions but carries ${s.questions.length}`,
      );
    }
  };

  lines.forEach((ln, idx) => {
    const lineNo = idx + 1;
    const hm = ln.match(SHEET_HEADING_RE);
    if (hm?.[1] && hm[2] !== undefined) {
      if (cur) finishQuestionCheck(cur);
      cur = {
        code: hm[1],
        title: hm[2],
        tradeKey: "",
        department: "",
        kind: "",
        status: "",
        formId: "",
        familyId: "",
        declaredQuestions: 0,
        questions: [],
      };
      sheets.push(cur);
      inQuestions = false;
      return;
    }
    if (cur === null) return;
    const sheet: TradeSheet = cur;
    if (HEADING_RE.test(ln) && !QUESTIONS_RE.test(ln)) {
      // A department banner or a later pack section ends the sheet.
      finishQuestionCheck(sheet);
      cur = null;
      return;
    }
    if (ln === "---") {
      // A rule separator between pack sections ends the sheet too; the
      // declared-count check still catches a sheet truncated mid-questions.
      finishQuestionCheck(sheet);
      cur = null;
      return;
    }
    if (ln.trim() === "") return;
    const qm = ln.match(QUESTIONS_RE);
    if (qm?.[1]) {
      sheet.declaredQuestions = Number(qm[1]);
      inQuestions = true;
      return;
    }
    if (!inQuestions) {
      const tm = ln.match(TABLE_ROW_RE);
      if (tm?.[1] && tm[2] !== undefined) {
        const field = tm[1].trim();
        if (field === "Field") return;
        const value = tm[2].trim();
        const bare = value.replace(/^`([^`]+)`$/, "$1");
        switch (field) {
          case "Trade key":
            sheet.tradeKey = bare;
            return;
          case "Department":
            sheet.department = value;
            return;
          case "Kind":
            sheet.kind = value;
            return;
          case "Status":
            sheet.status = value;
            return;
          case "Form id":
            sheet.formId = bare;
            return;
          case "Profiling family":
            sheet.familyId = bare;
            return;
          default:
            return;
        }
      }
      if (/^\|---/.test(ln) || KNOWN_IGNORABLE_RE.test(ln)) return;
      return fail(sheet.code, lineNo, `unexpected header line ${JSON.stringify(ln.slice(0, 80))}`);
    }
    const qq = ln.match(QUESTION_RE);
    if (qq?.[1] && qq[2] && qq[3]) {
      const pm = qq[3].match(PAREN_RE);
      if (!pm?.[1])
        return fail(sheet.code, lineNo, `unrecognised question header ${JSON.stringify(qq[3])}`);
      const tier = pm[1] as SheetQuestion["tier"];
      const pick = (pm[2] ?? "free") as SheetQuestion["pick"];
      const flag = (pm[4] ?? (pm[5] !== undefined ? "core" : null)) as SheetQuestion["flag"];
      const n = Number(qq[1]);
      if (n !== sheet.questions.length + 1) {
        return fail(sheet.code, lineNo, `question ${n} out of sequence`);
      }
      sheet.questions.push({
        n,
        key: qq[2],
        tier,
        pick,
        flag,
        asks: "",
        reason: "",
        chips: null,
        conditions: null,
        line: lineNo,
      });
      return;
    }
    const last = sheet.questions[sheet.questions.length - 1];
    if (!last) return fail(sheet.code, lineNo, `content before first question`);
    let m = ln.match(ASKS_RE);
    if (m?.[1] !== undefined) {
      if (last.asks !== "") return fail(sheet.code, lineNo, `duplicate Asks for ${last.key}`);
      last.asks = m[1];
      return;
    }
    m = ln.match(REASON_RE);
    if (m?.[1] !== undefined) {
      if (last.reason !== "") return fail(sheet.code, lineNo, `duplicate Reason for ${last.key}`);
      if (last.asks === "") return fail(sheet.code, lineNo, `Reason before Asks for ${last.key}`);
      last.reason = m[1];
      return;
    }
    if (ln.startsWith(CHIPS_PREFIX)) {
      if (last.chips !== null) return fail(sheet.code, lineNo, `duplicate Chips for ${last.key}`);
      if (last.asks === "" || last.reason === "") {
        return fail(sheet.code, lineNo, `Chips before Asks/Reason for ${last.key}`);
      }
      if (last.pick === "free")
        return fail(sheet.code, lineNo, `free-text ${last.key} carries chips`);
      const parts = ln.slice(CHIPS_PREFIX.length).split("; ");
      last.chips = parts.map((part) => {
        const cm = part.match(CHIP_RE);
        if (!cm?.[1] || cm[2] === undefined) {
          return fail(
            sheet.code,
            lineNo,
            `unparseable chip ${JSON.stringify(part)} in ${last.key}`,
          );
        }
        if (!STORED_VALUE_RE.test(cm[2])) {
          return fail(
            sheet.code,
            lineNo,
            `stored value ${JSON.stringify(cm[2])} breaks the slug rule in ${last.key}`,
          );
        }
        return { label: cm[1], value: cm[2], escape: cm[3] !== undefined };
      });
      return;
    }
    if (ln.startsWith(ASKED_PREFIX)) {
      if (last.conditions !== null)
        return fail(sheet.code, lineNo, `duplicate Asked-only-when for ${last.key}`);
      const exprs = ln.slice(ASKED_PREFIX.length).split(" OR ");
      last.conditions = exprs.map((e) => parseConditionExpr(e, sheet.code, lineNo));
      return;
    }
    return fail(
      sheet.code,
      lineNo,
      `unrecognised question line ${JSON.stringify(ln.slice(0, 80))}`,
    );
  });
  if (cur) finishQuestionCheck(cur);
  return sheets;
}

// ===========================================================================
// Compilation — sheet + overrides -> PackRecord
// ===========================================================================

const MIN_TIER: Record<SheetQuestion["tier"], string> = {
  easy: "easy",
  medium: "medium",
  advanced: "hard",
};
const ANSWER_TYPE: Record<SheetQuestion["pick"], string> = {
  one: "single_select",
  any: "multi_select",
  free: "text",
};
const OPTION_KEY_RE = /^[a-z_]+$/;

function renamedKey(
  key: string,
  renames: Record<string, string> | undefined,
  sheet: string,
): string {
  if (renames && key in renames) {
    const out = renames[key];
    if (out === undefined || !/^[a-z_]+$/.test(out) || out.length > 40) {
      throw new Error(
        `${SCRIPT}: sheet ${sheet}: rename target ${JSON.stringify(out)} is not a valid key`,
      );
    }
    return out;
  }
  return key;
}

function compileCondition(
  c: SheetCondition,
  renames: Record<string, string> | undefined,
  sheet: string,
): { op: string; left: { field: string }; right: { const: number | string[] } } {
  const field = renamedKey(c.field, renames, sheet);
  if (c.op === "in") return { op: "in", left: { field }, right: { const: c.const as string[] } };
  return { op: c.op, left: { field }, right: { const: c.const as number } };
}

export function compileSheet(sheet: TradeSheet, overrides: SheetOverrides): PackRecord {
  const ov = overrides.forms[sheet.formId];
  if (!ov) {
    throw new Error(
      `${SCRIPT}: sheet ${sheet.code} form ${sheet.formId} has no entry in the overrides file`,
    );
  }
  if (ov.sheet !== sheet.code) {
    throw new Error(
      `${SCRIPT}: overrides entry ${sheet.formId} says sheet ${ov.sheet} but the pack names it ${sheet.code}`,
    );
  }
  if (!Number.isInteger(ov.version) || ov.version < 1) {
    throw new Error(`${SCRIPT}: overrides entry ${sheet.formId} needs a version integer >= 1`);
  }
  if (sheet.tradeKey === "" || sheet.familyId === "") {
    throw new Error(
      `${SCRIPT}: sheet ${sheet.code} is missing its Trade key or Profiling family row`,
    );
  }
  const renames = ov.keyRenames ?? {};
  for (const from of Object.keys(renames)) {
    if (!sheet.questions.some((q) => q.key === from)) {
      throw new Error(
        `${SCRIPT}: sheet ${sheet.code}: rename source ${from} is not a question on the sheet`,
      );
    }
  }
  const questions = sheet.questions;
  if (questions.length === 0)
    throw new Error(`${SCRIPT}: sheet ${sheet.code} carries no questions`);
  const first = questions[0];
  const second = questions[1];
  if (!first || !first.key.endsWith("_experience")) {
    throw new Error(
      `${SCRIPT}: sheet ${sheet.code}: first question ${first?.key} is not the experience question`,
    );
  }
  if (!second || !second.key.endsWith("_level")) {
    throw new Error(
      `${SCRIPT}: sheet ${sheet.code}: second question ${second?.key} is not the level question`,
    );
  }

  const items: PackItemRecord[] = questions.map((q, qi) => {
    const key = renamedKey(q.key, renames, sheet.code);
    if (q.asks === "" || q.reason === "") {
      throw new Error(
        `${SCRIPT}: sheet ${sheet.code} question ${q.key} is missing its Asks or Reason line`,
      );
    }
    if (q.pick !== "free" && !q.chips) {
      throw new Error(`${SCRIPT}: sheet ${sheet.code} question ${q.key} is a select with no chips`);
    }
    if (q.pick === "free" && q.chips) {
      throw new Error(`${SCRIPT}: sheet ${sheet.code} question ${q.key} is free text with chips`);
    }
    const isExperience = qi === 0;
    const isLevel = qi === 1;

    let options: PackOptionRecord[] | undefined;
    if (q.chips) {
      if (q.chips.length < 2 || q.chips.length > 9) {
        throw new Error(
          `${SCRIPT}: sheet ${sheet.code} question ${q.key} has ${q.chips.length} chips, need 2..9`,
        );
      }
      if (q.chips.filter((c) => c.escape).length > 1) {
        throw new Error(
          `${SCRIPT}: sheet ${sheet.code} question ${q.key} carries two escape chips`,
        );
      }
      const labels = new Set<string>();
      for (const c of q.chips) {
        if (labels.has(c.label)) {
          throw new Error(
            `${SCRIPT}: sheet ${sheet.code} question ${q.key} repeats label ${JSON.stringify(c.label)}`,
          );
        }
        labels.add(c.label);
      }
      options = q.chips.map((c) => {
        if (c.escape) {
          if (c.value !== "unknown") {
            throw new Error(
              `${SCRIPT}: sheet ${sheet.code} question ${q.key}: escape chip stores ${JSON.stringify(c.value)}, need "unknown"`,
            );
          }
          return {
            option_key: "unknown",
            label_text: c.label,
            value_text: "unknown",
            is_none_of_above: true,
          };
        }
        if (NUMERIC_RE.test(c.value)) {
          if (isExperience) {
            const exp = overrides.experienceOptions.find((e) => e.label === c.label);
            if (!exp) {
              throw new Error(
                `${SCRIPT}: sheet ${sheet.code}: experience label ${JSON.stringify(c.label)} is not one of the six fixed bands`,
              );
            }
            if (Number(c.value) !== exp.value) {
              throw new Error(
                `${SCRIPT}: sheet ${sheet.code}: experience label ${JSON.stringify(c.label)} stores ${c.value}, need ${exp.value}`,
              );
            }
            return { option_key: exp.key, label_text: c.label, value_number: exp.value };
          }
          const pin = ov.optionKeys?.[q.key]?.[c.value];
          if (!pin) {
            throw new Error(
              `${SCRIPT}: sheet ${sheet.code} question ${q.key}: no recorded option key for band ${c.value} — add it to the overrides file`,
            );
          }
          if (!OPTION_KEY_RE.test(pin)) {
            throw new Error(`${SCRIPT}: overrides pin ${JSON.stringify(pin)} breaks ^[a-z_]+$`);
          }
          return { option_key: pin, label_text: c.label, value_text: c.value };
        }
        return { option_key: c.value, label_text: c.label, value_text: c.value };
      });
      const keys = new Set(options.map((o) => o.option_key));
      if (keys.size !== options.length) {
        throw new Error(`${SCRIPT}: sheet ${sheet.code} question ${q.key} repeats an option key`);
      }
    }

    const item: PackItemRecord = {
      question_key: key,
      min_tier: MIN_TIER[q.tier] as PackItemRecord["min_tier"],
      prompt_text: q.asks,
      why_text: q.reason,
      target_kind: "attribute",
      target_field: key,
      answer_type: ANSWER_TYPE[q.pick] as PackItemRecord["answer_type"],
      is_core: q.flag !== null,
      is_mandatory: q.flag === "mandatory",
      max_asks: isExperience || isLevel ? 2 : 1,
    };
    if (options) item.options = options;
    if (isExperience) item.retry_text = ov.retryExperience;
    if (isLevel) item.retry_text = ov.retryLevel;
    if (q.conditions) {
      const preds = q.conditions.map((c) => compileCondition(c, renames, sheet.code));
      item.ask_if = preds.length === 1 ? preds[0] : { op: "any", predicates: preds };
    }
    return item;
  });

  return {
    _why: ov.why,
    _scope: ov.scope,
    _depth:
      "THE TIER GATE IS the experience question, asked FIRST. Its options carry value_number ONLY: " +
      "pack-registry.service.ts resolves valueText ?? valueNumber, and a value_text would turn every " +
      "gte below into a string compare that is false forever (the #776 defect).",
    _budget: ov.budget,
    _sheet: `CEO pack v2, sheet ${sheet.code} (${sheet.title}). Status: ${sheet.status}`,
    pack_id: sheet.formId,
    version: ov.version,
    family_id: sheet.familyId,
    locale: "hi-IN",
    status: "active",
    review_note: ov.reviewNote,
    items,
  } as PackRecord;
}

/** Compile every sheet: 44 forms, one per form id. */
export function compileAllSheets(packText: string, overrides: SheetOverrides): PackRecord[] {
  const sheets = parseTradeSheets(packText);
  const seen = new Set<string>();
  const packs = sheets.map((s) => {
    if (s.formId === "") throw new Error(`${SCRIPT}: sheet ${s.code} names no Form id`);
    if (seen.has(s.formId)) throw new Error(`${SCRIPT}: duplicate form id ${s.formId}`);
    seen.add(s.formId);
    return compileSheet(s, overrides);
  });
  for (const formId of Object.keys(overrides.forms)) {
    if (!seen.has(formId)) {
      throw new Error(`${SCRIPT}: overrides entry ${formId} matches no sheet in the pack`);
    }
  }
  return packs;
}

// ===========================================================================
// Serialisation, diff, published-versions ledger
// ===========================================================================

/** The file bytes for one compiled form: pretty-printed, trailing newline. */
export function serialisePack(pack: PackRecord): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/** Target filename: v1 keeps the bare name; later versions sit beside it (#708). */
export function packFilename(pack: PackRecord): string {
  return pack.version === 1 ? `${pack.pack_id}.json` : `${pack.pack_id}@${pack.version}.json`;
}

export function loadPublishedVersions(ledgerPath: string): Set<string> {
  if (!existsSync(ledgerPath)) return new Set();
  const out = new Set<string>();
  for (const line of readFileSync(ledgerPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    out.add(t);
  }
  return out;
}

/** Forms whose (pack_id, version) the ledger already publishes. */
export function publishedCollisions(packs: PackRecord[], published: Set<string>): string[] {
  return packs.map((p) => `${p.pack_id}@${p.version}`).filter((kv) => published.has(kv));
}

export interface FormDiff {
  formId: string;
  version: number;
  filename: string;
  status: "new" | "unchanged" | "changed";
  diff: string;
}

/** Minimal line diff in unified form, for the dry-run printout. */
export function unifiedDiff(oldText: string, newText: string, filename: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // LCS lengths, suffix-compressed to two rows.
  const n = a.length;
  const m = b.length;
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);
  const table: number[][] = [];
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      curr[j] = a[i] === b[j] ? (prev[j + 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j + 1] ?? 0);
    }
    table[i] = [...curr];
    for (let j = 0; j <= m; j++) prev[j] = curr[j] ?? 0;
  }
  type Op = { kind: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "-", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", line: a[i] ?? "" });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "+", line: b[j] ?? "" });
    j++;
  }
  if (ops.every((o) => o.kind === " ")) return "";
  const out: string[] = [`--- a/${filename}`, `+++ b/${filename}`];
  // Emit one hunk per contiguous change block with 3 lines of context.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.kind === " ") return;
    for (let d = -3; d <= 3; d++) {
      const t = k + d;
      if (t >= 0 && t < keep.length) keep[t] = true;
    }
  });
  const hunks: string[][] = [];
  let block: string[] = [];
  let open = false;
  ops.forEach((o, k) => {
    if (keep[k] === true) {
      open = true;
      block.push(`${o.kind}${o.line}`);
    } else if (open) {
      hunks.push(block);
      block = [];
      open = false;
    }
  });
  if (block.length > 0) hunks.push(block);
  for (const h of hunks) {
    out.push(`@@ block of ${h.length} lines @@`);
    out.push(...h);
  }
  return out.join("\n");
}

export function diffAgainstPacks(packs: PackRecord[], packsDir: string): FormDiff[] {
  return packs.map((p) => {
    const filename = packFilename(p);
    const target = join(packsDir, filename);
    const text = serialisePack(p);
    if (!existsSync(target))
      return { formId: p.pack_id, version: p.version, filename, status: "new", diff: "" };
    const old = readFileSync(target, "utf8");
    if (old === text)
      return { formId: p.pack_id, version: p.version, filename, status: "unchanged", diff: "" };
    return {
      formId: p.pack_id,
      version: p.version,
      filename,
      status: "changed",
      diff: unifiedDiff(old, text, `packs/${filename}`),
    };
  });
}

// ===========================================================================
// CLI
// ===========================================================================

export interface CompileResult {
  packs: PackRecord[];
  diffs: FormDiff[];
  questions: number;
}

export function dryRun(packPath: string, overridesPath: string, packsDir: string): CompileResult {
  const packText = readFileSync(packPath, "utf8");
  const overrides = loadSheetOverrides(overridesPath);
  const packs = compileAllSheets(packText, overrides);
  const diffs = diffAgainstPacks(packs, packsDir);
  const questions = packs.reduce((n, p) => n + (p.items?.length ?? 0), 0);
  return { packs, diffs, questions };
}

function printDryRun(result: CompileResult): void {
  console.log(`[${SCRIPT}] ${result.packs.length} forms, ${result.questions} questions`);
  for (const d of result.diffs) {
    const count = result.packs.find((p) => p.pack_id === d.formId)?.items?.length ?? 0;
    console.log(
      `  ${d.status.toUpperCase().padEnd(9)} ${d.formId}@${d.version} (${count} questions) -> packs/${d.filename}`,
    );
    if (d.diff !== "") console.log(d.diff);
  }
}

function main(): number {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const here = __dirname;
  const packPath = join(here, PACK_REL);
  const overridesPath = join(here, OVERRIDES_REL);
  const packsDir = join(here, PACKS_REL);
  const ledgerPath = join(here, PUBLISHED_REL);

  let result: CompileResult;
  try {
    result = dryRun(packPath, overridesPath, packsDir);
  } catch (err) {
    console.error(`[${SCRIPT}] FAILED: ${(err as Error).message}`);
    return 1;
  }
  printDryRun(result);
  if (!write) {
    console.log(`[${SCRIPT}] dry run only — pass --write to write ${result.packs.length} files`);
    return 0;
  }
  const published = loadPublishedVersions(ledgerPath);
  const collisions = publishedCollisions(result.packs, published);
  if (collisions.length > 0) {
    console.error(
      `[${SCRIPT}] REFUSED: ${collisions.join(", ")} already published in _published-versions.jsonl — ` +
        `a published version is immutable and is never overwritten`,
    );
    return 1;
  }
  mkdirSync(packsDir, { recursive: true });
  for (const d of result.diffs) {
    const pack = result.packs.find((p) => p.pack_id === d.formId);
    if (!pack) continue;
    if (d.status === "unchanged") continue;
    const target = join(packsDir, d.filename);
    if (existsSync(target)) {
      console.error(
        `[${SCRIPT}] REFUSED: packs/${d.filename} exists with different bytes — ` +
          `a committed file's served text is never edited, retire it instead`,
      );
      return 1;
    }
    writeFileSync(target, serialisePack(pack), "utf8");
    console.log(`[${SCRIPT}] wrote packs/${d.filename}`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
