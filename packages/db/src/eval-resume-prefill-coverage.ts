/**
 * `pnpm db:eval:resume-prefill` — RI-7, an OFFLINE measurement, not a CI gate.
 *
 * WHAT IT ANSWERS. For every parsed résumé import with a staged suggestion payload: which of
 * the six `RESUME_SUGGESTION_TARGETS` fields did the parse actually offer (coverage), how often
 * did the worker later save a value at all (confirmation), and — when he did — how often did it
 * differ from what the résumé suggested (override)? Split by `extraction_method`, because the
 * plan's live question is whether OCR noise costs prefill quality relative to a clean text
 * layer. Modelled on `eval-occupation-retrieval.ts`: a runnable script around a pure, tested
 * aggregation (`resume-prefill-coverage.ts`), reporting counts and rates, nothing else.
 *
 * WHY IT NEEDS A DATABASE AND `eval-occupation-retrieval.ts` DOES NOT. That harness scores a
 * committed corpus against a committed gold set — everything it needs is in git. This one scores
 * REAL parses against REAL later answers; neither exists outside a populated database, so unlike
 * its sibling this script cannot be reproduced from a checkout alone. It is read-only and never
 * prints a decrypted value (see the privacy note below), but it is not offline in that sense.
 *
 * ── WHERE A CONFIRMED VALUE ACTUALLY LANDS, AND WHY THIS FILE HARD-CODES IT ────────────────
 *
 * `apps/api/src/profiling/facts/worker-fact.registry.ts` (`WORKER_FACTS`) is the real answer to
 * "where does fact X settle", and `apps/api/src/profiling/resume-import/resume-suggestions.ts`
 * (`RESUME_SUGGESTION_TARGETS`) is the real answer to "which résumé field maps to which pack
 * question". Neither is importable here: `packages/db` is a dependency OF `apps/api`, never the
 * other way, and importing an `apps/api` module into `packages/db` would invert that — the same
 * boundary `reencrypt-pii-backfill.ts`'s `parseKeyring` already crosses for `@badabhai/config`,
 * with the identical fix (a documented local mirror, not a shared import).
 *
 * `RESUME_TARGET_FIELDS` below is that mirror, for exactly the six fields
 * `resume-prefill-coverage.ts`'s `RESUME_PREFILL_FIELDS` names. Per field it lists, in the
 * PRIORITY ORDER this script actually queries, every settling location the registry names for
 * the corresponding `WorkerFactId`:
 *
 *   role_label        → fact `trade`           → worker_pack_answer.question_key = 'primary_trade'
 *   experience_years  → fact `experience`       → worker_pack_answer.question_key = 'experience_years'
 *   current_city       → fact `current_city`     → worker_pack_answer.question_key = 'current_city',
 *                                                   then workers.current_city
 *   salary_expected    → fact `salary_expected`   → worker_attributes.attribute_key = 'salary_expected_max'
 *                                                   (the preferences-page marker, owner ruling
 *                                                   2026-09-15), then worker_pack_answer.question_key
 *                                                   = 'salary_expected' (the legacy/still-shipped
 *                                                   universal question, #1503)
 *   education_level    → fact `education`        → worker_education.credential (the
 *                                                   qualifications-page marker), then
 *                                                   worker_attributes.attribute_key =
 *                                                   'education_credential', then
 *                                                   worker_pack_answer.question_key = 'education'
 *   availability        → fact `availability`      → worker_pack_answer.question_key = 'availability'
 *
 * A DOCUMENTED, HONEST GAP: the registry ALSO lists a `target_field` alias for every one of these
 * six (the RFS crosswalk path — a chat-interview answer projects onto `worker_profiles`'s
 * `experience` / `salary_expectation` / `availability` jsonb columns or `workers.current_city`).
 * That path is NOT queried here. The jsonb shape those columns hold is a nested draft object
 * (`WorkerProfileDraft`), not a flat value per RFS field id, and guessing its path without the
 * crosswalk itself (also `apps/api`-only) risks silently mis-scoring rather than under-counting.
 * The effect: a worker who confirmed a résumé-suggested fact ONLY through the chat/voice
 * interview (never through a trade-form pack question, an attribute, or a marker page) is
 * measured here as `confirmed: false` — the true confirmation rate for `experience_years`,
 * `availability` and (partially) `current_city` is therefore a LOWER BOUND, not an exact number.
 * `role_label`, `salary_expected` and `education_level` are unaffected in practice: their
 * confirming surfaces are the trade form / marker pages this script does query, per the routing
 * rulings in `resume-suggestion-reader.ts`'s docblock (#1503/#1504).
 *
 * ── PRIVACY (CLAUDE.md §3) ──────────────────────────────────────────────────────────────────
 *
 * Every decrypted suggestion and every queried confirmed value is reduced to three booleans
 * (`FieldObservation`) BEFORE it reaches `aggregateCoverage`/`formatReport` — see
 * `resume-prefill-coverage.ts`'s own header for why that reduction is structural, not
 * discipline. This script's own logging is counts-and-ids only: a decrypt failure logs the
 * import id, never the ciphertext or an error message that could echo plaintext.
 *
 * ── DECRYPT PATH ────────────────────────────────────────────────────────────────────────────
 *
 * `decode()` below performs the SAME validation `ResumeSuggestionReader.decode` runs in
 * `apps/api` (JSON-parse, reject non-objects, keep only shapes matching `ResumeSuggestion`) over
 * the SAME underlying primitives (`decryptPii` / `decryptPiiWithKeyring` from `./crypto` — the
 * functions `PiiCryptoService.decrypt` itself calls). It cannot import `PiiCryptoService`
 * (Nest DI, `apps/api`-only) so it re-derives the keyring from env the same way
 * `reencrypt-pii-backfill.ts`'s `parseKeyring` already does, unifying both the v1-legacy-only and
 * v2-keyring-configured cases exactly as `PiiCryptoService.decrypt` does.
 *
 *   pnpm db:eval:resume-prefill                        # report to stdout + reports/resume-prefill-coverage.json
 *   pnpm db:eval:resume-prefill --json=<path>           # write the JSON summary elsewhere
 *   pnpm db:eval:resume-prefill --sample-unsafe         # ALSO print a per-import DEBUG table —
 *                                                          matched/confirmed/covered flags ONLY,
 *                                                          still never a value; local dev only,
 *                                                          off by default.
 *
 * (DATABASE_URL, PII_ENCRYPTION_KEY, and — if the keyring is active —
 *  PII_ENCRYPTION_KEYS / PII_ENCRYPTION_ACTIVE_KID from env/.env.)
 *
 * ── UNVERIFIED AGAINST REAL DATA ────────────────────────────────────────────────────────────
 *
 * This script has not been run against a populated box. "Populated" means: RESUME_UPLOADS_BUCKET
 * armed, at least one worker has completed the upload → parse → suggestions-staged path for real
 * (`worker_resume_import.status = 'parsed'` with a non-null `suggestions_enc`), and at least one
 * of those workers has gone on to answer the corresponding trade-form/marker-page question. Until
 * then the query shapes below are typed and unit-tested against the schema but not proven against
 * a real ciphertext token or a real worker_pack_answer row.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { config } from "dotenv";
import { and, desc, eq, inArray } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import {
  workerAttributes,
  workerEducations,
  workerPackAnswers,
  workerResumeImports,
  workers,
} from "./schema";
import {
  PII_KID_PATTERN,
  decryptPii,
  decryptPiiWithKeyring,
  type PiiKeyring,
} from "./crypto";
import {
  RESUME_PREFILL_FIELDS,
  aggregateCoverage,
  formatReport,
  type FieldObservation,
  type ImportObservation,
  type ObservedExtractionMethod,
  type ResumePrefillField,
} from "./resume-prefill-coverage";

config({ path: "../../.env" });
config();

const SCRIPT = "eval:resume-prefill";
const DEFAULT_JSON_OUT = join("reports", "resume-prefill-coverage.json");

// ── The decrypted suggestion shape, mirrored from resume-suggestions.ts's ResumeSuggestion ──
interface DecodedSuggestionValues {
  readonly option_keys: string[];
  readonly text: string | null;
  readonly number: number | null;
  readonly bool: boolean | null;
}
interface DecodedSuggestion {
  readonly values: DecodedSuggestionValues;
  readonly source: "resume";
  readonly confidence: number;
}

function isDecodedSuggestion(value: unknown): value is DecodedSuggestion {
  if (value === null || typeof value !== "object") return false;
  const c = value as Partial<DecodedSuggestion>;
  if (c.source !== "resume" || typeof c.confidence !== "number") return false;
  const v = c.values as Partial<DecodedSuggestionValues> | undefined;
  return v !== undefined && v !== null && Array.isArray(v.option_keys);
}

function suggestionNonEmpty(s: DecodedSuggestion): boolean {
  return s.values.option_keys.length > 0 || s.values.text !== null || s.values.number !== null || s.values.bool !== null;
}

/**
 * THE LOCAL MIRROR — see this file's header for the full citation of what it mirrors and why it
 * cannot instead be an import. `questionKeys` is candidate `worker_pack_answer.question_key`
 * values for this field, in no particular priority (a worker answers at most one, since
 * `wpa_worker_question_uq` is per (worker, pack, question_key) and both candidates below are
 * universal-pack questions a worker is asked at most once).
 */
interface FieldStorage {
  readonly field: ResumePrefillField;
  readonly questionKeys: readonly string[];
  readonly attributeKeys: readonly string[];
  readonly education: boolean;
  readonly workerColumn: "currentCity" | null;
  readonly compare: "options" | "number" | "city";
}

const RESUME_TARGET_FIELDS: readonly FieldStorage[] = [
  { field: "role_label", questionKeys: ["primary_trade"], attributeKeys: [], education: false, workerColumn: null, compare: "options" },
  { field: "experience_years", questionKeys: ["experience_years"], attributeKeys: [], education: false, workerColumn: null, compare: "number" },
  { field: "current_city", questionKeys: ["current_city"], attributeKeys: [], education: false, workerColumn: "currentCity", compare: "city" },
  { field: "salary_expected", questionKeys: ["salary_expected"], attributeKeys: ["salary_expected_max"], education: false, workerColumn: null, compare: "number" },
  { field: "education_level", questionKeys: ["education"], attributeKeys: ["education_credential"], education: true, workerColumn: null, compare: "options" },
  { field: "availability", questionKeys: ["availability"], attributeKeys: [], education: false, workerColumn: null, compare: "options" },
];

// ── The résumé's question_key vocabulary for each field, for locating its suggestion in the
// decrypted byQuestionKey payload. Mirrors the same candidates as RESUME_TARGET_FIELDS above —
// the confirming surface and the suggested surface are named by the same pack question. ──
function suggestionFor(
  byQuestionKey: ReadonlyMap<string, DecodedSuggestion>,
  storage: FieldStorage,
): DecodedSuggestion | null {
  for (const key of storage.questionKeys) {
    const s = byQuestionKey.get(key);
    if (s && suggestionNonEmpty(s)) return s;
  }
  return null;
}

function normaliseText(text: string): string {
  return text.trim().toLowerCase();
}

function suggestedOptionValue(s: DecodedSuggestion): string | null {
  const first = s.values.option_keys[0];
  if (first !== undefined) return normaliseText(first);
  if (s.values.text !== null) return normaliseText(s.values.text);
  return null;
}

function suggestedNumberValue(s: DecodedSuggestion): number | null {
  return s.values.number;
}

function suggestedTextValue(s: DecodedSuggestion): string | null {
  return s.values.text;
}

// ── Confirmed-value lookups, batched per worker ──────────────────────────────────────────────
interface PackAnswerRow {
  workerId: string;
  questionKey: string;
  answerText: string | null;
  answerNumber: number | null;
  answerOptionKeys: string[] | null;
  answeredAt: Date;
}
interface AttributeRow {
  workerId: string;
  attributeKey: string;
  valueText: string | null;
  valueNumber: string | null;
}
interface EducationRow {
  workerId: string;
  credential: string | null;
}
async function loadConfirmedSources(
  db: Database,
  workerIds: readonly string[],
): Promise<{
  packAnswers: Map<string, PackAnswerRow[]>;
  attributes: Map<string, AttributeRow[]>;
  educations: Map<string, EducationRow[]>;
  cities: Map<string, string | null>;
}> {
  const packAnswers = new Map<string, PackAnswerRow[]>();
  const attributes = new Map<string, AttributeRow[]>();
  const educations = new Map<string, EducationRow[]>();
  const cities = new Map<string, string | null>();
  if (workerIds.length === 0) return { packAnswers, attributes, educations, cities };

  const allQuestionKeys = [...new Set(RESUME_TARGET_FIELDS.flatMap((f) => f.questionKeys))];
  const allAttributeKeys = [...new Set(RESUME_TARGET_FIELDS.flatMap((f) => f.attributeKeys))];

  const paRows = await db
    .select({
      workerId: workerPackAnswers.workerId,
      questionKey: workerPackAnswers.questionKey,
      answerText: workerPackAnswers.answerText,
      answerNumber: workerPackAnswers.answerNumber,
      answerOptionKeys: workerPackAnswers.answerOptionKeys,
      answeredAt: workerPackAnswers.answeredAt,
    })
    .from(workerPackAnswers)
    .where(
      and(
        inArray(workerPackAnswers.workerId, [...workerIds]),
        inArray(workerPackAnswers.questionKey, allQuestionKeys),
        eq(workerPackAnswers.status, "answered"),
      ),
    )
    .orderBy(desc(workerPackAnswers.answeredAt));
  for (const r of paRows) {
    const list = packAnswers.get(r.workerId) ?? [];
    list.push(r);
    packAnswers.set(r.workerId, list);
  }

  if (allAttributeKeys.length > 0) {
    const attrRows = await db
      .select({
        workerId: workerAttributes.workerId,
        attributeKey: workerAttributes.attributeKey,
        valueText: workerAttributes.valueText,
        valueNumber: workerAttributes.valueNumber,
      })
      .from(workerAttributes)
      .where(
        and(
          inArray(workerAttributes.workerId, [...workerIds]),
          inArray(workerAttributes.attributeKey, allAttributeKeys),
        ),
      );
    for (const r of attrRows) {
      const list = attributes.get(r.workerId) ?? [];
      list.push(r);
      attributes.set(r.workerId, list);
    }
  }

  if (RESUME_TARGET_FIELDS.some((f) => f.education)) {
    const eduRows = await db
      .select({ workerId: workerEducations.workerId, credential: workerEducations.credential })
      .from(workerEducations)
      .where(inArray(workerEducations.workerId, [...workerIds]));
    for (const r of eduRows) {
      const list = educations.get(r.workerId) ?? [];
      list.push(r);
      educations.set(r.workerId, list);
    }
  }

  if (RESUME_TARGET_FIELDS.some((f) => f.workerColumn === "currentCity")) {
    const cityRows = await db
      .select({ id: workers.id, currentCity: workers.currentCity })
      .from(workers)
      .where(inArray(workers.id, [...workerIds]));
    for (const r of cityRows) cities.set(r.id, r.currentCity);
  }

  return { packAnswers, attributes, educations, cities };
}

/** The observed (confirmed, matched) pair for one field on one worker, given the batched reads. */
function resolveConfirmed(
  storage: FieldStorage,
  workerId: string,
  suggestion: DecodedSuggestion,
  sources: Awaited<ReturnType<typeof loadConfirmedSources>>,
): { confirmed: boolean; matched: boolean | null } {
  // 1. worker_pack_answer — newest first (deduped by question_key: at most one live answer per
  //    question per pack, but a worker could hold rows under two packs; newest wins).
  const answers = (sources.packAnswers.get(workerId) ?? []).filter((r) =>
    storage.questionKeys.includes(r.questionKey),
  );
  const a = answers[0];
  if (a !== undefined) {
    return compareAnswer(storage, suggestion, a);
  }

  // 2. worker_attributes (marker-page-owned facts).
  if (storage.attributeKeys.length > 0) {
    const attrs = sources.attributes.get(workerId) ?? [];
    const attr = attrs.find((r) => storage.attributeKeys.includes(r.attributeKey));
    if (attr) return compareAttribute(storage, suggestion, attr);
  }

  // 3. worker_education (qualifications marker).
  if (storage.education) {
    const edus = (sources.educations.get(workerId) ?? []).filter((r) => r.credential !== null);
    if (edus.length > 0) {
      const suggested = suggestedOptionValue(suggestion);
      const matched = suggested !== null && edus.some((e) => normaliseText(e.credential ?? "") === suggested);
      return { confirmed: true, matched: edus.length > 0 ? matched : null };
    }
  }

  // 4. workers.current_city (RFS/chat path's one directly-queryable column).
  if (storage.workerColumn === "currentCity") {
    const city = sources.cities.get(workerId);
    if (city !== undefined && city !== null && city.trim().length > 0) {
      const suggested = suggestedTextValue(suggestion);
      const matched = suggested === null ? null : normaliseText(suggested) === normaliseText(city);
      return { confirmed: true, matched };
    }
  }

  return { confirmed: false, matched: null };
}

function compareAnswer(
  storage: FieldStorage,
  suggestion: DecodedSuggestion,
  answer: PackAnswerRow,
): { confirmed: boolean; matched: boolean | null } {
  switch (storage.compare) {
    case "number": {
      const suggested = suggestedNumberValue(suggestion);
      if (answer.answerNumber === null) return { confirmed: true, matched: null };
      const matched = suggested !== null && suggested === answer.answerNumber;
      return { confirmed: true, matched: suggested === null ? null : matched };
    }
    case "city": {
      const confirmedText = answer.answerText;
      if (confirmedText === null) return { confirmed: true, matched: null };
      const suggested = suggestedTextValue(suggestion);
      const matched = suggested === null ? null : normaliseText(suggested) === normaliseText(confirmedText);
      return { confirmed: true, matched };
    }
    case "options":
    default: {
      const confirmedOption = answer.answerOptionKeys?.[0] ?? answer.answerText;
      if (confirmedOption === null || confirmedOption === undefined) return { confirmed: true, matched: null };
      const suggested = suggestedOptionValue(suggestion);
      const matched = suggested === null ? null : normaliseText(confirmedOption) === suggested;
      return { confirmed: true, matched };
    }
  }
}

function compareAttribute(
  storage: FieldStorage,
  suggestion: DecodedSuggestion,
  attr: AttributeRow,
): { confirmed: boolean; matched: boolean | null } {
  if (storage.compare === "number") {
    const suggested = suggestedNumberValue(suggestion);
    const confirmedNumber = attr.valueNumber === null ? null : Number(attr.valueNumber);
    if (confirmedNumber === null) return { confirmed: true, matched: null };
    const matched = suggested !== null && suggested === confirmedNumber;
    return { confirmed: true, matched: suggested === null ? null : matched };
  }
  if (attr.valueText === null) return { confirmed: true, matched: null };
  const suggested = suggestedOptionValue(suggestion);
  const matched = suggested === null ? null : normaliseText(attr.valueText) === suggested;
  return { confirmed: true, matched };
}

// ── The keyring mirror — see this file's header for why it cannot instead import @badabhai/config
// or apps/api's PiiCryptoService. Unlike reencrypt-pii-backfill.ts's parseKeyring, the keyring here
// is OPTIONAL (mirrors PiiCryptoService.decrypt's `this.keyring ? … : …` dispatch): most rows this
// script will ever see were written under the legacy v1-only path. ──
function parseKeyringOptional(): PiiKeyring | null {
  const rawKeys = process.env.PII_ENCRYPTION_KEYS;
  const rawKid = process.env.PII_ENCRYPTION_ACTIVE_KID;
  if (!rawKeys && !rawKid) return null;
  if (!rawKeys || !rawKid) {
    throw new Error(`[${SCRIPT}] PII_ENCRYPTION_KEYS and PII_ENCRYPTION_ACTIVE_KID must both be set, or neither.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error(`[${SCRIPT}] PII_ENCRYPTION_KEYS is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[${SCRIPT}] PII_ENCRYPTION_KEYS must be a JSON object`);
  }
  const keys: Record<string, string> = {};
  for (const [kid, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PII_KID_PATTERN.test(kid) || typeof key !== "string" || Buffer.from(key, "base64").length !== 32) {
      throw new Error(`[${SCRIPT}] PII_ENCRYPTION_KEYS contains an invalid entry`);
    }
    keys[kid] = key;
  }
  if (!PII_KID_PATTERN.test(rawKid) || !Object.prototype.hasOwnProperty.call(keys, rawKid)) {
    throw new Error(`[${SCRIPT}] PII_ENCRYPTION_ACTIVE_KID does not match a key in PII_ENCRYPTION_KEYS`);
  }
  return { activeKid: rawKid, keys };
}

/** Same dispatch as `PiiCryptoService.decrypt`. */
function decrypt(token: string, keyring: PiiKeyring | null, legacyKey: string): string {
  return keyring ? decryptPiiWithKeyring(token, keyring, legacyKey) : decryptPii(token, legacyKey);
}

function decode(
  token: string | null,
  keyring: PiiKeyring | null,
  legacyKey: string,
): ReadonlyMap<string, DecodedSuggestion> {
  const out = new Map<string, DecodedSuggestion>();
  if (token === null) return out;
  const parsed: unknown = JSON.parse(decrypt(token, keyring, legacyKey));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [questionKey, value] of Object.entries(parsed)) {
    if (isDecodedSuggestion(value)) out.set(questionKey, value);
  }
  return out;
}

function arg(name: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const legacyKey = process.env.PII_ENCRYPTION_KEY;
  if (!legacyKey) throw new Error(`[${SCRIPT}] PII_ENCRYPTION_KEY is not set`);
  const keyring = parseKeyringOptional();
  const jsonOut = arg("json") ?? DEFAULT_JSON_OUT;
  const sampleUnsafe = process.argv.includes("--sample-unsafe");

  const { db } = createDbClient(url, { max: 1 });

  const imports = await db
    .select({
      id: workerResumeImports.id,
      workerId: workerResumeImports.workerId,
      extractionMethod: workerResumeImports.extractionMethod,
      suggestionsEnc: workerResumeImports.suggestionsEnc,
    })
    .from(workerResumeImports)
    .where(eq(workerResumeImports.status, "parsed"));

  const withSuggestions = imports.filter((r) => r.suggestionsEnc !== null);
  console.log(`[${SCRIPT}] parsed imports total: ${imports.length}; with a suggestion payload: ${withSuggestions.length}`);

  const workerIds = [...new Set(withSuggestions.map((r) => r.workerId))];
  const sources = await loadConfirmedSources(db, workerIds);

  const observations: ImportObservation[] = [];
  let decryptFailures = 0;

  for (const row of withSuggestions) {
    let byQuestionKey: ReadonlyMap<string, DecodedSuggestion>;
    try {
      byQuestionKey = decode(row.suggestionsEnc, keyring, legacyKey);
    } catch {
      // SOFT, like resume-suggestion-reader.ts — a row this script cannot decrypt is excluded
      // from the measurement rather than aborting it. Import id only; never the token.
      decryptFailures += 1;
      console.warn(`[${SCRIPT}] decrypt failed for import ${row.id.slice(0, 8)}…; excluded`);
      continue;
    }

    const fields = {} as Record<ResumePrefillField, FieldObservation>;
    for (const storage of RESUME_TARGET_FIELDS) {
      const suggestion = suggestionFor(byQuestionKey, storage);
      if (suggestion === null) {
        fields[storage.field] = { covered: false, confirmed: false, matched: null };
        continue;
      }
      const { confirmed, matched } = resolveConfirmed(storage, row.workerId, suggestion, sources);
      fields[storage.field] = { covered: true, confirmed, matched };
    }

    observations.push({
      extractionMethod: (row.extractionMethod ?? "unknown") as ObservedExtractionMethod,
      fields,
    });
  }

  if (decryptFailures > 0) {
    console.warn(`[${SCRIPT}] ${decryptFailures} import(s) excluded — decrypt failed`);
  }

  const summary = aggregateCoverage(observations);
  for (const line of formatReport(summary, observations.length)) console.log(line);

  if (sampleUnsafe) {
    // DEV-ONLY, OFF BY DEFAULT, STILL REDACTED. Flags only — never a suggested or confirmed
    // value — so turning this on cannot become the leak the rest of this script is built to
    // avoid.
    console.log(`[${SCRIPT}] --sample-unsafe: per-import flags (covered/confirmed/matched only)`);
    for (const [i, obs] of observations.entries()) {
      const flags = RESUME_PREFILL_FIELDS.map((f) => {
        const o = obs.fields[f];
        return `${f}=${o.covered ? "C" : "-"}${o.confirmed ? "K" : "-"}${o.matched === null ? "-" : o.matched ? "M" : "O"}`;
      }).join(" ");
      console.log(`  #${i} [${obs.extractionMethod}] ${flags}`);
    }
  }

  const outDir = dirname(jsonOut);
  if (outDir && outDir !== "." && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalParsedImports: imports.length,
        importsWithSuggestions: withSuggestions.length,
        decryptFailures,
        fields: summary,
      },
      null,
      2,
    ),
  );
  console.log(`[${SCRIPT}] wrote ${jsonOut}`);
}

if (process.argv[1] && /eval-resume-prefill-coverage/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`[${SCRIPT}] FAILED: ${(error as Error).message}`);
    process.exit(1);
  });
}
