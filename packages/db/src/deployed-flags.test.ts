/**
 * The two capability flags — what is settled, and what is not.
 *
 * The point of this file is that the two flags have **completely different epistemic status**
 * and the documents treat them the same. `DOMAIN_MATCH_ENABLED` is provably false. The value of
 * `SKILL_CANONICALIZE_ENABLED` is unknown, was deliberately changed on 2026-08-24, and reaches
 * production automatically on the next merge. Several documents lean on "the flag is off" as a
 * safety argument; exactly one of those two supports it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifySecret } from "./audit-deployed-flags";
import { missingProvenance } from "./evidence-provenance";

const ROOT = join(__dirname, "..", "..", "..");
const DOCS = join(ROOT, "docs", "registers", "taxonomy-decisions");

describe("classifySecret", () => {
  it("an ABSENT secret settles the question — compose's :- substitutes on empty and unset", () => {
    const f = classifySecret("X", null, "gates something");
    expect(f.exists).toBe(false);
    expect(f.determinable).toBe(true);
    expect(f.reasoning).toMatch(/deployed value is FALSE, provably/);
  });

  it("a PRESENT secret does not, however reassuring the compose default looks", () => {
    const f = classifySecret("X", { created_at: "a", updated_at: "a" }, "g");
    expect(f.exists).toBe(true);
    expect(f.determinable).toBe(false);
    expect(f.changed_since_creation).toBe(false);
  });

  it("a CHANGED secret is flagged as a deliberate act", () => {
    const f = classifySecret("X", { created_at: "a", updated_at: "b" }, "g");
    expect(f.changed_since_creation).toBe(true);
    expect(f.reasoning).toMatch(/CHANGED at b/);
  });

  it("the value is ALWAYS null, and the field is always present", () => {
    // Omitting the field would let the artifact read as though nobody asked.
    for (const raw of [null, { created_at: "a", updated_at: "b" }]) {
      expect(classifySecret("X", raw, "g")).toHaveProperty("deployed_value", null);
    }
  });
});

// ---------------------------------------------------------------------------
interface Flag {
  name: string;
  exists: boolean;
  created_at: string | null;
  updated_at: string | null;
  changed_since_creation: boolean | null;
  deployed_value: null;
  determinable: boolean;
  reasoning: string;
}
interface Artifact {
  ai_spend_inr: number;
  flags: Flag[];
  bridged_by_ci: Record<string, boolean>;
  compose_default: Record<string, string | null>;
  deploy_runs_on_every_main_push: boolean;
  what_would_settle_it: string;
  production_mutation_performed: boolean;
}

const art = JSON.parse(readFileSync(join(DOCS, "deployed-flag-facts.json"), "utf8")) as Artifact;
const by = new Map(art.flags.map((f) => [f.name, f]));

describe("DOMAIN_MATCH_ENABLED is settled", () => {
  const f = by.get("DOMAIN_MATCH_ENABLED")!;

  it("the secret does not exist, so the deployed value is provably false", () => {
    expect(f.exists).toBe(false);
    expect(f.determinable).toBe(true);
  });

  it("and the two halves of that proof are still in the repository", () => {
    // If either moves, the proof stops holding and this fails rather than going quiet.
    expect(art.bridged_by_ci["DOMAIN_MATCH_ENABLED"]).toBe(true);
    expect(art.compose_default["DOMAIN_MATCH_ENABLED"]).toBe("false");
  });
});

describe("SKILL_CANONICALIZE_ENABLED is NOT settled", () => {
  const f = by.get("SKILL_CANONICALIZE_ENABLED")!;

  it("the secret exists, so the compose default does not govern", () => {
    expect(f.exists).toBe(true);
    expect(f.determinable).toBe(false);
    expect(f.deployed_value).toBeNull();
  });

  it("and its value was CHANGED on 2026-08-24, long after it was created", () => {
    expect(f.created_at).toBe("2026-07-16T11:51:11Z");
    expect(f.updated_at).toBe("2026-08-24T11:30:45Z");
    expect(f.changed_since_creation).toBe(true);
  });

  it("the change reaches production automatically — no separate deploy step gates it", () => {
    expect(art.deploy_runs_on_every_main_push).toBe(true);
  });

  it("and settling it is explicitly NOT repository work", () => {
    expect(art.what_would_settle_it).toMatch(/box access|docker compose exec/);
    expect(art.what_would_settle_it).toMatch(/Neither is repository work/);
  });
});

describe("the artifact itself", () => {
  it("carries provenance, is repository-only, cost nothing, wrote nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
  });

  it("records NO secret value for either flag", () => {
    for (const f of art.flags) expect(f.deployed_value, f.name).toBeNull();
  });

  it("and the compose gates are still `:-`, never `:?` — every failure lands on OFF", () => {
    // A credential should fail the deploy when missing. A capability gate must not: the whole
    // safety posture is that an absent, empty or forgotten bridge resolves to false.
    const compose = readFileSync(join(ROOT, "docker-compose.staging.yml"), "utf8");
    expect(compose).toContain("DOMAIN_MATCH_ENABLED: ${DOMAIN_MATCH_ENABLED:-false}");
    expect(compose).toContain("SKILL_CANONICALIZE_ENABLED: ${SKILL_CANONICALIZE_ENABLED:-false}");
    expect(compose).not.toMatch(/SKILL_CANONICALIZE_ENABLED:\s*\$\{SKILL_CANONICALIZE_ENABLED:\?/);
  });
});
