/**
 * The `worker_certificate` / `worker_education` model — Zone 5's credentials, declared by `0098`.
 *
 * This file exists for the failure it prevents, which `delete-forensics-schema.test.ts` already
 * paid for once: `export * from "./qualification"` is enough for drizzle-kit — it reads the
 * module's exports, so the snapshot is always right — but NOT for the barrel's hand-maintained
 * `schema` object. The e2e RLS drift guard compares `live.size` against
 * `Object.keys(schema).length`, so an omission surfaces as a bare `expected 89 to be 87` that
 * names no table, in a suite that has nothing to do with this one.
 *
 * It also pins the two properties of this pair that a later "tidy-up" would plausibly undo: that
 * they are TWO tables rather than one with a `kind` column, and that ordering is an explicit
 * column rather than something derived from `year`.
 */
import { describe, expect, it } from "vitest";

import { schema } from "./schema";
import { workerCertificates, workerEducations } from "./schema/qualification";

describe("the qualification tables are registered in the model", () => {
  it("are in the exported schema object, not only re-exported from the module", () => {
    // Both are required, and only this assertion names the table when one is missing.
    expect(Object.keys(schema)).toContain("workerCertificates");
    expect(Object.keys(schema)).toContain("workerEducations");
    expect(schema.workerCertificates).toBe(workerCertificates);
    expect(schema.workerEducations).toBe(workerEducations);
  });

  it("keeps the three fields a certificate prints, and no council", () => {
    // "CNC Turning & Fanuc Programming (RVM CAD, 2020)" — a name, who awarded it, and when.
    // A council belongs to an EDUCATION and its absence here is what makes these two tables
    // rather than one with four columns nullable-by-kind and the real constraint somewhere no
    // CHECK can see it.
    const columns = Object.keys(workerCertificates);
    for (const c of ["name", "issuer", "year"]) expect(columns).toContain(c);
    expect(columns).not.toContain("council");
    expect(columns).not.toContain("credential");
  });

  it("keeps all five segments the education row prints, each its own column", () => {
    // "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad". Storing the rendered line would
    // make the composition unfixable and the parts unmatchable — `credential` and `field` are
    // matching inputs, not decoration.
    const columns = Object.keys(workerEducations);
    for (const c of ["credential", "field", "council", "year", "institute"]) {
      expect(columns).toContain(c);
    }
  });

  it("orders by an EXPLICIT column, never by year", () => {
    // Two credentials can share a year and an undated one still has the place the worker gave
    // it. Deriving the order from `year` would reshuffle rows between renders and make every
    // regenerated PDF a false diff — so the column existing is the guarantee, and a change that
    // removed it in favour of "just sort by year" would fail here rather than in a diff nobody
    // reads.
    expect(Object.keys(workerCertificates)).toContain("sortOrder");
    expect(Object.keys(workerEducations)).toContain("sortOrder");
  });

  it("holds no encrypted column — the in-clear decision is deliberate and reviewable", () => {
    // `issuer` and `institute` follow the `education_institute` precedent (in clear on
    // `worker_attributes` since R9 §3), not the `employer_name_enc` one. That is a ruling the
    // migration header argues explicitly, and it has a consequence beyond this table: a `*_enc`
    // column added here MUST also gain a `target(...)` entry in `reencrypt-pii-backfill.ts` or a
    // key rotation silently skips it. This assertion is what makes adding one a deliberate act.
    for (const table of [workerCertificates, workerEducations]) {
      expect(Object.keys(table).filter((c) => c.endsWith("Enc"))).toEqual([]);
    }
  });
});
