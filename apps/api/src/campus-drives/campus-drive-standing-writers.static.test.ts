import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * #2746 PR 6, migration review M1 — EVERY WRITER OF A COMPANY'S CAMPUS STANDING RE-STAMPS ITS
 * DRIVE REQUESTS.
 *
 * Campus's drive feed pages on `campus_drive_requests.updated_at` alone, and reads whether a
 * request's company is withdrawn (owner ruling R2) live from `payers.status` / `payers.role` and
 * `employer_profiles.verification_status` / `gst_number_enc`. A write to one of those that does not
 * move the request's `updated_at` leaves the request where Campus already read it, so Campus never
 * learns of the withdrawal (or the reinstatement). `restampCompanyDriveRequests`
 * (`campus-drive-feed-stamp.ts`) is the move; this test fails any write that skips it.
 *
 * WHAT IT SEES, in every non-test file under apps/api/src:
 *   - a Drizzle `.update(payers)` whose `.set({…})` names `status` (`payers.role` has no writer);
 *   - a Drizzle `.insert(employerProfiles)` / `.update(employerProfiles)` (any write: the verification
 *     and the GSTIN arrive in spread column objects, so the write itself is the signal);
 *   - raw SQL `UPDATE payers SET … status =` / `UPDATE employer_profiles` / `INSERT INTO
 *     employer_profiles`.
 * Each such write must be followed by a `restampCompanyDriveRequests(` call before the next member
 * of its class (or the end of the file): per write, not per file.
 *
 * WHAT IT DOES NOT SEE: `packages/db` (its seeds INSERT new payers, which have no requests yet, and
 * the PII re-encryption rewrites `gst_number_enc` ciphertext without changing whether a GSTIN is on
 * file), and an `INSERT INTO payers` (a new payer has no drive requests).
 */

const API_SRC = join(__dirname, "..");
const HELPER_CALL = "restampCompanyDriveRequests(";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test-support.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Where each standing write starts in `src` (character offsets). */
function standingWrites(src: string): number[] {
  const at: number[] = [];
  for (const m of src.matchAll(/\.update\(\s*payers\s*\)/g)) {
    const rest = src.slice(m.index, m.index + 800);
    const setAt = rest.indexOf(".set(");
    const endAt = rest.search(/\.(where|returning)\(/);
    if (setAt < 0 || (endAt >= 0 && endAt < setAt)) continue;
    const setText = rest.slice(setAt, endAt < 0 ? undefined : endAt);
    if (/[{,\s]status\s*:/.test(setText)) at.push(m.index);
  }
  for (const m of src.matchAll(/\.(insert|update)\(\s*employerProfiles\s*\)/g)) at.push(m.index);
  for (const m of src.matchAll(/\bupdate\s+"?payers"?\s+set\b[^;`]*?\bstatus\s*=/gi)) {
    at.push(m.index);
  }
  for (const m of src.matchAll(/\b(update|insert\s+into)\s+"?employer_profiles"?/gi)) {
    at.push(m.index);
  }
  return at.sort((a, b) => a - b);
}

/** Does a re-stamp follow the write at `offset` before the next class member (or the end)? */
function restampFollows(src: string, offset: number): boolean {
  const rest = src.slice(offset);
  const next = rest.search(/\n {2}(?:\/\*\*|async\s|private\s|public\s|protected\s|static\s)/);
  return (next < 0 ? rest : rest.slice(0, next)).includes(HELPER_CALL);
}

function writers(): { file: string; src: string; writes: number[] }[] {
  return sourceFiles(API_SRC)
    .map((full) => ({
      file: relative(API_SRC, full).split(sep).join("/"),
      src: readFileSync(full, "utf8"),
    }))
    .map((f) => ({ ...f, writes: standingWrites(f.src) }))
    .filter((f) => f.writes.length > 0);
}

describe("every writer of a company's Campus standing re-stamps its drive requests (migration review M1)", () => {
  it("the scan sees the writers it exists for (it has not gone blind)", () => {
    const files = writers().map((w) => w.file);
    for (const known of [
      "admin/admin-actions.repository.ts",
      "admin/companies/admin-companies.repository.ts",
      "payers/payers.repository.ts",
    ]) {
      expect(files).toContain(known);
    }
  });

  it("each standing write is followed by restampCompanyDriveRequests in the same member", () => {
    const missing: string[] = [];
    for (const { file, src, writes } of writers()) {
      for (const offset of writes) {
        if (!restampFollows(src, offset)) {
          const line = src.slice(0, offset).split("\n").length;
          missing.push(`${file}:${line}`);
        }
      }
    }
    expect(missing, "add restampCompanyDriveRequests(tx, [payerId]) after these writes").toEqual(
      [],
    );
  });

  describe("the scan itself", () => {
    const member = (body: string) =>
      `class R {\n  async write() {\n${body}\n  }\n\n  async next() {}\n}`;

    it.each([
      ["a Drizzle status write", `await tx.update(payers).set({ status: "suspended" }).where(w);`],
      [
        "a status write after other keys",
        `await tx.update(payers).set({ a: 1, status: x }).where(w);`,
      ],
      ["an employer_profiles insert", `await tx.insert(employerProfiles).values(v);`],
      ["an employer_profiles update", `await tx.update(employerProfiles).set(s).where(w);`],
      ["raw SQL on payers", "await sql`UPDATE payers SET status = 'archived' WHERE id = ${id}`;"],
      [
        "raw SQL on employer_profiles",
        "await sql`update employer_profiles set gst_number_enc = null`;",
      ],
    ])("sees %s, and wants the re-stamp after it", (_n, write) => {
      const bare = member(write);
      expect(standingWrites(bare)).toHaveLength(1);
      expect(restampFollows(bare, standingWrites(bare)[0]!)).toBe(false);
      const stamped = member(`${write}\n    await restampCompanyDriveRequests(tx, [id]);`);
      expect(restampFollows(stamped, standingWrites(stamped)[0]!)).toBe(true);
    });

    it("a re-stamp in the NEXT member does not count", () => {
      const src = `class R {\n  async write() {\n    await tx.update(payers).set({ status: "x" }).where(w);\n  }\n\n  async other() {\n    await restampCompanyDriveRequests(tx, [id]);\n  }\n}`;
      expect(restampFollows(src, standingWrites(src)[0]!)).toBe(false);
    });

    it.each([
      ["a name write", `await tx.update(payers).set({ orgNameEnc: x }).where(w);`],
      ["previous_status only, raw", "await sql`UPDATE payers SET previous_status = NULL`;"],
      ["a login stamp", `await tx.update(payers).set({ lastLoginAt: now }).where(w);`],
      ["a prebuilt set object", `await tx.update(payers).set(set).where(w);`],
    ])("ignores %s", (_n, write) => {
      expect(standingWrites(member(write))).toEqual([]);
    });
  });
});
