import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { PackRepository } from "./pack.repository";

/**
 * DB-free unit of the two pack reads that carry real logic.
 *
 * WHY THIS FILE EXISTS. Two things here would fail silently and look fine everywhere else:
 *
 * 1. `findActivePacks` filters on `status = 'active'` AND the locale. Drop either term and the
 *    registry starts serving DRAFT packs — unreviewed questions, to real workers — with every
 *    other test in the repository still green.
 * 2. `findPackHead` pins the VERSION. Drop `eq(version)` and a pack release mid-interview
 *    silently changes the questions under a worker halfway through answering them (risk #13),
 *    which is the exact failure the pinning design exists to prevent.
 *
 * Same PgDialect capture-and-compile pattern as `chat.repository.test.ts` — the SQL is rendered
 * and inspected, with no Postgres anywhere.
 */
function makeCapturingDb(rows: unknown[] = []) {
  const captured: { where?: unknown; orderBy?: unknown } = {};
  const chain = {
    from: () => chain,
    where(predicate: unknown) {
      captured.where = predicate;
      return chain;
    },
    orderBy(clause: unknown) {
      captured.orderBy = clause;
      return Promise.resolve(rows);
    },
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };
  const db = { select: vi.fn(() => chain) };
  return { db, captured };
}

const renderWhere = (predicate: unknown): string =>
  new PgDialect().sqlToQuery(predicate as never).sql;

describe("findActivePacks — a DRAFT pack must never reach a worker", () => {
  it("filters on family, locale AND status together", async () => {
    const { db, captured } = makeCapturingDb();
    await new PackRepository(db as never).findActivePacks(["fam_welding"], "hi-IN");
    const sql = renderWhere(captured.where);
    expect(sql).toContain('"family_id"');
    expect(sql).toContain('"locale"');
    expect(sql).toContain('"status"');
    expect(sql.toLowerCase()).toContain(" and ");
  });

  it("does not query at all for an empty family list", async () => {
    // `inArray` with an empty list is a SQL error in some dialects and a full scan in others.
    const { db } = makeCapturingDb();
    expect(await new PackRepository(db as never).findActivePacks([], "hi-IN")).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("findPackHead — the version pin (risk #13)", () => {
  it("scopes to the pack id AND the exact version", async () => {
    const { db, captured } = makeCapturingDb([{ packId: "qp_welding" }]);
    await new PackRepository(db as never).findPackHead("qp_welding", 2);
    const sql = renderWhere(captured.where);
    expect(sql).toContain('"pack_id"');
    expect(sql).toContain('"version"');
    expect(sql.toLowerCase()).toContain(" and ");
  });

  it("returns null rather than undefined when the pinned version is gone", async () => {
    const { db } = makeCapturingDb([]);
    expect(await new PackRepository(db as never).findPackHead("qp_welding", 9)).toBeNull();
  });
});

describe("findItems / findOptions", () => {
  it("scopes items to the pack id AND version, ordered for the engine", async () => {
    // `display_order` is the engine's priority input; an unordered read would make question
    // order depend on Postgres' physical row order.
    const { db, captured } = makeCapturingDb();
    await new PackRepository(db as never).findItems("qp_welding", 1);
    const sql = renderWhere(captured.where);
    expect(sql).toContain('"pack_id"');
    expect(sql).toContain('"pack_version"');
    expect(captured.orderBy).toBeDefined();
  });

  it("does not query at all for an empty item list", async () => {
    const { db } = makeCapturingDb();
    expect(await new PackRepository(db as never).findOptions([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("findBindings — the CANDIDATE filter (which level wins is resolveFamily's call)", () => {
  const rows = [
    { familyId: "fam_welding", specificity: 50, jobDomainId: "dom_welder", iscoUnitCode: null, iscoMinorCode: null, iscoSubmajorCode: null, iscoMajorCode: null, isUniversal: false },
    { familyId: "fam_welders", specificity: 40, jobDomainId: null, iscoUnitCode: "7212", iscoMinorCode: null, iscoSubmajorCode: null, iscoMajorCode: null, isUniversal: false },
    { familyId: "fam_metal", specificity: 20, jobDomainId: null, iscoUnitCode: null, iscoMinorCode: null, iscoSubmajorCode: "72", iscoMajorCode: null, isUniversal: false },
    { familyId: "fam_other", specificity: 40, jobDomainId: null, iscoUnitCode: "9999", iscoMinorCode: null, iscoSubmajorCode: null, iscoMajorCode: null, isUniversal: false },
    { familyId: "fam_universal", specificity: 0, jobDomainId: null, iscoUnitCode: null, iscoMinorCode: null, iscoSubmajorCode: null, iscoMajorCode: null, isUniversal: true },
  ];

  it("keeps every level the occupation actually sits under, and nothing else", async () => {
    const { db } = makeCapturingDb(rows);
    const found = await new PackRepository(db as never).findBindings({
      jobDomainId: "dom_welder",
      iscoUnitCode: "7212",
    });
    expect(found.map((b) => b.familyId).sort()).toEqual([
      "fam_metal",
      "fam_universal",
      "fam_welders",
      "fam_welding",
    ]);
  });

  it("keeps ONLY the universal binding for an occupation with no domain and no ISCO code", async () => {
    // An `rvm`-minted row has no published ISCO code. It must still reach an interview.
    const { db } = makeCapturingDb(rows);
    const found = await new PackRepository(db as never).findBindings({
      jobDomainId: null,
      iscoUnitCode: null,
    });
    expect(found.map((b) => b.familyId)).toEqual(["fam_universal"]);
  });

  it("never matches a binding on a null column by coincidence", async () => {
    // Without the explicit `!== null` guards, `null === null` would make every level match
    // every occupation and the whole chain would collapse to "the first row wins".
    const { db } = makeCapturingDb([
      { familyId: "fam_null", specificity: 50, jobDomainId: null, iscoUnitCode: null, iscoMinorCode: null, iscoSubmajorCode: null, iscoMajorCode: null, isUniversal: false },
    ]);
    const found = await new PackRepository(db as never).findBindings({
      jobDomainId: null,
      iscoUnitCode: null,
    });
    expect(found).toEqual([]);
  });
});
