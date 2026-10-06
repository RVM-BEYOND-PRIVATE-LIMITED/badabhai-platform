/**
 * `db:sync:agency-twins` — the ADR-0050 agency-twin sync, run by hand (ADR-0050 §5 trigger 3).
 *
 * WHEN. In the V1 flip window (ADR-0050 §6.3 step g): deploy with MATCH_V1_ENABLED on, then
 * `db:sync:agency-twins --apply` (twins move from `draft` to their mirrored status), then D4
 * (seed rows only), then D5 `db:materialize:reach --apply`. Also the probe of step (e): a DRY RUN
 * prints, per agency job, what the sync would do and why a twin would be refused.
 *
 * THE SAME CODE AS THE API'S QUEUE. Every plan, diff and write is `syncAgencyTwin` /
 * `disarmAgencyTwins` from `./agency-twin` — the functions the api's event poll and sweep run —
 * so a twin written here and a twin written by the sweep cannot differ. Every write emits the
 * same validated `job_posting.twin_synced` v1 on the same transaction.
 *
 * TWO VALUES IT REFUSES TO GUESS (both REQUIRED, because both are deploy state this script cannot
 * read from the box it is not running on):
 *   --match-v1=on|off           the target's MATCH_V1_ENABLED. `off` stages every twin as `draft`.
 *   --agency-twin-sync=on|off   the target's AGENCY_TWIN_SYNC_ENABLED. `off` runs the KILL SWITCH
 *                               (every non-closed twin → `paused`, no field copied) — the same
 *                               single action the disarmed api sweep performs — and nothing else.
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes. Production writes go through the shared ops guard
 * (`enforceOpsGuard`: `--i-mean-production` + `BADABHAI_OPS_ALLOW_PROD_WRITE=db:sync:agency-twins`).
 * `--job=<uuid>` limits the run to one agency job.
 *
 * PRIVACY: ids, enums and counts only on stdout — never a title, a description or an agency id.
 *
 *   pnpm db:sync:agency-twins --match-v1=on --agency-twin-sync=on
 *   pnpm db:sync:agency-twins --match-v1=on --agency-twin-sync=on --apply
 */
import { AGENCY_TWIN_ORG_LABEL, AGENCY_TWIN_SYSTEM_ACTOR_ID } from "@badabhai/config";
import {
  ENVIRONMENTS,
  createEvent,
  type Environment,
  type PayloadInputOf,
} from "@badabhai/event-schema";
import { parseMatchConfig } from "@badabhai/match-engine";
import { eq, sql as dsql } from "drizzle-orm";

import {
  AGENCY_TWIN_SYNC_SOURCE,
  agencyTwinConstantsProblems,
  disarmAgencyTwins,
  listAgencyJobIds,
  syncAgencyTwin,
  type AgencyTwinContext,
  type AgencyTwinWrite,
} from "./agency-twin";
import { createDbClient, type Database } from "./client";
import { argValue, parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";
import { events, matchConfig } from "./schema";

const NAME = "db:sync:agency-twins";
const DISARM_BATCH = 500;

function onOff(flag: string): boolean {
  const raw = argValue(flag);
  if (raw !== "on" && raw !== "off") {
    throw new Error(
      `[${NAME}] --${flag}=on|off is REQUIRED — it is the target's deploy state, and this script ` +
        `will not guess it (a wrong guess moves every twin's status).`,
    );
  }
  return raw === "on";
}

/** The envelope's closed environment enum, from NODE_ENV; anything unknown is `development`. */
function eventEnvironment(nodeEnv: string | undefined): Environment {
  return (ENVIRONMENTS as readonly string[]).includes(nodeEnv ?? "")
    ? (nodeEnv as Environment)
    : "development";
}

/** Insert one validated `job_posting.twin_synced` on the sync's own transaction. */
async function insertTwinEvent(
  tx: Database,
  payload: PayloadInputOf<"job_posting.twin_synced">,
  correlationId: string,
): Promise<void> {
  const event = createEvent({
    event_name: "job_posting.twin_synced",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "job_posting", subject_id: payload.job_posting_id },
    payload,
    source: "db-cli",
    correlation_id: correlationId,
    metadata: {
      // The event's own environment LABEL (metadata only). The blast radius of this run is
      // decided by DATABASE_URL through the ops guard, never by this value.
      environment: eventEnvironment(process.env.NODE_ENV),
      service: NAME,
      request_id: null,
    },
  });
  await tx.insert(events).values({
    id: event.event_id,
    eventName: event.event_name,
    eventVersion: event.event_version,
    occurredAt: new Date(event.occurred_at),
    actorType: event.actor.actor_type,
    actorId: event.actor.actor_id,
    subjectType: event.subject.subject_type,
    subjectId: event.subject.subject_id,
    correlationId: event.correlation_id,
    causationId: event.causation_id,
    idempotencyKey: null,
    payload: event.payload as Record<string, unknown>,
    metadata: event.metadata as Record<string, unknown>,
  });
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  const matchV1Enabled = onOff("match-v1");
  const armed = onOff("agency-twin-sync");
  const onlyJob = argValue("job");
  if (onlyJob !== undefined && !/^[0-9a-f-]{36}$/i.test(onlyJob)) {
    throw new Error(`[${NAME}] --job must be a uuid`);
  }

  const problems = agencyTwinConstantsProblems(AGENCY_TWIN_SYSTEM_ACTOR_ID, AGENCY_TWIN_ORG_LABEL);
  if (problems.length > 0) {
    throw new Error(
      `[${NAME}] REFUSING: the ADR-0050 Q3 constants are invalid: ${problems.join("; ")}`,
    );
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const correlationId = crypto.randomUUID();
  try {
    if (!armed) {
      // THE KILL SWITCH — the disarmed sync's one action, nothing else.
      const rows = await db.execute<{ n: number }>(dsql`
        SELECT count(*)::int AS n FROM job_postings
        WHERE sync_source = ${AGENCY_TWIN_SYNC_SOURCE} AND status NOT IN ('closed', 'paused')
      `);
      const due = (rows as unknown as { n: number }[])[0]?.n ?? 0;
      let moved = 0;
      if (opts.apply) {
        for (;;) {
          const batch = await disarmAgencyTwins(db, DISARM_BATCH, (tx, m) =>
            insertTwinEvent(
              tx,
              {
                job_posting_id: m.jobPostingId,
                source_job_id: m.sourceJobId,
                operation: "refused",
                status: "paused",
                changed_fields: ["status"],
                refused_reason: "kill_switch",
              },
              correlationId,
            ),
          );
          moved += batch.length;
          if (batch.length < DISARM_BATCH) break;
        }
      }
      printCounts(NAME, { mode: "DISARMED (kill switch)", "twins to pause": due, paused: moved });
      printFooter(NAME, opts, opts.apply ? moved : due);
      return;
    }

    const [cfgRow] = await db
      .select({ config: matchConfig.config })
      .from(matchConfig)
      .where(eq(matchConfig.isActive, true))
      .limit(1);
    const ctx: AgencyTwinContext = {
      matchV1Enabled,
      relatedSkillsDefault: parseMatchConfig(cfgRow?.config ?? {}).relatedSkillsDefault,
      systemActorId: AGENCY_TWIN_SYSTEM_ACTOR_ID,
      orgLabel: AGENCY_TWIN_ORG_LABEL,
    };

    const emit = (tx: Database, w: AgencyTwinWrite): Promise<void> =>
      insertTwinEvent(
        tx,
        {
          job_posting_id: w.jobPostingId,
          source_job_id: w.sourceJobId,
          operation: w.operation,
          status: w.status,
          changed_fields: w.changedFields,
          refused_reason: w.refusedReason,
        },
        correlationId,
      );

    const counts: Record<string, number> = {
      "agency jobs": 0,
      unchanged: 0,
      created: 0,
      updated: 0,
      status_changed: 0,
      refused: 0,
      "blocked by a D4 conversion": 0,
      failed: 0,
    };
    let afterId: string | null = opts.startAfter ?? null;
    for (;;) {
      const ids: string[] = onlyJob
        ? [onlyJob]
        : await listAgencyJobIds(db, afterId, opts.batchSize);
      for (const id of ids) {
        counts["agency jobs"]! += 1;
        try {
          const out = await syncAgencyTwin(db, id, ctx, { apply: opts.apply, emit });
          if (out.kind === "written") {
            counts[out.operation]! += 1;
            console.log(
              `  ${id} ${out.operation.padEnd(14)} status=${out.status}` +
                (out.refusedReason ? ` refused=${out.refusedReason}` : "") +
                ` changed=${out.changedFields.join(",")}`,
            );
          } else if (out.kind === "unchanged") counts["unchanged"]! += 1;
          else if (out.kind === "blocked_by_conversion") {
            counts["blocked by a D4 conversion"]! += 1;
            console.log(`  ${id} BLOCKED: posting ${out.jobPostingId} is a D4 conversion of it`);
          }
        } catch (err) {
          // One job's failure never stops the run; the sweep retries it. Ids only.
          counts["failed"]! += 1;
          console.log(`  ${id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (onlyJob || ids.length < opts.batchSize) break;
      afterId = ids[ids.length - 1] ?? null;
    }

    printCounts(NAME, { "match v1": matchV1Enabled ? "on" : "off", ...counts });
    const written = counts.created! + counts.updated! + counts.status_changed! + counts.refused!;
    printFooter(NAME, opts, written);
    if (counts.failed! > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level constant; the error message carries ids only.
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
