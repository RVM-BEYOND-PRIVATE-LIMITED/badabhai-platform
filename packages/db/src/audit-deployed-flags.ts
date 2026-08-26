/**
 * The two capability flags, as far as anything outside the box can see. NO DATABASE, ₹0.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Several committed documents use *"the flag is off"* as a **safety argument** for leaving other
 * things alone. Task 17b established that the repository cannot verify that: the effective value
 * is supplied from a GitHub Actions secret, and nothing in the repo or the database records it.
 *
 * What Task 17b did not do — because it did not occur to anyone to look — is read the secret's
 * **metadata**. GitHub never exposes a secret's value, and it does expose `created_at` and
 * `updated_at`, and whether the secret exists at all. Those three facts turn out to separate the
 * two flags completely:
 *
 *   DOMAIN_MATCH_ENABLED         does not exist -> the CD bridges empty -> compose's
 *                                `${VAR:-false}` substitutes on empty as well as unset ->
 *                                **provably false in the deployed container**
 *   SKILL_CANONICALIZE_ENABLED   exists, and its value was CHANGED after creation ->
 *                                the compose default does not govern -> **value unknown**
 *
 * ===========================================================================
 * WHAT IT WILL NOT DO
 * ===========================================================================
 * It does not read, guess or infer a secret's value, and it will not probe the running service.
 * "Do not infer it from smoke probes" is a standing instruction and it is also just correct:
 * Task 17b's own retracted claim came from exactly that reasoning, and the endpoint that looked
 * like proof turned out to be a token-guarded API route independent of the Python flag.
 *
 * It changes nothing. There is no write path to a secret, a workflow, or a container here.
 *
 * REQUIRES `gh` authenticated with repo access. Without it the run REFUSES rather than
 * reporting an absence — "the secret does not exist" and "I could not ask" must never collapse
 * into one answer, because they point in opposite directions.
 *
 *   pnpm db:audit:deployed-flags [--json=<out>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { provenance, REPOSITORY_ONLY } from "./evidence-provenance";

const SCRIPT = "audit:deployed-flags";

/** The two flags, and what each one gates. */
const FLAGS = [
  {
    name: "DOMAIN_MATCH_ENABLED",
    gates:
      "the embedding-based ANN fallback in domain_match.match_domain. The lexical layers " +
      "short-circuit before it, so production already resolves jd_* scopes with this false.",
  },
  {
    name: "SKILL_CANONICALIZE_ENABLED",
    gates:
      "/skills/canonicalize outright — the route returns `unresolved` before reaching either " +
      "retrieval path. Turning it on IS the activation.",
  },
] as const;

export interface SecretFacts {
  readonly name: string;
  readonly exists: boolean;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  /** `true` when the value has been set at least once SINCE creation. */
  readonly changed_since_creation: boolean | null;
  /**
   * What the deployed container holds. **Always null.** GitHub does not expose secret values,
   * and this field exists to make that absence explicit in the artifact rather than implied by
   * its omission — an artifact that simply lacks the field reads like nobody asked.
   */
  readonly deployed_value: null;
  readonly determinable: boolean;
  readonly reasoning: string;
}

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

/**
 * Read one secret's metadata. Throws on anything that is not a clean present/absent answer.
 *
 * The 404-vs-error distinction is the whole point: absent means the compose default governs and
 * the flag is provably off, while "gh is not authenticated" means nothing is known. Treating an
 * auth failure as absence would manufacture a proof of safety.
 */
export function classifySecret(
  name: string,
  raw: { created_at?: string; updated_at?: string } | null,
  gates: string,
): SecretFacts {
  if (raw === null) {
    return {
      name,
      exists: false,
      created_at: null,
      updated_at: null,
      changed_since_creation: null,
      deployed_value: null,
      determinable: true,
      reasoning:
        `The secret does not exist, so the CD bridges it as the empty string and compose's ` +
        `\${${name}:-false} substitutes — the ':-' form applies on empty as well as unset. ` +
        `The deployed value is FALSE, provably, without reading anything secret. Gates: ${gates}`,
    };
  }
  const created = raw.created_at ?? null;
  const updated = raw.updated_at ?? null;
  const changed = created !== null && updated !== null ? created !== updated : null;
  return {
    name,
    exists: true,
    created_at: created,
    updated_at: updated,
    changed_since_creation: changed,
    deployed_value: null,
    determinable: false,
    reasoning:
      `The secret EXISTS, so the CD passes its value and the compose default governs only if ` +
      `that value is empty. GitHub never exposes a secret's value, so the deployed setting is ` +
      `NOT DETERMINABLE from here.` +
      (changed === true
        ? ` Its value was CHANGED at ${updated}, after creation at ${created} — a deliberate act ` +
          `nobody recorded.`
        : ` It has not been changed since creation at ${created}.`) +
      ` Gates: ${gates}`,
  };
}

function ghSecret(name: string): { created_at?: string; updated_at?: string } | null {
  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/:owner/:repo/actions/secrets/${name}`, "--jq", "{created_at,updated_at}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out.trim()) as { created_at?: string; updated_at?: string };
  } catch (e: unknown) {
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message ?? e);
    // ONLY a 404 means "absent". Anything else — no auth, no network, no permission — is an
    // unknown, and an unknown must not be reported as a proof that the flag is off.
    if (/HTTP 404|Not Found/i.test(msg)) return null;
    throw new Error(
      `[${SCRIPT}] could not read metadata for ${name}: ${msg.trim().slice(0, 200)}\n` +
        `Refusing to continue: "the secret is absent" and "I could not ask" point in opposite ` +
        `directions and must never be merged.`,
    );
  }
}

function main(): void {
  const repoRoot = join(__dirname, "..", "..", "..");
  const compose = readFileSync(join(repoRoot, "docker-compose.staging.yml"), "utf8");
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

  console.log(`[${SCRIPT}] NO DATABASE. Reads secret METADATA only — never a value.`);

  const facts = FLAGS.map((f) => classifySecret(f.name, ghSecret(f.name), f.gates));

  // The repository half, so the artifact records the whole chain rather than one hop of it.
  const bridged = Object.fromEntries(
    FLAGS.map((f) => [f.name, ci.includes(`${f.name}: \${{ secrets.${f.name} }}`)]),
  );
  const composeDefault = Object.fromEntries(
    FLAGS.map((f) => {
      const m = compose.match(new RegExp(`${f.name}: \\$\\{${f.name}:-([a-z]+)\\}`));
      return [f.name, m?.[1] ?? null];
    }),
  );
  const deploysOnMainPush = /github\.ref == 'refs\/heads\/main'/.test(ci);

  for (const f of facts) {
    console.log(`\n  ${f.name}`);
    console.log(`    secret exists          ${f.exists}`);
    console.log(`    created / updated      ${f.created_at ?? "-"}  /  ${f.updated_at ?? "-"}`);
    console.log(`    changed since created  ${f.changed_since_creation ?? "n/a"}`);
    console.log(`    bridged by CI          ${bridged[f.name]}`);
    console.log(`    compose default        ${composeDefault[f.name]}`);
    console.log(`    DEPLOYED VALUE         ${f.determinable ? "false (provable)" : "NOT DETERMINABLE"}`);
    console.log(`    ${f.reasoning}`);
  }

  console.log(
    `\n  deploy job runs on every push to main = ${deploysOnMainPush}\n` +
      `  So a secret changed on day X reaches the running container at the next merge, with no\n` +
      `  separate deploy step and no record in this repository of what the value became.`,
  );

  const out = arg("json");
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          kind: "deployed-flag-facts",
          ...provenance({
            source: `pnpm db:audit:deployed-flags`,
            target: REPOSITORY_ONLY,
            readOnly: true,
            role: null,
            populationPredicate:
              "GitHub Actions repository-secret METADATA (name, created_at, updated_at, " +
              "existence) for the two capability flags, plus the CI bridge and the compose " +
              "default for each. No secret VALUE is read, and the running service is not probed.",
          }),
          ai_spend_inr: 0,
          flags: facts,
          bridged_by_ci: bridged,
          compose_default: composeDefault,
          deploy_runs_on_every_main_push: deploysOnMainPush,
          what_would_settle_it:
            "Someone with box access reads the effective environment of the running ai-service " +
            "container (`docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED`), " +
            "or re-sets the secret to a known value and notes it. Neither is repository work.",
          production_mutation_performed: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\n  written to ${out}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
