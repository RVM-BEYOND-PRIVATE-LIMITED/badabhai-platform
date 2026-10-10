import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import {
  createDbClient,
  flipGate,
  runCensus,
  type CensusResult,
  type DbClient,
} from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayersRepository } from "./payers.repository";
import { PayerOrgsRepository } from "./payer-orgs.repository";

/**
 * ADR-0053 (PAY-DB-01) — the org tenancy CENSUS against seeded breaches (ORG_TENANCY_PLAN §5
 * item 6; PR #2155 review L4). The census is the owner's first step before `shadow` (O-8 step 1),
 * so a check that silently counted nothing would wave a breach through the flip. Each must-be-zero
 * check is proven to SEE its breach on a real Postgres, and the CLI the owner runs is proven to
 * exit 1 on it:
 *
 *  - C2  (A1) a payer active in TWO teams;
 *  - C3  (A2) a team's anchor who is also an active member of another team;
 *  - C4  (A3 / R6) an agent active in an employer's team;
 *  - C6a a payer with no solo org;
 *  - C6b an org whose anchor has no active owner membership;
 *  - C9  (record) a team member's unsettled payment order on their OWN wallet.
 *
 * The rows are written the way a broken accept or a pre-0035 account would leave them — directly,
 * because the service refuses to create them (that refusal is what A1–A3 and R65 test). The
 * database is SHARED with the other gate files, so nothing here assumes the census is otherwise
 * clean: every assertion names the ids seeded here, and the vacuity check removes the seeds and
 * watches those ids leave every check.
 *
 * Fixtures carry no PII: synthetic `@e2e.badabhai.invalid` emails encrypted by the real crypto,
 * ids fresh per run, everything deleted in afterAll.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run org-tenancy-census.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const REPO_ROOT = resolve(__dirname, "../../../..");
const TAG = randomUUID().slice(0, 8);

function isLocal(url: string): boolean {
  try {
    return /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The ids each check returned, as strings (every check selects at least one id column). */
function idsIn(results: readonly CensusResult[], check: string): string[] {
  const result = results.find((r) => r.query.id === check);
  if (!result) throw new Error(`census has no check ${check}`);
  return result.rows.flatMap((row) => Object.values(row).map(String));
}

/** The owner's command, `pnpm --filter @badabhai/db db:audit:org-tenancy`, against this database. */
function runCensusCli(): { status: number | null; stdout: string; stderr: string } {
  const windows = process.platform === "win32";
  const out = spawnSync(
    windows ? "pnpm.cmd" : "pnpm",
    ["--filter", "@badabhai/db", "db:audit:org-tenancy"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL },
      shell: windows,
      timeout: 120_000,
    },
  );
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

describe.skipIf(!RUN)(
  "ADR-0053 census — every must-be-zero check sees its breach (Postgres)",
  () => {
    let client!: DbClient;
    let payers!: PayersRepository;
    let orgs!: PayerOrgsRepository;
    const created: string[] = [];
    const orderIds: string[] = [];
    const seeded: Record<"c2" | "c3" | "c4" | "c6a" | "c6b" | "c9", string> = {
      c2: "",
      c3: "",
      c4: "",
      c6a: "",
      c6b: "",
      c9: "",
    };

    /** A payer row; with its solo org and owner membership unless `solo` is false. */
    async function payer(
      label: string,
      opts: { role?: "employer" | "agent"; solo?: boolean } = {},
    ): Promise<string> {
      const { id } = await payers.createOrGet({
        role: opts.role ?? "employer",
        email: `census-${label}-${TAG}@e2e.badabhai.invalid`,
        orgName: "Census Org",
        phone: undefined,
      });
      created.push(id);
      if (opts.solo !== false) await orgs.ensureSoloOrg(id);
      return id;
    }

    async function orgOf(anchor: string): Promise<string> {
      const [row] =
        await client.sql`SELECT id FROM payer_orgs WHERE root_payer_id = ${anchor}::uuid`;
      return String(row!.id);
    }

    /** A membership row in `anchor`'s org, as a (racing or pre-rule) accept would leave it. */
    async function member(
      anchor: string,
      memberPayerId: string | null,
      status: "invited" | "active",
    ): Promise<void> {
      await client.sql`
      INSERT INTO payer_members (org_id, member_payer_id, email_enc, email_hash, org_role, status,
                                 invited_at, accepted_at)
      VALUES (${await orgOf(anchor)}::uuid, ${memberPayerId}, 'enc:census',
              ${`hash:census-${randomUUID()}`}, 'recruiter', ${status}::text, now(),
              CASE WHEN ${status}::text = 'active' THEN now() ELSE NULL END)`;
    }

    beforeAll(async () => {
      if (!isLocal(DATABASE_URL)) {
        throw new Error("org-tenancy-census.db refuses a non-local DATABASE_URL");
      }
      client = createDbClient(DATABASE_URL, { max: 2 });
      const config = loadServerConfig({ NODE_ENV: "test" });
      payers = new PayersRepository(client.db, new PiiCryptoService(config));
      orgs = new PayerOrgsRepository(client.db);

      // Two team anchors (employers) everyone below joins.
      const x = await payer("x");
      const y = await payer("y");

      // C2 (A1): one payer, active in BOTH teams.
      seeded.c2 = await payer("c2");
      await member(x, seeded.c2, "active");
      await member(y, seeded.c2, "active");

      // C3 (A2): an anchor of a team (an invited member, no member id yet) who is active in X's.
      seeded.c3 = await payer("c3");
      await member(seeded.c3, null, "invited");
      await member(x, seeded.c3, "active");

      // C4 (A3 / R6): an AGENT active in an EMPLOYER's team.
      seeded.c4 = await payer("c4", { role: "agent" });
      await member(y, seeded.c4, "active");

      // C6a: a payer with no solo org at all.
      seeded.c6a = await payer("c6a", { solo: false });

      // C6b: an org whose anchor has no active owner membership in it.
      seeded.c6b = await payer("c6b", { solo: false });
      await client.sql`INSERT INTO payer_orgs (root_payer_id, status) VALUES (${seeded.c6b}::uuid, 'active')`;

      // C9 (record): a team member's unsettled order, stamped with their OWN wallet.
      seeded.c9 = await payer("c9");
      await member(x, seeded.c9, "active");
      const [order] = await client.sql`
      INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider,
                                  provider_order_id, status)
      VALUES (${seeded.c9}::uuid, 'pack_10', 499, 10, 'razorpay', ${`order_census_${TAG}`}, 'created')
      RETURNING id`;
      orderIds.push(String(order!.id));
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      await client.sql`DELETE FROM payment_orders WHERE id = ANY(${orderIds}::uuid[])`;
      await client.sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${created}::uuid[])`;
      await client.sql`DELETE FROM payers WHERE id = ANY(${created}::uuid[])`;
      await client.sql.end({ timeout: 5 });
    });

    it("each must-be-zero check lists exactly the breach seeded for it, and C9 records the order", async () => {
      const results = await runCensus(client.sql);
      expect(idsIn(results, "C2")).toContain(seeded.c2);
      expect(idsIn(results, "C3")).toContain(seeded.c3);
      expect(idsIn(results, "C4")).toContain(seeded.c4);
      expect(idsIn(results, "C6a")).toContain(seeded.c6a);
      expect(idsIn(results, "C6b")).toContain(seeded.c6b);
      expect(idsIn(results, "C9")).toContain(orderIds[0]);
      // Each breach is seen by its OWN check, not by a neighbour (C2 is not a C3 row, etc.).
      expect(idsIn(results, "C2")).not.toContain(seeded.c3);
      expect(idsIn(results, "C3")).not.toContain(seeded.c2);
      expect(idsIn(results, "C4")).not.toContain(seeded.c2);
      // C1 records every team member seeded here.
      for (const id of [seeded.c2, seeded.c3, seeded.c4, seeded.c9]) {
        expect(idsIn(results, "C1")).toContain(id);
      }
    });

    it("the flip gate fails on C2, C3, C4, C6a and C6b", async () => {
      const gate = flipGate(await runCensus(client.sql));
      expect(gate.pass).toBe(false);
      for (const check of ["C2", "C3", "C4", "C6a", "C6b"]) expect(gate.failing).toContain(check);
    });

    it("the owner's CLI (db:audit:org-tenancy) exits 1 and names the failing checks", () => {
      const run = runCensusCli();
      expect(run.status, run.stderr).toBe(1);
      const verdict = run.stdout.split("\n").find((line) => line.includes("Flip gate")) ?? "";
      expect(verdict).toMatch(/FAILS on/);
      for (const check of ["C2", "C3", "C4", "C6a", "C6b"]) expect(verdict).toContain(check);
    }, 120_000);

    it("not vacuous: with the seeds repaired, none of their ids is reported by any check", async () => {
      // Repair each breach the way an operator would, then re-measure.
      await client.sql`DELETE FROM payment_orders WHERE id = ANY(${orderIds}::uuid[])`;
      await client.sql`
      DELETE FROM payer_members
      WHERE member_payer_id = ANY(${[seeded.c2, seeded.c3, seeded.c4, seeded.c9]}::uuid[])
        AND org_id IN (SELECT id FROM payer_orgs WHERE root_payer_id <> member_payer_id)`;
      await orgs.ensureSoloOrg(seeded.c6a);
      await client.sql`DELETE FROM payer_orgs WHERE root_payer_id = ${seeded.c6b}::uuid`;
      await orgs.ensureSoloOrg(seeded.c6b);

      const results = await runCensus(client.sql);
      const ours = [...Object.values(seeded), ...orderIds];
      for (const check of ["C1", "C2", "C3", "C4", "C6a", "C6b", "C9"]) {
        expect(
          idsIn(results, check).filter((id) => ours.includes(id)),
          check,
        ).toEqual([]);
      }
    });
  },
);
