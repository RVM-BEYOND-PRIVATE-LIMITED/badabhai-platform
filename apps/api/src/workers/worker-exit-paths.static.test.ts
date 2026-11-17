import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * #2753 item 13 — EVERY PATH THAT ERASES A WORKER IS LISTED, AND EACH WRITES `worker.account_deleted`.
 *
 * A workers row leaves the database in exactly two statements today:
 *   - `WorkersRepository.hardDelete`, called only by `AccountDeletionService.execute`, which the
 *     grace sweep and the QA immediate seam call (one event, keyed once per worker);
 *   - `InstituteLinkRepository.deleteLinkCreatedPendingWorker`, called only by
 *     `InstituteLinkService.unlinkStudent` on Campus's request (one event, on its transaction).
 * There is NO admin action that erases a worker (admins suspend). The event counts per path are
 * proved against Postgres in `auth/account-deletion-exit-paths.db.test.ts` and
 * `campus-link/institute-tag-rules.db.test.ts`.
 *
 * A new delete of the workers row, a new `hardDelete` caller or a new `execute` caller fails this
 * file until it is listed here, so a fifth exit path (an admin erase, a DSAR route) cannot ship
 * without someone deciding how it writes the one deletion event.
 *
 * #2837 — and each statement that deletes the row also erases the rows keyed on his id that no
 * cascade reaches (`eraseLoginKeyedRows`: `display_prefs`, `feature_pilot_subjects`), proved
 * against Postgres in `common/login-keyed-rows.db.test.ts`.
 */
const SRC = join(__dirname, "..");

/** Files whose code deletes from `workers` directly, and the method that does it. */
const DELETES_THE_ROW: Readonly<Record<string, string>> = {
  "workers/workers.repository.ts": "hardDelete",
  "campus-link/institute-link.repository.ts": "deleteLinkCreatedPendingWorker",
};

/** Every caller of those methods (and of the erasure), each of which writes the event itself. */
const CALLERS: Readonly<Record<string, { calls: string; writesEvent: boolean }>> = {
  "auth/account-deletion.service.ts": { calls: ".hardDelete(", writesEvent: true },
  "campus-link/institute-link.service.ts": {
    calls: ".deleteLinkCreatedPendingWorker(",
    writesEvent: true,
  },
  // The two entry points to `AccountDeletionService.execute`; the event is execute's.
  "auth/account-deletion-sweep.processor.ts": {
    calls: "accountDeletion.execute(",
    writesEvent: false,
  },
  "auth/auth.controller.ts": { calls: "accountDeletion.execute(", writesEvent: false },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const name = entry.name;
    const isSource =
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test-support.ts") &&
      !name.endsWith(".fake.ts");
    return isSource ? [path] : [];
  });
}

/** Code only: block and line comments dropped, so a comment naming a statement is not a hit. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const relativePath = (path: string) => relative(SRC, path).split(sep).join("/");

const DELETE_WORKERS = /\.delete\(\s*workers\s*\)|\bdelete\s+from\s+"?workers"?\b/i;
/** A call (`x.hardDelete(`), never the definition (`async hardDelete(`). */
const DELETE_CALL = /\.(hardDelete|deleteLinkCreatedPendingWorker)\(/;
const IMPORTS_ERASURE = /import\s*(type\s*)?\{[^}]*\bAccountDeletionService\b[^}]*\}\s*from/;

describe("#2753 item 13 — every worker exit path is listed and writes the deletion event", () => {
  const files = sourceFiles(SRC).map((path) => ({ rel: relativePath(path), src: code(path) }));

  it("finds the files that delete the workers row, and nothing else", () => {
    const found = files.filter((f) => DELETE_WORKERS.test(f.src)).map((f) => f.rel);
    expect(found.sort()).toEqual(Object.keys(DELETES_THE_ROW).sort());
  });

  it("finds every caller of those deletes and of the erasure, and nothing else", () => {
    const found = files
      .filter(
        (f) =>
          DELETE_CALL.test(f.src) || (IMPORTS_ERASURE.test(f.src) && /\.execute\(/.test(f.src)),
      )
      .map((f) => f.rel);
    expect(found.sort()).toEqual(Object.keys(CALLERS).sort());
  });

  for (const [file, method] of Object.entries(DELETES_THE_ROW)) {
    it(`${file} deletes the row in ${method}`, () => {
      expect(readFileSync(join(SRC, file), "utf8")).toContain(`async ${method}(`);
    });

    it(`${file} erases his login-keyed rows with the row (#2837)`, () => {
      expect(code(join(SRC, file))).toMatch(/eraseLoginKeyedRows\(\s*\w+,\s*\{\s*kind: "worker"/);
    });
  }

  for (const [file, caller] of Object.entries(CALLERS)) {
    it(`${file} calls ${caller.calls}${caller.writesEvent ? " and writes worker.account_deleted" : ""}`, () => {
      const src = code(join(SRC, file));
      expect(src).toContain(caller.calls);
      if (caller.writesEvent) expect(src).toContain(`"worker.account_deleted"`);
    });
  }
});
