import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { AdminEgressCapService } from "./admin-egress-cap.service";

/**
 * PER-ADMIN AI-TRACE DECRYPT CAP (migration 0083) — the third budget on the shared
 * {@link AdminEgressCapService}, on its OWN `admin_ai_trace:*` Redis namespace.
 *
 * ── WHY A THIRD KEYSPACE RATHER THAN A SHARE OF EITHER EXISTING ONE ─────────────────────
 * The base class's own header states the rule: "the namespace, the two config keys and therefore
 * the budget are properties of the CAP, not of the request". Two caps sharing a namespace share
 * a budget by accident, and both directions of sharing here are wrong:
 *
 *   * folded into `admin_pii_reveal` (10/hour) — an afternoon spent reading traces for one bad
 *     interview would exhaust the INCIDENT-RESPONSE budget for revealing a worker's phone;
 *   * folded into `admin_identity` (300/hour) — 300 names of headroom would silently authorise
 *     300 whole prompts, and a name is a field where a prompt is everything somebody said.
 *
 * Different acts, different velocities, different alerts, separate keyspaces.
 *
 * ── AND IT IS SIZED FOR DEBUGGING, NOT FOR COLLECTING ──────────────────────────────────
 * 20/hour and 60/day by default. Reading traces is what an engineer does with ONE reported bad
 * interview; anything that looks like assembling a corpus of what workers said is the thing this
 * cap exists to stop. It charges ONE unit per decrypt because the route is single-subject by
 * construction — there is no list, range or batch decrypt for a bulk read to hide behind, which
 * is the structural half of the same guarantee.
 *
 * FAIL CLOSED, inherited unchanged: a Redis error DENIES. An outage can never uncap a
 * disclosure, and here the disclosure is a worker's own words.
 */
@Injectable()
export class AdminAiTraceCapService extends AdminEgressCapService {
  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    // Reuse the existing BullMQ Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) queue: Queue,
  ) {
    super(
      config,
      queue,
      "admin_ai_trace",
      "ADMIN_AI_TRACE_MAX_PER_HOUR",
      "ADMIN_AI_TRACE_MAX_PER_DAY",
    );
  }
}
