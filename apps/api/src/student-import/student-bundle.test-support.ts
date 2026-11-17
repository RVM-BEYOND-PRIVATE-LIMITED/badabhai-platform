import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #2887 — writes a synthetic Campus student bundle exactly as the format doc describes (v1:
 * manifest.json, students.jsonl.enc, problems.jsonl.enc; scrypt + AES-256-GCM, "BBX1" ‖ iv ‖ ct ‖
 * tag), for the reader and import tests. Test support only: never in a real bundle path.
 */

export const TEST_PASSPHRASE = "correct horse battery staple";

export function encryptBundleText(text: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("BBX1", "ascii"), iv, body, cipher.getAuthTag()]);
}

export interface SyntheticBundleOptions {
  readonly students: readonly Record<string, unknown>[];
  readonly problems?: readonly Record<string, unknown>[];
  readonly scope?: Record<string, unknown>;
  readonly passphrase?: string;
  /** Corrupt the manifest's students sha256 (to test the refusal). */
  readonly badStudentsSha?: boolean;
  /** Raw students text instead of the JSON lines (to test per-line errors). */
  readonly rawStudentsText?: string;
}

export async function writeSyntheticBundle(opts: SyntheticBundleOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb2887-bundle-"));
  const salt = randomBytes(16);
  const key = scryptSync(opts.passphrase ?? TEST_PASSPHRASE, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const studentsText =
    opts.rawStudentsText ?? opts.students.map((s) => JSON.stringify(s)).join("\n") + "\n";
  const problemsText = (opts.problems ?? []).map((p) => JSON.stringify(p)).join("\n");
  const studentsEnc = encryptBundleText(studentsText, key);
  const problemsEnc = encryptBundleText(problemsText, key);
  const sha = (t: string | Buffer) => createHash("sha256").update(t).digest("hex");
  const manifest = {
    format: "badabhai-campus-student-export",
    version: 1,
    generated_at: "2026-11-17T18:00:00.000+05:30",
    read_only: true,
    source: { supabase_project_ref: "test" },
    scope: opts.scope ?? { students: "all" },
    next_since: "2026-11-17T17:50:00.000+05:30",
    counts: { students: opts.students.length },
    encryption: {
      scheme: "aes-256-gcm",
      kdf: "scrypt",
      N: 32768,
      r: 8,
      p: 1,
      salt: salt.toString("base64"),
    },
    files: {
      "students.jsonl": {
        records: opts.students.length,
        sha256: opts.badStudentsSha ? "0".repeat(64) : sha(studentsText),
        encrypted_sha256: sha(studentsEnc),
      },
      "problems.jsonl": {
        records: (opts.problems ?? []).length,
        sha256: sha(problemsText),
        encrypted_sha256: sha(problemsEnc),
      },
    },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "students.jsonl.enc"), studentsEnc);
  await writeFile(join(dir, "problems.jsonl.enc"), problemsEnc);
  return dir;
}

/** One synthetic student line in the v1 shape. */
export function syntheticStudent(
  sourceId: string,
  phone: string | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source_id: sourceId,
    student_ref: null,
    name: `Test Student ${sourceId}`,
    phone: { value: phone, class: phone ? "good" : "missing" },
    email: null,
    city: "Pune",
    state: "Maharashtra",
    pincode: null,
    adult: true,
    rvm: {
      status: "current",
      status_source: "legacy",
      course: "AutoCAD Mechanical",
      trade: null,
      branch: { id: 2, name: "Pune" },
      jobs_access: null,
    },
    profile: {
      total_experience_months: 18,
      is_fresher: false,
      current_role: null,
      skills: ["SolidWorks"],
      cad_software: ["AutoCAD"],
      certifications: [],
      industry: "Mechanical",
      job_domain: "Design Mechanical",
      job_role: "Product Design Engineer",
      preferred_job_types: ["full_time"],
      preferred_locations: ["Pune"],
    },
    experience: [
      {
        source_id: `${sourceId}-x1`,
        source: "manual_experience",
        company_name: "Synthetic Tools Pvt Ltd",
        industry: "Mechanical",
        job_domain: "Design Mechanical",
        job_role: "Product Design Engineer",
        skills: ["SolidWorks"],
        duration_months: 14,
        is_current: false,
        start_date: "2024-01-01",
        end_date: "2025-02-28",
      },
    ],
    skill_experience: [{ skill: "SolidWorks", months: 14 }],
    certifications: [
      {
        source_id: `${sourceId}-c1`,
        name: "GD&T Basics",
        issuing_authority: "NPTEL",
        issue_date: "2023",
      },
    ],
    rvm_certifications: [
      {
        source_id: `${sourceId}-r1`,
        job_role: "Product Design Engineer",
        skills: ["SolidWorks"],
        training_months: 4,
      },
    ],
    consent: {
      basis: "bulk_move_ruling",
      ruling: "badabhai-platform#2887, 17 Nov 2026",
      campus_records: [],
    },
    created_at: "2026-01-01T00:00:00.000+05:30",
    updated_at: "2026-11-01T00:00:00.000+05:30",
    changed_at: "2026-11-01T00:00:00.000+05:30",
    ...over,
  };
}
