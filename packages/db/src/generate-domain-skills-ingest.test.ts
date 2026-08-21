/**
 * `--ingest` AS A GATE, not as a reporter.
 *
 * The invariant under test, stated as the brief states it:
 *
 *   A CANDIDATE SET CONTAINING A DETECTED BLOCKING DUPLICATE MUST NOT BE PERSISTED MERELY
 *   BECAUSE THE BASIC SCHEMA VALIDATOR PASSES.
 *
 * "Persisted" has a precise meaning in this pipeline and it is why these tests touch a real
 * filesystem instead of asserting on a return value. The documented path from a batch to the
 * database is: `--ingest` writes `accepted-*.jsonl` -> a human appends those files to
 * `data/taxonomy/` -> `db:seed:domain-skills` writes rows. The FILE is the persistence step
 * a human acts on, so a gate that logs a failure and still writes `accepted-skills.jsonl`
 * has not gated anything — the next person follows the happy path in the docblock and
 * appends it.
 *
 * So every assertion below is about what is ON DISK afterwards. Both directions are pinned:
 * the duplicate batch must leave no `accepted-*`, and the clean batch must leave one, because
 * a gate that blocks everything is as useless as one that blocks nothing and is much harder
 * to notice.
 *
 * These run against the REAL committed corpus (`data/taxonomy`), which today holds 28 domains
 * and zero skills. That is deliberate: the candidates are then the only skills in scope, so a
 * finding cannot be an artifact of something already committed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBatchManifest, ingest, type BatchManifest } from "./generate-domain-skills";

const CNC_TURNING = "jd_nco_7223_6002";
const CNC_PROGRAMMER = "jd_nco_7223_6003";

let dir: string;

/** A batch directory in the shape `--emit-prompts` leaves behind. */
function seedBatchDir(responses: readonly unknown[]): void {
  const manifest = buildBatchManifest({
    batchId: "batch_test",
    generatedAt: new Date("2026-08-16T00:00:00.000Z"),
    domains: [CNC_TURNING, CNC_PROGRAMMER],
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(
    join(dir, "raw-responses.jsonl"),
    `${responses.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
}

function skillEntry(label: string, alias: string) {
  return {
    existing_skill_id: null,
    label_en: label,
    label_hi: null,
    aliases: [{ text: alias, lang: "en" }],
    requirement: "required",
    relevance: 80,
    confidence: 0.9,
  };
}

/**
 * Two labels that mean one thing and collide on NOTHING the validator checks. Word order
 * differs, so the normalized labels differ; the aliases are distinct strings. This is the
 * exact shape that passed every structural check and would have seeded two rows.
 */
const DUPLICATE_PAIR = [
  {
    job_domain_id: CNC_TURNING,
    skills: [skillEntry("Hydraulic Hose Crimping", "hose crimping")],
  },
  {
    job_domain_id: CNC_PROGRAMMER,
    skills: [skillEntry("Crimping Hydraulic Hose", "hydraulic crimping")],
  },
];

const CLEAN_SINGLE = [
  {
    job_domain_id: CNC_TURNING,
    skills: [skillEntry("Hydraulic Hose Crimping", "hose crimping")],
  },
];

function manifestOf(): BatchManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BatchManifest;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taxonomy-ingest-"));
  // The ingest is deliberately chatty — it is a CLI. Silenced so a failing assertion is
  // readable, never to hide a behaviour under test; every assertion reads the filesystem.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("a within-batch duplicate cannot reach the corpus", () => {
  it("BLOCKS, and writes NO accepted-*.jsonl for a human to append", () => {
    seedBatchDir(DUPLICATE_PAIR);
    const outcome = ingest([], dir);

    expect(outcome.blocked).toBe(true);
    expect(outcome.blockingCodes).toContain("MISSED_REUSE_WITHIN_BATCH");
    // THE INVARIANT. Not "a warning was printed" — the file the next step consumes is absent.
    expect(existsSync(join(dir, "accepted-skills.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "accepted-domain-skills.jsonl"))).toBe(false);
  });

  it("passed every STRUCTURAL check — which is exactly why the second gate exists", () => {
    seedBatchDir(DUPLICATE_PAIR);
    const outcome = ingest([], dir);
    // Zero rejections: both candidates are well-formed, resolvable, non-colliding. The
    // validator has nothing to say and the batch is still unfit.
    expect(outcome.rejectionCount).toBe(0);
    expect(outcome.acceptedSkillCount).toBe(2);
    expect(manifestOf().rejected_count).toBe(0);
    expect(manifestOf().quality_gate_verdict).toBe("BLOCK");
  });

  it("keeps the candidates under an honest name, so the finding is reviewable", () => {
    // Withholding is not hiding. A human who decides the gate is wrong can still act on
    // these — but they have to rename a file, which is a visible act, not the happy path.
    seedBatchDir(DUPLICATE_PAIR);
    ingest([], dir);
    const blocked = readFileSync(join(dir, "blocked-skills.jsonl"), "utf8");
    expect(blocked).toContain("Hydraulic Hose Crimping");
    expect(blocked).toContain("Crimping Hydraulic Hose");
    expect(existsSync(join(dir, "blocked-domain-skills.jsonl"))).toBe(true);
  });

  it("records the finding in quality-gate.json, with the evidence that produced it", () => {
    seedBatchDir(DUPLICATE_PAIR);
    ingest([], dir);
    const report = JSON.parse(readFileSync(join(dir, "quality-gate.json"), "utf8")) as {
      verdict: string;
      findings: { code: string; evidence: string[] }[];
    };
    expect(report.verdict).toBe("BLOCK");
    const finding = report.findings.find((f) => f.code === "MISSED_REUSE_WITHIN_BATCH");
    expect(finding?.evidence.some((e) => e.startsWith("WITHIN_BATCH:"))).toBe(true);
  });

  it("DELETES a previous run's accepted-*.jsonl rather than leaving it to be appended", () => {
    // The nastiest ordering: yesterday's batch passed, today's re-ingest fails. A stale
    // `accepted-skills.jsonl` sitting exactly where the instructions say to look, with no
    // indication it is superseded, is worse than never having written it.
    seedBatchDir(CLEAN_SINGLE);
    expect(ingest([], dir).blocked).toBe(false);
    expect(existsSync(join(dir, "accepted-skills.jsonl"))).toBe(true);

    seedBatchDir(DUPLICATE_PAIR);
    expect(ingest([], dir).blocked).toBe(true);
    expect(existsSync(join(dir, "accepted-skills.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "accepted-domain-skills.jsonl"))).toBe(false);
  });
});

describe("a clean batch is not obstructed", () => {
  it("PASSES and writes accepted-*.jsonl", () => {
    seedBatchDir(CLEAN_SINGLE);
    const outcome = ingest([], dir);

    expect(outcome.blocked).toBe(false);
    expect(outcome.blockingCodes).toEqual([]);
    expect(readFileSync(join(dir, "accepted-skills.jsonl"), "utf8")).toContain(
      "Hydraulic Hose Crimping",
    );
    expect(existsSync(join(dir, "blocked-skills.jsonl"))).toBe(false);
    expect(manifestOf().quality_gate_verdict).toBe("PASS");
  });

  it("still writes quality-gate.json on a pass — the report is not a failure artifact", () => {
    seedBatchDir(CLEAN_SINGLE);
    ingest([], dir);
    const report = JSON.parse(readFileSync(join(dir, "quality-gate.json"), "utf8")) as {
      verdict: string;
    };
    expect(report.verdict).toBe("PASS");
  });
});

describe("the manifest keeps the two failure modes apart", () => {
  it("a malformed candidate is a REJECTION; a duplicate set is a BLOCK", () => {
    // Conflating them would hide the more dangerous one: a batch can read `rejected_count: 0`
    // and still be unfit to persist.
    seedBatchDir([
      {
        job_domain_id: CNC_TURNING,
        // An invented id the catalogue never carried — the classic malformed candidate.
        skills: [
          { ...skillEntry("Coolant Management", "coolant"), existing_skill_id: "skill_not_real" },
        ],
      },
    ]);
    ingest([], dir);
    const m = manifestOf();
    expect(m.rejected_count).toBe(1);
    expect(Object.keys(m.rejections_by_reason ?? {})).toEqual(["INVENTED_SKILL_ID"]);
    expect(m.quality_gate_verdict).toBe("PASS");
  });
});
