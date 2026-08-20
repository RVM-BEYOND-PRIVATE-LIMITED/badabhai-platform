/**
 * "Is this database ready for the code on `main`?" — one read-only question, one command.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * On 2026-08-19 production was running code from `9bb12992` against a database without
 * migration `0078`. Every write to `unresolved_phrase` had been failing since the first deploy
 * after that merge: the interview path swallows the error by design (`identify.service.ts`
 * logs "the interview is unaffected"), so nothing was on fire and nothing was in an alert —
 * the platform simply stopped recording the growth signal that table exists to collect, and
 * `POST /skills/unresolved` and `POST /occupation/unresolved` returned 500 to anyone who
 * called them.
 *
 * Every individual control worked. The migration was correctly marked APPLY BEFORE DEPLOY, the
 * header explained why, `MIGRATIONS.md` listed it. What was missing was any way to ASK a
 * database whether it had it. `drizzle.__drizzle_migrations` does not answer that question
 * usefully — its row count does not line up with the repo's file count (76 vs 79 here, because
 * earlier migrations were baselined), so "76 applied" reads as alarming and means nothing. The
 * only reliable question is whether the OBJECTS the deployed code dereferences exist.
 *
 * ===========================================================================
 * WHAT GOES IN THE MANIFEST
 * ===========================================================================
 * Not every object — that would be a schema differ, and drizzle already owns that job. Only
 * objects where **code on `main` names the object unconditionally**, so a database without it
 * produces a runtime failure rather than a dormant feature. That is exactly the set for which
 * "apply before deploy" is the correct instruction, which is why each entry records the
 * migration, the code path, and what the failure looks like from outside.
 *
 * An entry earns its place by answering: if this is missing and we deploy, what breaks and how
 * would we find out? If the answer is "nothing" the migration is not apply-before-deploy and
 * does not belong here.
 */

/** One object the deployed code requires, and the consequence of its absence. */
export interface SchemaRequirement {
  /** Stable id, used in output and in tests. */
  readonly id: string;
  /** The migration that introduces it. */
  readonly migration: string;
  /** `table` | `column` | `constraint` | `index` | `rls`. */
  readonly kind: "table" | "column" | "constraint" | "index" | "rls";
  readonly table: string;
  /** Column name for `column`, constraint/index name otherwise. Unused for `table`. */
  readonly object?: string;
  /** The code that names it unconditionally. */
  readonly requiredBy: string;
  /** What an operator would see if it is missing. */
  readonly failureMode: string;
}

/**
 * R39 — the three tables migration 0082 re-locks, and why they are here at all.
 *
 * THESE ARE NOT "CODE WILL 500 WITHOUT THEM" ENTRIES, and that is the same exception the 0080
 * RLS entry already makes. The manifest's usual bar is "code on `main` names this object
 * unconditionally"; an RLS entry fails that bar by construction, because a missing lock breaks
 * nothing an operator can see. It earns its place the other way round: the failure is SILENT and
 * permanent, so an audit is the ONLY thing that would ever report it.
 *
 * WHY 0048 IS NOT ENOUGH. 0048 declares FORCE and all four REVOKEs for exactly these three
 * tables, and 0048 is RECORDED in the journal — yet on production the grants are still there.
 * The table bodies were applied out-of-band, Supabase's default privileges granted the Data-API
 * roles at CREATE time, and the REVOKE tail never ran. `adopt-migrations.ts` then recorded 0048
 * as applied after a full-depth check of tables, columns, indexes, constraints and RLS
 * enable/force — a check that does not look at GRANTS. So the one tool positioned to catch this
 * passed it. 0082 re-states the lock and these entries make the state askable.
 *
 * WHY ONLY THREE OF THE SEVEN. `agency_profiles`, `employer_profiles`, `payer_capabilities` and
 * `payer_member_invites` exist on production and in NO migration and NO schema file (GAP-DB-21).
 * A manifest entry for them would report MISSING on every correctly-migrated fresh database,
 * which inverts the question this file exists to answer. `db:audit:rls` is their authority: it
 * sweeps what is actually there, so it covers a table no manifest could name.
 */
const R39_LOCKED_BY_0082: readonly { readonly table: string; readonly holds: string }[] = [
  {
    table: "agency_kyc",
    holds:
      "PAN and bank-account ciphertext plus a keyed HMAC — the highest-sensitivity financial PII " +
      "on the platform (ADR-0022 Amdt 2, ADR-0004 discipline)",
  },
  {
    table: "agency_payout_accruals",
    holds: "the commission accrual ledger — ₹ amounts and opaque ids, of which source_unlock_id is one hop from a worker",
  },
  {
    table: "agency_payout_requests",
    holds: "payout requests — ₹ amounts, opaque ids and a status enum",
  },
];

/**
 * How `0082` reaches a table: through a schema file, or only through `to_regclass`.
 *
 * `declared-by-0048` tables exist in every environment — migration `0048` creates them — so
 * their absence is a real failure. `unmodelled` tables (GAP-DB-21) exist on production and in no
 * migration and no schema file, so their absence is the CORRECT state everywhere else, and
 * `0082` reaches them only inside a guarded `DO $$` block.
 */
export type R39Class = "declared-by-0048" | "unmodelled";

export interface R39Table {
  readonly table: string;
  readonly cls: R39Class;
}

/**
 * THE SEVEN, in the order `0082` locks them — the single source for every consumer.
 *
 * This list lives here rather than beside the rehearsal runner because it now has three
 * readers that must not drift apart: `verify-rls-lock.ts` (rehearses the statements),
 * `migration-adoption.ts` (verifies `0082`'s EFFECTS, because its Section B is dynamic SQL that
 * cannot be read off the file), and this file's own manifest, which can only name the three
 * that a fresh database is guaranteed to have.
 */
export const R39_TABLES: readonly R39Table[] = [
  { table: "agency_kyc", cls: "declared-by-0048" },
  { table: "agency_payout_accruals", cls: "declared-by-0048" },
  { table: "agency_payout_requests", cls: "declared-by-0048" },
  { table: "agency_profiles", cls: "unmodelled" },
  { table: "employer_profiles", cls: "unmodelled" },
  { table: "payer_capabilities", cls: "unmodelled" },
  { table: "payer_member_invites", cls: "unmodelled" },
];

const R39_RLS_REQUIREMENTS: readonly SchemaRequirement[] = R39_LOCKED_BY_0082.map(({ table, holds }) => ({
  id: `0082-${table.replace(/_/g, "-")}-rls`,
  migration: "0082_rls_lock_seven_tables",
  kind: "rls" as const,
  table,
  requiredBy:
    "no code path — this is the platform-wide table-DEFAULT lock (TD20). 0048 declares it for " +
    "this table and its REVOKE tail never reached production, so the grant, not RLS, is what " +
    "governs `service_role` here: that role has rolbypassrls = true, which means RLS does not " +
    "apply to it at all and an open grant is an open table",
  failureMode:
    `SILENT and permanent. ${table} holds ${holds}. It is empty today, so nothing is exposed ` +
    "yet — the exposure begins with the first row written, and no surface degrades to announce " +
    "it. Only db:audit:rls or this audit will ever say so",
}));

/**
 * The apply-before-deploy set.
 *
 * `unresolved_phrase_scope_uq` is listed as its own requirement rather than being folded into
 * the column check, because the two fail differently and only one of them is loud. Without the
 * COLUMN, the INSERT throws. With the column but the OLD four-column index, every INSERT
 * SUCCEEDS — and two canonical misses of the same phrase in different job domains silently
 * merge into one row with a summed count. That is the failure the widening exists to prevent,
 * and it leaves no error anywhere.
 */
export const SCHEMA_REQUIREMENTS: readonly SchemaRequirement[] = [
  {
    id: "0078-column",
    migration: "0078_unresolved_phrase_job_domain_id",
    kind: "column",
    table: "unresolved_phrase",
    object: "job_domain_id",
    requiredBy: "SkillsRepository.recordUnresolved — named in the INSERT column list and the ON CONFLICT target, unconditionally",
    failureMode:
      "every unresolved write throws. POST /skills/unresolved and POST /occupation/unresolved return 500; the interview path catches and logs, so canonical growth signal is lost SILENTLY",
  },
  {
    id: "0078-unique-index",
    migration: "0078_unresolved_phrase_job_domain_id",
    kind: "index",
    table: "unresolved_phrase",
    object: "unresolved_phrase_scope_uq",
    requiredBy: "SkillsRepository.recordUnresolved — ON CONFLICT (scope, phrase, domain_id, job_domain_id, lang)",
    failureMode:
      "with the old 4-column index the ON CONFLICT target does not match any index and the INSERT throws; if it were widened WITHOUT NULLS NOT DISTINCT, occupation-scope rows would stop deduping instead",
  },
  {
    id: "0078-check",
    migration: "0078_unresolved_phrase_job_domain_id",
    kind: "constraint",
    table: "unresolved_phrase",
    object: "unresolved_phrase_one_domain_chk",
    requiredBy: "the at-most-one-vocabulary invariant; the repository also refuses pre-DB, so this is defence in depth",
    failureMode:
      "a row carrying BOTH domain_id and job_domain_id becomes storable. Nothing throws; the row is simply meaningless to both retrieval paths",
  },
  {
    id: "0080-worker-feedback-table",
    migration: "0080_worker_feedback",
    kind: "table",
    table: "worker_feedback",
    requiredBy:
      "FeedbackRepository.insert on POST /workers/me/feedback, and AdminFeedbackRepository.list " +
      "on GET /admin/feedback — both name the table unconditionally, neither is behind a flag",
    failureMode:
      "every worker feedback submission 500s and the typed message is lost with the response; the admin Feedback screen 500s on first page load. LOUD on both surfaces, unlike 0078",
  },
  {
    id: "0080-worker-feedback-rls",
    migration: "0080_worker_feedback",
    kind: "rls",
    table: "worker_feedback",
    requiredBy:
      "the RLS tail is HAND-APPENDED in the migration — drizzle-kit models ENABLE and neither " +
      "FORCE nor the four REVOKEs — so it is exactly the part a hand-run apply or a regenerate " +
      "drops, and nothing in ordinary CI notices: tests/e2e/rls-spine.e2e.test.ts is skipIf-gated",
    failureMode:
      "SILENT, and the worst kind on this table: `worker_feedback.message` is the one column on " +
      "the spine deliberately allowed to hold a worker's own free-text PII. Without FORCE the " +
      "owner — the only connection the backend uses — bypasses every policy, and without the " +
      "REVOKEs every PostgREST role can read it. Both surfaces keep working, so nothing reports it",
  },
  {
    id: "0081-screen-context-column",
    migration: "0081_worker_feedback_screen_context",
    kind: "column",
    table: "worker_feedback",
    object: "screen_context",
    requiredBy:
      "FeedbackRepository.insert (the drizzle model's full column list, on POST /workers/me/feedback) " +
      "and AdminFeedbackRepository.list (an explicit SELECT column on GET /admin/feedback) — " +
      "neither is behind a flag",
    failureMode:
      "identical to the 0080 table entry and for the same reason — both surfaces 500. Listed SEPARATELY because the table can be present while the column is not, which is exactly the state a deploy that skips this migration produces",
  },
  {
    id: "0083-ai-call-traces-table",
    migration: "0083_ai_call_traces",
    kind: "table",
    table: "ai_call_traces",
    requiredBy:
      "AdminAiTracesRepository.list + .byId on GET /admin/ai-traces — named unconditionally in " +
      "the SELECT. AiTraceRecorder names it too, on every AI call, but that write is deliberately " +
      "OUTSIDE the caller's transaction inside its own catch, so it is NOT what puts this entry here",
    failureMode:
      "SPLIT, and that is why it is worth listing rather than assuming. The WRITE fails soft: " +
      "every AI call still succeeds and every trace is silently dropped (counted, and logged once " +
      "per process) — the 0078 shape exactly, a signal that stops being collected with nothing on " +
      "fire. The READ is the loud half: GET /admin/ai-traces 500s on first page load. Neither " +
      "half degrades in a way that names the missing table, which is the whole reason to be able " +
      "to ASK",
  },
  {
    id: "0083-ai-call-traces-rls",
    migration: "0083_ai_call_traces",
    kind: "rls",
    table: "ai_call_traces",
    requiredBy:
      "no code path — the FORCE + four REVOKEs are HAND-APPENDED to the migration (drizzle-kit " +
      "models ENABLE and nothing else), so they are exactly the part a hand-run apply or a " +
      "regenerate drops, and nothing in ordinary CI notices: tests/e2e/rls-spine.e2e.test.ts is " +
      "skipIf-gated. Same exception the 0080 RLS entry already makes to this manifest's usual bar",
    failureMode:
      "SILENT, and the worst instance of it on this spine. This table holds the prompt and the " +
      "completion of EVERY AI call for EVERY worker — `worker_feedback` is one worker's paragraph " +
      "by comparison. The ciphertext CHECK still holds without RLS, so a reader gets tokens rather " +
      "than prose; what a lost lock hands over is the LINKAGE (which worker, which session, which " +
      "task, when, how long) across the entire worker base, to every PostgREST role. Without FORCE " +
      "the owner — the only connection the backend uses — bypasses every policy. Both surfaces " +
      "keep working, so nothing reports it",
  },
  ...R39_RLS_REQUIREMENTS,
] as const;

/** What the live database actually has, keyed by requirement id. */
export type PresenceMap = Readonly<Record<string, boolean>>;

/** The Data-API roles a spine table must never grant to. The owner is handled by FORCE. */
export const DATA_API_ROLES = ["anon", "authenticated", "service_role", "PUBLIC"] as const;

/**
 * Is this table actually locked?
 *
 * THREE CONDITIONS, ALL REQUIRED, and the reason the middle one is not redundant: `ENABLE ROW
 * LEVEL SECURITY` alone is decorative here, because the table OWNER bypasses every policy and
 * the owner is the only connection the backend uses. `FORCE` is what makes the lock apply to
 * the one role that matters. The REVOKEs then handle the roles that never see a policy at all.
 *
 * Case-insensitive on the role name because `PUBLIC` is spelled that way in DDL and lowercased
 * in the catalog — matching only one spelling would let the broadest grant of all through.
 */
export function rlsLocked(state: {
  enabled: boolean;
  forced: boolean;
  grantedRoles: readonly string[];
}): boolean {
  if (!state.enabled || !state.forced) return false;
  const granted = new Set(state.grantedRoles.map((r) => r.toLowerCase()));
  return !DATA_API_ROLES.some((r) => granted.has(r.toLowerCase()));
}

export interface ContractResult {
  readonly requirement: SchemaRequirement;
  readonly present: boolean;
}

/** Join the manifest against observed presence. Pure, so the reporting logic is testable. */
export function evaluateContract(
  requirements: readonly SchemaRequirement[],
  presence: PresenceMap,
): ContractResult[] {
  return requirements.map((requirement) => ({ requirement, present: presence[requirement.id] === true }));
}

/**
 * The single sentence a deploy gate would read. `null` = the database is ready.
 *
 * Deliberately names the MIGRATIONS rather than the objects: an operator's next action is
 * `pnpm --filter @badabhai/db db:migrate`, not `ALTER TABLE`.
 */
export function contractBlockReason(results: readonly ContractResult[]): string | null {
  const missing = results.filter((r) => !r.present);
  if (missing.length === 0) return null;
  const migrations = [...new Set(missing.map((m) => m.requirement.migration))].sort();
  return (
    `${missing.length} required object(s) missing, from migration(s) ${migrations.join(", ")}. ` +
    `The deployed code names them unconditionally — apply before the code reaches the box.`
  );
}

/**
 * ===========================================================================
 * THE SECOND QUESTION: can the remedy actually run?
 * ===========================================================================
 * `contractBlockReason` above tells an operator to run `db:migrate`. On 2026-08-19 that
 * instruction was WRONG on production, and wrong in the direction that wastes a maintenance
 * window: `worker_feedback` was missing, the operator ran the migrate, and 0080 never applied
 * — because `drizzle-kit migrate` replays every journal entry the database has not recorded,
 * IN ORDER, and the four before it (0076-0079) were unrecorded-but-already-live. It reached
 * `CREATE TABLE "job_domain"`, died on "already exists", and rolled back before 0080.
 *
 * ===========================================================================
 * WHAT THE MIGRATOR ACTUALLY BRANCHES ON — corrected 2026-08-20
 * ===========================================================================
 * The paragraph above says "replays every journal entry the database has not recorded". That is
 * what the OUTCOME looked like, and it is not the rule. Read from the installed
 * `drizzle-orm@0.45.2` (`pg-core/dialect.js`; `drizzle-kit migrate` delegates to it):
 *
 *     select id, hash, created_at from drizzle.__drizzle_migrations
 *       order by created_at desc limit 1          <-- ONE row. A WATERMARK.
 *     for (const m of migrations)
 *       if (!last || Number(last.created_at) < m.folderMillis) { ...apply...; ...insert... }
 *
 * A HIGH-WATER MARK, not set membership. Every journal entry whose `when` exceeds the newest
 * recorded `created_at` is applied; everything at or below it is skipped, recorded or not. On
 * 2026-08-19 the two models agreed by coincidence — the watermark sat at 0075, so "unrecorded"
 * and "above the watermark" named the same five files — and that coincidence is exactly why the
 * wrong rule looked confirmed by the incident.
 *
 * They stopped agreeing on 2026-08-20, when `0081_worker_feedback_screen_context` was applied
 * out of band and moved the watermark past 0076-0080. Under the old model this file reports
 * `db:migrate` UNSAFE and demands an adoption first; under the real rule those five are simply
 * skipped and the next migration applies cleanly. Same database, opposite instruction.
 *
 * The correction matters more in the other direction, and there it is dangerous rather than
 * merely wasteful: a genuinely-pending migration whose `when` is BELOW the watermark is skipped
 * SILENTLY. `db:migrate` exits 0, writes nothing, and the objects never arrive — the shape of
 * the 0078 incident with the one alarm that eventually caught it removed. Minting a migration
 * stamps `when` from the current clock, so this needs an out-of-order apply or a hand-pinned
 * `when`. Both have happened here.
 *
 * So: HASH MEMBERSHIP answers "is the journal honest?" and the WATERMARK answers "what will the
 * next `db:migrate` actually do?". Different questions; this reports both.
 *
 * This function deliberately does NOT decide whether an unrecorded migration is live or
 * genuinely pending. It cannot: the manifest covers only apply-before-deploy objects, so
 * silence about a migration is not evidence about it. `reconcile-migrations.ts` answers that
 * question at depth and `adopt-migrations.ts` acts on it.
 */
export interface JournalEntry {
  /** The migration filename stem, e.g. `0080_worker_feedback`. */
  readonly tag: string;
  /** sha256 of the file's contents — one of the two columns `drizzle.__drizzle_migrations` holds. */
  readonly hash: string;
  /** The journal's `when`, stored as `created_at`. THE VALUE THE MIGRATOR COMPARES. */
  readonly when: number;
}

/** What the database has recorded, in the two forms the two questions need. */
export interface RecordedState {
  /** Every `hash` in `drizzle.__drizzle_migrations`. Answers "is the journal honest?". */
  readonly hashes: ReadonlySet<string>;
  /** `max(created_at)`, or null when the table is absent or empty. Answers "what runs next?". */
  readonly watermark: number | null;
}

export interface MigrationDrift {
  /** Journal entries with no row in the database, in journal order. Journal honesty. */
  readonly unrecorded: readonly string[];
  /** The contract observed these migrations' objects missing — genuinely pending. */
  readonly pending: readonly string[];
  /** `when` > watermark: exactly what the next `db:migrate` will execute, in order. */
  readonly willReplay: readonly string[];
  /** Unrecorded and at or below the watermark: skipped, silently, and never recorded. */
  readonly willSkip: readonly string[];
  /** Will be replayed and is NOT known-missing — the "already exists" abort risk. */
  readonly replayCollides: readonly string[];
  /** Will be SKIPPED and IS known-missing. The dangerous one: db:migrate cannot fix it. */
  readonly silentlySkipped: readonly string[];
  /** True when `db:migrate` alone both reaches the pending set and does not abort. */
  readonly migrateAloneIsSafe: boolean;
}

export function migrationDrift(
  journal: readonly JournalEntry[],
  recorded: RecordedState,
  missingMigrations: readonly string[],
): MigrationDrift {
  const missing = new Set(missingMigrations);
  const { hashes, watermark } = recorded;

  const unrecorded = journal.filter((e) => !hashes.has(e.hash)).map((e) => e.tag);
  const pending = journal.filter((e) => missing.has(e.tag)).map((e) => e.tag);

  // Drizzle's rule, verbatim: `!last || Number(last.created_at) < m.folderMillis`.
  const above = (e: JournalEntry): boolean => watermark === null || e.when > watermark;
  const willReplay = journal.filter(above).map((e) => e.tag);
  const willSkip = journal.filter((e) => !above(e) && !hashes.has(e.hash)).map((e) => e.tag);

  // A replay only MATTERS when something pending sits behind it. `db:migrate` aborts the whole
  // transaction on "already exists", so a not-known-missing file stops everything after it —
  // but if nothing after it is pending, the abort costs nothing and calling that unsafe is
  // crying wolf on every ordinary new migration.
  const replayCollides = willReplay.filter(
    (t, i) => !missing.has(t) && willReplay.slice(i + 1).some((later) => missing.has(later)),
  );
  const silentlySkipped = willSkip.filter((t) => missing.has(t));

  return {
    unrecorded,
    pending,
    willReplay,
    willSkip,
    replayCollides,
    silentlySkipped,
    migrateAloneIsSafe: replayCollides.length === 0 && silentlySkipped.length === 0,
  };
}

/**
 * The operator's next commands, in order. Returned as lines rather than printed so the
 * decision is testable and the runner stays a reporter.
 *
 * A NOTE ON THE `--expect-host` LINE: `adopt-migrations.ts` requires it alongside `--apply`
 * precisely because adoption records DDL as done WITHOUT running it, so pointing it at the
 * wrong environment writes a lie into that environment's journal and every later migration
 * inherits it. Left as a placeholder here on purpose — this file must not guess a host.
 */
export function driftRemedy(drift: MigrationDrift): string[] {
  if (drift.unrecorded.length === 0) return [];

  // WORST FIRST. A silently-skipped pending migration is the only state `db:migrate` cannot
  // reach at all, and it is the only one that reports success while doing nothing — so it must
  // never sit underneath a command an operator could run instead of reading it.
  if (drift.silentlySkipped.length > 0) {
    return [
      "db:migrate CANNOT APPLY THESE AND WILL NOT SAY SO. drizzle skips every journal entry at",
      "or below the newest recorded created_at, so these sit under the watermark and are passed",
      "over in silence — the command exits 0 and the objects never arrive:",
      ...drift.silentlySkipped.map((t) => `    ${t}`),
      "",
      "This is out-of-order history: something with a LATER `when` was applied first. Neither",
      "migrate nor adopt fixes it — adoption would record them as done while they are missing.",
      "Apply their SQL by hand against this database, then adopt to record it:",
      "",
      `  psql "$DATABASE_URL" -1 -f packages/db/migrations/${drift.silentlySkipped[0]}.sql`,
      `  npx tsx adopt-migrations.ts --only ${drift.silentlySkipped.join(",")}`,
      "  npx tsx adopt-migrations.ts --only <the same list> --apply --expect-host <host substring>",
      "  pnpm --filter @badabhai/db db:audit:schema-contract   # expect READY",
    ];
  }

  if (drift.replayCollides.length > 0) {
    return [
      "db:migrate ALONE WILL NOT REACH THE PENDING MIGRATION(S). Everything above the watermark",
      `is replayed in order, so it re-runs ${drift.replayCollides[0]} first and aborts on`,
      '"already exists" if that migration is in fact live. Classify, adopt, then migrate:',
      "",
      "  npx tsx reconcile-migrations.ts        # per file: RECORDED / LIVE / ABSENT / PARTIAL",
      `  npx tsx adopt-migrations.ts --only ${drift.replayCollides.join(",")}`,
      "  npx tsx adopt-migrations.ts --only <the LIVE ones> --apply --expect-host <host substring>",
      "  pnpm --filter @badabhai/db db:migrate",
      "  pnpm --filter @badabhai/db db:audit:schema-contract   # expect READY",
    ];
  }

  const lines = ["pnpm --filter @badabhai/db db:migrate   (against THIS database)"];
  if (drift.willSkip.length > 0) {
    // Not a blocker and not nothing. These are already live, so skipping them is harmless
    // TODAY — but the journal stays a false record of what this database has, and the next
    // person to read it is owed the truth rather than a silence that happens to be survivable.
    lines.push(
      "",
      `then, hygiene: ${drift.willSkip.length} live file(s) sit below the watermark and will be`,
      "skipped forever, leaving the journal a false record of this database:",
      ...drift.willSkip.map((t) => `    ${t}`),
      `  npx tsx adopt-migrations.ts --only ${drift.willSkip.join(",")}`,
      "  npx tsx adopt-migrations.ts --only <the same list> --apply --expect-host <host substring>",
    );
  }
  return lines;
}

/**
 * The unique index must be present AND have the widened column list; an index of the right
 * name and the wrong shape is the more dangerous state, because `ON CONFLICT` fails loudly on
 * a mismatch but a silently-narrow key merges rows.
 */
export function uniqueIndexMatches(indexdef: string | null): boolean {
  if (indexdef === null) return false;
  const cols = /\(([^)]*)\)/.exec(indexdef)?.[1] ?? "";
  const wanted = ["scope", "phrase", "domain_id", "job_domain_id", "lang"];
  const got = cols.split(",").map((c) => c.trim());
  return wanted.every((w) => got.includes(w)) && /NULLS NOT DISTINCT/i.test(indexdef);
}
