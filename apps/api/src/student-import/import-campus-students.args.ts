import { parseArgs } from "node:util";
import { PRODUCTION_WRITE_FLAG } from "@badabhai/db";

const WRITE_FLAG = PRODUCTION_WRITE_FLAG.replace(/^--/, "");

/** The import CLI's arguments, checked (#2887). */
export type ImportCampusStudentsArgs =
  | {
      readonly kind: "import";
      readonly bundle: string;
      readonly apply: boolean;
      readonly batch: string | null;
      readonly since: boolean;
      readonly report: string | null;
      readonly limit: number | null;
      readonly productionWrite: boolean;
    }
  | {
      readonly kind: "rollback";
      readonly batchId: string;
      readonly report: string | null;
      readonly productionWrite: boolean;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict: an unknown flag, a positional argument, or a combination that makes no sense is
 * refused with a message, before anything is read. The export passphrase is NEVER an argument
 * (it comes from `CAMPUS_EXPORT_PASSPHRASE`).
 */
export function parseImportCampusStudentsArgs(argv: readonly string[]): ImportCampusStudentsArgs {
  const { values, positionals } = parseArgs({
    // A package-script run may forward a leading `--`; it is not an argument.
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      bundle: { type: "string" },
      apply: { type: "boolean", default: false },
      batch: { type: "string" },
      since: { type: "boolean", default: false },
      rollback: { type: "string" },
      report: { type: "string" },
      limit: { type: "string" },
      [WRITE_FLAG]: { type: "boolean", default: false },
    },
  });
  if (positionals.length > 0) {
    throw new Error(`unexpected argument: ${positionals[0]}`);
  }
  const productionWrite = (values as Record<string, unknown>)[WRITE_FLAG] === true;
  const report = values.report ?? null;

  if (values.rollback !== undefined) {
    if (
      values.bundle !== undefined ||
      values.apply ||
      values.since ||
      values.batch !== undefined ||
      values.limit !== undefined
    ) {
      throw new Error("--rollback takes only a batch id (and --report)");
    }
    if (!UUID.test(values.rollback)) throw new Error("--rollback needs the batch id (a uuid)");
    return { kind: "rollback", batchId: values.rollback.toLowerCase(), report, productionWrite };
  }

  if (values.bundle === undefined || values.bundle.trim() === "") {
    throw new Error("--bundle <folder> is required");
  }
  const apply = values.apply === true;
  const batch = values.batch?.trim() ?? null;
  if (apply && !batch) throw new Error("--apply needs --batch <label>");
  if (batch !== null && (batch.length < 1 || batch.length > 120)) {
    throw new Error("--batch must be 1 to 120 characters");
  }
  let limit: number | null = null;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw new Error("--limit must be a whole number from 1 to 1000000");
    }
  }
  return {
    kind: "import",
    bundle: values.bundle,
    apply,
    batch,
    since: values.since === true,
    report,
    limit,
    productionWrite,
  };
}
