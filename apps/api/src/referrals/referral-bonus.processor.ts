import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { REFERRAL_BONUS_QUEUE, type ReferralBonusJobData } from "../queue/queue.constants";
import { ReferralBonusService, type BonusOutcome } from "./referral-bonus.service";

/**
 * Evaluates the §X.6 activation-bonus rule off the request path, whenever either leg of it
 * may have just completed (profile confirmed / unlock granted — the two producers).
 *
 * IDEMPOTENT BY CONSTRUCTION, so at-least-once delivery is safe: the service re-reads BOTH
 * legs from the database and the accrual insert is `ON CONFLICT (invited_worker_id) DO
 * NOTHING`. A double-fire writes one row and emits one event; the `trigger` in the payload
 * is observability only and never steers the decision.
 *
 * The overwhelmingly common outcome is a no-op — most workers were never referred at all —
 * so the log stays at debug-ish level and, like the service, carries the reason CODE with
 * NO ids (an id plus `duplicate_phone` would assert a relationship between two people).
 */
@Processor(REFERRAL_BONUS_QUEUE)
export class ReferralBonusProcessor extends WorkerHost {
  private readonly logger = new Logger(ReferralBonusProcessor.name);

  constructor(private readonly bonus: ReferralBonusService) {
    super();
  }

  async process(job: Job<ReferralBonusJobData>): Promise<BonusOutcome> {
    const { invitedWorkerId, trigger } = job.data;
    const outcome = await this.bonus.evaluate(invitedWorkerId);
    if (outcome.accrued) {
      // The accrual itself is on the event spine (referral.bonus_accrued); this line only
      // records WHICH leg completed last, which the event deliberately does not carry.
      this.logger.log(`referral bonus accrued (trigger=${trigger})`);
    }
    return outcome;
  }
}
