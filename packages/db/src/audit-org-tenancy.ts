/**
 * ADR-0053 (PAY-DB-01) — the payer org tenancy CENSUS. READ-ONLY, ₹0.
 *
 * Runs ORG_TENANCY_PLAN §6's queries C1–C9 and prints counts plus opaque ids. It is the first
 * step of the flip (plan §5, owner action O-8 step 1): before `PAYER_ORG_TENANCY_MODE` goes to
 * `shadow`, this must show C2 = C3 = C4 = C6 = 0, and C1 and C5 recorded.
 *
 *   pnpm --filter @badabhai/db db:audit:org-tenancy
 *
 * ===========================================================================================
 * WHAT EACH CHECK MEANS
 * ===========================================================================================
 *  C1  team members — the ONLY payers whose view changes at the flip (record it).
 *  C2  rule A1 breached: more than one active team membership. MUST be 0 (the resolver's R3
 *      would 403 them).
 *  C3  rule A2 breached: a team org's anchor is an active member of another org. MUST be 0.
 *  C4  rule A3 / R6 breached: a member's vertical role differs from the anchor's. MUST be 0.
 *  C5  born-where (O-2): rows a team member owns under their OWN key, which they stop seeing at
 *      the flip. Record it; the owner ruled O-2 (no merge) on 2026-10-08.
 *  C5b the same, in CREDITS: the balance in team members' own wallets. Its own line — a balance
 *      summed into C5's row count would make that headline meaningless.
 *  C6  payers with no solo org, or an org whose anchor has no active owner membership. MUST be
 *      0 to flip cleanly (R4 heals the first kind on the next request).
 *  C7  team orgs R5 would block at the flip (org or anchor not active). Record it (O-6).
 *  C8  informational: tenant rows whose key names no `payers` row (unreachable today and after).
 *  C9  team members' UNSETTLED payment orders (any status but `paid`: a `failed` order can
 *      still be captured on a provider retry) stamped with their OWN wallet. Record it:
 *      after the flip the member's browser verify of such an order is refused (it compares with
 *      the org), while the Razorpay webhook still settles it into the member's personal wallet
 *      (ADR-0053 §6, the plan's support runbook). Tell those members before `on`.
 *
 * ===========================================================================================
 * READ-ONLY BY CONSTRUCTION
 * ===========================================================================================
 * Every statement below is a SELECT (or a WITH … SELECT); `audit-org-tenancy.test.ts` refuses
 * any other. The whole run is ONE `read only` transaction (checked to report read-only before the
 * first query), so Postgres refuses a write even if one slipped in. Nothing is repaired here:
 * the census measures, the owner decides.
 *
 * ===========================================================================================
 * PRIVACY
 * ===========================================================================================
 * Output is opaque uuids, enum values (org_role, role, status), counts and one timestamp. No
 * name, email, phone, org name or ciphertext is selected.
 */
import { config } from "dotenv";
import type { Sql, TransactionSql } from "postgres";

import { createDbClient } from "./client";

// The repository-root file first, as the other db runners do (cwd = packages/db under pnpm).
// dotenv never overwrites an already-set variable, so a real environment still wins.
config({ path: "../../.env" });
config();

const SCRIPT = "audit:org-tenancy";

/** How a check's count is read at the flip (plan §5 step 1). */
export type CensusRule = "must_be_zero" | "record" | "informational";

export interface CensusQuery {
  readonly id: string;
  readonly title: string;
  readonly rule: CensusRule;
  /** For C5 / C8: one row per table with a `n` column, summed rather than counted. */
  readonly tally?: true;
  readonly sql: string;
}

const TEAM_MEMBERS_CTE = `
  team_members AS (
    SELECT DISTINCT pm.member_payer_id AS id
    FROM payer_members pm
    JOIN payer_orgs po ON po.id = pm.org_id
    WHERE pm.status = 'active'
      AND pm.member_payer_id IS NOT NULL
      AND po.root_payer_id <> pm.member_payer_id
  )`;

export const CENSUS_QUERIES: readonly CensusQuery[] = [
  {
    id: "C1",
    title: "team members (the only payers whose view changes at the flip)",
    rule: "record",
    sql: `
      SELECT pm.member_payer_id, pm.org_id, po.root_payer_id AS anchor, pm.org_role, pm.accepted_at
      FROM payer_members pm
      JOIN payer_orgs po ON po.id = pm.org_id
      WHERE pm.status = 'active'
        AND pm.member_payer_id IS NOT NULL
        AND po.root_payer_id <> pm.member_payer_id
      ORDER BY pm.accepted_at, pm.member_payer_id`,
  },
  {
    id: "C2",
    title: "A1 breached: more than one active team membership",
    rule: "must_be_zero",
    sql: `
      SELECT pm.member_payer_id, count(*)::int AS team_memberships
      FROM payer_members pm
      JOIN payer_orgs po ON po.id = pm.org_id
      WHERE pm.status = 'active'
        AND pm.member_payer_id IS NOT NULL
        AND po.root_payer_id <> pm.member_payer_id
      GROUP BY pm.member_payer_id
      HAVING count(*) > 1
      ORDER BY pm.member_payer_id`,
  },
  {
    id: "C3",
    title: "A2 breached: a team org's anchor is an active member of another org",
    rule: "must_be_zero",
    sql: `
      WITH team_anchors AS (
        SELECT DISTINCT po.root_payer_id AS id
        FROM payer_orgs po
        JOIN payer_members pm ON pm.org_id = po.id
        WHERE pm.status <> 'removed'
          AND pm.member_payer_id IS DISTINCT FROM po.root_payer_id
      )
      SELECT pm.member_payer_id, pm.org_id
      FROM payer_members pm
      JOIN payer_orgs po ON po.id = pm.org_id
      WHERE pm.status = 'active'
        AND po.root_payer_id <> pm.member_payer_id
        AND pm.member_payer_id IN (SELECT id FROM team_anchors)
      ORDER BY pm.member_payer_id`,
  },
  {
    id: "C4",
    title: "A3 / R6 breached: member role differs from the anchor's role",
    rule: "must_be_zero",
    sql: `
      SELECT pm.member_payer_id, m.role AS member_role, r.role AS anchor_role
      FROM payer_members pm
      JOIN payer_orgs po ON po.id = pm.org_id
      JOIN payers m ON m.id = pm.member_payer_id
      JOIN payers r ON r.id = po.root_payer_id
      WHERE pm.status = 'active'
        AND po.root_payer_id <> pm.member_payer_id
        AND m.role IS DISTINCT FROM r.role
      ORDER BY pm.member_payer_id`,
  },
  {
    id: "C5",
    title: "born-where (O-2): what team members own under their own key",
    rule: "record",
    tally: true,
    sql: `
      WITH ${TEAM_MEMBERS_CTE}
      SELECT 'job_postings' AS t, count(*)::bigint AS n FROM job_postings WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'jobs', count(*) FROM jobs WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'unlocks', count(*) FROM unlocks WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'resume_disclosures', count(*) FROM resume_disclosures WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'posting_plans', count(*) FROM posting_plans WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'posting_boosts', count(*) FROM posting_boosts WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'payer_capacity', count(*) FROM payer_capacity WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'payment_orders', count(*) FROM payment_orders WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'credit_ledger', count(*) FROM credit_ledger WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'payer_credits', count(*) FROM payer_credits WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'agency_invites', count(*) FROM agency_invites WHERE inviter_payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'referral_links', count(*) FROM referral_links WHERE agent_payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'agency_kyc', count(*) FROM agency_kyc WHERE payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'agency_payout_accruals', count(*) FROM agency_payout_accruals WHERE agency_payer_id IN (SELECT id FROM team_members)
      UNION ALL SELECT 'agency_payout_requests', count(*) FROM agency_payout_requests WHERE agency_payer_id IN (SELECT id FROM team_members)`,
  },
  {
    // Its own line, never summed into C5: C5 counts ROWS, this is CREDITS (review L4).
    id: "C5b",
    title: "born-where (O-2): credits held in team members' own wallets",
    rule: "record",
    tally: true,
    sql: `
      WITH ${TEAM_MEMBERS_CTE}
      SELECT 'payer_credits.balance' AS t, coalesce(sum(balance), 0)::bigint AS n
      FROM payer_credits WHERE payer_id IN (SELECT id FROM team_members)`,
  },
  {
    id: "C6a",
    title: "payers with no solo org",
    rule: "must_be_zero",
    sql: `
      SELECT p.id
      FROM payers p
      LEFT JOIN payer_orgs po ON po.root_payer_id = p.id
      WHERE po.id IS NULL
      ORDER BY p.id`,
  },
  {
    id: "C6b",
    title: "orgs whose anchor has no active membership in them",
    rule: "must_be_zero",
    sql: `
      SELECT po.root_payer_id
      FROM payer_orgs po
      LEFT JOIN payer_members pm
        ON pm.org_id = po.id AND pm.member_payer_id = po.root_payer_id AND pm.status = 'active'
      WHERE pm.id IS NULL
      ORDER BY po.root_payer_id`,
  },
  {
    id: "C7",
    title: "team orgs R5 would block (org or anchor not active)",
    rule: "record",
    sql: `
      SELECT DISTINCT po.id AS org_id, po.status AS org_status, r.status AS anchor_status
      FROM payer_orgs po
      JOIN payers r ON r.id = po.root_payer_id
      JOIN payer_members pm
        ON pm.org_id = po.id AND pm.status = 'active' AND pm.member_payer_id <> po.root_payer_id
      WHERE po.status <> 'active' OR r.status <> 'active'
      ORDER BY po.id`,
  },
  {
    id: "C8",
    title: "tenant rows whose key names no payers row (informational)",
    rule: "informational",
    tally: true,
    sql: `
      SELECT 'unlocks' AS t, count(*)::bigint AS n FROM unlocks u
        WHERE NOT EXISTS (SELECT 1 FROM payers p WHERE p.id = u.payer_id)
      UNION ALL SELECT 'payer_credits', count(*) FROM payer_credits c
        WHERE NOT EXISTS (SELECT 1 FROM payers p WHERE p.id = c.payer_id)
      UNION ALL SELECT 'job_postings', count(*) FROM job_postings j
        WHERE j.payer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payers p WHERE p.id = j.payer_id)`,
  },
  {
    // PR #2171 review (security L2): an order stamped with a member's personal wallet before the
    // flip cannot be browser-verified by that member after it; the webhook still settles it.
    id: "C9",
    title: "team members' unsettled payment orders stamped with their own wallet (record; runbook)",
    rule: "record",
    sql: `
      WITH ${TEAM_MEMBERS_CTE}
      SELECT po.id AS order_id, po.payer_id, po.created_at
      FROM payment_orders po
      WHERE po.status <> 'paid'
        AND po.payer_id IN (SELECT id FROM team_members)
      ORDER BY po.created_at`,
  },
];

export interface CensusResult {
  readonly query: CensusQuery;
  readonly rows: readonly Record<string, unknown>[];
}

/** The number a check reports: a tally sums its `n` column; every other check counts its rows. */
export function censusCount(result: CensusResult): number {
  if (!result.query.tally) return result.rows.length;
  return result.rows.reduce((sum, row) => sum + Number(row["n"] ?? 0), 0);
}

/**
 * The flip gate (plan §5 step 1): the checks that must be zero, and which of them are not.
 * C5 / C5b non-zero is NOT a failure — it is what O-2 rules on, and O-2 was ruled (born-where).
 */
export function flipGate(results: readonly CensusResult[]): { pass: boolean; failing: string[] } {
  const failing = results
    .filter((r) => r.query.rule === "must_be_zero" && censusCount(r) !== 0)
    .map((r) => r.query.id);
  return { pass: failing.length === 0, failing };
}

/** At most this many rows are listed per check; the count is always exact. */
const LIST_LIMIT = 50;

function formatRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : String(v)}`)
    .join(" ");
}

/**
 * Run every check inside ONE `read only` transaction (review L5) and return the results in
 * order. Postgres itself refuses a write inside it, whatever a query says; the transaction is
 * also checked to REPORT read-only before anything is measured. A role without BYPASSRLS is
 * refused: every payer table is RLS-locked with no policies, so its zeros would mean "not allowed
 * to look", not "nothing to fix".
 */
export async function runCensus(sql: Sql): Promise<CensusResult[]> {
  const run = async (tx: TransactionSql): Promise<CensusResult[]> => {
    const [ro] = (await tx.unsafe("SHOW transaction_read_only")) as unknown as {
      transaction_read_only: string;
    }[];
    if (ro?.transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] transaction is not read-only; refusing to measure`);
    }
    const [who] = (await tx.unsafe(
      "SELECT current_user AS who, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls",
    )) as unknown as { who: string; bypass_rls: boolean }[];
    if (who?.bypass_rls !== true) {
      throw new Error(
        `[${SCRIPT}] role ${who?.who} does not bypass RLS. Every count would be a permission ` +
          `artifact rather than a measurement; refusing to report.`,
      );
    }
    const results: CensusResult[] = [];
    for (const query of CENSUS_QUERIES) {
      const rows = (await tx.unsafe(query.sql)) as unknown as Record<string, unknown>[];
      results.push({ query, rows });
    }
    return results;
  };
  return (await sql.begin("read only", run)) as unknown as CensusResult[];
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  // Show WHICH database — never credentials.
  const parsed = new URL(url);
  console.log(`[${SCRIPT}] target host=${parsed.hostname} db=${parsed.pathname.slice(1)}`);
  console.log(`[${SCRIPT}] READ-ONLY — measures, repairs nothing\n`);

  const { sql } = createDbClient(url, { max: 1 });
  try {
    const results = await runCensus(sql);
    for (const result of results) {
      const { query, rows } = result;
      const n = censusCount(result);
      const tag = query.rule === "must_be_zero" ? (n === 0 ? "ok" : "MUST BE 0") : query.rule;
      console.log(`${query.id.padEnd(4)} ${String(n).padStart(6)}  [${tag}] ${query.title}`);
      for (const row of rows.slice(0, LIST_LIMIT)) console.log(`         ${formatRow(row)}`);
      if (rows.length > LIST_LIMIT) console.log(`         … ${rows.length - LIST_LIMIT} more`);
    }

    const gate = flipGate(results);
    console.log("");
    if (gate.pass) {
      console.log(
        "✓ Flip gate (plan §5 step 1): C2, C3, C4 and C6 are all 0. Record C1, C5 and C5b.",
      );
    } else {
      console.log(`✗ Flip gate (plan §5 step 1) FAILS on ${gate.failing.join(", ")}.`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
