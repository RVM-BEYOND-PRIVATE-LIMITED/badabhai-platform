import { describe, expect, it } from "vitest";

import {
  catalogEmptyFailure,
  curatedAliasFailureDetail,
  expectedCuratedAliases,
  missingCuratedAliases,
  type CuratedAlias,
} from "./verify-job-domains";

/**
 * Regression test for the "catalog is empty" deploy gate (Phase 1 acceptance criterion:
 * "`db:verify:domains` FAILs on an empty table (regression test for the inert check)").
 *
 * THE BUG THIS EXISTS FOR. The empty-catalog condition was once pushed through the
 * `checks` array. Every entry there counts BAD ROWS and the reporting loop treats
 * `count === 0` as PASS, so "0 domains" printed `PASS  catalog is empty` and exited 0 —
 * and since an unseeded table yields 0 for every other check too, the gate then announced
 * "all structural checks passed" against a database with no catalog at all. The one
 * failure the gate exists to catch inverted into a green run.
 *
 * SCOPE, STATED PLAINLY. This pins the DECISION, not the process exit code. Asserting the
 * real exit would mean running `tsx src/verify-job-domains.ts` against a database whose
 * `job_domain` table is empty, and `packages/db` has no live-database harness — the
 * `RUN_DB_TESTS` suites all live in `apps/api`, and truncating `job_domain` in a shared CI
 * database to create the condition would be destructive to every other suite sharing it.
 * The end-to-end behaviour is verified by hand on a throwaway database instead (create →
 * `db:migrate` → `db:verify:domains` → exit 1).
 *
 * THE CI GAP THIS DOCBLOCK USED TO REPORT IS CLOSED, and the correction is worth keeping
 * rather than deleting: `db:verify:domains` now runs in `ci.yml` (against the ephemeral e2e
 * container) and in `staging-cd.yml` (against the live staging database), both after
 * `db:seed:domains --apply` + `db:normalize:aliases --apply`. What is NOT automatic is any
 * persistent database outside those two paths — `staging-cd.yml` is `workflow_dispatch` only
 * and inert until a human wires the `staging` environment — which is precisely why the gate
 * has to be able to SEE a missing alias overlay rather than pass over it.
 */
describe("catalogEmptyFailure — the empty-catalog deploy gate", () => {
  it("reports a failure when the catalog has no rows", () => {
    const failure = catalogEmptyFailure(0);
    expect(failure).not.toBeNull();
    // The message has to tell an operator what to actually do; a bare "FAIL" on a fresh
    // database sends them reading source.
    expect(failure).toContain("catalog is empty");
    expect(failure).toContain("db:seed:domains --apply");
  });

  it("reports NOTHING for any non-empty catalog", () => {
    // The inverted-convention bug made zero mean PASS. Pin the other direction too, so a
    // future edit cannot make every catalog size "fail" and be papered over by disabling
    // the gate.
    for (const n of [1, 2, 436, 3885, 4071, 100_000]) {
      expect(catalogEmptyFailure(n), `${n} domains must not fail`).toBeNull();
    }
  });

  it("treats zero as the ONLY failing value — the finding IS the zero", () => {
    // This is the whole inversion in one assertion: `count === 0` means PASS everywhere
    // else in this file, and means FAIL here.
    expect(catalogEmptyFailure(0)).not.toBeNull();
    expect(catalogEmptyFailure(1)).toBeNull();
  });
});

/**
 * The curated-alias gate — "did the AUTHORED overlay actually land?".
 *
 * THE DEFECT THIS EXISTS FOR, stated as the worker saw it. A profiling chat asked a CAD
 * draughtsman his trade, then asked again and offered him Devanagari chips. Root cause: the
 * `rvm-aliases.jsonl` tranche was in the repo and not in the database, so "cad draughtsman"
 * missed L0, fell to the skeleton fold, and reached a GOLF CADDIE at 0.72 — under
 * `AUTO_FLOOR`, so the engine disambiguated instead of pinning. Every structural check in
 * `verify-job-domains.ts` passed on that database, because the NCO seeder writes each
 * occupation's own `label_en` into its alias array: no domain has "zero aliases" even when
 * the entire curated vocabulary is absent.
 *
 * These tests pin the PURE predicates, for the reason the docblock above gives — `packages/db`
 * has no live-database harness. The SQL that feeds them is one unconditional
 * `SELECT "id" FROM "job_domain_alias"`, which is the smallest thing this file could have
 * left unasserted.
 */
describe("missingCuratedAliases — the authored overlay must actually be in the database", () => {
  const rows: CuratedAlias[] = [
    { id: "id-cad", jobDomainId: "jd_nco_3118_0401", text: "cad", lang: "en" },
    { id: "id-autocad", jobDomainId: "jd_nco_3118_0401", text: "autocad", lang: "en" },
    { id: "id-naksha", jobDomainId: "jd_nco_3118_0301", text: "नक्शा", lang: "hi" },
  ];

  it("reports every authored row when the overlay never seeded — the reported failure", () => {
    // The real shape of the defect: the published catalogue is present (so every other
    // check is green) and not one authored row is.
    expect(missingCuratedAliases(rows, new Set())).toEqual(rows);
  });

  it("reports NOTHING when every authored row is present", () => {
    expect(missingCuratedAliases(rows, new Set(["id-cad", "id-autocad", "id-naksha"]))).toEqual([]);
  });

  it("reports the PARTIAL case — a half-applied seed is not a pass", () => {
    // Chunked inserts mean "some landed" is a real state, not a hypothetical one, and it is
    // the state a count-only check would round to green.
    expect(missingCuratedAliases(rows, new Set(["id-cad"]))).toEqual([rows[1], rows[2]]);
  });

  it("ignores database rows the overlay never authored", () => {
    // The published NCO/ISCO aliases share this table. They are not this check's business,
    // and an id-keyed comparison is what keeps them out of it.
    expect(missingCuratedAliases(rows, new Set(["id-cad", "id-autocad", "id-naksha", "id-nco"])))
      .toEqual([]);
  });
});

describe("expectedCuratedAliases — read from the same loader the seeder reads", () => {
  it("derives ids for the shipped overlay, including the rows the CAD defect turned on", () => {
    const curated = expectedCuratedAliases();
    // A corpus that silently read zero rows would make the gate vacuous in the exact
    // direction it is meant to catch, so the non-empty assertion is load-bearing.
    expect(curated.length).toBeGreaterThan(0);

    const cad = curated.find((a) => a.jobDomainId === "jd_nco_3118_0401" && a.text === "cad");
    expect(cad, '"cad" -> jd_nco_3118_0401 is the row that keeps draughtsmen off a golf course')
      .toBeDefined();
    expect(cad?.lang).toBe("en");
    // v5-shaped deterministic uuid, per `job-domain-alias-id.ts` — not a random one.
    expect(cad?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("derives DISTINCT ids per row — a collision would hide a missing alias", () => {
    const curated = expectedCuratedAliases();
    expect(new Set(curated.map((a) => a.id)).size).toBe(curated.length);
  });
});

describe("curatedAliasFailureDetail — what the operator is told", () => {
  const rows: CuratedAlias[] = [
    { id: "a", jobDomainId: "jd_nco_3118_0401", text: "cad", lang: "en" },
    { id: "b", jobDomainId: "jd_nco_3118_0401", text: "autocad", lang: "en" },
    { id: "c", jobDomainId: "jd_nco_3118_0301", text: "नक्शा", lang: "hi" },
    { id: "d", jobDomainId: "jd_nco_3118_0301", text: "naksha", lang: "en" },
  ];

  it("names the command that fixes it", () => {
    const detail = curatedAliasFailureDetail(rows);
    expect(detail).toContain("db:seed:domains --apply");
    expect(detail).toContain("db:normalize:aliases --apply");
  });

  it("samples rows rather than printing all of them", () => {
    const detail = curatedAliasFailureDetail(rows);
    expect(detail).toContain("jd_nco_3118_0401");
    expect(detail).toContain('"cad"');
    // The fourth row is summarised, not listed — the common failure is ALL of them.
    expect(detail).toContain("+1 more");
    expect(detail).not.toContain('"naksha"');
  });

  it("does not claim 'more' when the sample already covers everything", () => {
    expect(curatedAliasFailureDetail(rows.slice(0, 2))).not.toContain("more");
  });
});
