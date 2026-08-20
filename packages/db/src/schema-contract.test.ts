/**
 * The manifest and its evaluation.
 *
 * These are cheap tests for a check whose whole value is being trustworthy when someone runs it
 * against production at 2am. The one that matters most is `uniqueIndexMatches`: an index of the
 * right NAME and the wrong SHAPE is the state that fails quietly, so an existence check would
 * have reported "OK" for precisely the case worth catching.
 */
import { describe, expect, it } from "vitest";

import {
  SCHEMA_REQUIREMENTS,
  contractBlockReason,
  driftRemedy,
  evaluateContract,
  DATA_API_ROLES,
  migrationDrift,
  rlsLocked,
  uniqueIndexMatches,
  type JournalEntry,
  type RecordedState,
} from "./schema-contract";

const allPresent = Object.fromEntries(SCHEMA_REQUIREMENTS.map((r) => [r.id, true]));

describe("SCHEMA_REQUIREMENTS — the manifest itself", () => {
  it("has a unique id per entry", () => {
    const ids = SCHEMA_REQUIREMENTS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry names the code that breaks and how the break presents", () => {
    // An entry without these is unactionable: an operator reading MISSING needs to know
    // whether they are looking at a 500 or at silent data loss, because those get different
    // responses at different hours.
    for (const r of SCHEMA_REQUIREMENTS) {
      expect(r.requiredBy.length, r.id).toBeGreaterThan(20);
      expect(r.failureMode.length, r.id).toBeGreaterThan(20);
      expect(r.migration, r.id).toMatch(/^\d{4}_/);
    }
  });

  it("column and index/constraint entries carry an object name; table and rls ones do not", () => {
    // `object` names a thing INSIDE the table. `table` and `rls` are both properties OF the
    // table, so requiring a name there would mean inventing one — and an invented name in a
    // manifest is a probe that silently checks the wrong thing.
    const wholeTable = new Set(["table", "rls"]);
    for (const r of SCHEMA_REQUIREMENTS) {
      if (wholeTable.has(r.kind)) expect(r.object, r.id).toBeUndefined();
      else expect(r.object, r.id).toBeTruthy();
    }
  });
});

describe("evaluateContract / contractBlockReason", () => {
  it("is silent when everything is present", () => {
    expect(contractBlockReason(evaluateContract(SCHEMA_REQUIREMENTS, allPresent))).toBeNull();
  });

  it("treats an ABSENT key as missing, not as unknown", () => {
    // The probe writes a key per requirement; a typo or an added requirement with no probe
    // branch would leave the key undefined. Defaulting that to "present" would make a new
    // requirement silently vacuous — the failure this whole file exists to avoid.
    const r = evaluateContract(SCHEMA_REQUIREMENTS, {});
    expect(r.every((x) => !x.present)).toBe(true);
    expect(contractBlockReason(r)).toMatch(/missing/);
  });

  it("names the migration, not the objects — that is the operator's next command", () => {
    const reason = contractBlockReason(evaluateContract(SCHEMA_REQUIREMENTS, {}));
    expect(reason).toContain("0078_unresolved_phrase_job_domain_id");
  });

  it("deduplicates migrations when several objects come from one", () => {
    const reason = contractBlockReason(evaluateContract(SCHEMA_REQUIREMENTS, {})) ?? "";
    const hits = reason.match(/0078_unresolved_phrase_job_domain_id/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it("reports a partial state as blocked", () => {
    const partial = { ...allPresent, "0078-check": false };
    expect(contractBlockReason(evaluateContract(SCHEMA_REQUIREMENTS, partial))).toMatch(/1 required object/);
  });
});

describe("uniqueIndexMatches — shape, not existence", () => {
  const WIDE =
    "CREATE UNIQUE INDEX unresolved_phrase_scope_uq ON public.unresolved_phrase " +
    "USING btree (scope, phrase, domain_id, job_domain_id, lang) NULLS NOT DISTINCT";

  it("accepts the widened index", () => {
    expect(uniqueIndexMatches(WIDE)).toBe(true);
  });

  it("rejects the OLD four-column index of the same name", () => {
    // This is the production state found on 2026-08-19. An `EXISTS` probe reports it as fine.
    expect(
      uniqueIndexMatches(
        "CREATE UNIQUE INDEX unresolved_phrase_scope_uq ON public.unresolved_phrase " +
          "USING btree (scope, phrase, domain_id, lang) NULLS NOT DISTINCT",
      ),
    ).toBe(false);
  });

  it("rejects a widened index that lost NULLS NOT DISTINCT", () => {
    // drizzle omits this clause on INDEXes every single time — 0037, 0067, 0072, 0076, 0078.
    // Without it the occupation scope, which writes domain_id NULL, stops deduping and the
    // table grows one row per occurrence instead of one row with a count.
    expect(uniqueIndexMatches(WIDE.replace(" NULLS NOT DISTINCT", ""))).toBe(false);
  });

  it("rejects a missing index", () => {
    expect(uniqueIndexMatches(null)).toBe(false);
  });

  it("is insensitive to column order but not to column membership", () => {
    expect(uniqueIndexMatches(WIDE.replace("scope, phrase", "phrase, scope"))).toBe(true);
    expect(uniqueIndexMatches(WIDE.replace(", lang)", ")"))).toBe(false);
  });
});

/**
 * THE SECOND QUESTION — what will `db:migrate` actually do?
 *
 * This block exists because of a real wasted production attempt on 2026-08-19: the audit
 * correctly reported `worker_feedback` missing and told the operator to run `db:migrate`, which
 * could not possibly reach 0080.
 *
 * It was then REWRITTEN on 2026-08-20, because the rule the first version encoded was wrong.
 * Drizzle does not compare per-file membership; it takes `max(created_at)` as a WATERMARK and
 * applies everything above it. The two models happened to agree on 2026-08-19 — the watermark
 * sat at 0075, so "unrecorded" and "above the watermark" named the same files — and the
 * coincidence made the wrong rule look confirmed by the incident it was written for. They came
 * apart the moment a migration was applied out of band. The three cases below are the three
 * distinct answers, and only one of them existed in the first version.
 */
const entry = (tag: string, hash: string, when: number): JournalEntry => ({ tag, hash, when });
const recorded = (hashes: string[], watermark: number | null): RecordedState => ({
  hashes: new Set(hashes),
  watermark,
});

// The shape production was in on 2026-08-19: recorded through 0075; 0076-0079 live but
// unrecorded; 0080 unrecorded AND absent. `when` values are the real ones from _journal.json.
const PROD_JOURNAL = [
  entry("0075_job_postings_state", "h75", 1786780800000),
  entry("0076_canonical_domain_skill_taxonomy", "h76", 1786873547157),
  entry("0077_ai_cost_running_totals", "h77", 1787052403952),
  entry("0078_unresolved_phrase_job_domain_id", "h78", 1787061158602),
  entry("0079_journey_read_indexes", "h79", 1787119704131),
  entry("0080_worker_feedback", "h80", 1787133816492),
];
const AT_0075 = recorded(["h75"], 1786780800000);

describe("migrationDrift — the watermark, not the row count and not set membership", () => {
  it("reports what drizzle will replay: everything above the watermark, in journal order", () => {
    const d = migrationDrift(PROD_JOURNAL, AT_0075, ["0080_worker_feedback"]);
    expect(d.willReplay).toEqual([
      "0076_canonical_domain_skill_taxonomy",
      "0077_ai_cost_running_totals",
      "0078_unresolved_phrase_job_domain_id",
      "0079_journey_read_indexes",
      "0080_worker_feedback",
    ]);
    expect(d.willSkip).toEqual([]);
  });

  it("calls db:migrate UNSAFE when a not-known-missing file is replayed before the pending one", () => {
    // The 2026-08-19 state. drizzle replays in order, so the FIRST file above the watermark
    // decides the outcome — and if its DDL is already live the run aborts before 0080.
    const d = migrationDrift(PROD_JOURNAL, AT_0075, ["0080_worker_feedback"]);
    expect(d.replayCollides[0]).toBe("0076_canonical_domain_skill_taxonomy");
    expect(d.migrateAloneIsSafe).toBe(false);
  });

  it("calls db:migrate SAFE once the four live files are recorded", () => {
    const d = migrationDrift(
      PROD_JOURNAL,
      recorded(["h75", "h76", "h77", "h78", "h79"], 1787119704131),
      ["0080_worker_feedback"],
    );
    expect(d.willReplay).toEqual(["0080_worker_feedback"]);
    expect(d.replayCollides).toEqual([]);
    expect(d.migrateAloneIsSafe).toBe(true);
  });

  it("THE OUT-OF-ORDER CASE: a later migration applied first strands the ones beneath it", () => {
    // What actually happened on 2026-08-20 — 0081 was applied out of band, taking the
    // watermark past all five unrecorded files. They are now skipped rather than replayed, so
    // the naive "adopt first" instruction became wrong. Live files, so nothing is broken.
    const withNewer = [...PROD_JOURNAL, entry("0081_worker_feedback_screen_context", "h81", 1787141865609)];
    const d = migrationDrift(withNewer, recorded(["h75", "h81"], 1787141865609), []);
    expect(d.willReplay).toEqual([]);
    expect(d.willSkip).toEqual([
      "0076_canonical_domain_skill_taxonomy",
      "0077_ai_cost_running_totals",
      "0078_unresolved_phrase_job_domain_id",
      "0079_journey_read_indexes",
      "0080_worker_feedback",
    ]);
    expect(d.migrateAloneIsSafe).toBe(true);
  });

  it("THE DANGEROUS CASE: a genuinely-missing file below the watermark is skipped SILENTLY", () => {
    // Same shape as above, except 0080's objects are absent. `db:migrate` exits 0, writes
    // nothing, and the table never arrives — the 0078 incident with its alarm removed. Nothing
    // in the old model could express this state at all.
    const withNewer = [...PROD_JOURNAL, entry("0081_worker_feedback_screen_context", "h81", 1787141865609)];
    const d = migrationDrift(withNewer, recorded(["h75", "h81"], 1787141865609), ["0080_worker_feedback"]);
    expect(d.silentlySkipped).toEqual(["0080_worker_feedback"]);
    expect(d.migrateAloneIsSafe).toBe(false);
  });

  it("preserves journal ORDER rather than sorting, because replay order is the mechanism", () => {
    const shuffled = [entry("b", "hb", 2), entry("a", "ha", 1)];
    expect(migrationDrift(shuffled, recorded([], null), []).unrecorded).toEqual(["b", "a"]);
  });

  it("reports a fully-recorded journal as no drift at all", () => {
    const d = migrationDrift(PROD_JOURNAL, recorded(["h75", "h76", "h77", "h78", "h79", "h80"], 1787133816492), []);
    expect(d.unrecorded).toEqual([]);
    expect(d.willSkip).toEqual([]);
    expect(d.migrateAloneIsSafe).toBe(true);
  });

  it("treats a database with NO journal table as everything-above-the-watermark, not as ready", () => {
    // A never-migrated database is a legitimate audit target. `watermark: null` is drizzle's
    // `!lastDbMigration` branch, which applies the whole journal.
    const d = migrationDrift(PROD_JOURNAL, recorded([], null), ["0080_worker_feedback"]);
    expect(d.unrecorded).toHaveLength(PROD_JOURNAL.length);
    expect(d.willReplay).toHaveLength(PROD_JOURNAL.length);
    expect(d.migrateAloneIsSafe).toBe(false);
  });

  it("does not claim a replayed migration is live — only that it will be replayed", () => {
    // The manifest covers apply-before-deploy objects only, so silence about a migration is
    // not evidence about it. Anything stronger belongs to reconcile-migrations.ts.
    const lines = driftRemedy(migrationDrift(PROD_JOURNAL, AT_0075, ["0080_worker_feedback"])).join("\n");
    expect(lines).toContain("reconcile-migrations.ts");
    expect(lines).not.toMatch(/\bis live\b/);
  });
});

describe("driftRemedy — a different instruction per state", () => {
  it("is the plain migrate when nothing blocks it and nothing is stranded", () => {
    const d = migrationDrift(
      PROD_JOURNAL,
      recorded(["h75", "h76", "h77", "h78", "h79"], 1787119704131),
      ["0080_worker_feedback"],
    );
    expect(driftRemedy(d)).toEqual(["pnpm --filter @badabhai/db db:migrate   (against THIS database)"]);
  });

  it("is classify -> adopt -> migrate -> re-audit when a live file is about to be replayed", () => {
    const lines = driftRemedy(migrationDrift(PROD_JOURNAL, AT_0075, ["0080_worker_feedback"]));
    const joined = lines.join("\n");
    expect(joined).toContain("reconcile-migrations.ts");
    expect(joined).toContain("adopt-migrations.ts");
    expect(joined).toContain("db:migrate");
    // The re-audit is the last step, not the first: "apply it" is not "it applied".
    expect(lines[lines.length - 1]).toContain("db:audit:schema-contract");
  });

  it("leads with the silent-skip case, and does NOT offer db:migrate for it", () => {
    // The one state where running the obvious command produces a green result and no change.
    // Putting it under a runnable command would be the worst possible ordering.
    const withNewer = [...PROD_JOURNAL, entry("0081_worker_feedback_screen_context", "h81", 1787141865609)];
    const lines = driftRemedy(
      migrationDrift(withNewer, recorded(["h75", "h81"], 1787141865609), ["0080_worker_feedback"]),
    );
    expect(lines[0]).toContain("CANNOT APPLY THESE AND WILL NOT SAY SO");
    expect(lines.join("\n")).not.toContain("pnpm --filter @badabhai/db db:migrate\n");
  });

  it("adds the hygiene adopt when live files are stranded below the watermark", () => {
    const withNewer = [...PROD_JOURNAL, entry("0081_worker_feedback_screen_context", "h81", 1787141865609)];
    const lines = driftRemedy(migrationDrift(withNewer, recorded(["h75", "h81"], 1787141865609), []));
    expect(lines[0]).toContain("db:migrate");
    expect(lines.join("\n")).toContain("adopt-migrations.ts --only 0076_canonical_domain_skill_taxonomy");
  });

  it("never emits a --apply without an --expect-host beside it", () => {
    // Adoption records DDL as done WITHOUT running it, so the wrong target writes a lie into
    // that database's journal and every later migration inherits it.
    const states = [
      migrationDrift(PROD_JOURNAL, AT_0075, ["0080_worker_feedback"]),
      migrationDrift(PROD_JOURNAL, recorded(["h75", "h80"], 1787133816492), []),
      migrationDrift(PROD_JOURNAL, recorded(["h75", "h80"], 1787133816492), ["0078_unresolved_phrase_job_domain_id"]),
    ];
    for (const d of states) {
      for (const line of driftRemedy(d)) {
        if (line.includes("--apply")) expect(line).toContain("--expect-host");
      }
    }
  });

  it("says nothing at all when the journal is clean", () => {
    expect(
      driftRemedy(migrationDrift(PROD_JOURNAL, recorded(["h75", "h76", "h77", "h78", "h79", "h80"], 1787133816492), [])),
    ).toEqual([]);
  });
});

/**
 * RLS as a first-class requirement.
 *
 * Added because the one check that would have caught a dropped RLS tail —
 * `tests/e2e/rls-spine.e2e.test.ts` — is `describe.skipIf(!RUN)` and does not run in ordinary
 * CI. The tail is hand-appended in every migration that has one (drizzle models ENABLE and
 * neither FORCE nor the REVOKEs), so it is precisely what a hand-run apply loses, and on
 * `worker_feedback` the column at stake is the one place on the spine a worker's own free-text
 * PII is allowed to live.
 */
describe("rlsLocked — ENABLE alone is decorative", () => {
  const locked = { enabled: true, forced: true, grantedRoles: ["postgres"] };

  it("accepts a table that is enabled, forced, and grants only the owner", () => {
    expect(rlsLocked(locked)).toBe(true);
  });

  it("REJECTS enabled-but-not-forced, which is the state drizzle generates on its own", () => {
    // The owner bypasses every policy without FORCE, and the owner is the only connection the
    // backend uses — so this is the difference between a lock and a decoration.
    expect(rlsLocked({ ...locked, forced: false })).toBe(false);
  });

  it("rejects a table with RLS off entirely", () => {
    expect(rlsLocked({ ...locked, enabled: false })).toBe(false);
  });

  it.each(["anon", "authenticated", "service_role"])("rejects a grant to %s", (role) => {
    expect(rlsLocked({ ...locked, grantedRoles: ["postgres", role] })).toBe(false);
  });

  it("rejects a PUBLIC grant whatever its case", () => {
    // `PUBLIC` is spelled uppercase in DDL and lowercased in the catalog. Matching one spelling
    // would let the broadest grant of all through.
    expect(rlsLocked({ ...locked, grantedRoles: ["PUBLIC"] })).toBe(false);
    expect(rlsLocked({ ...locked, grantedRoles: ["public"] })).toBe(false);
  });

  it("tolerates an unknown role — only the Data-API roles are forbidden", () => {
    expect(rlsLocked({ ...locked, grantedRoles: ["postgres", "some_migration_role"] })).toBe(true);
  });

  it("DATA_API_ROLES names every role the REVOKE tail revokes", () => {
    // Drift guard: the migration revokes from PUBLIC, anon, authenticated and service_role. A
    // role dropped from this list is a hole the audit would then report as locked.
    expect([...DATA_API_ROLES].sort()).toEqual(["PUBLIC", "anon", "authenticated", "service_role"]);
  });
});

describe("the 0080 RLS requirement", () => {
  const rls = SCHEMA_REQUIREMENTS.find((r) => r.id === "0080-worker-feedback-rls");

  it("is in the manifest, as its own entry rather than folded into the table check", () => {
    // The two fail differently: without the TABLE both surfaces 500 loudly; without the LOCK
    // both surfaces work perfectly and free-text worker PII is readable by every PostgREST
    // role. Folding them together would let the loud failure mask the silent one.
    expect(rls).toBeDefined();
    expect(rls?.kind).toBe("rls");
  });

  it("says the failure is SILENT, because that is what makes it worth a manifest entry", () => {
    expect(rls?.failureMode).toMatch(/SILENT/);
  });
});

/**
 * R39 — the seven unlocked tables, and the three of them this manifest can speak for.
 *
 * The split is the interesting part and the easiest thing to get wrong later: four of the seven
 * exist on production and in no migration and no schema file, so listing them here would make a
 * correctly-migrated fresh database report MISSING. `db:audit:rls` covers those, because it
 * sweeps what is actually present instead of what someone remembered to enumerate.
 */
describe("the 0082 R39 requirements", () => {
  const r39 = SCHEMA_REQUIREMENTS.filter((r) => r.migration === "0082_rls_lock_seven_tables");

  it("covers exactly the three tables that exist in every environment", () => {
    expect(r39.map((r) => r.table).sort()).toEqual([
      "agency_kyc",
      "agency_payout_accruals",
      "agency_payout_requests",
    ]);
  });

  it("does NOT list the four unmodelled tables, which exist on production alone", () => {
    // Listing them would make this audit answer "not ready" for every database that is in fact
    // correct. They are GAP-DB-21's dead scaffolding and `db:audit:rls` is their authority.
    const unmodelled = ["agency_profiles", "employer_profiles", "payer_capabilities", "payer_member_invites"];
    expect(SCHEMA_REQUIREMENTS.filter((r) => unmodelled.includes(r.table))).toEqual([]);
  });

  it("is `rls`-kind and whole-table, like the 0080 entry", () => {
    for (const r of r39) {
      expect(r.kind).toBe("rls");
      expect(r.object).toBeUndefined();
    }
  });

  it("says the failure is SILENT, because no surface degrades when the lock is missing", () => {
    for (const r of r39) expect(r.failureMode).toMatch(/SILENT/);
  });

  it("names service_role's rolbypassrls as the reason the GRANT is the control", () => {
    // The whole finding. "RLS is on with zero policies" is a real denial for anon and
    // authenticated and no denial at all for service_role, so a reader who takes ENABLE as
    // sufficient would close this as a false positive.
    for (const r of r39) expect(r.requiredBy).toMatch(/rolbypassrls/);
  });

  it("records that the lock is empty-table latent rather than an active leak", () => {
    // Measured on production 2026-08-20: all seven hold 0 rows. Overstating this as a live
    // breach is how a P2 becomes an unplanned production change at midnight.
    for (const r of r39) expect(r.failureMode).toMatch(/empty today/);
  });

  it("keeps every entry's id unique against the rest of the manifest", () => {
    const ids = SCHEMA_REQUIREMENTS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
