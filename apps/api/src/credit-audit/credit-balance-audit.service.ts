import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import {
  CreditBalanceAuditRepository,
  type CreditAuditFinding,
} from "./credit-balance-audit.repository";

/** At most this many wallet ids per class go into the log line (the counts are always whole). */
export const CREDIT_AUDIT_LOG_IDS_PER_CLASS = 50;

/** The findings sorted into the three classes, with the signed credit gaps. */
export interface CreditAuditSummary {
  readonly walletsChecked: number;
  /** Balance row present, balance ≠ Σ ledger. */
  readonly ledgerMismatches: readonly CreditAuditFinding[];
  /** Balance row present, balance ≠ Σ lots' remaining credits. */
  readonly lotMismatches: readonly CreditAuditFinding[];
  /** No balance row, but ledger lines (non-zero sum) or lots. */
  readonly orphans: readonly CreditAuditFinding[];
  /** Σ (balance − ledger sum) over the ledger mismatches. */
  readonly ledgerGapCredits: number;
  /** Σ (balance − lots sum) over the lot mismatches. */
  readonly lotGapCredits: number;
}

/** What one tick did. Counts only (BullMQ job-inspection surface). */
export type CreditBalanceAuditResult =
  | { readonly armed: false }
  | {
      readonly armed: true;
      readonly walletsChecked: number;
      readonly ledgerMismatches: number;
      readonly lotMismatches: number;
      readonly orphanWallets: number;
      /** True when this run wrote today's alert (false when clean, or already raised today). */
      readonly alerted: boolean;
    };

/**
 * Sort the audit's findings into its three classes. A wallet can be both a ledger and a lot
 * mismatch; each class counts it once.
 */
export function summarizeCreditAudit(
  walletsChecked: number,
  findings: readonly CreditAuditFinding[],
): CreditAuditSummary {
  const withWallet = findings.filter((f) => f.balance !== null);
  const ledgerMismatches = withWallet.filter((f) => f.balance !== f.ledgerSum);
  const lotMismatches = withWallet.filter((f) => f.balance !== f.lotsSum);
  return {
    walletsChecked,
    ledgerMismatches,
    lotMismatches,
    orphans: findings.filter((f) => f.balance === null),
    ledgerGapCredits: ledgerMismatches.reduce((s, f) => s + (f.balance! - f.ledgerSum), 0),
    lotGapCredits: lotMismatches.reduce((s, f) => s + (f.balance! - f.lotsSum), 0),
  };
}

/** The alert's idempotency key: one alert per UTC day, however many ticks or replicas run. */
export function creditAuditAlertKey(now: Date): string {
  return `payer.credit_balance_audit_failed:${now.toISOString().slice(0, 10)}`;
}

/**
 * #2774 — THE NIGHTLY CREDIT BALANCE AUDIT.
 *
 * Reads every wallet in one read-only snapshot ({@link CreditBalanceAuditRepository}) and checks
 * the wallet invariant. A clean run logs one line and emits nothing. A failing run:
 *  - logs ONE error line with the counts, the signed gaps and the wallet ids (opaque keys, at most
 *    {@link CREDIT_AUDIT_LOG_IDS_PER_CLASS} per class), for whoever repairs them;
 *  - emits ONE `payer.credit_balance_audit_failed` (counts only), keyed per day so a duplicated
 *    tick or a second replica raises it once. The admin dashboard's breach counter shows it.
 *
 * IT NEVER WRITES A WALLET. Which side is right (the ledger is the source of truth, ADR-0010 §D5;
 * lots re-align on the next wallet touch) is a decision for the person repairing it.
 *
 * OFF BY DEFAULT (`CREDIT_BALANCE_AUDIT_ENABLED`): a tick returns at once without a query.
 */
@Injectable()
export class CreditBalanceAuditService {
  private readonly logger = new Logger(CreditBalanceAuditService.name);

  constructor(
    private readonly repo: CreditBalanceAuditRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async run(now: Date): Promise<CreditBalanceAuditResult> {
    if (!this.config.CREDIT_BALANCE_AUDIT_ENABLED) return { armed: false };

    const snapshot = await this.repo.read();
    const s = summarizeCreditAudit(snapshot.walletsChecked, snapshot.findings);
    const counts = {
      armed: true as const,
      walletsChecked: s.walletsChecked,
      ledgerMismatches: s.ledgerMismatches.length,
      lotMismatches: s.lotMismatches.length,
      orphanWallets: s.orphans.length,
    };
    if (snapshot.findings.length === 0) {
      this.logger.log(`credit balance audit: clean (wallets_checked=${s.walletsChecked})`);
      return { ...counts, alerted: false };
    }

    const ids = (list: readonly CreditAuditFinding[]) => {
      const shown = list.slice(0, CREDIT_AUDIT_LOG_IDS_PER_CLASS).map((f) => f.walletKey);
      const more = list.length - shown.length;
      return `[${shown.join(",")}]${more > 0 ? ` (+${more} more)` : ""}`;
    };
    this.logger.error(
      `credit balance audit FAILED: wallets_checked=${s.walletsChecked} ` +
        `ledger_mismatches=${counts.ledgerMismatches} lot_mismatches=${counts.lotMismatches} ` +
        `orphan_wallets=${counts.orphanWallets} ledger_gap_credits=${s.ledgerGapCredits} ` +
        `lot_gap_credits=${s.lotGapCredits}; nothing was changed. ` +
        `ledger=${ids(s.ledgerMismatches)} lots=${ids(s.lotMismatches)} orphans=${ids(s.orphans)}`,
    );
    const { written } = await this.events.emitOnce({
      event_name: "payer.credit_balance_audit_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer", subject_id: null },
      payload: {
        wallets_checked: s.walletsChecked,
        ledger_mismatches: counts.ledgerMismatches,
        lot_mismatches: counts.lotMismatches,
        orphan_wallets: counts.orphanWallets,
        ledger_gap_credits: s.ledgerGapCredits,
        lot_gap_credits: s.lotGapCredits,
      },
      idempotencyKey: creditAuditAlertKey(now),
    });
    return { ...counts, alerted: written };
  }
}
