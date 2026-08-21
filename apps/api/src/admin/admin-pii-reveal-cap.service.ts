import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import {
  AdminEgressCapService,
  type AdminEgressCapResult,
  type AdminEgressCapWindow,
} from "./admin-egress-cap.service";

/**
 * Which window an over-cap reveal denial breached — mirrors the event payload enum.
 *
 * Re-exported (as an alias of the shared {@link AdminEgressCapWindow}) so the reveal service's
 * existing import keeps working: the vocabulary is one vocabulary across both egress caps, and
 * a second copy would be the first thing to drift.
 */
export type AdminPiiRevealCapWindow = AdminEgressCapWindow;

/** The outcome of the reveal cap check. See {@link AdminEgressCapResult}. */
export type AdminPiiRevealCapResult = AdminEgressCapResult;

/**
 * PER-ADMIN worker-PII reveal cap (ADR-0025 ADMIN-3b must-fix #8) — an hour + day velocity
 * backstop on the single most sensitive route in the system. A reason-gated reveal must still be
 * RATE-bounded so a compromised/abusive admin cannot bulk-deanonymize workers.
 *
 * ── ALL OF THE MECHANISM NOW LIVES IN {@link AdminEgressCapService} ─────────────────────────
 * ...and NONE of this cap's behaviour changed when it moved there. The keyspace is still
 * `admin_pii_reveal:{hour,day}:<admin_id>:<utc stamp>`, the limits are still
 * `ADMIN_PII_REVEAL_MAX_PER_{HOUR,DAY}` (10 / 30), the hour window is still checked and
 * short-circuited first, and a Redis error still DENIES with `window:"hour"`. The one
 * generalisation the identity read needed — charging N units for a disclosure of N subjects —
 * is a defaulted parameter, so this caller's single `consume(adminId)` is exactly the `INCRBY
 * key 1` it always was. `admin-pii-reveal-cap.service.test.ts` pins every one of those
 * properties against THIS class rather than the base, so a change made "for the other caller"
 * fails here.
 *
 * ORDER: this is checked BEFORE the decrypt (an over-cap request reveals NOTHING). The counter
 * is INCREMENTED on the authorized path (the reveal is the costly action), so a denied /
 * flag-failed request earlier in the pipeline does not consume the budget.
 */
@Injectable()
export class AdminPiiRevealCapService extends AdminEgressCapService {
  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    // Reuse the existing BullMQ Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) queue: Queue,
  ) {
    super(
      config,
      queue,
      "admin_pii_reveal",
      "ADMIN_PII_REVEAL_MAX_PER_HOUR",
      "ADMIN_PII_REVEAL_MAX_PER_DAY",
    );
  }
}
