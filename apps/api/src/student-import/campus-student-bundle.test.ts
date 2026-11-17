import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  parseStudentLines,
  readCampusStudentBundle,
  StudentBundleError,
} from "./campus-student-bundle";
import {
  syntheticStudent,
  TEST_PASSPHRASE,
  writeSyntheticBundle,
} from "./student-bundle.test-support";

/**
 * #2887 — the Campus student bundle reader (format v1): the documented encryption, the hash check
 * before any line is used, and per-line errors that are reported, never skipped silently.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const bundle = async (opts: Parameters<typeof writeSyntheticBundle>[0]) => {
  const d = await writeSyntheticBundle(opts);
  dirs.push(d);
  return d;
};

describe("readCampusStudentBundle", () => {
  it("decrypts, verifies and parses a v1 bundle", async () => {
    const dir = await bundle({
      students: [syntheticStudent("cand-1", "9876500001"), syntheticStudent("cand-2", null)],
      problems: [{ kind: "phone_missing", candidate_source_id: "cand-2", detail: null }],
    });
    const out = await readCampusStudentBundle(dir, TEST_PASSPHRASE);
    expect(out.manifest.version).toBe(1);
    expect(out.students.map((s) => s.student.source_id)).toEqual(["cand-1", "cand-2"]);
    expect(out.students[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.lineErrors).toEqual([]);
    expect(out.problems).toEqual([
      { kind: "phone_missing", candidate_source_id: "cand-2", detail: null },
    ]);
  }, 30_000);

  it("a wrong passphrase is refused, and the message never carries it", async () => {
    const dir = await bundle({ students: [syntheticStudent("cand-1", "9876500001")] });
    const err = await readCampusStudentBundle(dir, "zq-not-the-key-7741").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudentBundleError);
    expect((err as Error).message).toMatch(/decryption failed/);
    expect((err as Error).message).not.toContain("zq-not-the-key-7741");
  }, 30_000);

  it("a plain-text hash that does not match the manifest is refused before any line is used", async () => {
    const dir = await bundle({
      students: [syntheticStudent("cand-1", "9876500001")],
      badStudentsSha: true,
    });
    await expect(readCampusStudentBundle(dir, TEST_PASSPHRASE)).rejects.toThrow(/sha256/);
  }, 30_000);

  it("a folder with no manifest is refused", async () => {
    await expect(
      readCampusStudentBundle("C:/definitely/not/here", TEST_PASSPHRASE),
    ).rejects.toThrow(/manifest\.json/);
  });
});

describe("parseStudentLines", () => {
  it("reports a bad line with its number and id, and keeps the good ones", () => {
    const good = JSON.stringify(syntheticStudent("cand-1", "9876500001"));
    const badPhone = JSON.stringify(
      syntheticStudent("cand-2", null, { phone: { value: "12345", class: "good" } }),
    );
    const out = parseStudentLines(`${good}\nnot json\n${badPhone}\n${good}\n`);
    expect(out.students.map((s) => s.lineNo)).toEqual([1]);
    expect(out.lineErrors.map((e) => [e.lineNo, e.sourceId])).toEqual([
      [2, null],
      [3, "cand-2"],
      [4, "cand-1"],
    ]);
    expect(out.lineErrors[2]!.issues).toEqual(["source_id appears twice in the bundle"]);
  });

  it("accepts fields Campus adds later (lenient on what the import does not read)", () => {
    const out = parseStudentLines(
      JSON.stringify(syntheticStudent("cand-1", "9876500001", { new_campus_field: { x: 1 } })),
    );
    expect(out.students).toHaveLength(1);
  });

  it("the content hash ignores key order and changes with the content", () => {
    const a = parseStudentLines(JSON.stringify({ ...syntheticStudent("c", "9876500001") }));
    const reordered = Object.fromEntries(
      Object.entries(syntheticStudent("c", "9876500001")).reverse(),
    );
    const b = parseStudentLines(JSON.stringify(reordered));
    const c = parseStudentLines(
      JSON.stringify(syntheticStudent("c", "9876500001", { city: "Nashik" })),
    );
    expect(a.students[0]!.contentHash).toBe(b.students[0]!.contentHash);
    expect(a.students[0]!.contentHash).not.toBe(c.students[0]!.contentHash);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined, x: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":0,"z":1}]},"b":1}',
    );
  });
});
