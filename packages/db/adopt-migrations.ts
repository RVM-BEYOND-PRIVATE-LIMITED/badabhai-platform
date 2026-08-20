/**
 * Adopt ALREADY-APPLIED migrations into the Drizzle journal — generalized from adopt-0066.ts.
 *
 * THE PROBLEM. `drizzle.__drizzle_migrations` records 47 of the repo's 74 migrations. The other
 * 27 are unrecorded but their DDL is already live (created by hand, or by differently-numbered
 * copies on stale branches). `pnpm db:migrate` therefore reaches 0048 — the first unrecorded
 * migration carrying DDL — and dies on "already exists", which blocks EVERY later migration
 * including the org-as-tenant one. See GAP-DB-19.
 *
 * THE FIX. Record those migrations as applied WITHOUT re-running their DDL. That is only safe if
 * what is in the database actually matches what each migration would have created, so this
 * script VERIFIES FIRST, AT DEPTH, and refuses to record anything on any mismatch.
 *
 * DEPTH (per migration, matching adopt-0066.ts rather than a presence-only heuristic). The rules
 * live in `src/migration-adoption.ts`, pure and unit-tested; this file is the runner:
 *   • tables exist
 *   • every column exists AND its data_type matches the declared type
 *   • every CREATE INDEX exists
 *   • every ADD CONSTRAINT exists
 *   • ENABLE / FORCE ROW LEVEL SECURITY is actually enabled / forced
 *   • every REVOKE ALL actually took — the role holds NO grant on the table
 *   • the migration declares SOMETHING checkable, and contains no dynamic SQL
 *
 * THE LAST TWO WERE ADDED AFTER THIS TOOL GOT ONE WRONG. `0048` declares FORCE plus four
 * REVOKEs per table; its objects all verified, so it was adopted clean — and `anon`,
 * `authenticated` and `service_role` still hold every DML privilege plus TRUNCATE on all three
 * of its tables. That is R39, and the pass is what stopped anyone looking. Separately, a
 * migration made only of backfills or DROPs parsed to an EMPTY expectation set, which trivially
 * matches any database: recorded as applied on no evidence at all. Both are refusals now.
 *
 * SAFETY RAILS — this writes to a live database, so:
 *   • verify-only by default; --apply is required to write
 *   • --apply additionally REQUIRES --expect-host <substring>, matched against the real host,
 *     so it is impossible to adopt against the wrong environment by having the wrong .env loaded
 *   • ALL-OR-NOTHING: if any selected migration fails verification, NOTHING is recorded
 *   • --only <tag,tag,...> pins the exact set, so a later drift cannot silently widen the scope
 *   • an unrecognised SQL type is a HARD FAILURE, never a silent pass (fail closed)
 *
 *   npx tsx adopt-migrations.ts                                  # verify every unrecorded one
 *   npx tsx adopt-migrations.ts --only 0048_empty_archangel      # verify a subset
 *   npx tsx adopt-migrations.ts --apply --expect-host db.staging # verify, then record
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

import {
  adoptionProblems,
  effectVerifierFor,
  parseMigration,
  type LiveCatalog,
} from "./src/migration-adoption";

config({ path: "../../.env" });
config({ path: ".env" });

const argv = process.argv;
const APPLY = argv.includes("--apply");
const flag = (name: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
};
const DOCTOR = argv.includes("--doctor");
const FORCE_RLS_FOR = flag("--force-rls-for");
const EXPECT_HOST = flag("--expect-host");
const ONLY = flag("--only")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}


async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const parsed = new URL(url);
  const host = parsed.hostname;
  console.log(`[adopt] target host=${host} db=${parsed.pathname.slice(1)}`);
  console.log(`[adopt] mode=${APPLY ? "APPLY (writes)" : "VERIFY-ONLY (read-only)"}`);

  if (APPLY) {
    if (!EXPECT_HOST) {
      console.error(
        "[adopt] REFUSING: --apply requires --expect-host <substring>.\n" +
          "        The wrong .env is the likeliest way to adopt against the wrong database.",
      );
      process.exitCode = 1;
      return;
    }
    if (!host.includes(EXPECT_HOST)) {
      console.error(
        `[adopt] REFUSING: --expect-host "${EXPECT_HOST}" does not match host "${host}".`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const dir = join(process.cwd(), "migrations");
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };

  const sql = postgres(url, { max: 1 });
  try {
    if (DOCTOR) {
      // Pre-flight. `FORCE ROW LEVEL SECURITY` makes RLS apply to the table OWNER too. With ZERO
      // policies in this schema, forcing a table the API's role owns WITHOUT bypassrls would deny
      // the API all access to it. So: is the connection role bypassrls, and who owns the tables?
      const me = await sql<{ u: string; su: boolean; brls: boolean }[]>`
        SELECT current_user u, rolsuper su, rolbypassrls brls
          FROM pg_roles WHERE rolname = current_user`;
      console.log(`\n[doctor] role=${me[0]!.u} superuser=${me[0]!.su} bypassrls=${me[0]!.brls}`);
      console.log(
        me[0]!.brls || me[0]!.su
          ? "[doctor] → FORCE RLS is SAFE for this connection (it bypasses RLS regardless)."
          : "[doctor] → ⚠ FORCE RLS would DENY this connection on any table it owns (zero policies).",
      );
      const own = await sql<{ relname: string; owner: string; forced: boolean; n: string }[]>`
        SELECT c.relname, pg_get_userbyid(c.relowner) owner, c.relforcerowsecurity forced,
               (SELECT count(*) FROM pg_class x WHERE x.oid=c.oid)::text n
          FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='r' AND NOT c.relforcerowsecurity
         ORDER BY c.relname`;
      console.log(`\n[doctor] tables with RLS enabled but NOT forced (${own.length}):`);
      for (const r of own) console.log(`   ${r.relname.padEnd(26)} owner=${r.owner}`);

      // Will `drizzle-kit migrate` skip everything? It matches a recorded row by created_at AND
      // the sha256 of the migration file. A hash mismatch means drizzle would try to RE-APPLY a
      // migration whose DDL is already live — the exact "already exists" failure we just cleared.
      const rows = await sql<{ hash: string; created_at: string }[]>`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations`;
      const byWhen = new Map(rows.map((r) => [String(r.created_at), r.hash]));
      const bad: string[] = [];
      let matched = 0;
      for (const e of journal.entries) {
        const stored = byWhen.get(String(e.when));
        if (stored === undefined) {
          bad.push(`${e.tag}: NOT RECORDED`);
          continue;
        }
        const actual = createHash("sha256")
          .update(readFileSync(join(dir, `${e.tag}.sql`)))
          .digest("hex");
        if (stored === actual) matched += 1;
        else bad.push(`${e.tag}: hash mismatch (stored ${stored.slice(0, 12)}… vs file ${actual.slice(0, 12)}…)`);
      }
      console.log(`\n[doctor] journal hash check: ${matched}/${journal.entries.length} match`);
      if (bad.length === 0) console.log("[doctor] → `pnpm db:migrate` will skip all migrations (no DDL).");
      else for (const b of bad) console.log(`   ✗ ${b}`);

      // THE OTHER DIRECTION, and the one nothing was looking at. Everything above asks "is each
      // file recorded?". This asks "is each recorded row a file?" — and a row with no journal
      // entry means production has applied a migration THIS CHECKOUT DOES NOT CONTAIN.
      //
      // Found the hard way on 2026-08-20: `0081_worker_feedback_screen_context` merged and was
      // applied to production while a second branch was minting its own `0081`. The slot was
      // taken, in the database, and every local tool reported a clean journal because none of
      // them looked this way round. That is exactly the collision MIGRATIONS.md's numbering
      // rules exist to prevent, and a --doctor that cannot see it is why it happened anyway.
      const known = new Set(journal.entries.map((e) => String(e.when)));
      const orphans = rows.filter((r) => !known.has(String(r.created_at)));
      console.log(`
[doctor] recorded rows with NO journal entry here: ${orphans.length}`);
      for (const o of orphans) {
        console.log(`   ⚠ created_at=${o.created_at} hash=${o.hash.slice(0, 16)}…`);
      }
      if (orphans.length > 0) {
        console.log("   → production has applied a migration this checkout does not have.");
        console.log("     Fetch and rebase before minting a new one — the number may be taken.");
      }
      console.log("");
      return;
    }

    if (FORCE_RLS_FOR) {
      // Complete a PARTIALLY-applied migration by running exactly the FORCE ROW LEVEL SECURITY
      // statements that migration itself declares — never a table it does not name. Scope comes
      // from the .sql file, so it cannot creep.
      const entry = journal.entries.find((e) => e.tag === FORCE_RLS_FOR);
      if (!entry) throw new Error(`unknown migration "${FORCE_RLS_FOR}"`);
      const exp = parseMigration(readFileSync(join(dir, `${entry.tag}.sql`), "utf8"));
      const declared = [...exp.rlsForced];
      const live = await sql<{ relname: string; forced: boolean }[]>`
        SELECT c.relname, c.relforcerowsecurity forced FROM pg_class c
          JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='r'`;
      const forcedNow = new Set(live.filter((r) => r.forced).map((r) => r.relname));
      const todo = declared.filter((t) => !forcedNow.has(t));
      console.log(`\n[force-rls] ${entry.tag} declares FORCE on ${declared.length} table(s)`);
      console.log(`[force-rls] already forced: ${declared.length - todo.length} | to fix: ${todo.length}`);
      for (const t of todo) console.log(`   → ${t}`);
      if (todo.length === 0) {
        console.log("[force-rls] nothing to do.");
        return;
      }
      if (!APPLY) {
        console.log("[force-rls] verify-only. Re-run with --apply --expect-host <host>.");
        return;
      }
      for (const t of todo) {
        await sql.unsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
        console.log(`[force-rls] forced ${t}`);
      }
      const after = await sql<{ relname: string; forced: boolean }[]>`
        SELECT c.relname, c.relforcerowsecurity forced FROM pg_class c
          JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='r' AND c.relname = ANY(${declared})`;
      console.log("[force-rls] verify:");
      for (const r of after) console.log(`   ${r.forced ? "OK  " : "FAIL"} ${r.relname} forced=${r.forced}`);
      return;
    }

    const recordedRows = await sql<{ created_at: string }[]>`
      SELECT created_at FROM drizzle.__drizzle_migrations`;
    const recorded = new Set(recordedRows.map((r) => String(r.created_at)));

    let targets = journal.entries.filter((e) => !recorded.has(String(e.when)));
    if (ONLY.length > 0) {
      const want = new Set(ONLY);
      const unknown = ONLY.filter((t) => !journal.entries.some((e) => e.tag === t));
      if (unknown.length > 0) throw new Error(`--only names unknown migrations: ${unknown.join(", ")}`);
      targets = targets.filter((e) => want.has(e.tag));
    }
    // COUNT BY MEMBERSHIP, NOT BY SUBTRACTION. `journal.length - recorded.size` is only correct
    // while every recorded row corresponds to a journal entry in THIS checkout. On 2026-08-20 it
    // did not: production carried an orphan row from a checkout that never reached `main`, and
    // the subtraction reported five unrecorded files when six were. `targets` was right, so the
    // run was safe — but the header contradicted it, and a header that disagrees with the work
    // is worse than no header. Orphans are now stated instead of silently absorbed.
    const matched = journal.entries.filter((e) => recorded.has(String(e.when))).length;
    const unrecorded = journal.entries.length - matched;
    const orphans = recorded.size - matched;
    console.log(
      `[adopt] recorded=${recorded.size} unrecorded=${unrecorded} selected=${targets.length}` +
        (orphans > 0
          ? `\n[adopt] ⚠ ${orphans} recorded row(s) match NO journal entry here — production has a` +
            ` migration this checkout does not. Run --doctor; fetch before minting a new number.`
          : "") +
        "\n",
    );
    if (targets.length === 0) {
      console.log("[adopt] nothing to do.");
      return;
    }

    // live catalog
    const cols = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema='public'`;
    const liveTables = new Set(cols.map((r) => r.table_name));
    const liveCols = new Map(cols.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
    const liveIdx = new Set(
      (await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`).map(
        (r) => r.indexname,
      ),
    );
    const liveCons = new Set(
      (await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint`).map((r) => r.conname),
    );
    const rlsRows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relkind='r'`;
    const rlsOn = new Set(rlsRows.filter((r) => r.relrowsecurity).map((r) => r.relname));
    const rlsForced = new Set(rlsRows.filter((r) => r.relforcerowsecurity).map((r) => r.relname));

    // GRANTS — the R39 blind spot. A migration's REVOKE tail is the only thing standing between
    // `service_role` (rolbypassrls = true, so RLS never filters it) and the table, and it was
    // not checked here until 0048 was adopted clean with all twelve of its REVOKEs unapplied.
    const grantRows = await sql<{ table_name: string; grantee: string }[]>`
      SELECT DISTINCT table_name, grantee FROM information_schema.role_table_grants
       WHERE table_schema='public'`;
    const grants = new Set(grantRows.map((r) => `${r.table_name}:${r.grantee.toLowerCase()}`));

    // FUNCTION EXECUTE — the same blind spot one object class over, and the reason 0085 exists.
    // `information_schema.routine_privileges` omits `PUBLIC` entirely (it reports named grantees
    // only), and PUBLIC is the broadest grant of the four, so this reads `pg_proc.proacl`
    // directly. `aclexplode` renders the PUBLIC grant as grantee OID 0, which `pg_get_userbyid`
    // returns as `-` — normalised to `public` so it matches DATA_API_ROLES lowercased.
    //
    // A NULL `proacl` means "defaults apply", which for a function is EXECUTE to PUBLIC — so
    // `coalesce(proacl, acldefault('f', proowner))` is not tidiness: without it a function that
    // has never been touched by a GRANT reads as having no grants at all, which is the exact
    // false PASS this check exists to prevent.
    const fnAclRows = await sql<{ proname: string; grantee: string; priv: string }[]>`
      SELECT p.proname,
             CASE WHEN a.grantee = 0 THEN 'public'
                  ELSE lower(pg_get_userbyid(a.grantee)) END AS grantee,
             a.privilege_type AS priv
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE'`;
    const functionGrants = new Set(fnAclRows.map((r) => `${r.proname}:${r.grantee}`));

    const live: LiveCatalog = {
      tables: liveTables,
      columns: liveCols,
      indexes: liveIdx,
      constraints: liveCons,
      rlsEnabled: rlsOn,
      rlsForced,
      grants,
      functionGrants,
    };

    const clean: JournalEntry[] = [];
    const dirty: { tag: string; problems: string[] }[] = [];

    for (const entry of targets) {
      // Every rule lives in `src/migration-adoption.ts` — pure, so each one is unit-tested
      // against a synthetic catalog rather than only ever exercised against production. The tag
      // is passed because a migration may register an EFFECT VERIFIER there: the one narrow way
      // past the dynamic-SQL refusal, and strictly more evidence than the parse, not less.
      const problems = adoptionProblems(
        readFileSync(join(dir, `${entry.tag}.sql`), "utf8"),
        live,
        entry.tag,
      );

      if (problems.length === 0) {
        clean.push(entry);
        const v = effectVerifierFor(entry.tag);
        console.log(
          v === undefined
            ? `  ✓ ${entry.tag}`
            : `  ✓ ${entry.tag} — ${v.assertions} effect assertion(s) verified against the catalog (${v.why})`,
        );
      } else {
        dirty.push({ tag: entry.tag, problems });
        console.log(`  ✗ ${entry.tag} — ${problems.length} mismatch(es)`);
        for (const p of problems.slice(0, 8)) console.log(`      ${p}`);
        if (problems.length > 8) console.log(`      … +${problems.length - 8} more`);
      }
    }

    console.log(`\n[adopt] clean=${clean.length} mismatched=${dirty.length}`);

    if (dirty.length > 0) {
      console.error(
        "\n[adopt] REFUSING to record ANYTHING — all-or-nothing.\n" +
          "        The live schema is not what these migrations would have created. Adopting\n" +
          "        would hide that difference from every future migration, permanently.",
      );
      process.exitCode = 1;
      return;
    }
    if (!APPLY) {
      console.log("[adopt] verify-only. Re-run with --apply --expect-host <host> to record.");
      return;
    }

    // Drizzle stores a plain sha256 of the migration FILE contents, ordered by created_at.
    //
    // IDEMPOTENT BY THE INSERT, not only by the selection. `targets` already excludes anything
    // recorded, so a second ordinary run does nothing — but that filter was read seconds ago and
    // `__drizzle_migrations` has no unique constraint on `created_at`, so two overlapping runs
    // (or one re-run after a half-finished attempt) would both pass the filter and write the
    // same row twice. `WHERE NOT EXISTS` inside the same transaction makes the write itself the
    // guard, and re-reports what it actually inserted rather than what it intended to.
    let written = 0;
    await sql.begin(async (tx) => {
      for (const entry of clean) {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, `${entry.tag}.sql`)))
          .digest("hex");
        const rows = await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          SELECT ${hash}, ${entry.when}
           WHERE NOT EXISTS (
             SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}
           )
          RETURNING 1 AS ok`;
        if (rows.length > 0) written += 1;
        else console.log(`  = ${entry.tag} was already recorded by the time we wrote — skipped`);
      }
    });
    console.log(`[adopt] recorded ${written} of ${clean.length} verified migration(s). \`pnpm db:migrate\` can now proceed.`);
    console.log(`[adopt] re-run with --doctor to confirm drizzle will attempt no DDL.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[adopt] failed:", err);
  process.exit(1);
});
