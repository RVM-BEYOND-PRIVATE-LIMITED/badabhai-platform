/**
 * `db:audit:form-write-path` — reproduces the trade-form answer write and prints the REAL error.
 *
 * ═══ SAFETY: NOTHING IS EVER COMMITTED ═══
 *
 * Each INSERT below runs inside `sql.begin(...)` whose callback ALWAYS throws a rollback sentinel
 * on its last line, so postgres.js always issues ROLLBACK. There is no path that reaches COMMIT.
 * Everything else in this file is a catalogue SELECT.
 *
 * WHY A WRITE AT ALL. 149 unit tests cover the form's answer path with every repository mocked, so
 * this SQL has never executed in CI. Reading constraints says what COULD fail; executing the
 * statement the service actually builds says what DOES.
 *
 * EVERY SECTION IS INDEPENDENT. A failure reports and continues — a diagnostic that dies on its
 * own first bad query tells you less than one that runs the rest.
 */
import { config } from "dotenv";
import { join } from "node:path";
import postgres from "postgres";

config({ path: join("..", "..", ".env") });

const ROLLBACK = Symbol("intentional-rollback");
const PACK = "qp_cnc_turning";

function url(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    console.error("DATABASE_URL is not set. Run this the same way as db:audit:live-drift.");
    process.exit(1);
  }
  return value;
}

/** Print a PostgresError the way a server log would, so the cause is unambiguous. */
function describe(error: unknown): void {
  const e = error as Record<string, unknown>;
  if (typeof e?.code === "string") {
    console.log(`    !! ${String(e.severity ?? "ERROR")} ${String(e.code)}: ${String(e.message)}`);
    for (const key of ["detail", "hint", "constraint", "column", "table", "where"]) {
      if (e[key]) console.log(`       ${key}: ${String(e[key])}`);
    }
  } else {
    console.log(`    !! ${String((error as Error)?.message ?? error)}`);
  }
}

async function step<T>(title: string, fn: () => Promise<T>): Promise<T | null> {
  console.log(`\n══════ ${title} ══════`);
  try {
    return await fn();
  } catch (error) {
    describe(error);
    console.log("  (section failed; continuing)");
    return null;
  }
}

/** Run one candidate statement and ALWAYS roll back. Prints OK or the exact Postgres error. */
async function probe(
  sql: postgres.Sql,
  label: string,
  run: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<void> {
  console.log(`  ${label}`);
  try {
    await sql.begin(async (tx) => {
      await run(tx);
      console.log("    OK — this statement succeeds");
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) describe(error);
  }
}

async function main(): Promise<void> {
  const sql = postgres(url(), { max: 1, prepare: false });
  console.log("[audit:form-write-path] catalogue reads + ROLLED-BACK write probes.");
  console.log(`  target host = ${/@([^/:]+)/.exec(url())?.[1] ?? "unknown"}`);

  try {
    const packs = await step(`${PACK} in the database`, async () => {
      const rows = await sql`
        SELECT pack_id, version, status, locale, family_id
        FROM question_pack WHERE pack_id = ${PACK} ORDER BY version`;
      for (const p of rows) {
        console.log(`  v${p.version}  status=${p.status}  locale=${p.locale}  family=${p.family_id}`);
      }
      if (rows.length === 0) console.log("  !! NOT SEEDED under this pack_id");
      const items = await sql`
        SELECT pack_version, count(*)::int AS n FROM question_pack_item
        WHERE pack_id = ${PACK} GROUP BY pack_version ORDER BY pack_version`;
      for (const i of items) console.log(`  items: v${i.pack_version} -> ${i.n}`);
      return rows;
    });

    // THE ACTIVE VERSION IS WHAT THE SERVICE PINS, not the highest — `loadForFamily` filters on
    // status='active'. A row written against a different version is still legal here (no FK), but
    // the number is worth seeing next to what the pack rows say.
    const activeVersion =
      (packs ?? []).find((p) => p.status === "active")?.version ??
      (packs ?? [])[packs?.length ? packs.length - 1 : 0]?.version ??
      1;

    const who = await step("a worker with a form handover", async () => {
      // ORDERED THE WAY `findLatestSessionByWorker` ORDERS (chat.repository.ts:165) so the probe
      // pins the SAME session row the service would. `chat_sessions` has `started_at`, not
      // `created_at`.
      const rows = await sql`
        SELECT w.id AS worker_id, cs.id AS session_id, cs.status AS session_status,
               cs.conversation_state ->> 'form_kind' AS form_kind
        FROM chat_sessions cs
        JOIN workers w ON w.id = cs.worker_id
        WHERE cs.conversation_state ->> 'form_kind' IS NOT NULL
        ORDER BY cs.last_message_at DESC NULLS LAST, cs.started_at DESC
        LIMIT 1`;
      if (rows.length === 0) {
        console.log("  !! no session carries form_kind — the handover never wrote it");
        return null;
      }
      const r = rows[0]!;
      console.log(`  worker=${r.worker_id}`);
      console.log(`  session=${r.session_id} (status=${r.session_status})`);
      console.log(`  form_kind=${r.form_kind}   pack_version to write=${activeVersion}`);
      return r;
    });

    if (!who) {
      console.log("\nNo worker to probe with — cannot run the write probes.");
      return;
    }
    const workerId = who.worker_id as string;
    const sessionId = who.session_id as string;

    console.log("\n══════ WRITE PROBES (each one rolled back) ══════");

    await probe(
      sql,
      "[a] worker_pack_answer — single_select, value in answer_text:",
      (tx) => tx`
        INSERT INTO worker_pack_answer
          (worker_id, chat_session_id, pack_id, pack_version, question_key,
           answer_text, status, source)
        VALUES (${workerId}, ${sessionId}, ${PACK}, ${activeVersion},
                'turning_experience', '3-7 years', 'answered', 'form')
        ON CONFLICT (worker_id, pack_id, question_key) DO UPDATE SET
          answer_text = excluded.answer_text,
          answer_number = excluded.answer_number,
          answer_bool = excluded.answer_bool,
          answer_option_keys = excluded.answer_option_keys,
          status = excluded.status,
          source = excluded.source,
          answered_at = now()`,
    );

    await probe(
      sql,
      "[b] worker_pack_answer — multi_select, value in answer_option_keys:",
      (tx) => tx`
        INSERT INTO worker_pack_answer
          (worker_id, chat_session_id, pack_id, pack_version, question_key,
           answer_option_keys, status, source)
        VALUES (${workerId}, ${sessionId}, ${PACK}, ${activeVersion},
                'turning_machine', ${sql.array(["cnc_lathe", "vmc"])}, 'answered', 'form')
        ON CONFLICT (worker_id, pack_id, question_key) DO UPDATE SET
          answer_text = excluded.answer_text,
          answer_number = excluded.answer_number,
          answer_bool = excluded.answer_bool,
          answer_option_keys = excluded.answer_option_keys,
          status = excluded.status,
          source = excluded.source,
          answered_at = now()`,
    );

    await probe(
      sql,
      "[c] worker_attributes — text value, the shape projectProfile builds:",
      (tx) => tx`
        INSERT INTO worker_attributes
          (worker_id, attribute_key, value_kind, value_text,
           source, question_key, pack_id, pack_version, session_id)
        VALUES (${workerId}, 'turning_experience', 'text', '3-7 years',
                'answer_map', 'turning_experience', ${PACK}, ${activeVersion}, ${sessionId})
        ON CONFLICT (worker_id, attribute_key) DO UPDATE SET
          value_kind = excluded.value_kind,
          value_bool = excluded.value_bool,
          value_number = excluded.value_number,
          value_text = excluded.value_text,
          value_text_list = excluded.value_text_list,
          value_text_polished = excluded.value_text_polished,
          value_text_polished_declined = CASE WHEN worker_attributes.value_text IS NOT DISTINCT FROM excluded.value_text THEN worker_attributes.value_text_polished_declined ELSE false END,
          source = excluded.source,
          question_key = excluded.question_key,
          pack_id = excluded.pack_id,
          pack_version = excluded.pack_version,
          session_id = excluded.session_id,
          updated_at = now()`,
    );

    await probe(
      sql,
      "[d] worker_attributes — text_list, the multi-select shape:",
      (tx) => tx`
        INSERT INTO worker_attributes
          (worker_id, attribute_key, value_kind, value_text_list,
           source, question_key, pack_id, pack_version, session_id)
        VALUES (${workerId}, 'turning_machine', 'text_list',
                ${sql.json(["CNC lathe", "VMC"])},
                'answer_map', 'turning_machine', ${PACK}, ${activeVersion}, ${sessionId})
        ON CONFLICT (worker_id, attribute_key) DO UPDATE SET
          value_kind = excluded.value_kind,
          value_bool = excluded.value_bool,
          value_number = excluded.value_number,
          value_text = excluded.value_text,
          value_text_list = excluded.value_text_list,
          value_text_polished = excluded.value_text_polished,
          value_text_polished_declined = CASE WHEN worker_attributes.value_text IS NOT DISTINCT FROM excluded.value_text THEN worker_attributes.value_text_polished_declined ELSE false END,
          source = excluded.source,
          question_key = excluded.question_key,
          pack_id = excluded.pack_id,
          pack_version = excluded.pack_version,
          session_id = excluded.session_id,
          updated_at = now()`,
    );

    console.log("\n  Any '!!' line above is the production 500. All probes rolled back.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main();
