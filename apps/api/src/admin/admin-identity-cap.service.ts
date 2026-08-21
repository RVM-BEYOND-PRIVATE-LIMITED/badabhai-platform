import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { AdminEgressCapService } from "./admin-egress-cap.service";

/**
 * PER-ADMIN NAME-egress cap (owner ruling 2026-08-18) — the identity sibling of
 * {@link import("./admin-pii-reveal-cap.service").AdminPiiRevealCapService}, on its OWN Redis
 * namespace (`admin_identity:*`) and its OWN budget.
 *
 * ── WHY A SECOND BUDGET RATHER THAN A SHARE OF THE REVEAL'S ─────────────────────────────
 * A reveal is ONE disclosure on a reason-gated, feature-flagged, single-subject route. An
 * entity LIST is up to `limit` disclosures in one unremarkable page view. Charging both to the
 * 10/hour reveal budget would make routine console use exhaust the incident-response budget
 * within a single screen; sharing the identity budget in the other direction would let 300
 * names/hour of headroom stand in for a control that exists to stop bulk deanonymization.
 * Different acts, different velocities, different alerts — separate keyspaces.
 *
 * And it must exist AT ALL because without it the reveal cap is bypassed by paging: names are a
 * bulk egress the single-subject cap structurally cannot see.
 *
 * The counters advance by names ACTUALLY disclosed, so a page of workers who never gave us a
 * name costs nothing — see {@link import("./admin-identity.service").AdminIdentityService}.
 */
@Injectable()
export class AdminIdentityCapService extends AdminEgressCapService {
  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    // Reuse the existing BullMQ Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) queue: Queue,
  ) {
    super(
      config,
      queue,
      "admin_identity",
      "ADMIN_IDENTITY_MAX_PER_HOUR",
      "ADMIN_IDENTITY_MAX_PER_DAY",
    );
  }
}
