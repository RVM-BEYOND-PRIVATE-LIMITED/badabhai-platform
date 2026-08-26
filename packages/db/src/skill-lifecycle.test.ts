/**
 * The skill / skill-alias lifecycle — and the assertions that keep it honest.
 *
 * Two groups matter more than the rest:
 *
 *   - **"nothing produces vocabulary unattended"**, which is the claim the whole model exists
 *     to make. If it ever fails, an ingestion route has become fully automatic and CLAUDE.md §3
 *     needs re-reading against it — mapping a phrase to a canonical id is a business decision.
 *   - **the writer scan**, which is checked against fabricated inputs as well as the real tree,
 *     because a scan that cannot fail proves nothing about the tree it passes on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  crossVocabularyWriters,
  scanWriters,
  sourceFiles,
  stripComments,
} from "./lifecycle-writer-scan";
import {
  LIFECYCLE,
  automaticPrefix,
  fullyAutomaticPaths,
  humanGates,
  reachesProductAutomatically,
  trafficDrivenPaths,
  validateLifecycle,
  type LifecyclePath,
  type LifecycleStep,
} from "./skill-lifecycle";

const SRC = __dirname;

const step = (o: Partial<LifecycleStep> & { id: string }): LifecycleStep => ({
  what: "w",
  actor: "OFFLINE_RUNNER",
  performedBy: "pnpm x",
  writes: "repository_file",
  ...o,
});

const path = (o: Partial<LifecyclePath> & { id: string }): LifecyclePath => ({
  title: "t",
  origin: "HAND_AUTHORED",
  produces: "repository_file",
  steps: [step({ id: `${o.id}.1` })],
  everCompleted: "n/a",
  ...o,
});

// ---------------------------------------------------------------------------
describe("validateLifecycle", () => {
  const writers = new Set(["seed-skills.ts"]);

  it("accepts a coherent path", () => {
    expect(validateLifecycle([path({ id: "A" })], writers)).toEqual([]);
  });

  it("refuses a path that claims to produce something no step writes", () => {
    // Otherwise `produces` is an aspiration and a reader cannot tell the difference.
    const p = validateLifecycle([path({ id: "A", produces: "skill_alias" })], writers);
    expect(p[0]?.problem).toMatch(/claims to produce skill_alias/);
  });

  it("refuses a runner that writes a table without naming its writer file", () => {
    const p = validateLifecycle(
      [path({ id: "A", produces: "skill_alias", steps: [step({ id: "A.1", writes: "skill_alias" })] })],
      writers,
    );
    expect(p[0]?.problem).toMatch(/names no writer file/);
  });

  it("refuses a writer file the source scan did not find", () => {
    const p = validateLifecycle(
      [
        path({
          id: "A",
          produces: "skill_alias",
          steps: [step({ id: "A.1", writes: "skill_alias", writerFile: "ghost.ts" })],
        }),
      ],
      writers,
    );
    expect(p[0]?.problem).toMatch(/names writer ghost\.ts/);
  });

  it("refuses a HUMAN or MODEL step that claims to write a table directly", () => {
    // A person writes files; a model writes proposals. Marking a table write as HUMAN would
    // hide an unguarded runner behind a person who is not actually typing SQL.
    for (const actor of ["HUMAN", "MODEL"] as const) {
      const p = validateLifecycle(
        [
          path({
            id: actor,
            produces: "skill",
            steps: [step({ id: `${actor}.1`, actor, writes: "skill" })],
          }),
        ],
        writers,
      );
      expect(p[0]?.problem, actor).toMatch(new RegExp(`actor ${actor} cannot write skill`));
    }
  });

  it("refuses duplicate ids and empty paths", () => {
    expect(validateLifecycle([path({ id: "A" }), path({ id: "A" })], writers)[0]?.problem).toMatch(
      /duplicate path id/,
    );
    expect(validateLifecycle([path({ id: "B", steps: [] })], writers)[0]?.problem).toMatch(
      /no steps/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("automaticPrefix", () => {
  it("stops at the first human, not the last", () => {
    const p = path({
      id: "A",
      steps: [
        step({ id: "1", actor: "RUNTIME" }),
        step({ id: "2", actor: "HUMAN" }),
        step({ id: "3", actor: "OFFLINE_RUNNER" }),
      ],
    });
    expect(automaticPrefix(p).map((s) => s.id)).toEqual(["1"]);
    expect(humanGates(p).map((s) => s.id)).toEqual(["2"]);
  });

  it("is the whole path when no person is involved", () => {
    const p = path({ id: "A", steps: [step({ id: "1", actor: "RUNTIME" })] });
    expect(automaticPrefix(p)).toHaveLength(1);
  });

  it("separates 'writes a table unattended' from 'produces its output unattended'", () => {
    // The distinction the growth loops turn on: the QUEUE fills by itself, the VOCABULARY
    // does not. Collapsing them reads as "the learning loop is automatic".
    const p = path({
      id: "GROWTH",
      produces: "skill_alias",
      steps: [
        step({ id: "1", actor: "RUNTIME", writes: "unresolved_phrase" }),
        step({ id: "2", actor: "HUMAN" }),
        step({ id: "3", writes: "skill_alias", writerFile: "seed-skills.ts" }),
      ],
    });
    expect(automaticPrefix(p)).toHaveLength(1);
    expect(reachesProductAutomatically(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the real lifecycle", () => {
  const scan = scanWriters(SRC);

  it("is coherent against the real source tree", () => {
    expect(validateLifecycle(LIFECYCLE, scan.writers)).toEqual([]);
  });

  it("declares five paths, three of which start from a worker utterance", () => {
    expect(LIFECYCLE).toHaveLength(5);
    expect(trafficDrivenPaths().map((p) => p.id)).toEqual([
      "P3-SKILL-GROWTH",
      "P4-OCCUPATION-GROWTH",
      "P5-MINING",
    ]);
  });

  it("NOT ONE PATH produces its vocabulary without a person", () => {
    // The headline. Coverage is a function of review cadence, not of traffic.
    for (const p of LIFECYCLE) {
      expect(reachesProductAutomatically(p), p.id).toBe(false);
      expect(humanGates(p).length, p.id).toBeGreaterThan(0);
    }
    expect(fullyAutomaticPaths()).toEqual([]);
  });

  it("and every traffic-driven path stalls at a mapping decision, not at a runner", () => {
    // The human gate is always "which canonical id does this phrase mean" — the one thing
    // §3 reserves for a person. Worth pinning: a future 'optimization' that removes it would
    // be removing the business decision, not a bottleneck.
    for (const p of trafficDrivenPaths()) {
      const firstGate = humanGates(p)[0]!;
      expect(firstGate.writes, p.id).toBe("repository_file");
    }
  });

  it("names only runners that exist", () => {
    const files = new Set(sourceFiles(SRC));
    for (const p of LIFECYCLE) {
      for (const s of p.steps) {
        if (s.writerFile !== undefined) expect(files.has(s.writerFile), s.id).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("the writer scan", () => {
  const scan = scanWriters(SRC);

  it("finds exactly one writer for job_domain_skill — the Path A scope bottleneck", () => {
    // 28 of 3,885 selectable occupations carry an edge, and this is why: one seeder, fed by
    // one hand-picked file. Any second writer is a new ingestion route and should be read.
    expect([...(scan.byTable.get("job_domain_skill") ?? [])]).toEqual(["seed-domain-skills.ts"]);
  });

  it("finds no path from the occupation vocabulary into the skill vocabulary", () => {
    // Directionality. `job_domain_alias` holds job titles; deriving `skill_alias` from it
    // would put job titles into the skill id space.
    expect(crossVocabularyWriters(SRC)).toEqual([]);
  });

  it("attributes every skill_alias writer to a declared lifecycle role", () => {
    // Not a fixed list — a fixed list is the writers someone remembered. Instead: every
    // discovered writer must be one the model names, or a maintenance runner the model
    // deliberately excludes (normalization, election, embedding, retag, rollback, provenance).
    const declared = new Set(
      LIFECYCLE.flatMap((p) => p.steps.map((s) => s.writerFile)).filter(
        (f): f is string => f !== undefined,
      ),
    );
    const maintenance = new Set([
      "decollide-skill-aliases.ts", // election — de-elects a duplicate, adds no vocabulary
      "normalize-skill-aliases.ts", // fills text_norm, never text
      "retag-skills.ts", // moves an alias between skills, adds no vocabulary
      "s3d-rollback.ts", // restores rows the database already had
      "verify-embedding-provenance.ts", // stamps embedding_model on proven rows
    ]);
    for (const f of scan.byTable.get("skill_alias") ?? []) {
      expect(declared.has(f) || maintenance.has(f), `${f} writes skill_alias but no role claims it`).toBe(
        true,
      );
    }
  });

  it("does NOT count a statement quoted in a comment", () => {
    const code = stripComments(`/* UPDATE skill_alias SET embedding = NULL */\nconst x = 1;`);
    expect(code).not.toContain("UPDATE skill_alias");
  });

  it("does NOT count a statement rendered into a plain string", () => {
    // `deprecation-seed-plan.ts` RENDERS the SQL a separate runner executes, and
    // `audit-alias-collision-cleanup.ts` PRINTS the de-election it refuses to run. Counting
    // them would flag the files most careful to separate planning from execution.
    for (const f of ["deprecation-seed-plan.ts", "audit-alias-collision-cleanup.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).toMatch(/UPDATE skill/); // it really does contain the text …
      expect(scan.writers.has(f), f).toBe(false); // … and is still not a writer
    }
  });

  it("does count a statement inside a dsql tagged template", () => {
    // The inverse of the case above, on the runner that actually performs the de-election.
    expect(scan.writers.has("decollide-skill-aliases.ts")).toBe(true);
    expect(scan.writers.has("seed-deprecations.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("db:mine:aliases can reach its credentials", () => {
  it("loads the repository-root .env like the other db runners", () => {
    // It did not, for its entire life. `pnpm db:mine:aliases` runs with cwd = packages/db,
    // where a bare `config()` finds no file, so the runner threw `DATABASE_URL is not set`
    // before touching anything. The fault was invisible because the generator had no traffic
    // to mine — the failure read as "not wired up yet". `chat_messages` now holds inbound
    // rows, so it is reachable, and this pins the fix.
    const src = readFileSync(join(SRC, "mine-chat-aliases.ts"), "utf8");
    expect(src).toContain('config({ path: "../../.env" })');
  });
});
