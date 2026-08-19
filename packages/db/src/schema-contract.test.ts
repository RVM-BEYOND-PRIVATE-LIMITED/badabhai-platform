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
  evaluateContract,
  uniqueIndexMatches,
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
