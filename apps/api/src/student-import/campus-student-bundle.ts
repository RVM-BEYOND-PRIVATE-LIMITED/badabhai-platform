import { createDecipheriv, createHash, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * #2887 — the reader for Campus's student export (bundle format v1,
 * RVMBeyond_jobportal `docs/api/student-export-bundle.md`, agreed on #2887 on 17 Nov 2026).
 *
 * A bundle is a folder: `manifest.json` (plain, counts only), `students.jsonl.enc` and
 * `problems.jsonl.enc` (each encrypted on its own). This module:
 *   1. validates the manifest (format `badabhai-campus-student-export`, version 1);
 *   2. derives the key with scrypt (N 32768, r 8, p 1) from the passphrase and the manifest's salt;
 *   3. decrypts each file ("BBX1" ‖ iv 12 ‖ ciphertext ‖ tag 16, AES-256-GCM) — a wrong
 *      passphrase or a damaged file fails the GCM tag and throws;
 *   4. checks the plain text's sha256 against the manifest before a single line is used;
 *   5. parses each line with a schema that is STRICT on the fields the import reads and lenient on
 *      the rest (a later Campus field never breaks the import; a malformed one we use is a
 *      per-line error, reported with its line number and Campus id, never a silent skip).
 *
 * The PASSPHRASE comes from the caller (the CLI reads `CAMPUS_EXPORT_PASSPHRASE` from the
 * environment): never an argument, never logged, never in an error message.
 */

export const STUDENT_BUNDLE_FORMAT = "badabhai-campus-student-export";
export const STUDENT_BUNDLE_VERSION = 1;
const MAGIC = Buffer.from("BBX1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

const SourceId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const MaybeString = z.string().nullish();
const StringList = z.array(z.string()).nullish();
const Months = z.number().nullish();

const FileEntry = z.object({
  records: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  encrypted_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const StudentBundleManifestSchema = z.looseObject({
  format: z.literal(STUDENT_BUNDLE_FORMAT),
  version: z.literal(STUDENT_BUNDLE_VERSION),
  generated_at: z.string(),
  read_only: z.literal(true),
  scope: z.union([
    z.looseObject({ students: z.literal("all") }),
    z.looseObject({ students: z.literal("since"), since: z.string() }),
    z.looseObject({ students: z.literal("list") }),
  ]),
  next_since: z.string().nullish(),
  counts: z.record(z.string(), z.unknown()),
  encryption: z.looseObject({
    scheme: z.literal("aes-256-gcm"),
    kdf: z.literal("scrypt"),
    N: z.literal(32768),
    r: z.literal(8),
    p: z.literal(1),
    salt: z.string().min(1),
  }),
  files: z.looseObject({
    "students.jsonl": FileEntry,
    "problems.jsonl": FileEntry,
  }),
});
export type StudentBundleManifest = z.infer<typeof StudentBundleManifestSchema>;

/** The phone classes Campus assigns (only `good` gets a BadaBhai login). */
export const CAMPUS_PHONE_CLASSES = [
  "good",
  "shared",
  "company_number",
  "not_mobile",
  "missing",
] as const;

export const CampusStudentLineSchema = z.looseObject({
  source_id: SourceId,
  student_ref: MaybeString,
  name: MaybeString,
  phone: z.looseObject({
    value: z
      .string()
      .regex(/^[6-9]\d{9}$/)
      .nullable(),
    class: z.enum(CAMPUS_PHONE_CLASSES),
  }),
  city: MaybeString,
  state: MaybeString,
  adult: z.boolean().nullable(),
  rvm: z
    .looseObject({
      status: z.enum(["current", "alumnus"]).nullish(),
      course: MaybeString,
      trade: MaybeString,
      branch: z.looseObject({ id: z.number().nullish(), name: MaybeString }).nullish(),
    })
    .nullish(),
  profile: z
    .looseObject({
      total_experience_months: Months,
      is_fresher: z.boolean().nullish(),
      skills: StringList,
      cad_software: StringList,
      certifications: StringList,
      industry: MaybeString,
      job_domain: MaybeString,
      job_role: MaybeString,
      preferred_locations: StringList,
    })
    .nullish(),
  experience: z
    .array(
      z.looseObject({
        source: MaybeString,
        company_name: MaybeString,
        job_role: MaybeString,
        job_domain: MaybeString,
        skills: StringList,
        duration_months: Months,
        is_current: z.boolean().nullish(),
        start_date: MaybeString,
        end_date: MaybeString,
      }),
    )
    .nullish(),
  skill_experience: z.array(z.looseObject({ skill: MaybeString, months: Months })).nullish(),
  certifications: z
    .array(
      z.looseObject({
        name: MaybeString,
        issuing_authority: MaybeString,
        issue_date: MaybeString,
      }),
    )
    .nullish(),
  rvm_certifications: z
    .array(
      z.looseObject({
        job_role: MaybeString,
        job_domain: MaybeString,
        skills: StringList,
        training_months: Months,
      }),
    )
    .nullish(),
  consent: z
    .looseObject({
      basis: MaybeString,
      campus_records: z
        .array(
          z.looseObject({
            purpose: MaybeString,
            text_version: MaybeString,
            source: MaybeString,
            given_at: MaybeString,
          }),
        )
        .nullish(),
    })
    .nullish(),
  changed_at: MaybeString,
});
export type CampusStudentLine = z.infer<typeof CampusStudentLineSchema>;

export const CampusProblemLineSchema = z.looseObject({
  kind: z.string().min(1),
  candidate_source_id: SourceId,
});
export type CampusProblemLine = z.infer<typeof CampusProblemLineSchema>;

/** One student line, parsed, with what makes a re-run idempotent. */
export interface ParsedStudentLine {
  readonly lineNo: number;
  readonly student: CampusStudentLine;
  /** sha256 of the line's canonical JSON (keys sorted): an unchanged record hashes the same. */
  readonly contentHash: string;
}

/** A line the schema refused: never imported, always reported. */
export interface StudentLineError {
  readonly lineNo: number;
  /** The Campus id, when the line had a readable one. */
  readonly sourceId: string | null;
  readonly issues: readonly string[];
}

export interface CampusStudentBundle {
  readonly manifest: StudentBundleManifest;
  readonly students: readonly ParsedStudentLine[];
  readonly lineErrors: readonly StudentLineError[];
  readonly problems: readonly CampusProblemLine[];
}

/** Refused before anything is read: a wrong passphrase, a damaged file, a hash mismatch. */
export class StudentBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudentBundleError";
  }
}

export function deriveBundleKey(passphrase: string, saltBase64: string): Buffer {
  if (passphrase.length === 0) throw new StudentBundleError("the export passphrase is empty");
  return scryptSync(passphrase, Buffer.from(saltBase64, "base64"), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

/** Decrypts one `.jsonl.enc` file. Throws `StudentBundleError` on a bad layout or a failed tag. */
export function decryptBundleFile(file: Buffer, key: Buffer, name: string): string {
  if (file.length < MAGIC.length + IV_BYTES + TAG_BYTES || !file.subarray(0, 4).equals(MAGIC)) {
    throw new StudentBundleError(`${name}: not a BBX1 file`);
  }
  const iv = file.subarray(4, 4 + IV_BYTES);
  const tag = file.subarray(file.length - TAG_BYTES);
  const body = file.subarray(4 + IV_BYTES, file.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Never the passphrase or the key in the message.
    throw new StudentBundleError(`${name}: decryption failed (wrong passphrase or damaged file)`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with object keys sorted at every level: one record always hashes to one value. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function lines(text: string): { lineNo: number; raw: string }[] {
  return text
    .split("\n")
    .map((raw, i) => ({ lineNo: i + 1, raw: raw.trim() }))
    .filter((l) => l.raw.length > 0);
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(line)"}: ${i.message}`);
}

/** Parses decrypted `students.jsonl` text. Exported for the tests. */
export function parseStudentLines(text: string): {
  students: ParsedStudentLine[];
  lineErrors: StudentLineError[];
} {
  const students: ParsedStudentLine[] = [];
  const lineErrors: StudentLineError[] = [];
  const seen = new Set<string>();
  for (const { lineNo, raw } of lines(text)) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      lineErrors.push({ lineNo, sourceId: null, issues: ["not valid JSON"] });
      continue;
    }
    const sourceId =
      json !== null &&
      typeof json === "object" &&
      typeof (json as { source_id?: unknown }).source_id === "string"
        ? (json as { source_id: string }).source_id
        : null;
    const parsed = CampusStudentLineSchema.safeParse(json);
    if (!parsed.success) {
      lineErrors.push({ lineNo, sourceId, issues: issuesOf(parsed.error) });
      continue;
    }
    if (seen.has(parsed.data.source_id)) {
      lineErrors.push({ lineNo, sourceId, issues: ["source_id appears twice in the bundle"] });
      continue;
    }
    seen.add(parsed.data.source_id);
    students.push({ lineNo, student: parsed.data, contentHash: sha256Hex(canonicalJson(json)) });
  }
  return { students, lineErrors };
}

/** Parses decrypted `problems.jsonl` text; a malformed problem line is dropped from the counts. */
export function parseProblemLines(text: string): CampusProblemLine[] {
  const out: CampusProblemLine[] = [];
  for (const { raw } of lines(text)) {
    try {
      const parsed = CampusProblemLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A broken problem line only lowers a count in the report; it never blocks the import.
    }
  }
  return out;
}

/** Reads, decrypts, verifies and parses a whole bundle folder. */
export async function readCampusStudentBundle(
  dir: string,
  passphrase: string,
): Promise<CampusStudentBundle> {
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new StudentBundleError("manifest.json is missing or not JSON");
  }
  const manifest = StudentBundleManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    throw new StudentBundleError(
      `manifest.json is not a v1 student export: ${issuesOf(manifest.error).join("; ")}`,
    );
  }
  const key = deriveBundleKey(passphrase, manifest.data.encryption.salt);

  const open = async (name: "students.jsonl" | "problems.jsonl"): Promise<string> => {
    let file: Buffer;
    try {
      file = await readFile(join(dir, `${name}.enc`));
    } catch {
      throw new StudentBundleError(`${name}.enc is missing`);
    }
    const expected = manifest.data.files[name];
    if (
      expected.encrypted_sha256 &&
      createHash("sha256").update(file).digest("hex") !== expected.encrypted_sha256
    ) {
      throw new StudentBundleError(`${name}.enc does not match the manifest's encrypted_sha256`);
    }
    const text = decryptBundleFile(file, key, name);
    if (sha256Hex(text) !== expected.sha256) {
      throw new StudentBundleError(`${name}: the plain text does not match the manifest's sha256`);
    }
    return text;
  };

  const { students, lineErrors } = parseStudentLines(await open("students.jsonl"));
  const problems = parseProblemLines(await open("problems.jsonl"));
  return { manifest: manifest.data, students, lineErrors, problems };
}
