import { describe, expect, it } from "vitest";

import type { Database } from "./client";
import { encryptPii, encryptPiiWithKeyring } from "./crypto";
import { PRODUCTION_WRITE_FLAG } from "./ops-guard";
import { piiCodec } from "./pii-keyring-env";
import {
  NEWLY_ARMED_FLAG,
  TITLE_CASE_COLUMNS,
  buildTargets,
  canSeeForcedRlsRows,
  describeDbFailure,
  formatSummary,
  judgeWriteKey,
  keyringSourceOf,
  parseTitleCaseCli,
  planValue,
  safeErrorLine,
  writeFormatLabel,
  writeKeyProblem,
  type ColumnStats,
  type TitleCaseRunResult,
} from "./title-case-backfill";

/**
 * #1432 — the backfill's decisions, without a database. The DB-backed half (dry run writes
 * nothing, apply, re-run, undecryptable rows) is `title-case-backfill.db.test.ts`.
 */
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 8).toString("base64");
const identity = (s: string) => s;

describe("planValue — one stored value", () => {
  it("cases a lowercase plain value and leaves a correct one alone", () => {
    expect(planValue("cnc turner", identity)).toEqual({ kind: "change", cased: "Cnc Turner" });
    expect(planValue("electrician", identity)).toEqual({ kind: "change", cased: "Electrician" });
    // The two the issue names, which INITCAP would have broken.
    expect(planValue("RVM CAD", identity)).toEqual({ kind: "unchanged" });
    expect(planValue("CNC Operator", identity)).toEqual({ kind: "unchanged" });
  });

  it("decrypts an encrypted value to decide, and hands back PLAINTEXT to encode", () => {
    const codec = piiCodec(KEY, null);
    const token = encryptPii("recursive global infotech pvt ltd", KEY);
    expect(planValue(token, (s) => codec.decrypt(s))).toEqual({
      kind: "change",
      cased: "Recursive Global Infotech Pvt Ltd",
    });
    expect(planValue(encryptPii("RVM CAD", KEY), (s) => codec.decrypt(s))).toEqual({
      kind: "unchanged",
    });
  });

  it("calls a token it cannot open undecryptable — never an abort, never a guess", () => {
    const codec = piiCodec(KEY, null);
    expect(planValue(encryptPii("acme", OTHER_KEY), (s) => codec.decrypt(s))).toEqual({
      kind: "undecryptable",
    });
    expect(planValue("v1.not.a.token", (s) => codec.decrypt(s))).toEqual({ kind: "undecryptable" });
    expect(planValue("plaintext that was never encrypted", (s) => codec.decrypt(s))).toEqual({
      kind: "undecryptable",
    });
  });

  it("is idempotent — a value it produced is unchanged on the next run", () => {
    for (const raw of ["rvm cad pvt lt", "mCA institute", "govt  iti", "3d cad institute"]) {
      const first = planValue(raw, identity);
      expect(first.kind).toBe("change");
      if (first.kind === "change")
        expect(planValue(first.cased, identity)).toEqual({ kind: "unchanged" });
    }
  });
});

describe("the targets", () => {
  // buildTargets only builds closures; nothing touches the handle until a target is called.
  const targets = buildTargets({} as Database);

  it("are exactly the three columns #1432 names, in the order the summary prints them", () => {
    expect(targets.map((t) => t.name)).toEqual([...TITLE_CASE_COLUMNS]);
  });

  it("re-encrypt exactly the one AES-256-GCM column, and only it", () => {
    expect(targets.filter((t) => t.encrypted).map((t) => t.name)).toEqual([
      "worker_employment.employer_name_enc",
    ]);
  });
});

describe("parseTitleCaseCli", () => {
  it("defaults to a DRY RUN over all three columns", () => {
    expect(parseTitleCaseCli([])).toEqual({
      apply: false,
      batchSize: 500,
      columns: null,
      keyringNewlyArmed: false,
    });
  });

  it("writes only on an explicit --apply", () => {
    expect(parseTitleCaseCli(["--apply"]).apply).toBe(true);
    expect(parseTitleCaseCli(["--", "--apply"]).apply).toBe(true);
  });

  it("leaves the production flag to the ops guard rather than rejecting it", () => {
    expect(parseTitleCaseCli(["--apply", PRODUCTION_WRITE_FLAG]).apply).toBe(true);
  });

  it("takes the newly-armed acknowledgement only when spelled out", () => {
    expect(parseTitleCaseCli(["--apply", NEWLY_ARMED_FLAG]).keyringNewlyArmed).toBe(true);
    expect(parseTitleCaseCli(["--apply"]).keyringNewlyArmed).toBe(false);
    expect(() => parseTitleCaseCli(["--keyring-newly-armed"])).toThrow("unknown argument");
  });

  it("bounds --batch-size", () => {
    expect(parseTitleCaseCli(["--batch-size=1"]).batchSize).toBe(1);
    expect(parseTitleCaseCli(["--batch-size=10000"]).batchSize).toBe(10000);
    for (const bad of ["0", "10001", "1.5", "abc", "", "-3"]) {
      expect(() => parseTitleCaseCli([`--batch-size=${bad}`]), bad).toThrow("--batch-size");
    }
  });

  it("scopes with --column, and refuses a name it does not know", () => {
    expect(
      parseTitleCaseCli(["--column=worker_education.field,worker_employment_role.role_label"])
        .columns,
    ).toEqual(["worker_education.field", "worker_employment_role.role_label"]);
    expect(
      parseTitleCaseCli(["--column=worker_education.field,worker_education.field"]).columns,
    ).toEqual(["worker_education.field"]);
    expect(() => parseTitleCaseCli(["--column=worker_education.institute"])).toThrow(
      "unknown: worker_education.institute",
    );
    expect(() => parseTitleCaseCli(["--column="])).toThrow("--column takes");
  });

  it("FAILS CLOSED on an unknown flag — a typo must not widen an --apply", () => {
    // `--colum=` is the dangerous one: silently ignored, it would apply to all three columns.
    expect(() => parseTitleCaseCli(["--apply", "--colum=worker_education.field"])).toThrow(
      'unknown argument "--colum=worker_education.field"',
    );
    expect(() => parseTitleCaseCli(["--aply"])).toThrow("unknown argument");
  });
});

describe("the write key — refusing to write v2 the API cannot read", () => {
  const keyring = { activeKid: "api-2026", keys: { "api-2026": KEY } };
  const codec = piiCodec(OTHER_KEY, keyring);
  const decrypt = (t: string) => codec.decrypt(t);
  const opens = encryptPiiWithKeyring("+919800000001", keyring);
  /** The same kid NAME minted under another key — a dev .env that reused the API's kid. */
  const sameKidOtherKey = encryptPiiWithKeyring("+919800000002", {
    activeKid: "api-2026",
    keys: { "api-2026": OTHER_KEY },
  });

  it("is proven only by a stored token under the active kid that this run's key opens", () => {
    expect(judgeWriteKey([opens], decrypt, false)).toBe("proven");
    // One tampered or foreign token is not a verdict while another one opens.
    expect(judgeWriteKey([sameKidOtherKey, opens], decrypt, false)).toBe("proven");
  });

  it("refuses an unproven kid unless the operator acknowledges it is newly armed", () => {
    expect(judgeWriteKey([], decrypt, false)).toBe("no-token");
    expect(judgeWriteKey([], decrypt, true)).toBe("acknowledged");
    expect(writeKeyProblem("no-token")).toContain(NEWLY_ARMED_FLAG);
    expect(writeKeyProblem("acknowledged")).toBeNull();
  });

  it("refuses a different key behind the same kid, whatever the flags say", () => {
    expect(judgeWriteKey([sameKidOtherKey], decrypt, false)).toBe("key-mismatch");
    expect(judgeWriteKey([sameKidOtherKey], decrypt, true)).toBe("key-mismatch");
    expect(writeKeyProblem("key-mismatch")).toContain("does not override");
  });

  it("lets a run with nothing new to prove through", () => {
    expect(writeKeyProblem("not-applicable")).toBeNull();
    expect(writeKeyProblem("proven")).toBeNull();
  });

  it("names neither the kid nor any key in a refusal", () => {
    for (const check of ["no-token", "key-mismatch"] as const) {
      const message = writeKeyProblem(check)!;
      expect(message).not.toContain("api-2026");
      expect(message).not.toContain(KEY);
    }
  });

  it("says where the keyring came from — the shell, or dotenv's fill-in from the root .env", () => {
    expect(keyringSourceOf({ keys: true, kid: true })).toBe("shell");
    expect(keyringSourceOf({ keys: false, kid: false })).toBe("env-file");
    expect(keyringSourceOf({ keys: true, kid: false })).toBe("mixed");
    expect(writeFormatLabel(null)).toBe("writes v1 (legacy key, no keyring)");
    expect(writeFormatLabel("shell")).toBe("writes v2 (keyring armed, from the shell)");
    expect(writeFormatLabel("env-file")).toContain("from the root .env, not the shell");
  });
});

describe("canSeeForcedRlsRows — refusing the false all-clear", () => {
  it("lets a superuser or a BYPASSRLS role through, and nothing else", () => {
    expect(canSeeForcedRlsRows({ rolsuper: true, rolbypassrls: false })).toBe(true);
    expect(canSeeForcedRlsRows({ rolsuper: false, rolbypassrls: true })).toBe(true);
    expect(canSeeForcedRlsRows({ rolsuper: false, rolbypassrls: false })).toBe(false);
  });
});

describe("output never carries a value", () => {
  const stats = (over: Partial<ColumnStats>): ColumnStats => ({
    scanned: 0,
    unchanged: 0,
    change: 0,
    undecryptable: 0,
    written: 0,
    concurrentSkipped: 0,
    ...over,
  });
  const result: TitleCaseRunResult = {
    columns: [
      {
        name: "worker_employment.employer_name_enc",
        stats: stats({ scanned: 4, unchanged: 1, change: 2, undecryptable: 1, written: 2 }),
      },
      {
        name: "worker_employment_role.role_label",
        stats: stats({ scanned: 3, change: 3, written: 2, concurrentSkipped: 1 }),
      },
      { name: "worker_education.field", stats: stats({ scanned: 2, unchanged: 2 }) },
    ],
    workersAffected: 3,
    employerNameWrites: "v2",
    writeKey: "proven",
  };

  it("prints counts per column, and the workers-affected count", () => {
    const dry = formatSummary(result, false).join("\n");
    expect(dry).toMatch(/worker_employment\.employer_name_enc\s+4\s+1\s+2\s+1/);
    expect(dry).toMatch(/worker_education\.field\s+2\s+2\s+0\s+0/);
    expect(dry).toContain("workers with at least one changing value: 3");
    expect(dry).toContain("DRY RUN — 5 value(s) would change");
    expect(dry).not.toContain("written");
  });

  it("reports what an --apply wrote and what it left for a re-run", () => {
    const applied = formatSummary(result, true).join("\n");
    expect(applied).toMatch(/worker_employment_role\.role_label\s+3\s+0\s+3\s+0\s+2\s+1/);
    expect(applied).toContain("APPLY complete — 4/5 value(s) written; 1 changed since read");
    expect(applied).toContain("NOT re-rendered");
  });

  it("says so plainly when there is nothing to do", () => {
    const none: TitleCaseRunResult = {
      columns: [{ name: "worker_education.field", stats: stats({ scanned: 2, unchanged: 2 }) }],
      workersAffected: 0,
      employerNameWrites: null,
      writeKey: "not-applicable",
    };
    const text = formatSummary(none, false).join("\n");
    expect(text).toContain("nothing to change");
    // Employer names out of scope: no write format to state.
    expect(text).not.toContain("employer names:");
  });

  it("states the employer-name write format and what proves the API can read it", () => {
    const line = (over: Pick<TitleCaseRunResult, "employerNameWrites" | "writeKey">) =>
      formatSummary({ ...result, ...over }, false).find((l) => l.includes("employer names:"));
    expect(line({ employerNameWrites: "v2", writeKey: "proven" })).toContain(
      "writes v2 under the keyring's active kid — a stored token under that kid decrypts",
    );
    expect(line({ employerNameWrites: "v2", writeKey: "no-token" })).toContain(
      "an --apply refuses",
    );
    expect(line({ employerNameWrites: "v2", writeKey: "acknowledged" })).toContain(
      NEWLY_ARMED_FLAG,
    );
    expect(line({ employerNameWrites: "v1", writeKey: "not-applicable" })).toContain(
      "writes v1 (legacy key, no keyring)",
    );
  });

  /** A drizzle 0.45 query error, as the driver builds it: the PARAMS are in the message. */
  const queryError = (): Error => {
    const err = new Error(
      'Failed query: update "worker_employment_role" set "role_label" = $1 where ...\nparams: Sandhar Technologies,cnc turner',
    ) as Error & { query: string; params: unknown[]; cause: unknown };
    err.name = "DrizzleQueryError";
    err.query = 'update "worker_employment_role" set "role_label" = $1 where ...';
    err.params = ["Sandhar Technologies", "cnc turner"];
    err.cause = Object.assign(new Error('violates check constraint "wer_role_label_chk"'), {
      code: "23514",
    });
    return err;
  };

  it("describes a failed write by its SQLSTATE and withholds the driver message", () => {
    const line = describeDbFailure(queryError());
    expect(line).toContain("SQLSTATE 23514");
    expect(line).not.toContain("Sandhar");
    expect(line).not.toContain("cnc turner");
  });

  it("the CLI's fatal line withholds a query error's values, and keeps its own refusals readable", () => {
    const line = safeErrorLine(queryError());
    expect(line).toContain("SQLSTATE 23514");
    expect(line).not.toContain("Sandhar");
    expect(safeErrorLine(new Error("[backfill:title-case] REFUSING TO WRITE. …"))).toBe(
      "[backfill:title-case] REFUSING TO WRITE. …",
    );
  });
});
