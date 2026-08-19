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
  migrationDrift,
  uniqueIndexMatches,
  type JournalEntry,
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

  it("column and index/constraint entries carry an object name", () => {
    for (const r of SCHEMA_REQUIREMENTS) {
      if (r.kind !== "table") expect(r.object, r.id).toBeTruthy();
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
 * THE SECOND QUESTION — can the remedy actually run?
 *
 * This block exists because of a real wasted production attempt on 2026-08-19: the audit
 * correctly reported `worker_feedback` missing and told the operator to run `db:migrate`,
 * which could not possibly reach 0080 because four unrecorded-but-live files sat in front
 * of it. Every assertion below is about that ordering, not about counting rows.
 */
const entry = (tag: string, hash: string): JournalEntry => ({ tag, hash });

// The shape production was actually in: recorded through 0075; 0076-0079 live but unrecorded;
// 0080 unrecorded AND absent.
const PROD_JOURNAL = [
  entry("0075_job_postings_state", "h75"),
  entry("0076_canonical_domain_skill_taxonomy", "h76"),
  entry("0077_ai_cost_running_totals", "h77"),
  entry("0078_unresolved_phrase_job_domain_id", "h78"),
  entry("0079_journey_read_indexes", "h79"),
  entry("0080_worker_feedback", "h80"),
];

describe("migrationDrift — the journal, not its row count", () => {
  it("separates genuinely-pending from unrecorded-but-not-known-missing", () => {
    const d = migrationDrift(PROD_JOURNAL, new Set(["h75"]), ["0080_worker_feedback"]);
    expect(d.pending).toEqual(["0080_worker_feedback"]);
    expect(d.unclassified).toEqual([
      "0076_canonical_domain_skill_taxonomy",
      "0077_ai_cost_running_totals",
      "0078_unresolved_phrase_job_domain_id",
      "0079_journey_read_indexes",
    ]);
  });

  it("calls db:migrate UNSAFE when anything unclassified precedes the pending file", () => {
    // The whole point. drizzle replays in order, so the FIRST unrecorded file decides the
    // outcome — and if its DDL is already live the run aborts before the one that matters.
    expect(migrationDrift(PROD_JOURNAL, new Set(["h75"]), ["0080_worker_feedback"]).migrateAloneIsSafe).toBe(
      false,
    );
  });

  it("calls db:migrate SAFE when the only unrecorded file is the pending one", () => {
    const recorded = new Set(["h75", "h76", "h77", "h78", "h79"]);
    const d = migrationDrift(PROD_JOURNAL, recorded, ["0080_worker_feedback"]);
    expect(d.unclassified).toEqual([]);
    expect(d.migrateAloneIsSafe).toBe(true);
  });

  it("preserves journal ORDER rather than sorting, because replay order is the mechanism", () => {
    const shuffled = [entry("b", "hb"), entry("a", "ha")];
    expect(migrationDrift(shuffled, new Set(), []).unrecorded).toEqual(["b", "a"]);
  });

  it("reports a fully-recorded journal as no drift at all", () => {
    const d = migrationDrift(PROD_JOURNAL, new Set(["h75", "h76", "h77", "h78", "h79", "h80"]), []);
    expect(d.unrecorded).toEqual([]);
    expect(d.migrateAloneIsSafe).toBe(true);
  });

  it("treats a database with NO journal table as everything-unrecorded, not as ready", () => {
    // A never-migrated database is a legitimate audit target; failing open here would report
    // the emptiest possible database as having no drift.
    const d = migrationDrift(PROD_JOURNAL, new Set(), ["0080_worker_feedback"]);
    expect(d.unrecorded).toHaveLength(PROD_JOURNAL.length);
    expect(d.migrateAloneIsSafe).toBe(false);
  });

  it("does not claim an unclassified migration is live — only that it will be replayed", () => {
    // The manifest covers apply-before-deploy objects only, so silence about a migration is
    // not evidence about it. Anything stronger belongs to reconcile-migrations.ts.
    const lines = driftRemedy(migrationDrift(PROD_JOURNAL, new Set(["h75"]), ["0080_worker_feedback"])).join(
      "\n",
    );
    expect(lines).toContain("reconcile-migrations.ts");
    expect(lines).not.toMatch(/\bis live\b/);
  });
});

describe("driftRemedy — the commands, in order", () => {
  it("is the plain migrate when nothing blocks it", () => {
    const d = migrationDrift(PROD_JOURNAL, new Set(["h75", "h76", "h77", "h78", "h79"]), [
      "0080_worker_feedback",
    ]);
    expect(driftRemedy(d)).toEqual(["pnpm --filter @badabhai/db db:migrate   (against THIS database)"]);
  });

  it("is classify -> adopt -> migrate -> re-audit when the journal is behind", () => {
    const lines = driftRemedy(migrationDrift(PROD_JOURNAL, new Set(["h75"]), ["0080_worker_feedback"]));
    const joined = lines.join("\n");
    expect(joined).toContain("reconcile-migrations.ts");
    expect(joined).toContain("adopt-migrations.ts");
    expect(joined).toContain("db:migrate");
    // The re-audit is the last step, not the first: "apply it" is not "it applied".
    expect(lines[lines.length - 1]).toContain("db:audit:schema-contract");
  });

  it("never emits a --apply without an --expect-host beside it", () => {
    // Adoption records DDL as done WITHOUT running it, so the wrong target writes a lie into
    // that database's journal and every later migration inherits it.
    for (const line of driftRemedy(migrationDrift(PROD_JOURNAL, new Set(["h75"]), ["0080_worker_feedback"]))) {
      if (line.includes("--apply")) expect(line).toContain("--expect-host");
    }
  });

  it("says nothing at all when the journal is clean", () => {
    expect(driftRemedy(migrationDrift(PROD_JOURNAL, new Set(["h75", "h76", "h77", "h78", "h79", "h80"]), []))).toEqual(
      [],
    );
  });
});
