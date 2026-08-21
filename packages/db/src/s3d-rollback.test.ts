/**
 * S3-D rollback — the rules, pinned.
 *
 * The property that must never be wrong is a NEGATIVE one: the rollback must not delete a row
 * that existed before it. There is no way to notice that failing by watching a log — the run
 * looks identical either way — so the membership rule is a pure function with every branch
 * covered, including the case the naive implementation gets wrong (delete everything not in the
 * manifest).
 */
import { describe, expect, it } from "vitest";

import {
  manifestDigest,
  manifestMismatch,
  planRollback,
  type AliasSnapshot,
  type S3dManifest,
  type SkillSnapshot,
} from "./s3d-rollback";
import { deterministicAliasId } from "./skill-alias-id";

const TARGET = { hostClass: "SUPABASE (remote)", database: "postgres" };

const alias = (skillId: string, text: string, embedded = true): AliasSnapshot => ({
  id: deterministicAliasId(skillId, text, "en"),
  skillId,
  text,
  lang: "en",
  domainId: "cnc-programming",
  embedded,
});

function manifest(over: Partial<Omit<S3dManifest, "digest">> = {}): S3dManifest {
  const body = {
    kind: "s3d-rollback-manifest" as const,
    capturedAt: "2026-08-19T00:00:00.000Z",
    target: TARGET,
    skills: [
      { skillId: "skill_cad_interpretation", status: "active", replacedBy: null },
      { skillId: "skill_drawing_reading", status: "active", replacedBy: null },
    ] as SkillSnapshot[],
    aliases: [alias("skill_cad_interpretation", "CAD")] as AliasSnapshot[],
    ...over,
  };
  return { ...body, digest: manifestDigest(body) };
}

/** State after S3-D: the predecessor deprecated, its alias moved onto the terminal. */
function afterS3d() {
  const moved = deterministicAliasId("skill_drawing_reading", "CAD", "en");
  return {
    skills: [
      { skillId: "skill_cad_interpretation", status: "deprecated", replacedBy: "skill_drawing_reading" },
      { skillId: "skill_drawing_reading", status: "active", replacedBy: null },
    ] as SkillSnapshot[],
    aliasIds: new Set([moved]),
    terminals: new Map([["skill_cad_interpretation", "skill_drawing_reading"]]),
    movedId: moved,
  };
}

describe("planRollback — restoring the pre-S3-D state", () => {
  it("restores the flipped skill's status AND its pointer together", () => {
    const s = afterS3d();
    const p = planRollback(manifest(), { skills: s.skills, aliasIds: s.aliasIds }, s.terminals);
    expect(p.skillsToRestore).toEqual([
      { skillId: "skill_cad_interpretation", status: "active", replacedBy: null },
    ]);
  });

  it("re-homes the alias the retag moved away", () => {
    const s = afterS3d();
    const p = planRollback(manifest(), { skills: s.skills, aliasIds: s.aliasIds }, s.terminals);
    expect(p.aliasesToRestore.map((a) => a.text)).toEqual(["CAD"]);
  });

  it("deletes the row the retag created, and only that one", () => {
    const s = afterS3d();
    const p = planRollback(manifest(), { skills: s.skills, aliasIds: s.aliasIds }, s.terminals);
    expect(p.aliasesToDelete).toEqual([s.movedId]);
  });
});

describe("the delete-protection property", () => {
  it("NEVER deletes a row that was present at capture", () => {
    // The naive implementation is "delete everything not in the manifest". Here the terminal
    // already owned its own "CAD" row before S3-D, so that id IS in the manifest and must
    // survive — even though it is also the id the retag would have minted.
    const terminalOwn = alias("skill_drawing_reading", "CAD");
    const m = manifest({ aliases: [alias("skill_cad_interpretation", "CAD"), terminalOwn] });
    const s = afterS3d();
    const p = planRollback(m, { skills: s.skills, aliasIds: new Set([terminalOwn.id]) }, s.terminals);
    expect(p.aliasesToDelete).toEqual([]);
  });

  it("reports an unexplained extra rather than deleting it", () => {
    // A row that appeared from somewhere else entirely — another job, a manual insert. The
    // rollback has no basis for attributing it to S3-D, so it must not touch it.
    const s = afterS3d();
    const stranger = deterministicAliasId("skill_unrelated", "something else", "en");
    const p = planRollback(
      manifest(),
      { skills: s.skills, aliasIds: new Set([...s.aliasIds, stranger]) },
      s.terminals,
    );
    expect(p.aliasesToDelete).not.toContain(stranger);
    expect(p.unexplainedExtras).toContain(stranger);
  });

  it("only treats an id as retag-created if the crosswalk actually explains it", () => {
    // Same id, but no terminal mapping — so nothing says the retag made it. Not deletable.
    const s = afterS3d();
    const p = planRollback(manifest(), { skills: s.skills, aliasIds: s.aliasIds }, new Map());
    expect(p.aliasesToDelete).toEqual([]);
    expect(p.unexplainedExtras).toEqual([s.movedId]);
  });

  it("does not try to recreate a skill row that no longer exists at all", () => {
    // Restoring a status is in scope; resurrecting a deleted skill is not, and SG-5 says skill
    // rows are never deleted anyway — so if one is missing, something else is very wrong.
    const p = planRollback(manifest(), { skills: [], aliasIds: new Set() }, new Map());
    expect(p.skillsToRestore).toEqual([]);
  });
});

describe("idempotency", () => {
  it("plans nothing when the database already matches the manifest", () => {
    const m = manifest();
    const p = planRollback(
      m,
      { skills: [...m.skills], aliasIds: new Set(m.aliases.map((a) => a.id)) },
      new Map(),
    );
    expect(p.skillsToRestore).toEqual([]);
    expect(p.aliasesToRestore).toEqual([]);
    expect(p.aliasesToDelete).toEqual([]);
    expect(p.alreadyCorrect).toBe(m.skills.length);
  });

  it("a second pass over an already-restored database is a no-op", () => {
    const m = manifest();
    const restored = { skills: [...m.skills], aliasIds: new Set(m.aliases.map((a) => a.id)) };
    const first = planRollback(m, restored, new Map());
    const second = planRollback(m, restored, new Map());
    expect(first).toEqual(second);
    expect(second.aliasesToRestore).toEqual([]);
  });

  it("treats a null and an absent replaced_by as the same value", () => {
    // Otherwise every run would "restore" a row that is already correct, and idempotency
    // would be false in the most common shape.
    const m = manifest({ skills: [{ skillId: "s", status: "active", replacedBy: null }] });
    const p = planRollback(
      m,
      { skills: [{ skillId: "s", status: "active", replacedBy: null }], aliasIds: new Set(m.aliases.map((a) => a.id)) },
      new Map(),
    );
    expect(p.skillsToRestore).toEqual([]);
  });
});

describe("manifestMismatch — the pre-assertion", () => {
  it("accepts a manifest captured against this target", () => {
    expect(manifestMismatch(manifest(), TARGET)).toBeNull();
  });

  it("refuses a manifest captured against a DIFFERENT database", () => {
    // Restoring production from a manifest captured on a laptop is the worst available
    // outcome, and the two are one shell variable apart.
    expect(manifestMismatch(manifest(), { hostClass: "LOCAL DOCKER", database: "badabhai" })).toMatch(
      /captured against/,
    );
  });

  it("refuses a manifest whose digest no longer matches its contents", () => {
    // The delete-protection list lives in this file. If it can be edited after capture, the
    // protection is advisory — so an edited manifest is refused outright rather than trusted.
    const m = manifest();
    const tampered = { ...m, aliases: [] } as S3dManifest;
    expect(manifestMismatch(tampered, TARGET)).toMatch(/digest does not match/);
  });

  it("refuses a file that is not an S3-D manifest at all", () => {
    expect(manifestMismatch({ ...manifest(), kind: "something-else" } as unknown as S3dManifest, TARGET)).toMatch(
      /not an S3-D manifest/,
    );
  });
});

describe("manifestDigest", () => {
  it("is order-independent", () => {
    const a = manifest().aliases;
    const base = { ...manifest(), aliases: a };
    const rev = { ...manifest(), aliases: [...a].reverse() };
    expect(manifestDigest(base)).toBe(manifestDigest(rev));
  });

  it("changes when an alias is removed from the protection list", () => {
    const m = manifest();
    expect(manifestDigest(m)).not.toBe(manifestDigest({ ...m, aliases: [] }));
  });

  it("changes when a captured status changes", () => {
    const m = manifest();
    expect(manifestDigest(m)).not.toBe(
      manifestDigest({ ...m, skills: [{ skillId: "skill_cad_interpretation", status: "deprecated", replacedBy: null }] }),
    );
  });

  it("records whether each alias was embedded, so a silent vector loss is detectable", () => {
    const m = manifest();
    expect(manifestDigest(m)).not.toBe(
      manifestDigest({ ...m, aliases: [alias("skill_cad_interpretation", "CAD", false)] }),
    );
  });
});
