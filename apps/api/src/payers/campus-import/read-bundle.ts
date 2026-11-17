/**
 * #2754 — read and check a Campus company export bundle (RVMBeyond_jobportal#156, format v1).
 *
 * The checks run in this order, and the first failure stops the read:
 *   1. `manifest.json` parses and names this format and version, and says it was read-only.
 *   2. Every file the importer needs is listed in the manifest and present on disk.
 *   3. Each file's bytes hash to the manifest's sha256, and its line count equals `records`.
 *      A bundle edited by hand, truncated in transit or mixed from two runs fails here.
 *   4. Every line parses as JSON and matches its record schema.
 *   5. Cross-file references hold: every login, job and plan line names an exported company,
 *      every application names an exported job of that same company.
 *
 * ERRORS NEVER CARRY A VALUE. A failure names the file, the line number and the field path only:
 * the bundle holds names, phones and emails, and an error message ends up in a terminal log.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  CAMPUS_BUNDLE_FILES,
  RECORD_SCHEMAS,
  manifestSchema,
  type CampusBundle,
  type CampusBundleFile,
} from "./bundle.schema";

export class CampusBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampusBundleError";
  }
}

/** Reads a file's bytes. Injected so the checks can be tested without touching the disk. */
export type ReadBytes = (path: string) => Buffer;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The zod issues of one record, as paths only (`gst.gstin: invalid_type`), never values. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(record)"}: ${i.code}`)
    .join("; ");
}

function parseLines<S extends z.ZodTypeAny>(
  file: CampusBundleFile,
  text: string,
  schema: S,
): z.infer<S>[] {
  const out: z.infer<S>[] = [];
  const lines = text.split("\n");
  // Campus ends a non-empty file with one newline; a final empty string is that newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, i) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new CampusBundleError(`${file} line ${i + 1}: not valid JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CampusBundleError(`${file} line ${i + 1}: ${describeIssues(parsed.error)}`);
    }
    out.push(parsed.data);
  });
  return out;
}

/** The record count of a JSON Lines text, as Campus counts it (one record per line). */
function lineCount(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

export function readCampusBundle(dir: string, readBytes: ReadBytes = readFileSync): CampusBundle {
  let manifestBytes: Buffer;
  try {
    manifestBytes = readBytes(join(dir, "manifest.json"));
  } catch {
    throw new CampusBundleError("manifest.json: cannot be read in the bundle folder");
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new CampusBundleError("manifest.json: not valid JSON");
  }
  const manifestParsed = manifestSchema.safeParse(manifestJson);
  if (!manifestParsed.success) {
    throw new CampusBundleError(`manifest.json: ${describeIssues(manifestParsed.error)}`);
  }
  const manifest = manifestParsed.data;

  const texts = {} as Record<CampusBundleFile, string>;
  for (const file of CAMPUS_BUNDLE_FILES) {
    const info = manifest.files[file];
    if (!info) throw new CampusBundleError(`manifest.json: does not list ${file}`);
    let bytes: Buffer;
    try {
      bytes = readBytes(join(dir, file));
    } catch {
      throw new CampusBundleError(`${file}: listed in the manifest but cannot be read`);
    }
    if (sha256(bytes) !== info.sha256) {
      throw new CampusBundleError(`${file}: sha256 does not match the manifest`);
    }
    const text = bytes.toString("utf8");
    if (lineCount(text) !== info.records) {
      throw new CampusBundleError(
        `${file}: ${lineCount(text)} records on disk, the manifest says ${info.records}`,
      );
    }
    texts[file] = text;
  }

  const bundle: CampusBundle = {
    manifest,
    manifestSha256: sha256(manifestBytes),
    companies: parseLines("companies.jsonl", texts["companies.jsonl"], RECORD_SCHEMAS["companies.jsonl"]),
    logins: parseLines("logins.jsonl", texts["logins.jsonl"], RECORD_SCHEMAS["logins.jsonl"]),
    jobs: parseLines("jobs.jsonl", texts["jobs.jsonl"], RECORD_SCHEMAS["jobs.jsonl"]),
    applications: parseLines(
      "applications.jsonl",
      texts["applications.jsonl"],
      RECORD_SCHEMAS["applications.jsonl"],
    ),
    unusedPlans: parseLines(
      "unused_plans.jsonl",
      texts["unused_plans.jsonl"],
      RECORD_SCHEMAS["unused_plans.jsonl"],
    ),
    problems: parseLines("problems.jsonl", texts["problems.jsonl"], RECORD_SCHEMAS["problems.jsonl"]),
  };
  checkReferences(bundle);
  return bundle;
}

/** Step 5: every reference between files points at a record of the same bundle. */
export function checkReferences(bundle: CampusBundle): void {
  const companyIds = new Set<string>();
  bundle.companies.forEach((c, i) => {
    if (companyIds.has(c.source_id)) {
      throw new CampusBundleError(`companies.jsonl line ${i + 1}: source_id appears twice`);
    }
    companyIds.add(c.source_id);
  });
  bundle.logins.forEach((l, i) => {
    if (!companyIds.has(l.company_source_id)) {
      throw new CampusBundleError(`logins.jsonl line ${i + 1}: company_source_id is not exported`);
    }
  });
  const jobCompany = new Map<string, string>();
  bundle.jobs.forEach((j, i) => {
    if (!companyIds.has(j.company_source_id)) {
      throw new CampusBundleError(`jobs.jsonl line ${i + 1}: company_source_id is not exported`);
    }
    if (jobCompany.has(j.source_id)) {
      throw new CampusBundleError(`jobs.jsonl line ${i + 1}: source_id appears twice`);
    }
    jobCompany.set(j.source_id, j.company_source_id);
  });
  const applicationIds = new Set<string>();
  bundle.applications.forEach((a, i) => {
    const owner = jobCompany.get(a.job_source_id);
    if (owner === undefined) {
      throw new CampusBundleError(`applications.jsonl line ${i + 1}: job_source_id is not exported`);
    }
    if (owner !== a.company_source_id) {
      throw new CampusBundleError(
        `applications.jsonl line ${i + 1}: company_source_id is not the job's company`,
      );
    }
    if (applicationIds.has(a.source_id)) {
      throw new CampusBundleError(`applications.jsonl line ${i + 1}: source_id appears twice`);
    }
    applicationIds.add(a.source_id);
  });
  const planKeys = new Set<string>();
  bundle.unusedPlans.forEach((p, i) => {
    if (planKeys.has(p.key)) {
      throw new CampusBundleError(`unused_plans.jsonl line ${i + 1}: key appears twice`);
    }
    planKeys.add(p.key);
    if (p.line !== "payment_never_registered" && (!p.company_source_id || !companyIds.has(p.company_source_id))) {
      throw new CampusBundleError(
        `unused_plans.jsonl line ${i + 1}: company_source_id is not exported`,
      );
    }
  });
}
