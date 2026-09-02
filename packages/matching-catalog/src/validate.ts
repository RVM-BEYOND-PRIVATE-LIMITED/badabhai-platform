/**
 * The PUBLISH-TIME GATE. `matching_catalog` rows are untyped jsonb until they pass
 * here, and nothing may become the active catalog without passing.
 *
 * INVARIANT (P1): an invalid catalog can never become the active one.
 *
 * Two things this file guarantees that a bare `schema.parse()` does not:
 *
 *  1. IT NAMES THE PATH. A rejection reads `adjacency[7].to` or
 *     `functionMultiplier.matrix.operator.programmer`, never "invalid catalog".
 *     RVM publishes this blob; an error that does not say which of ~2,000 cells is
 *     wrong is an error nobody can act on.
 *  2. IT CHECKS REFERENCES. Zod validates shape in isolation. It cannot know that
 *     `adjacency[7].to` points at a role that is not in `roles[]`, or that a role's
 *     `familyId` dangles. Those are the failures that silently degrade matching
 *     rather than breaking it — a dangling family means the 0.90 same-family edge
 *     quietly never fires and the pair falls to the 0.45 adjacent-domain floor.
 *
 * Pure: no I/O, no throw, no DB. The caller decides what a failure means.
 */
import { matchingCatalogSchema, type MatchingCatalog } from "./types";

/** One reason a catalog was rejected, anchored to the exact offending field. */
export interface CatalogIssue {
  /** Dotted/indexed path into the blob, e.g. `roles[3].familyId`. */
  readonly path: string;
  /** What is wrong with the value at `path`. */
  readonly message: string;
  /** Stable machine code, for tests and for grouping in the ops UI. */
  readonly code: CatalogIssueCode;
}

export type CatalogIssueCode =
  | "schema" // failed the Zod contract (shape, enum, or range)
  | "unknown_role" // an adjacency edge points at a role that does not exist
  | "unknown_domain" // a role's domainId is not in domains[]
  | "unknown_family" // a role's familyId is not in families[]
  | "duplicate_id"; // two registry entries share an id

export type ValidateResult =
  | { readonly ok: true; readonly catalog: MatchingCatalog }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] };

/**
 * Render a Zod path as the addressable string a human can find in the blob:
 * `["roles", 3, "functions", 0]` -> `roles[3].functions[0]`.
 */
export function formatPath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out === "" ? seg : `.${seg}`;
    }
  }
  return out === "" ? "(root)" : out;
}

/**
 * Validate a raw catalog value. Returns every issue found, not just the first —
 * a publisher fixing one cell at a time across a 22-role taxonomy is a bad afternoon.
 *
 * Order matters: the Zod pass runs first and, if it fails, we return immediately.
 * Reference checks read `catalog.roles`/`domains`/`families` and would themselves
 * crash on a blob whose `roles` is not an array.
 */
export function validateMatchingCatalog(raw: unknown): ValidateResult {
  const parsed = matchingCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        message: i.message,
        code: "schema" as const,
      })),
    };
  }

  const catalog = parsed.data;
  const issues: CatalogIssue[] = [];

  // --- duplicate ids -------------------------------------------------------------
  // A duplicate silently shadows: two roles with the same id means one of them can
  // never be addressed by an adjacency edge, and which one wins is array order.
  collectDuplicates(catalog.domains, "domains", issues);
  collectDuplicates(catalog.families, "families", issues);
  collectDuplicates(catalog.roles, "roles", issues);

  const roleIds = new Set(catalog.roles.map((r) => r.id));
  const domainIds = new Set(catalog.domains.map((d) => d.id));
  const familyIds = new Set(catalog.families.map((f) => f.id));

  // --- every role resolves to a real domain and a real family --------------------
  catalog.roles.forEach((role, i) => {
    if (!domainIds.has(role.domainId)) {
      issues.push({
        path: `roles[${i}].domainId`,
        message: `role "${role.id}" references domain "${role.domainId}", which is not in domains[]`,
        code: "unknown_domain",
      });
    }
    if (!familyIds.has(role.familyId)) {
      issues.push({
        path: `roles[${i}].familyId`,
        message: `role "${role.id}" references family "${role.familyId}", which is not in families[]`,
        code: "unknown_family",
      });
    }
  });

  // --- every adjacency edge connects two real roles -------------------------------
  catalog.adjacency.forEach((edge, i) => {
    if (!roleIds.has(edge.from)) {
      issues.push({
        path: `adjacency[${i}].from`,
        message: `adjacency edge references unknown role "${edge.from}"`,
        code: "unknown_role",
      });
    }
    if (!roleIds.has(edge.to)) {
      issues.push({
        path: `adjacency[${i}].to`,
        message: `adjacency edge references unknown role "${edge.to}"`,
        code: "unknown_role",
      });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, catalog };
}

/** Flag any id that appears more than once in a registry, naming the later index. */
function collectDuplicates(
  entries: ReadonlyArray<{ readonly id: string }>,
  field: "domains" | "families" | "roles",
  issues: CatalogIssue[],
): void {
  const seen = new Map<string, number>();
  entries.forEach((entry, i) => {
    const first = seen.get(entry.id);
    if (first !== undefined) {
      issues.push({
        path: `${field}[${i}].id`,
        message: `duplicate id "${entry.id}" — already declared at ${field}[${first}]`,
        code: "duplicate_id",
      });
      return;
    }
    seen.set(entry.id, i);
  });
}

/** One-line summary of a rejection, safe for logs and ops surfaces (PII-free by shape). */
export function describeIssues(issues: readonly CatalogIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}
