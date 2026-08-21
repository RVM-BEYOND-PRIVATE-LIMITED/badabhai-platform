/**
 * ISCO/NCO inheritance materializer — the PURE core.
 *
 * ===========================================================================
 * WHAT IT IS FOR, AND WHAT IT IS NOT FOR
 * ===========================================================================
 * `job_domain_skill` is AUTHORING / CORPUS METADATA. It is not on the runtime matching path:
 * the runtime bridge is `ATTRIBUTE_TO_MATCH_SKILLS` → `mskill_*` → `worker_skill` → `job_reach`
 * (see `d1-runtime-path-trace.md`, verified against production 2026-08-21).
 *
 * So materializing edges here **increases taxonomy coverage and has no direct runtime matching
 * effect under the current architecture**. That sentence is repeated in the dry-run output on
 * purpose: a fan-out number looks like a relevance win and is not one.
 *
 * ===========================================================================
 * THE RULE
 * ===========================================================================
 * A skill authored against an occupation applies to the occupations BELOW it in the
 * ISCO-08 / NCO-2015 tree. "Welder" implies its narrower children; it says nothing about its
 * siblings or its parent.
 *
 * Roots are domains holding an edge a human or a reviewed batch authored — `llm_bootstrap` or
 * `curated`. **`inherited` edges are never roots.** Letting inheritance cascade off its own
 * output would make the result depend on execution order and stop it being idempotent, which
 * is exactly the property the PK `(job_domain_id, skill_id)` was designed to give.
 *
 * ===========================================================================
 * FAIL CLOSED
 * ===========================================================================
 * It never guesses. Every proposal a rule cannot decide is classified and reported rather than
 * written: `AMBIGUOUS` when two equally-near ancestors disagree, `UNRESOLVABLE` when the skill
 * does not exist. Authored edges always win over inherited ones and are never overwritten.
 *
 * NO IO. No database, no provider, no clock, no randomness. Inputs are values, so the whole
 * rule set is testable without a database and a dry-run is reproducible from committed inputs.
 */

/** A node of the occupation tree, as the materializer needs it. */
export interface DomainNode {
  readonly job_domain_id: string;
  readonly parent_job_domain_id: string | null;
  readonly status: string;
  readonly selectable: boolean;
  readonly label_en?: string | null;
}

/** An existing `job_domain_skill` row. */
export interface ExistingEdge {
  readonly job_domain_id: string;
  readonly skill_id: string;
  readonly source: "llm_bootstrap" | "inherited" | "curated";
  readonly status: string;
  readonly default_requirement?: "required" | "preferred";
  readonly relevance?: number;
  readonly confidence?: number | null;
}

export interface SkillRef {
  readonly skill_id: string;
  readonly status: "active" | "provisional" | "deprecated";
}

/**
 * Why a proposal ended where it did. Every candidate edge carries one, so the report explains
 * itself without anyone opening this file.
 */
export type Disposition =
  /** Would be written by an authorized run. */
  | "CANDIDATE"
  /** An inherited row for this pair already exists — the idempotency case. */
  | "EXISTING"
  /** The descendant authored its own edge for this skill. Authored always wins. */
  | "AUTHORED_WINS"
  /** Two equally-near ancestors disagree. Never guessed. */
  | "AMBIGUOUS"
  /** The skill id is not in the corpus. */
  | "UNRESOLVABLE"
  /** The target domain is not active/selectable. */
  | "SKIPPED_DOMAIN"
  /** The skill is deprecated — inheriting it would resurrect a retired concept. */
  | "SKIPPED_DEPRECATED_SKILL";

export interface ProposedEdge {
  readonly job_domain_id: string;
  readonly skill_id: string;
  /** The ancestor the edge is resolved down from — `inherited_from_job_domain_id`. */
  readonly inherited_from: string;
  /** Hops below the authoring ancestor. Always ≥ 1; depth 0 is the authored row itself. */
  readonly depth: number;
  readonly default_requirement: "required" | "preferred";
  readonly relevance: number;
  readonly confidence: number | null;
  readonly disposition: Disposition;
  readonly reason: string;
  /** Whether this edge depends on a skill production cannot currently serve. */
  readonly skill_status: "active" | "provisional" | "deprecated" | "unknown";
}

export interface InheritancePlan {
  readonly roots: readonly string[];
  readonly reachableDomains: readonly string[];
  readonly proposals: readonly ProposedEdge[];
  readonly counts: Readonly<Record<Disposition, number>>;
  /** Candidates whose skill is `provisional` — invisible to production retrieval today. */
  readonly candidatesOnProvisionalSkills: number;
  /** Domains that would gain at least one inherited edge. */
  readonly domainsGainingEdges: number;
  /** Cycles found while walking parents. Non-empty means the tree is not a tree. */
  readonly cycles: readonly string[];
}

const AUTHORED: ReadonlySet<string> = new Set(["llm_bootstrap", "curated"]);

/**
 * Children index. Built once; a per-node scan would be O(n²) over 4,071 domains.
 */
function childrenOf(domains: readonly DomainNode[]): Map<string, DomainNode[]> {
  const m = new Map<string, DomainNode[]>();
  for (const d of domains) {
    if (d.parent_job_domain_id === null) continue;
    m.set(d.parent_job_domain_id, [...(m.get(d.parent_job_domain_id) ?? []), d]);
  }
  // Sorted so the walk order — and therefore the output — is deterministic.
  for (const [, kids] of m) kids.sort((a, b) => a.job_domain_id.localeCompare(b.job_domain_id));
  return m;
}

/**
 * Every strict descendant of `root`, with its depth. Breadth-first, cycle-guarded.
 *
 * The cycle guard is not defensive padding: `parent_job_domain_id` is a self-referencing FK
 * with nothing stopping a loop, and a loop here would hang the materializer rather than fail
 * it. A visited node is skipped and recorded.
 */
export function descendants(
  root: string,
  kids: ReadonlyMap<string, DomainNode[]>,
  cycles: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>([root]);
  let frontier: { id: string; depth: number }[] = [{ id: root, depth: 0 }];
  while (frontier.length > 0) {
    const next: { id: string; depth: number }[] = [];
    for (const { id, depth } of frontier) {
      for (const c of kids.get(id) ?? []) {
        if (seen.has(c.job_domain_id)) {
          cycles.push(`${id} -> ${c.job_domain_id}`);
          continue;
        }
        seen.add(c.job_domain_id);
        out.set(c.job_domain_id, depth + 1);
        next.push({ id: c.job_domain_id, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Plan the inheritance. Pure: same inputs, same output, always.
 */
export function planInheritance(
  domains: readonly DomainNode[],
  edges: readonly ExistingEdge[],
  skills: readonly SkillRef[],
): InheritancePlan {
  const byDomain = new Map(domains.map((d) => [d.job_domain_id, d]));
  const skillById = new Map(skills.map((s) => [s.skill_id, s]));
  const kids = childrenOf(domains);
  const cycles: string[] = [];

  // Unit separator, written as an ESCAPE not a raw byte: a raw 0x1f makes ripgrep treat the
  // whole file as binary and skip it, so every grep over it silently returns nothing
  // (`source-hygiene.test.ts`). It also cannot occur inside a domain or skill id, so
  // `jd_a` + `skill_b` can never collide with `jd_ask` + `ill_b`.
  const existingKey = (d: string, s: string): string => `${d}\u001f${s}`;
  const existing = new Map(edges.map((e) => [existingKey(e.job_domain_id, e.skill_id), e]));

  // Roots: domains with at least one ACTIVE, AUTHORED edge. Inherited edges are excluded so
  // the plan cannot cascade off its own previous output.
  const authoredByRoot = new Map<string, ExistingEdge[]>();
  for (const e of edges) {
    if (!AUTHORED.has(e.source) || e.status !== "active") continue;
    authoredByRoot.set(e.job_domain_id, [...(authoredByRoot.get(e.job_domain_id) ?? []), e]);
  }
  const roots = [...authoredByRoot.keys()].sort();

  // (domain, skill) -> the nearest-ancestor proposal seen so far. Nearest wins; a tie between
  // two DIFFERENT ancestors at the same depth is genuinely undecidable and is reported.
  const best = new Map<string, ProposedEdge>();
  const reachable = new Set<string>();

  for (const root of roots) {
    const desc = descendants(root, kids, cycles);
    for (const domainId of desc.keys()) reachable.add(domainId);

    for (const [domainId, depth] of [...desc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const target = byDomain.get(domainId);
      for (const e of (authoredByRoot.get(root) ?? []).slice().sort((a, b) => a.skill_id.localeCompare(b.skill_id))) {
        const k = existingKey(domainId, e.skill_id);
        const skill = skillById.get(e.skill_id);

        const base = {
          job_domain_id: domainId,
          skill_id: e.skill_id,
          inherited_from: root,
          depth,
          default_requirement: e.default_requirement ?? "preferred",
          relevance: e.relevance ?? 50,
          confidence: e.confidence ?? null,
          skill_status: skill?.status ?? ("unknown" as const),
        };

        let proposal: ProposedEdge;
        const already = existing.get(k);
        if (skill === undefined) {
          proposal = { ...base, disposition: "UNRESOLVABLE", reason: `skill ${e.skill_id} is not in the corpus` };
        } else if (skill.status === "deprecated") {
          proposal = { ...base, disposition: "SKIPPED_DEPRECATED_SKILL", reason: `skill ${e.skill_id} is deprecated` };
        } else if (target === undefined || target.status !== "active" || !target.selectable) {
          proposal = { ...base, disposition: "SKIPPED_DOMAIN", reason: `domain ${domainId} is not active+selectable` };
        } else if (already !== undefined && AUTHORED.has(already.source)) {
          proposal = { ...base, disposition: "AUTHORED_WINS", reason: `${domainId} authored its own ${already.source} edge` };
        } else if (already !== undefined) {
          proposal = { ...base, disposition: "EXISTING", reason: `an inherited edge already exists` };
        } else {
          proposal = { ...base, disposition: "CANDIDATE", reason: `inherited from ${root} at depth ${depth}` };
        }

        const prior = best.get(k);
        if (prior === undefined) {
          best.set(k, proposal);
          continue;
        }
        // Nearest ancestor wins — deterministic and independent of iteration order.
        if (proposal.depth < prior.depth) {
          best.set(k, proposal);
        } else if (
          proposal.depth === prior.depth &&
          prior.inherited_from !== proposal.inherited_from &&
          prior.disposition === "CANDIDATE" &&
          proposal.disposition === "CANDIDATE" &&
          (prior.default_requirement !== proposal.default_requirement || prior.relevance !== proposal.relevance)
        ) {
          // Same distance, different ancestors, different answers. Nothing decides this.
          best.set(k, {
            ...prior,
            disposition: "AMBIGUOUS",
            reason:
              `ancestors ${[prior.inherited_from, proposal.inherited_from].sort().join(" and ")} both reach ` +
              `${domainId} at depth ${depth} with different requirement/relevance`,
          });
        }
      }
    }
  }

  const proposals = [...best.values()].sort(
    (a, b) => a.job_domain_id.localeCompare(b.job_domain_id) || a.skill_id.localeCompare(b.skill_id),
  );

  const counts = {
    CANDIDATE: 0, EXISTING: 0, AUTHORED_WINS: 0, AMBIGUOUS: 0,
    UNRESOLVABLE: 0, SKIPPED_DOMAIN: 0, SKIPPED_DEPRECATED_SKILL: 0,
  } as Record<Disposition, number>;
  for (const p of proposals) counts[p.disposition] += 1;

  return {
    roots,
    reachableDomains: [...reachable].sort(),
    proposals,
    counts,
    candidatesOnProvisionalSkills: proposals.filter((p) => p.disposition === "CANDIDATE" && p.skill_status === "provisional").length,
    domainsGainingEdges: new Set(proposals.filter((p) => p.disposition === "CANDIDATE").map((p) => p.job_domain_id)).size,
    cycles: [...new Set(cycles)].sort(),
  };
}

/** The sentence that must accompany any fan-out number. */
export const NO_RUNTIME_EFFECT_NOTICE =
  "job_domain_skill remains authoring/corpus metadata and is not a runtime matching input " +
  "under the current architecture. Materializing these relationships does not itself increase " +
  "runtime matching coverage — the runtime bridge is ATTRIBUTE_TO_MATCH_SKILLS -> mskill_*.";
