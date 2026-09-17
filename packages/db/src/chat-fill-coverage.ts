/**
 * Chat-road fill coverage — the RULER, pure and offline.
 *
 * ═══ WHAT THIS MEASURES, AND WHY IT EXISTS ═══════════════════════════════════════════════════
 *
 * The chat road deterministically settles only four fields (`trade`, `experience`,
 * `current_city`, `availability`) plus a gated model overlay; every other field on this list is
 * structurally unaskable there because `CHAT_FACT_OWNER` reads `pages` and the universal tail
 * never serves it (see `apps/api/src/profiling/facts/worker-fact.ownership.ts`). This module is
 * the measurement that turns "structurally unaskable" into a number and holds it still while
 * the elicitation work lands: fill rate per field per road, over a corpus of per-worker
 * observations.
 *
 * ═══ WHY IT DOES NOT TOUCH A DATABASE OR A WORKER VALUE ═════════════════════════════════════
 *
 * A row here is `{ road, filled: Record<field, boolean> }` — a road plus one boolean per field.
 * There is no string, number, id or free-text field anywhere on the observation type, so a
 * function that is never handed a worker value cannot leak one (the RI-7 discipline,
 * `resume-prefill-coverage.ts`, applied to the field-fill question). The corpus is the same
 * shape: `parseCorpusLines` is STRICT about keys — a line carrying anything but `road` and
 * `filled` is refused rather than ignored, so a value cannot ride into the measurement through
 * the corpus file.
 *
 * ═══ WHERE THE FIELD LIST COMES FROM ════════════════════════════════════════════════════════
 *
 * `CHAT_FILL_FIELDS` is the 19 `WORKER_FACT_IDS` from `worker-fact.registry.ts` plus the six
 * Layer A storage fields that are not facts (whatsapp, training, licence, portfolio, secondary
 * occupations, verification). `packages/db` cannot import `apps/api` (the dependency points the
 * other way), so the fact half is a NAMED MIRROR — and the drift is closed by an `apps/api`
 * contract test that asserts every `WORKER_FACT_IDS` entry is a `CHAT_FILL_FIELD`
 * (`chat-fill-fields.contract.test.ts`). Extending the registry without extending this list is
 * a red test, not a silent gap.
 *
 * ═══ THE NULL-SOURCE NUMBER ═════════════════════════════════════════════════════════════════
 *
 * `road: null` models a `worker_profiles.source IS NULL` row — a pre-0107 profile whose road was
 * never recorded (D1: NULL is unknown, never a guess). The aggregate reports how many such rows
 * the corpus carried. The PRODUCTION expectation is ~0; the live number is one read-only query,
 * `select count(*) from worker_profiles where source is null`, and the Phase 3 view exposes the
 * same fact per worker. This module only reports what it is handed.
 */

/**
 * The 19 facts, in `WORKER_FACT_IDS` order. MIRRORED, not imported — see the header. The
 * `chat-fill-fields.contract.test.ts` guard in `apps/api` keeps the mirror honest.
 */
export const FACT_FILL_FIELDS = [
  "trade",
  "experience",
  "current_city",
  "preferred_locations",
  "shift",
  "salary_expected",
  "education",
  "availability",
  "certifications",
  "work_history",
  "languages",
  "documents_ready",
  "job_type",
  "relocation",
  "accommodation",
  "work_types",
  "salary_period",
  "commute_max_km",
  "willing_to_travel",
] as const;

/**
 * Layer A storage that is NOT a registry fact: the private profile fields (a)-(e) and the two
 * (f)/(g) additions, each with its own table or column. `licence` is ONE field because the
 * number and the expiry are captured and erased together.
 */
export const LAYER_A_FILL_FIELDS = [
  "whatsapp",
  "training",
  "licence",
  "portfolio",
  "secondary_occupations",
  "verification",
] as const;

export const CHAT_FILL_FIELDS = [...FACT_FILL_FIELDS, ...LAYER_A_FILL_FIELDS] as const;

export type ChatFillField = (typeof CHAT_FILL_FIELDS)[number];

/**
 * `form` / `chat` are `worker_profiles.source` (D1). `unknown` is the null source — the pre-0107
 * rows — surfaced as its own bucket rather than folded into either road, because guessing the
 * road is exactly what D1 forbids.
 */
export const FILL_ROADS = ["form", "chat", "unknown"] as const;
export type FillRoad = (typeof FILL_ROADS)[number];

/** One worker, reduced to a road and one boolean per field. No values, by construction. */
export interface FillObservation {
  readonly road: FillRoad;
  readonly filled: Readonly<Record<ChatFillField, boolean>>;
}

export interface FieldFillSummary {
  readonly road: FillRoad;
  readonly field: ChatFillField;
  readonly workers: number;
  readonly filled: number;
  /** `filled / workers`, or `0` when the road has no workers — never `NaN`. */
  readonly fillRate: number;
}

export interface FillAggregate {
  readonly rows: readonly FieldFillSummary[];
  readonly totalWorkers: number;
  /** Rows whose source is NULL (pre-0107). Production expectation ~0; see the header. */
  readonly unknownRoadWorkers: number;
  readonly workersPerRoad: Readonly<Record<FillRoad, number>>;
}

/**
 * Aggregate observations into one row per (road, field).
 *
 * EVERY FIELD GETS A ROW FOR EVERY ROAD THAT HAS AT LEAST ONE WORKER — including a 0% row. A
 * missing row would make "this road never fills the field" indistinguishable from "nobody
 * measured it", which is the one distinction this ruler exists to draw.
 */
export function aggregateFill(observations: readonly FillObservation[]): FillAggregate {
  const workersPerRoad: Record<FillRoad, number> = { form: 0, chat: 0, unknown: 0 };
  const counts = new Map<
    string,
    { road: FillRoad; field: ChatFillField; workers: number; filled: number }
  >();

  for (const observation of observations) {
    workersPerRoad[observation.road] += 1;
    for (const field of CHAT_FILL_FIELDS) {
      const key = `${observation.road} ${field}`;
      const row = counts.get(key) ?? { road: observation.road, field, workers: 0, filled: 0 };
      row.workers += 1;
      if (observation.filled[field]) row.filled += 1;
      counts.set(key, row);
    }
  }

  const roadOrder: readonly FillRoad[] = FILL_ROADS;
  const rows = [...counts.values()]
    .filter((r) => workersPerRoad[r.road] > 0)
    .map((r) => ({
      road: r.road,
      field: r.field,
      workers: r.workers,
      filled: r.filled,
      fillRate: r.workers === 0 ? 0 : r.filled / r.workers,
    }))
    .sort((a, b) => {
      const fieldOrder = CHAT_FILL_FIELDS.indexOf(a.field) - CHAT_FILL_FIELDS.indexOf(b.field);
      if (fieldOrder !== 0) return fieldOrder;
      return roadOrder.indexOf(a.road) - roadOrder.indexOf(b.road);
    });

  return {
    rows,
    totalWorkers: observations.length,
    unknownRoadWorkers: workersPerRoad.unknown,
    workersPerRoad,
  };
}

// ── The corpus format ────────────────────────────────────────────────────────────────────────
//
// One JSON object per line: `{"road": "form"|"chat"|null, "filled": ["trade", ...]}`. Blank
// lines and `#` comments carry the provenance header. `filled` is a SPARSE list of field names
// (a corpus author writes what is settled, not 25 falses) which is expanded to the full record
// here. STRICT: every key is checked, every field name must be closed-set, so a corpus file
// cannot smuggle a value into the measurement.

export function parseCorpusLines(text: string): FillObservation[] {
  const out: FillObservation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`corpus line ${i + 1}: not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`corpus line ${i + 1}: must be a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "road" && key !== "filled") {
        throw new Error(
          `corpus line ${i + 1}: unexpected key "${key}" (values are not corpus data)`,
        );
      }
    }
    const rawRoad = record.road;
    const road: FillRoad = rawRoad === "form" || rawRoad === "chat" ? rawRoad : "unknown";
    if (rawRoad !== null && rawRoad !== "form" && rawRoad !== "chat" && rawRoad !== "unknown") {
      throw new Error(`corpus line ${i + 1}: road must be "form", "chat", "unknown" or null`);
    }
    const rawFilled = record.filled ?? [];
    if (!Array.isArray(rawFilled) || rawFilled.some((f) => typeof f !== "string")) {
      throw new Error(`corpus line ${i + 1}: filled must be an array of field names`);
    }
    const filledNames = rawFilled as string[];
    const seen = new Set<string>();
    for (const name of filledNames) {
      if (!(CHAT_FILL_FIELDS as readonly string[]).includes(name)) {
        throw new Error(`corpus line ${i + 1}: unknown field "${name}"`);
      }
      if (seen.has(name)) throw new Error(`corpus line ${i + 1}: field "${name}" listed twice`);
      seen.add(name);
    }
    const filled = {} as Record<ChatFillField, boolean>;
    for (const field of CHAT_FILL_FIELDS) filled[field] = seen.has(field);
    out.push({ road, filled });
  });
  return out;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** The stdout table — counts and rates only, one row per (field, road). */
export function formatReport(aggregate: FillAggregate): string[] {
  const lines: string[] = [];
  lines.push(
    `[chat-fill] workers scored: ${aggregate.totalWorkers}` +
      ` (form ${aggregate.workersPerRoad.form} · chat ${aggregate.workersPerRoad.chat}` +
      ` · unknown ${aggregate.workersPerRoad.unknown})`,
  );
  lines.push(
    `[chat-fill] NULL-source workers (pre-0107): ${aggregate.unknownRoadWorkers}` +
      " — production expectation ~0; live count: select count(*) from worker_profiles where source is null",
  );
  if (aggregate.rows.length === 0) {
    lines.push("[chat-fill] no workers in the corpus.");
    return lines;
  }
  lines.push(
    "  field".padEnd(24) + "form".padStart(16) + "chat".padStart(16) + "unknown".padStart(16),
  );
  for (const field of CHAT_FILL_FIELDS) {
    let line = `  ${field}`.padEnd(24);
    for (const road of FILL_ROADS) {
      const row = aggregate.rows.find((r) => r.field === field && r.road === road);
      line +=
        row === undefined
          ? "—".padStart(16)
          : `${pct(row.fillRate)} (${row.filled}/${row.workers})`.padStart(16);
    }
    lines.push(line);
  }
  return lines;
}
