import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, workerResumeImports, workers, type DbClient } from "@badabhai/db";

import { ResumeImportRepository } from "./resume-import.repository";

/**
 * The settle and the failure guard, against a REAL Postgres (amended 2026-09-15).
 *
 * WHY IT HAS TO BE A REAL DATABASE. The fix is ONE UPDATE that must satisfy five `wri_*` CHECKs
 * at once and must write NOTHING when the row has left `parsing`. Both are properties of the
 * engine: a fake can copy the CHECKs, but only Postgres can prove the copy is faithful, and
 * only a real `RETURNING` proves the zero-row path that entitles a caller to emit.
 *
 * THE VACUITY CHECK IS THE LAST TEST. It performs the split write the settle replaced and
 * expects `wri_suggestions_chk` to refuse it — so a green run proves the CHECKs were live, not
 * that a migration was missing and every write sailed through.
 *
 * NOT YET ON CI'S DB-GATE LIST. `.github/workflows/ci.yml` runs a HAND-LISTED set of DB suites
 * with `RUN_DB_TESTS=1` (step "DB-backed gates"); this file is not among them, so today it runs
 * locally and in review only. Adding it there is a follow-up, and until it lands the guards are
 * held in CI by `*.query.test.ts`, which compiles the same statements without a connection and
 * maps the row counts — this file is the half that needs the engine.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:migrate                       # 0105 must be applied
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run src/profiling/resume-import/resume-import.repository.db.test.ts
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const WORKER = "00000000-0000-4000-8000-00000000a141";
const FACTS_OCR = { extractionMethod: "ocr" as const, pageCount: 2, ocrConfidence: 0.81 };
const FORM = { route: "form" as const, formKind: "cnc_turner", suggestionsEnc: "v1:sealed" };

describe.skipIf(!RUN)("ResumeImportRepository settle + failure guards (migration 0105)", () => {
  let client!: DbClient;
  let repo!: ResumeImportRepository;
  let seq = 0;

  async function importRow(status: "uploaded" | "parsing" = "parsing"): Promise<string> {
    seq += 1;
    const row = await repo.create({
      workerId: WORKER,
      storageKey: `resume-uploads/${WORKER}/db-test-${process.pid}-${seq}.pdf`,
      mime: "application/pdf",
      byteSize: 1024,
    });
    if (status === "parsing") expect(await repo.markParsing(row.id)).toBe(true);
    return row.id;
  }

  async function read(id: string) {
    const [row] = await client.db
      .select()
      .from(workerResumeImports)
      .where(eq(workerResumeImports.id, id));
    return row!;
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new ResumeImportRepository(client.db);
    // The imports go with the worker (`ON DELETE CASCADE`), so one delete clears any debris a
    // crashed previous run left behind.
    await client.db.delete(workers).where(eq(workers.id, WORKER));
    await client.db.insert(workers).values({
      id: WORKER,
      phoneE164: "v1.resume-import-db-test",
      phoneHash: `resume-import-db-test-${WORKER}`,
      status: "active" as const,
    });
  });

  afterAll(async () => {
    await client.db.delete(workers).where(eq(workers.id, WORKER));
    await client.sql.end();
  });

  beforeEach(() => {
    expect(RUN).toBe(true);
  });

  it("the settle passes every real CHECK, writing status, route and facts in one statement", async () => {
    const id = await importRow();

    const wrote = await repo.withTransaction((tx) => repo.settleParsed(id, FACTS_OCR, FORM, tx));

    expect(wrote).toBe(true);
    expect(await read(id)).toMatchObject({
      status: "parsed",
      route: "form",
      formKind: "cnc_turner",
      suggestionsEnc: "v1:sealed",
      extractionMethod: "ocr",
      pageCount: 2,
      failureReason: null,
    });
    expect((await read(id)).ocrConfidence).toBeCloseTo(0.81, 5);
  });

  it("a chat settle with a stray form kind stores none — the equivalence CHECK would refuse it", async () => {
    const id = await importRow();
    const wrote = await repo.withTransaction((tx) =>
      repo.settleParsed(
        id,
        { extractionMethod: "pdf_text", pageCount: 1, ocrConfidence: 0.5 },
        { route: "chat", formKind: "cnc_turner", suggestionsEnc: null },
        tx,
      ),
    );
    expect(wrote).toBe(true);
    expect(await read(id)).toMatchObject({ route: "chat", formKind: null, ocrConfidence: null });
  });

  it("a SECOND settle writes nothing and returns false", async () => {
    const id = await importRow();
    await repo.withTransaction((tx) => repo.settleParsed(id, FACTS_OCR, FORM, tx));

    const again = await repo.withTransaction((tx) =>
      repo.settleParsed(
        id,
        { extractionMethod: "pdf_text", pageCount: 1, ocrConfidence: null },
        { route: "chat", formKind: null, suggestionsEnc: null },
        tx,
      ),
    );

    expect(again).toBe(false);
    expect(await read(id)).toMatchObject({ route: "form", extractionMethod: "ocr" });
  });

  it("a settle on a row that never left `uploaded` writes nothing — the guard is `parsing`, not `not parsed`", async () => {
    const id = await importRow("uploaded");
    expect(await repo.withTransaction((tx) => repo.settleParsed(id, FACTS_OCR, FORM, tx))).toBe(false);
    expect((await read(id)).status).toBe("uploaded");
  });

  it("`markFailed` on a PARSED row writes nothing — a late failure never overwrites a route", async () => {
    const id = await importRow();
    await repo.withTransaction((tx) => repo.settleParsed(id, FACTS_OCR, FORM, tx));

    const failed = await repo.withTransaction((tx) =>
      repo.markFailed(id, "parse_unavailable", null, tx),
    );

    expect(failed).toBe(false);
    expect(await read(id)).toMatchObject({ status: "parsed", route: "form", failureReason: null });
  });

  it("`markFailed` on a parsing row settles it, and a later settle cannot resurrect it", async () => {
    const id = await importRow();
    expect(
      await repo.withTransaction((tx) => repo.markFailed(id, "parse_output_invalid", null, tx)),
    ).toBe(true);
    expect(await repo.withTransaction((tx) => repo.settleParsed(id, FACTS_OCR, FORM, tx))).toBe(
      false,
    );
    expect(await read(id)).toMatchObject({
      status: "failed",
      failureReason: "parse_output_invalid",
      route: null,
    });
  });

  it("a throw after the settle, inside the transaction, rolls the settle back to `parsing`", async () => {
    // What makes emit-in-the-same-transaction mean anything: an event insert that fails must
    // take the status with it.
    const id = await importRow();
    await expect(
      repo.withTransaction(async (tx) => {
        await repo.settleParsed(id, FACTS_OCR, FORM, tx);
        throw new Error("emit refused");
      }),
    ).rejects.toThrow("emit refused");
    expect(await read(id)).toMatchObject({ status: "parsing", route: null, suggestionsEnc: null });
  });

  it("VACUITY: the split write the settle replaced is refused by `wri_suggestions_chk`", async () => {
    // If this passes, the CHECKs are live — and the settle's success above is evidence, not a
    // table with no constraints accepting anything.
    const id = await importRow();
    let caught: unknown;
    try {
      await client.db
        .update(workerResumeImports)
        .set({ route: "form", formKind: "cnc_turner", suggestionsEnc: "v1:sealed" })
        .where(eq(workerResumeImports.id, id));
    } catch (error) {
      caught = error;
    }
    const text = `${String(caught)} ${JSON.stringify((caught as { cause?: unknown })?.cause ?? {})}`;
    expect(text).toContain("wri_suggestions_chk");
  });
});
