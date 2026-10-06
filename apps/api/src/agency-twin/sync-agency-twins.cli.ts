/**
 * The ADR-0050 agency-twin sync, run by hand (ADR-0050 §5 trigger 3) — the flip-window step and
 * the pre-arm probe.
 *
 *   node apps/api/dist/agency-twin/sync-agency-twins.cli.js \
 *     --match-v1=on|off --agency-twin-sync=on|off [--apply] [--job=<uuid>] [--batch-size=<n>]
 *
 * (`pnpm --filter @badabhai/api build` first; on a deployed box the api image already carries
 * `dist/`, so it runs where `DATABASE_URL` is.)
 *
 * WHEN. ADR-0050 §6.3 step (g): deploy with MATCH_V1_ENABLED on, then this with `--apply` (twins
 * move from `draft` to their mirrored status), then D4 (seed rows only), then D5. A DRY RUN (the
 * default) is the step (e) probe: per agency job, what the sync would do and why a twin would be
 * refused.
 *
 * THE SAME CODE AS THE API'S QUEUE: `syncAgencyTwin` / `disarmAgencyTwins` from `@badabhai/db`
 * for every plan and write, and `twinSyncedPayload` / `killSwitchPayload` + the real
 * `EventsService` for every event — on the write's own transaction, validated by the registry.
 * It lives in the api (not `packages/db`) because this is where the event registry and the
 * ADR-0050 Q3 constants already are, with no new dependency edge.
 *
 * TWO VALUES IT REFUSES TO GUESS (both REQUIRED — the target's deploy state, which a process on
 * another box cannot read): `--match-v1` and `--agency-twin-sync`. `--agency-twin-sync=off` runs
 * the KILL SWITCH (every non-closed twin → `paused`, no field copied) and nothing else.
 *
 * TARGET SAFETY: the shared ops guard (`enforceOpsGuard`) — a write to a production-like
 * database needs `--i-am-authorised-to-write-to-production` AND
 * `OPS_ALLOW_PRODUCTION=sync-agency-twins`. Output is ids, enums and counts only.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  AGENCY_TWIN_ORG_LABEL,
  AGENCY_TWIN_SYSTEM_ACTOR_ID,
  type ServerConfig,
} from "@badabhai/config";
import {
  AGENCY_TWIN_SYNC_SOURCE,
  PRODUCTION_WRITE_FLAG,
  agencyTwinConstantsProblems,
  createDbClient,
  disarmAgencyTwins,
  enforceOpsGuard,
  listAgencyJobIds,
  syncAgencyTwin,
  type AgencyTwinContext,
  type Database,
} from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { sql as dsql } from "drizzle-orm";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { killSwitchPayload, twinSyncedPayload } from "./agency-twin.service";

export const SYNC_AGENCY_TWINS_SCRIPT = "sync-agency-twins";
const DISARM_BATCH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyncAgencyTwinsArgs {
  apply: boolean;
  matchV1Enabled: boolean;
  armed: boolean;
  job: string | null;
  batchSize: number;
}

/** Strict argv parsing: an unknown, malformed or missing required flag is an error, never a guess. */
export function parseSyncAgencyTwinsArgs(argv: readonly string[]): SyncAgencyTwinsArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: "boolean", default: false },
      "match-v1": { type: "string" },
      "agency-twin-sync": { type: "string" },
      job: { type: "string" },
      "batch-size": { type: "string" },
      [PRODUCTION_WRITE_FLAG.replace(/^--/, "")]: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const onOff = (name: "match-v1" | "agency-twin-sync"): boolean => {
    const v = values[name];
    if (v !== "on" && v !== "off") {
      throw new Error(
        `--${name}=on|off is REQUIRED — it is the target's deploy state, and this script will not ` +
          `guess it (a wrong guess moves every twin's status).`,
      );
    }
    return v === "on";
  };
  const job = values.job ?? null;
  if (job !== null && !UUID.test(job)) throw new Error("--job must be a uuid");
  const batchSize = values["batch-size"] === undefined ? 200 : Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error("--batch-size must be an integer in 1..5000");
  }
  return {
    apply: values.apply === true,
    matchV1Enabled: onOff("match-v1"),
    armed: onOff("agency-twin-sync"),
    job,
    batchSize,
  };
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseSyncAgencyTwinsArgs(argv);
  const problems = agencyTwinConstantsProblems(AGENCY_TWIN_SYSTEM_ACTOR_ID, AGENCY_TWIN_ORG_LABEL);
  if (problems.length > 0) {
    throw new Error(`the ADR-0050 Q3 constants are invalid: ${problems.join("; ")}`);
  }
  const { connectionString } = enforceOpsGuard({
    script: SYNC_AGENCY_TWINS_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: args.apply,
  });
  console.log(
    `[${SYNC_AGENCY_TWINS_SCRIPT}] ${args.apply ? "APPLY" : "DRY-RUN"} — match-v1=${
      args.matchV1Enabled ? "on" : "off"
    } agency-twin-sync=${args.armed ? "on" : "off"}`,
  );

  const client = createDbClient(connectionString, { max: 1 });
  const db = client.db;
  // The real, registry-validating emitter. NODE_ENV labels the event's metadata only; the blast
  // radius was decided above by the guard, from the connection string.
  const events = new EventsService(new EventsRepository(db), {
    NODE_ENV: process.env.NODE_ENV ?? "development",
  } as ServerConfig);
  const emit = (tx: Database, payload: PayloadInputOf<"job_posting.twin_synced">) =>
    events.emit({
      event_name: "job_posting.twin_synced",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "job_posting", subject_id: payload.job_posting_id },
      payload,
      tx,
      correlationId: randomUUID(),
      requestId: SYNC_AGENCY_TWINS_SCRIPT,
    });

  try {
    if (!args.armed) {
      const rows = await db.execute<{ n: number }>(dsql`
        SELECT count(*)::int AS n FROM job_postings
        WHERE sync_source = ${AGENCY_TWIN_SYNC_SOURCE} AND status NOT IN ('closed', 'paused')`);
      const due = (rows as unknown as { n: number }[])[0]?.n ?? 0;
      let paused = 0;
      if (args.apply) {
        for (;;) {
          const batch = await disarmAgencyTwins(db, DISARM_BATCH, (tx, m) =>
            emit(tx, killSwitchPayload(m)).then(() => undefined),
          );
          paused += batch.length;
          if (batch.length < DISARM_BATCH) break;
        }
      }
      console.log(`  kill switch: twins to pause=${due} paused=${paused}`);
      return 0;
    }

    const cfg = await new MatchConfigService(new MatchConfigRepository(db)).get();
    const ctx: AgencyTwinContext = {
      matchV1Enabled: args.matchV1Enabled,
      relatedSkillsDefault: cfg.relatedSkillsDefault,
      systemActorId: AGENCY_TWIN_SYSTEM_ACTOR_ID,
      orgLabel: AGENCY_TWIN_ORG_LABEL,
    };
    const counts: Record<string, number> = {
      jobs: 0,
      unchanged: 0,
      created: 0,
      updated: 0,
      status_changed: 0,
      refused: 0,
      blocked: 0,
      failed: 0,
    };
    let afterId: string | null = null;
    for (;;) {
      const ids: string[] = args.job
        ? [args.job]
        : await listAgencyJobIds(db, afterId, args.batchSize);
      for (const id of ids) {
        counts.jobs! += 1;
        try {
          const out = await syncAgencyTwin(db, id, ctx, {
            apply: args.apply,
            emit: (tx, w) => emit(tx, twinSyncedPayload(w)).then(() => undefined),
          });
          if (out.kind === "written") {
            counts[out.operation]! += 1;
            console.log(
              `  ${id} ${out.operation} status=${out.status}` +
                (out.refusedReason ? ` refused=${out.refusedReason}` : "") +
                ` changed=${out.changedFields.join(",")}`,
            );
          } else if (out.kind === "unchanged") counts.unchanged! += 1;
          else if (out.kind === "blocked_by_conversion") {
            counts.blocked! += 1;
            console.log(`  ${id} BLOCKED: posting ${out.jobPostingId} is a D4 conversion of it`);
          }
        } catch (err) {
          // One job's failure never stops the run; the api sweep retries it. Ids only.
          counts.failed! += 1;
          console.log(`  ${id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (args.job || ids.length < args.batchSize) break;
      afterId = ids[ids.length - 1] ?? null;
    }
    console.log(
      `  summary: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}${args.apply ? "" : " (DRY RUN — nothing written; re-run with --apply)"}`,
    );
    return counts.failed! > 0 ? 1 : 0;
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(
        `[${SYNC_AGENCY_TWINS_SCRIPT}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
