/**
 * The question-pack corpus — loader + validator for the data behind migration 0069.
 *
 * THE VALIDATOR IS THE POINT OF THIS FILE, exactly as it is for `job-domain-corpus.ts`.
 * A pack is reviewed prose bound to a taxonomy, and almost every way it can be wrong is
 * INVISIBLE once seeded: a question gated on a mistyped key never appears; a follow-up
 * cycle hangs an interview; two families claiming one unit group silently give a trade
 * the wrong interview; an off-persona prompt ships copy nobody signed off. None of these
 * throw at run time. They just make the product quietly worse for one trade, which is the
 * hardest kind of bug to notice and the cheapest kind to prevent.
 *
 * FILE LAYOUT, and why it is not one JSONL like the job domains.
 *   data/question-packs/_families.jsonl   family + binding records, one per line
 *   data/question-packs/packs/<id>.json   ONE PACK PER FILE, pretty-printed
 * Families and bindings are small flat records, so JSONL gives the line-diffable review
 * that made the domain corpus reviewable. A pack is not: twelve questions with options
 * and conditions on a single line is unreadable in a diff, and the whole reason packs are
 * data is so a human can review a wording change. One pretty-printed file per pack means
 * a diff shows exactly which question moved.
 *
 * RETURNS EVERY PROBLEM, NEVER THROWS ON THE FIRST — the property inherited deliberately
 * from `validateJobDomainCorpus`. Authoring errors arrive in families (one bad rename
 * produces a dozen dangling references) and fixing them one exception per run is
 * miserable enough that people stop running the validator.
 *
 * PRIVACY: reviewed interview copy and occupation references. No worker data.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checkPersonaTokens } from "@badabhai/profiling-lexicon";
import {
  predicateFields,
  validatePredicate,
} from "./question-pack-predicate";

export const QUESTION_PACK_DATA_DIR = join(__dirname, "..", "data", "question-packs");

const FAMILY_ID_RE = /^fam_[a-z0-9_]+$/;
const PACK_ID_RE = /^qp_[a-z0-9_]+$/;
/** The SAME filter `chat.service.ts` applies before an id reaches an event payload. */
const QUESTION_KEY_RE = /^[a-z_]+$/;
const OPTION_KEY_RE = /^[a-z0-9_]+$/;
const MAX_QUESTION_KEY_LEN = 40;

const TARGET_KINDS = ["rfs", "match_skill", "attribute", "none"] as const;
const ANSWER_TYPES = [
  "text",
  "number",
  "boolean",
  "single_select",
  "multi_select",
  "city",
  "salary",
  "duration",
] as const;
const STATUSES = ["active", "draft", "deprecated"] as const;
const SELECT_TYPES = new Set(["single_select", "multi_select"]);

/**
 * Persona rules, applied to `prompt_text` at BUILD time.
 *
 * PROMOTED FROM A RUNTIME COST. Today `persona_guard.check_turn` runs on every generated
 * turn and, on violation, pays for a repair retry — a per-conversation tax to police text
 * a model just invented. Static reviewed copy can be checked once, here, for free.
 *
 * ONLY THE STRUCTURAL RULES ARE MIRRORED: one question mark, at most 20 words, no
 * exclamation, no emoji. The banned-token rules (BANNED_VOCATIVES / _INFORMAL / _GUSH /
 * _PROMISE / _DEICTICS) are NOT checked here and that is deliberate, not an oversight —
 * those five lists live only in `apps/ai-service/app/profiling/persona.py`, and
 * re-typing them in TypeScript would create precisely the cross-language drift that
 * `packages/profiling-lexicon` exists to eliminate. The right fix is to extract them to
 * shared JSON the way Phase 3 extracted the gazetteers, which touches a file this module
 * does not own (CLAUDE.md §6).
 *
 * DEFERRED: banned-token validation. Owner: Prakash (persona.py) or a joint PR.
 * Reason: needs the persona word lists moved to packages/profiling-lexicon/data first.
 * Until then an off-vocabulary prompt is caught by human review, not mechanically.
 */
const MAX_PROMPT_WORDS = 20;
const MAX_QUESTION_MARKS = 1;
// Explicit ranges rather than \p{Emoji}: the same code-point-class discipline the
// normalizer uses, and it mirrors `persona_guard._EMOJI_RE` range for range so the two
// languages agree on what an emoji is.
//
// U+FE0F (variation selector-16) is a COMBINING character, which is exactly why it
// belongs in this class: it is the code point that turns a plain glyph into its emoji
// presentation, so a prompt carrying it is an emoji prompt even when the base character
// is innocuous ASCII. `no-misleading-character-class` assumes a character class wants
// whole grapheme clusters; this one deliberately wants code points.
//
// The case that MEASURABLY needs it is a keycap sequence: "1<FE0F><20E3>" is an ASCII
// digit plus two combining code points, and without the FE0F range none of them match,
// so it passes as clean text. A heart is NOT the example — U+2764 already sits inside
// 2600-27BF and is caught either way. Both were verified, because a lint-disable
// justified by a false example is worse than no justification at all. Pinned by the
// "catches a KEYCAP sequence" test.
//
// Kept on ONE line so the directive above lands on the regex literal itself — split
// across two lines it applies to the `const` and the rule fires anyway.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{FE0F}]/u;

// ===========================================================================
// Record shapes
// ===========================================================================

export interface FamilyRecord {
  kind: "family";
  family_id: string;
  label_en: string;
  label_hi?: string | null;
  canonical_role_id?: string | null;
  industry_id?: string | null;
  status?: (typeof STATUSES)[number];
}

export interface BindingRecord {
  kind: "binding";
  family_id: string;
  job_domain_id?: string | null;
  isco_unit_code?: string | null;
  isco_minor_code?: string | null;
  isco_submajor_code?: string | null;
  isco_major_code?: string | null;
  is_universal?: boolean;
}

export interface PackOptionRecord {
  option_key: string;
  label_text: string;
  value_text?: string | null;
  value_number?: number | null;
  value_bool?: boolean | null;
  implies_skill_id?: string | null;
  is_none_of_above?: boolean;
}

export interface PackItemRecord {
  question_key: string;
  prompt_text: string;
  why_text?: string | null;
  retry_text?: string | null;
  target_kind: (typeof TARGET_KINDS)[number];
  target_field?: string | null;
  target_skill_id?: string | null;
  answer_type: (typeof ANSWER_TYPES)[number];
  is_mandatory?: boolean;
  is_core?: boolean;
  max_asks?: number;
  min_turn?: number | null;
  max_turn?: number | null;
  ask_if?: unknown;
  skip_if?: unknown;
  parent_item_key?: string | null;
  options?: PackOptionRecord[];
}

export interface PackRecord {
  pack_id: string;
  version: number;
  family_id: string;
  locale?: string;
  status?: (typeof STATUSES)[number];
  review_note?: string | null;
  items: PackItemRecord[];
}

export interface QuestionPackCorpus {
  families: FamilyRecord[];
  bindings: BindingRecord[];
  packs: PackRecord[];
}

/** The specificity a binding's target implies. Mirrors `pfb_specificity_matches_target_chk`. */
export function bindingSpecificity(b: BindingRecord): number | null {
  if (b.job_domain_id) return 50;
  if (b.isco_unit_code) return 40;
  if (b.isco_minor_code) return 30;
  if (b.isco_submajor_code) return 20;
  if (b.isco_major_code) return 10;
  if (b.is_universal) return 0;
  return null;
}

/** Which target column a binding sets, for the "two families, one target" check. */
function bindingTarget(b: BindingRecord): string | null {
  if (b.job_domain_id) return `job_domain:${b.job_domain_id}`;
  if (b.isco_unit_code) return `unit:${b.isco_unit_code}`;
  if (b.isco_minor_code) return `minor:${b.isco_minor_code}`;
  if (b.isco_submajor_code) return `submajor:${b.isco_submajor_code}`;
  if (b.isco_major_code) return `major:${b.isco_major_code}`;
  if (b.is_universal) return "universal";
  return null;
}

// ===========================================================================
// Loading
// ===========================================================================

export function loadQuestionPackCorpus(dir: string = QUESTION_PACK_DATA_DIR): QuestionPackCorpus {
  const families: FamilyRecord[] = [];
  const bindings: BindingRecord[] = [];
  const packs: PackRecord[] = [];
  if (!existsSync(dir)) return { families, bindings, packs };

  const familyFile = join(dir, "_families.jsonl");
  if (existsSync(familyFile)) {
    readFileSync(familyFile, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) return;
        let parsed: FamilyRecord | BindingRecord;
        try {
          parsed = JSON.parse(trimmed) as FamilyRecord | BindingRecord;
        } catch {
          throw new Error(`_families.jsonl:${i + 1} is not valid JSON`);
        }
        if (parsed.kind === "family") families.push(parsed);
        else if (parsed.kind === "binding") bindings.push(parsed);
        else throw new Error(`_families.jsonl:${i + 1} has unknown kind ${JSON.stringify((parsed as { kind: string }).kind)}`);
      });
  }

  const packDir = join(dir, "packs");
  if (existsSync(packDir)) {
    for (const file of readdirSync(packDir).filter((f) => f.endsWith(".json")).sort()) {
      const raw = readFileSync(join(packDir, file), "utf8");
      try {
        packs.push(JSON.parse(raw) as PackRecord);
      } catch {
        throw new Error(`packs/${file} is not valid JSON`);
      }
    }
  }
  return { families, bindings, packs };
}

// ===========================================================================
// Validation
// ===========================================================================

/** What the validator needs from the OCCUPATION corpus to check binding targets. */
export interface TaxonomyView {
  jobDomainIds: ReadonlySet<string>;
  iscoUnitCodes: ReadonlySet<string>;
  iscoMinorCodes: ReadonlySet<string>;
  iscoSubmajorCodes: ReadonlySet<string>;
  iscoMajorCodes: ReadonlySet<string>;
}

/** Skill ids a `match_skill` question may target. Empty set disables the check. */
export interface SkillView {
  skillIds: ReadonlySet<string>;
}

/** RFS field ids a `rfs` question may target. Empty set disables the check. */
export interface FieldView {
  fieldIds: ReadonlySet<string>;
}

/**
 * Persona check on one prompt. Returns problems, empty means clean.
 * See the DEFERRED note above for what is deliberately NOT checked.
 */
export function checkPromptPersona(text: string, where: string): string[] {
  const problems: string[] = [];
  const marks = (text.match(/\?/g) ?? []).length;
  if (marks !== MAX_QUESTION_MARKS) {
    problems.push(
      `${where}: prompt has ${marks} question mark(s), needs exactly ${MAX_QUESTION_MARKS}. ` +
        `Two questions in one turn is the fastest way to lose a low-literacy worker.`,
    );
  }
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length > MAX_PROMPT_WORDS) {
    problems.push(`${where}: prompt is ${words.length} words, max ${MAX_PROMPT_WORDS}`);
  }
  if (text.includes("!")) problems.push(`${where}: prompt contains an exclamation mark`);
  if (EMOJI_RE.test(text)) problems.push(`${where}: prompt contains an emoji`);
  // THE BANNED-TOKEN LISTS, lifted from `persona.py` into `data/persona.json` before Phase 8
  // deletes that file. `persona_guard.check_turn` enforced these per turn against a model's
  // output, with a repair retry; the deterministic engine's prompts are AUTHORED, so the same
  // rules become a build-time gate over text that cannot change at runtime. Strictly stronger.
  for (const problem of checkPersonaTokens(text)) problems.push(`${where}: ${problem}`);
  return problems;
}

/**
 * Every problem with the corpus, as human-readable strings. EMPTY MEANS SEEDABLE.
 *
 * `taxonomy`, `skills` and `fields` are optional views: passing an empty set DISABLES that
 * cross-reference rather than failing every row, so the validator is usable from a unit
 * test that has no catalogue loaded. The seed runner always passes real ones.
 */
export function validateQuestionPackCorpus(
  corpus: QuestionPackCorpus,
  opts: { taxonomy?: TaxonomyView; skills?: SkillView; fields?: FieldView } = {},
): string[] {
  const problems: string[] = [];
  const { families, bindings, packs } = corpus;

  // ── Families ──────────────────────────────────────────────────────────────
  const familyIds = new Set<string>();
  for (const f of families) {
    const where = `family ${f.family_id}`;
    if (!FAMILY_ID_RE.test(f.family_id ?? "")) {
      problems.push(`${where}: family_id must match ${FAMILY_ID_RE}`);
      continue;
    }
    if (familyIds.has(f.family_id)) problems.push(`${where}: duplicate family_id`);
    familyIds.add(f.family_id);
    if (!f.label_en || f.label_en.trim().length === 0) problems.push(`${where}: label_en is required`);
    if (f.status && !STATUSES.includes(f.status)) problems.push(`${where}: unknown status ${JSON.stringify(f.status)}`);
    // label_hi is what a worker is SHOWN when the engine confirms their trade. Its
    // absence is not fatal (label_en is the fallback) but it is worth flagging, because
    // "Metal Working Machine Tool Setters and Operators" is unusable as a confirmation.
    if (!f.label_hi) {
      problems.push(`${where}: WARN label_hi is missing — the worker-facing confirmation will fall back to label_en`);
    }
  }

  // ── Bindings ──────────────────────────────────────────────────────────────
  const claimedTargets = new Map<string, string>();
  let universalCount = 0;
  for (const b of bindings) {
    const where = `binding ${b.family_id}`;
    if (!familyIds.has(b.family_id)) {
      problems.push(`${where}: family_id is not a family in this corpus`);
      continue;
    }
    const spec = bindingSpecificity(b);
    if (spec === null) {
      problems.push(`${where}: sets no target — needs exactly one of job_domain_id, isco_*_code or is_universal`);
      continue;
    }
    const setCount = [
      b.job_domain_id,
      b.isco_unit_code,
      b.isco_minor_code,
      b.isco_submajor_code,
      b.isco_major_code,
      b.is_universal ? "u" : null,
    ].filter(Boolean).length;
    if (setCount > 1) {
      problems.push(`${where}: sets ${setCount} targets — exactly one is allowed (mirrors pfb_exactly_one_target_chk)`);
      continue;
    }
    const target = bindingTarget(b);
    if (target === null) continue;
    if (target === "universal") universalCount++;
    // The corpus-level twin of the six partial unique indexes. Catching it HERE names
    // both families; catching it at INSERT names only an index.
    const prior = claimedTargets.get(target);
    if (prior !== undefined && prior !== b.family_id) {
      problems.push(
        `${where}: target ${target} is already claimed by ${prior}. Two families cannot bind the same target — ` +
          `most-specific-wins would silently pick one and that trade would get the wrong interview.`,
      );
    }
    claimedTargets.set(target, b.family_id);

    const tax = opts.taxonomy;
    if (tax) {
      const missing =
        (b.job_domain_id && !tax.jobDomainIds.has(b.job_domain_id) && `job_domain_id ${b.job_domain_id}`) ||
        (b.isco_unit_code && !tax.iscoUnitCodes.has(b.isco_unit_code) && `isco_unit_code ${b.isco_unit_code}`) ||
        (b.isco_minor_code && !tax.iscoMinorCodes.has(b.isco_minor_code) && `isco_minor_code ${b.isco_minor_code}`) ||
        (b.isco_submajor_code && !tax.iscoSubmajorCodes.has(b.isco_submajor_code) && `isco_submajor_code ${b.isco_submajor_code}`) ||
        (b.isco_major_code && !tax.iscoMajorCodes.has(b.isco_major_code) && `isco_major_code ${b.isco_major_code}`);
      if (missing) problems.push(`${where}: ${missing} does not exist in the occupation catalogue`);
    }
  }

  // THE FALLBACK OF LAST RESORT. Without a universal pack, a worker in an unauthored
  // trade resolves to nothing and the interview has no questions to ask — which is a
  // dead conversation, not a degraded one.
  if (bindings.length > 0 && universalCount === 0) {
    problems.push(`corpus: no universal binding — every unauthored trade would resolve to no pack at all`);
  }
  if (universalCount > 1) {
    problems.push(`corpus: ${universalCount} universal bindings — exactly one is allowed (mirrors pfb_universal_uq)`);
  }

  // ── Packs ─────────────────────────────────────────────────────────────────
  const seenPacks = new Set<string>();
  const familiesWithActivePack = new Set<string>();
  for (const p of packs) {
    const where = `pack ${p.pack_id}@${p.version}`;
    if (!PACK_ID_RE.test(p.pack_id ?? "")) {
      problems.push(`${where}: pack_id must match ${PACK_ID_RE}`);
      continue;
    }
    if (!Number.isInteger(p.version) || p.version < 1) {
      problems.push(`${where}: version must be an integer >= 1`);
      continue;
    }
    const key = `${p.pack_id}@${p.version}`;
    if (seenPacks.has(key)) problems.push(`${where}: duplicate (pack_id, version)`);
    seenPacks.add(key);
    if (!familyIds.has(p.family_id)) problems.push(`${where}: family_id ${p.family_id} is not a family in this corpus`);
    if (p.status && !STATUSES.includes(p.status)) problems.push(`${where}: unknown status ${JSON.stringify(p.status)}`);

    const locale = p.locale ?? "hi-IN";
    if ((p.status ?? "draft") === "active") {
      const activeKey = `${p.family_id}|${locale}`;
      if (familiesWithActivePack.has(activeKey)) {
        problems.push(`${where}: a second ACTIVE pack for ${activeKey} — the resolver must never have to choose`);
      }
      familiesWithActivePack.add(activeKey);
    }

    if (!Array.isArray(p.items) || p.items.length === 0) {
      problems.push(`${where}: has no items — an empty pack is a dead interview`);
      continue;
    }

    const keys = new Set<string>();
    for (const it of p.items) {
      const iw = `${where} item ${it.question_key}`;
      if (!QUESTION_KEY_RE.test(it.question_key ?? "")) {
        problems.push(`${iw}: question_key must match ${QUESTION_KEY_RE}`);
        continue;
      }
      if (it.question_key.length > MAX_QUESTION_KEY_LEN) {
        problems.push(
          `${iw}: question_key is ${it.question_key.length} chars, max ${MAX_QUESTION_KEY_LEN}. ` +
            `Over-length ids are DISCARDED by the event-payload filter, which drops a completed interview.`,
        );
      }
      if (keys.has(it.question_key)) problems.push(`${iw}: duplicate question_key in this pack`);
      keys.add(it.question_key);

      if (!TARGET_KINDS.includes(it.target_kind)) problems.push(`${iw}: unknown target_kind ${JSON.stringify(it.target_kind)}`);
      if (!ANSWER_TYPES.includes(it.answer_type)) problems.push(`${iw}: unknown answer_type ${JSON.stringify(it.answer_type)}`);
      if (it.target_kind === "match_skill" && !it.target_skill_id) {
        problems.push(`${iw}: target_kind 'match_skill' needs target_skill_id`);
      }
      if ((it.target_kind === "rfs" || it.target_kind === "attribute") && !it.target_field) {
        problems.push(`${iw}: target_kind '${it.target_kind}' needs target_field`);
      }
      if (opts.skills?.skillIds.size && it.target_skill_id && !opts.skills.skillIds.has(it.target_skill_id)) {
        problems.push(`${iw}: target_skill_id ${it.target_skill_id} is not a skill`);
      }
      if (opts.fields?.fieldIds.size && it.target_kind === "rfs" && it.target_field && !opts.fields.fieldIds.has(it.target_field)) {
        problems.push(`${iw}: target_field ${it.target_field} is not in the Resume Field Set vocabulary`);
      }
      if (it.max_asks !== undefined && (!Number.isInteger(it.max_asks) || it.max_asks < 1 || it.max_asks > 3)) {
        problems.push(`${iw}: max_asks must be an integer 1..3`);
      }
      if (
        it.min_turn !== undefined && it.min_turn !== null &&
        it.max_turn !== undefined && it.max_turn !== null &&
        it.min_turn > it.max_turn
      ) {
        problems.push(`${iw}: min_turn ${it.min_turn} is after max_turn ${it.max_turn}`);
      }

      problems.push(...checkPromptPersona(it.prompt_text ?? "", iw));

      // NO TEMPLATE PLACEHOLDER IN ANY SERVED TEXT. Two lines, and the highest-value two lines
      // in this validator.
      //
      // The voice form pre-renders every string the engine can serve into TTS audio, keyed by
      // `sha256(text)` and shared across every worker. That is safe only while the text depends
      // on nothing about the individual. `{{worker_name}}` is a reviewed affordance of this
      // corpus — the API interpolates it POST-emit, into the client-returned reply only, so the
      // durable and rendered copies keep the placeholder — but an authored prompt carrying it
      // would put ONE worker's name into a clip EVERY other worker hears. That is the worst
      // failure available in the design, and it is a single careless pack row away.
      //
      // All three served fields, not just the prompt: `why_text` reaches a worker inside the
      // clarify concatenation and `retry_text` on the second ask. Measured at the time this
      // landed: 0 of 466 items contain `{{` anywhere, so this is a guard, not a repair.
      for (const [field, text] of [
        ["prompt_text", it.prompt_text],
        ["retry_text", it.retry_text],
        ["why_text", it.why_text],
      ] as const) {
        if (typeof text === "string" && /\{\{|\}\}/.test(text)) {
          problems.push(
            `${iw}: ${field} contains a template placeholder. Served text is pre-rendered to ` +
              `shared TTS audio, so an interpolated value would be spoken to every worker.`,
          );
        }
      }

      // A select with fewer than two options is not a choice.
      const options = it.options ?? [];
      if (SELECT_TYPES.has(it.answer_type) && options.length < 2) {
        problems.push(`${iw}: ${it.answer_type} needs at least 2 options, has ${options.length}`);
      }
      if (!SELECT_TYPES.has(it.answer_type) && options.length > 0) {
        problems.push(`${iw}: answer_type ${it.answer_type} must not carry options`);
      }
      const optKeys = new Set<string>();
      const optLabels = new Set<string>();
      for (const o of options) {
        const ow = `${iw} option ${o.option_key}`;
        if (!OPTION_KEY_RE.test(o.option_key ?? "")) problems.push(`${ow}: option_key must match ${OPTION_KEY_RE}`);
        if (optKeys.has(o.option_key)) problems.push(`${ow}: duplicate option_key`);
        optKeys.add(o.option_key);
        if (!o.label_text || o.label_text.trim().length === 0) problems.push(`${ow}: label_text is required`);
        // The label IS the worker's recorded answer, verbatim. Two identical labels make
        // the record ambiguous after the fact and are indistinguishable to the worker.
        else if (optLabels.has(o.label_text)) problems.push(`${ow}: duplicate label_text ${JSON.stringify(o.label_text)} — the label is the answer of record`);
        else optLabels.add(o.label_text);
        // OPTIONS ARE ANSWERS, NEVER QUESTIONS. Unenforceable while an LLM wrote them;
        // mechanical now that they are reviewed rows.
        if (o.label_text?.includes("?")) problems.push(`${ow}: label_text contains '?' — options are ANSWERS, never questions`);
      }
      if (options.filter((o) => o.is_none_of_above).length > 1) {
        problems.push(`${iw}: more than one option flagged is_none_of_above`);
      }
    }

    // ── Cross-item checks, now that every key in the pack is known ──────────
    for (const it of p.items) {
      const iw = `${where} item ${it.question_key}`;
      if (it.ask_if !== undefined && it.ask_if !== null) {
        problems.push(...validatePredicate(it.ask_if, keys, `${iw}.ask_if`));
      }
      if (it.skip_if !== undefined && it.skip_if !== null) {
        problems.push(...validatePredicate(it.skip_if, keys, `${iw}.skip_if`));
      }
      // A question gated on ITSELF can never fire.
      for (const f of [...predicateFields(it.ask_if), ...predicateFields(it.skip_if)]) {
        if (f === it.question_key) problems.push(`${iw}: its own condition reads ${f} — it could never fire`);
      }
      if (it.parent_item_key) {
        if (!keys.has(it.parent_item_key)) {
          problems.push(`${iw}: parent_item_key ${it.parent_item_key} is not a question in this pack`);
        } else {
          const parent = p.items.find((x) => x.question_key === it.parent_item_key);
          // DEPTH 1. A follow-up to a follow-up is a conversation tree nobody can review,
          // and the engine's ask accounting assumes a flat-plus-one shape.
          if (parent?.parent_item_key) {
            problems.push(`${iw}: follow-up depth is capped at 1 (parent ${parent.question_key} is itself a follow-up)`);
          }
          if (parent?.question_key === it.question_key) {
            problems.push(`${iw}: is its own parent`);
          }
        }
      }
    }

    // Every family with a pack should also have a binding, or the pack is unreachable.
    if (!bindings.some((b) => b.family_id === p.family_id)) {
      problems.push(`${where}: family ${p.family_id} has no binding — this pack can never be resolved`);
    }
  }

  return problems;
}

/** Load + validate. Throws with EVERY problem listed. */
export function resolveQuestionPackCorpus(
  dir: string = QUESTION_PACK_DATA_DIR,
  opts: { taxonomy?: TaxonomyView; skills?: SkillView; fields?: FieldView } = {},
): QuestionPackCorpus {
  const corpus = loadQuestionPackCorpus(dir);
  const problems = validateQuestionPackCorpus(corpus, opts);
  const fatal = problems.filter((p) => !p.includes("WARN"));
  if (fatal.length > 0) {
    throw new Error(`question-pack corpus invalid:\n  - ${fatal.join("\n  - ")}`);
  }
  return corpus;
}

/** Counts for a dry-run summary. Ids + integers only, never row contents. */
export function summariseQuestionPackCorpus(c: QuestionPackCorpus): Record<string, number> {
  return {
    families: c.families.length,
    bindings: c.bindings.length,
    packs: c.packs.length,
    active_packs: c.packs.filter((p) => (p.status ?? "draft") === "active").length,
    items: c.packs.reduce((n, p) => n + (p.items?.length ?? 0), 0),
    options: c.packs.reduce((n, p) => n + (p.items ?? []).reduce((m, i) => m + (i.options?.length ?? 0), 0), 0),
  };
}
