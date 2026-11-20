import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  CREDIT_BALANCE_AUDIT_QUEUE,
  CREDIT_BALANCE_AUDIT_SCHEDULER_ID,
} from "../queue/queue.constants";
import {
  CreditBalanceAuditService,
  type CreditBalanceAuditResult,
} from "./credit-balance-audit.service";

/** Once a day. */
export const CREDIT_BALANCE_AUDIT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * #2774 — the nightly credit balance audit's CLOCK. A repeatable BullMQ job with no payload (the
 * still-looking sweep's architecture): the audit is one read-only snapshot, so a lost or
 * duplicated Redis job is harmless and the alert's per-day key raises it once. What a tick does is
 * {@link CreditBalanceAuditService.run}; this class only registers the tick and runs it.
 *
 * REGISTERED WHATEVER THE SWITCH SAYS. With `CREDIT_BALANCE_AUDIT_ENABLED` off a tick returns at
 * once without a query, so turning the switch on needs no redeploy-time registration. A
 * registration failure logs one warning and never fails boot.
 */
@Processor(CREDIT_BALANCE_AUDIT_QUEUE)
export class CreditBalanceAuditProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CreditBalanceAuditProcessor.name);

  constructor(
    private readonly audit: CreditBalanceAuditService,
    @InjectQueue(CREDIT_BALANCE_AUDIT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the daily tick. Idempotent by scheduler id; a failure never fails boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(CREDIT_BALANCE_AUDIT_SCHEDULER_ID, {
        every: CREDIT_BALANCE_AUDIT_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `credit balance audit scheduler registration failed; a previously-registered scheduler ` +
          `keeps ticking and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
      );
    }
  }

  /** One tick. */
  async process(): Promise<CreditBalanceAuditResult> {
    return this.audit.run(new Date());
  }
}
