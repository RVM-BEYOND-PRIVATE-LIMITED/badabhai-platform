/**
 * #2887 — move RVM students from Campus's export into BadaBhai (ADR-0067; how to run it:
 * docs/api/student-import-cli.md).
 *
 *   Dry run (the default; reads, writes nothing, prints the report), after a build:
 *     CAMPUS_EXPORT_PASSPHRASE=… node apps/api/dist/workers/import-campus-students.cli.js
 *       --bundle <folder> [--report out.json]
 *   Apply:      … --bundle <folder> --apply --batch "bulk move 1"
 *   Nightly:    … --bundle <since-folder> --since --apply --batch "nightly 2026-11-18"
 *   Roll back:  … --rollback <batch id>
 *
 * Writing (--apply, --rollback) needs STUDENT_MOVE_ENABLED=true and the 0182 tables, and against
 * production the ops guard's flag + env pair. The export passphrase comes ONLY from the
 * environment and is never printed.
 */
import { writeFile } from "node:fs/promises";
import type { ServerConfig } from "@badabhai/config";
import { createDbClient, enforceOpsGuard } from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { readCampusStudentBundle } from "../student-import/campus-student-bundle";
import { parseImportCampusStudentsArgs } from "../student-import/import-campus-students.args";
import {
  importCampusStudents,
  rollbackStudentImport,
  StudentImportRefused,
} from "../student-import/import-campus-students";

export const IMPORT_CAMPUS_STUDENTS_SCRIPT = "import-campus-students";

async function main(): Promise<void> {
  const args = parseImportCampusStudentsArgs(process.argv.slice(2));
  const mutating = args.kind === "rollback" || args.apply;
  const DATABASE_URL = process.env.DATABASE_URL;
  enforceOpsGuard({
    script: IMPORT_CAMPUS_STUDENTS_SCRIPT,
    env: process.env,
    connectionString: DATABASE_URL,
    argv: process.argv.slice(2),
    mutating,
  });
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (mutating && process.env.STUDENT_MOVE_ENABLED !== "true") {
    throw new StudentImportRefused(
      "STUDENT_MOVE_ENABLED is not true: turn the switch on before writing (a dry run needs no switch)",
    );
  }
  const client = createDbClient(DATABASE_URL, { max: 4 });
  try {
    if (args.kind === "rollback") {
      // The pattern of the other ops CLIs: the envelope's environment from NODE_ENV.
      const events = new EventsService(new EventsRepository(client.db), {
        NODE_ENV: process.env.NODE_ENV ?? "development",
      } as ServerConfig);
      const report = await rollbackStudentImport(client.db, args.batchId, events);
      console.log(JSON.stringify(report, null, 2));
      if (args.report) await writeFile(args.report, JSON.stringify(report, null, 2));
      return;
    }
    const passphrase = process.env.CAMPUS_EXPORT_PASSPHRASE ?? "";
    if (passphrase === "") throw new StudentImportRefused("CAMPUS_EXPORT_PASSPHRASE is not set");
    const crypto = new PiiCryptoService(process.env as unknown as ServerConfig);
    const bundle = await readCampusStudentBundle(args.bundle, passphrase);
    const report = await importCampusStudents(client.db, crypto, bundle, {
      apply: args.apply,
      batchLabel: args.batch,
      since: args.since,
      ...(args.limit !== null ? { limit: args.limit } : {}),
    });
    // The summary on stdout; the per-student list (ids only) in the report file.
    const { students, ...summary } = report;
    console.log(JSON.stringify({ ...summary, studentsListed: students.length }, null, 2));
    if (args.report) await writeFile(args.report, JSON.stringify(report, null, 2));
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(
    `[student-import] ${err instanceof Error ? `${err.name}: ${err.message}` : "failed"}`,
  );
  process.exitCode = 1;
});
