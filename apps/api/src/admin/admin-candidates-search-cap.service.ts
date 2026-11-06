import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { AdminEgressCapService } from "./admin-egress-cap.service";

/**
 * CANDIDATES SEARCH cap (ADR-0062 §3.6, #2559/B5) — name/phone lookups per
 * admin on their OWN Redis namespace (`admin_candidates_search:*`), sized in
 * SEARCHES (300/hour, 2000/day): a lookup costs one whether it matches nothing
 * or a hundred rows.
 *
 * Fail-closed like every egress cap: a Redis error DENIES, and the caller
 * serves nothing (not even faceless rows — an uncounted lookup is unaudited
 * velocity). Over-cap denials emit PII-free
 * `admin.candidates_search_cap_exceeded` (no term, no result, no count).
 */
@Injectable()
export class AdminCandidatesSearchCapService extends AdminEgressCapService {
  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    // Reuse the existing BullMQ Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) queue: Queue,
  ) {
    super(
      config,
      queue,
      "admin_candidates_search",
      "ADMIN_CANDIDATES_SEARCH_MAX_PER_HOUR",
      "ADMIN_CANDIDATES_SEARCH_MAX_PER_DAY",
    );
  }
}
