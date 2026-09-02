PHASE P1 — matching_catalog config table. PLAN MODE. Changes the database.

Show me the plan and wait for approval before writing any code.

Build a table called matching_catalog. Copy the shape of the existing pricing_catalog
table exactly:
  (id, catalog jsonb, revision int default 1, is_active, updated_by, created_at, updated_at)

  CORRECTED 2026-09-02 (owner ruling). This line previously read
  "(id, version, catalog_json jsonb, published_by, published_at, is_active)", which
  described no table that exists. The real pricing_catalog (packages/db/src/schema/
  payer.ts) and its existing clone match_config (schema/match.ts) both use
  catalog/config + revision + updated_by + created_at/updated_at. The convention is
  2-0; a third config table with its own vocabulary is a permanent tax and triples
  the cost of ever extracting a shared config-catalog module.

catalog (the jsonb column) holds all of these — the master context puts them deliberately outside
the schema because they change often:
  - role registry (role_id, label, domain_id, family_id)
  - families and domains
  - adjacency multipliers (directed, sparse)
  - functionMultiplier matrix. It must be able to express
    higher-tier-to-operator = 0.85 and operator-to-higher-tier = 0.25
  - collarTierBand
  - per-role attribute whitelists
  - per-role list of allowed function values and collar tiers

Deliver:
  1. The migration FILE only. Do not run it. Say clearly in your output that
     Divyanshu runs it.
  2. Drizzle schema and repository, following the pricing_catalog pattern.
  3. A versioned Zod schema for the catalog blob, placed in packages/.
  4. A validator that runs at publish time and REJECTS a catalog if:
       - an adjacency edge points at a role_id that does not exist
       - any multiplier is outside 0.00 to 1.00
       - a role has no family or no domain
       - a role declares a function value outside the locked list
     The rejection message must name the exact field that is wrong, not just fail.
  5. Read and publish endpoints behind InternalServiceGuard.
     Note: R31 was a bug where the pricing catalog endpoint had no auth at all.
     Do not repeat it.
  6. Only one row can have is_active = true. Enforce this in the DATABASE
     (unique partial index or similar), not in application code.

Do NOT put real values in. R1 to R4 are still open. Seed only a syntactically valid
fixture catalog with is_active = false, for tests.

INVARIANT: an invalid catalog can never become the active one.
