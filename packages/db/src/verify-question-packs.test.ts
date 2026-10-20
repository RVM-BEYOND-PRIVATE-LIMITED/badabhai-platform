import { describe, expect, it } from "vitest";

import type { PackRecord } from "./question-pack-corpus";
import {
  expectedPackVersions,
  missingPackVersionDetail,
  packStatusDriftDetail,
  packVersionDrift,
  type PackVersionRow,
} from "./verify-question-packs";

/**
 * The pack-version gate (#2381). `db:verify:packs` compared corpus and live COUNTS only, so a
 * merged pack version that never reached the database passed every check — twice
 * (`qp_universal@3/@4` on 2026-09-24, `@7/@8` on 2026-10-20). These pin the decision on the
 * pure diff; the live query is one SELECT over `question_pack`, verified by hand against the
 * production snapshot the incident was found on.
 */

const pack = (pack_id: string, version: number, status?: PackRecord["status"]): PackRecord => ({
  pack_id,
  version,
  family_id: "fam_universal",
  ...(status === undefined ? {} : { status }),
  items: [],
});

const row = (packId: string, version: number, status: string): PackVersionRow => ({
  packId,
  version,
  status,
});

describe("expectedPackVersions — what the seeder would write", () => {
  it("carries each version's authored status", () => {
    expect(
      expectedPackVersions([
        pack("qp_universal", 7, "deprecated"),
        pack("qp_universal", 8, "active"),
      ]),
    ).toEqual([row("qp_universal", 7, "deprecated"), row("qp_universal", 8, "active")]);
  });

  it("defaults an unstated status to draft, exactly as planPackRows writes it", () => {
    expect(expectedPackVersions([pack("qp_new_trade", 1)])).toEqual([
      row("qp_new_trade", 1, "draft"),
    ]);
  });
});

describe("packVersionDrift — corpus versions vs live rows", () => {
  it("is clean when every corpus version is live with the same status", () => {
    const expected = [row("qp_universal", 7, "deprecated"), row("qp_universal", 8, "active")];
    expect(packVersionDrift(expected, [...expected])).toEqual({ missing: [], statusDrift: [] });
  });

  it("catches the 2026-10-20 production state: v7/v8 absent, v6 still active", () => {
    const expected = [
      row("qp_universal", 6, "deprecated"),
      row("qp_universal", 7, "deprecated"),
      row("qp_universal", 8, "active"),
    ];
    const live = [row("qp_universal", 6, "active")];

    const drift = packVersionDrift(expected, live);

    expect(drift.missing).toEqual([
      row("qp_universal", 7, "deprecated"),
      row("qp_universal", 8, "active"),
    ]);
    expect(drift.statusDrift).toEqual([
      { packId: "qp_universal", version: 6, corpus: "deprecated", live: "active" },
    ]);
  });

  it("matches on (pack_id, version), never on pack_id alone", () => {
    const drift = packVersionDrift(
      [row("qp_welding", 2, "active")],
      [row("qp_welding", 1, "active")],
    );
    expect(drift.missing).toEqual([row("qp_welding", 2, "active")]);
  });

  it("does not report a live version the corpus lacks as missing", () => {
    const drift = packVersionDrift(
      [row("qp_a", 1, "active")],
      [row("qp_a", 1, "active"), row("qp_b", 1, "draft")],
    );
    expect(drift).toEqual({ missing: [], statusDrift: [] });
  });
});

describe("failure details — name rows and the fix", () => {
  it("names the missing versions and the P3-0 seed command", () => {
    const detail = missingPackVersionDetail([
      row("qp_universal", 7, "deprecated"),
      row("qp_universal", 8, "active"),
    ]);
    expect(detail).toContain("qp_universal@7 (deprecated)");
    expect(detail).toContain("qp_universal@8 (active)");
    expect(detail).toContain("db:seed:packs --apply");
  });

  it("caps the sample at three and counts the rest", () => {
    const missing = [1, 2, 3, 4, 5].map((v) => row("qp_x", v, "deprecated"));
    const detail = missingPackVersionDetail(missing);
    expect(detail).toContain("qp_x@3");
    expect(detail).not.toContain("qp_x@4");
    expect(detail).toContain("+2 more");
  });

  it("states both sides of a status drift", () => {
    const detail = packStatusDriftDetail([
      { packId: "qp_universal", version: 6, corpus: "deprecated", live: "active" },
    ]);
    expect(detail).toContain("qp_universal@6 corpus=deprecated live=active");
    expect(detail).toContain("db:seed:packs --apply");
  });
});
