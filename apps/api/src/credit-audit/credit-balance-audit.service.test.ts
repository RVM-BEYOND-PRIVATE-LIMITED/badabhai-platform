import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { EventsService } from "../events/events.service";
import type {
  CreditAuditFinding,
  CreditBalanceAuditRepository,
} from "./credit-balance-audit.repository";
import {
  CREDIT_AUDIT_LOG_IDS_PER_CLASS,
  CreditBalanceAuditService,
  creditAuditAlertKey,
  summarizeCreditAudit,
} from "./credit-balance-audit.service";

/** #2774 — the nightly credit balance audit: off, clean, failing, once a day, ids capped. */

const NOW = new Date("2026-11-19T21:30:00.000Z");
const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const f = (
  n: number,
  balance: number | null,
  ledgerSum: number,
  lotsSum: number,
): CreditAuditFinding => ({ walletKey: key(n), balance, ledgerSum, lotsSum });

function setup(enabled: boolean, findings: CreditAuditFinding[], walletsChecked = 100) {
  const read = vi.fn(async () => ({ walletsChecked, findings }));
  const emitOnce = vi.fn(async () => ({ event: {} as never, written: true }));
  const service = new CreditBalanceAuditService(
    { read } as unknown as CreditBalanceAuditRepository,
    { emitOnce } as unknown as EventsService,
    { CREDIT_BALANCE_AUDIT_ENABLED: enabled } as ServerConfig,
  );
  const error = vi.spyOn(
    (service as unknown as { logger: { error: (m: string) => void } }).logger,
    "error",
  );
  error.mockImplementation(() => undefined);
  return { service, read, emitOnce, error };
}

describe("summarizeCreditAudit", () => {
  it("sorts findings into ledger, lot and orphan classes with signed gaps", () => {
    const s = summarizeCreditAudit(10, [
      f(1, 10, 8, 10), // ledger only: +2
      f(2, 5, 5, 9), // lots only: −4
      f(3, 7, 4, 1), // both: +3 on the ledger, +6 on the lots
      f(4, null, 3, 0), // orphan
    ]);
    expect(s.ledgerMismatches.map((x) => x.walletKey)).toEqual([key(1), key(3)]);
    expect(s.lotMismatches.map((x) => x.walletKey)).toEqual([key(2), key(3)]);
    expect(s.orphans.map((x) => x.walletKey)).toEqual([key(4)]);
    expect(s.ledgerGapCredits).toBe(5);
    expect(s.lotGapCredits).toBe(2);
  });
});

describe("CreditBalanceAuditService.run", () => {
  it("off: returns at once without a query or an event", async () => {
    const { service, read, emitOnce } = setup(false, [f(1, 10, 8, 10)]);
    expect(await service.run(NOW)).toEqual({ armed: false });
    expect(read).not.toHaveBeenCalled();
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("clean: reads once, emits nothing", async () => {
    const { service, read, emitOnce, error } = setup(true, [], 42);
    expect(await service.run(NOW)).toEqual({
      armed: true,
      walletsChecked: 42,
      ledgerMismatches: 0,
      lotMismatches: 0,
      orphanWallets: 0,
      alerted: false,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(emitOnce).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("failing: one counts-only alert keyed to the day, and one log line with the wallet ids", async () => {
    const { service, emitOnce, error } = setup(true, [f(1, 10, 8, 10), f(4, null, 3, 0)], 7);
    const out = await service.run(NOW);
    expect(out).toMatchObject({ ledgerMismatches: 1, lotMismatches: 0, orphanWallets: 1, alerted: true });
    expect(emitOnce).toHaveBeenCalledTimes(1);
    expect(emitOnce).toHaveBeenCalledWith({
      event_name: "payer.credit_balance_audit_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer", subject_id: null },
      payload: {
        wallets_checked: 7,
        ledger_mismatches: 1,
        lot_mismatches: 0,
        orphan_wallets: 1,
        ledger_gap_credits: 2,
        lot_gap_credits: 0,
      },
      idempotencyKey: "payer.credit_balance_audit_failed:2026-11-19",
    });
    // The ids go to the log, never into the event.
    expect(JSON.stringify(emitOnce.mock.calls[0])).not.toContain(key(1));
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toContain(key(1));
    expect(line).toContain(key(4));
    expect(line).toContain("nothing was changed");
  });

  it("an alert already raised today reports alerted: false (a second tick or replica)", async () => {
    const { service, emitOnce } = setup(true, [f(1, 10, 8, 10)]);
    emitOnce.mockResolvedValueOnce({ event: {} as never, written: false });
    expect(await service.run(NOW)).toMatchObject({ alerted: false, ledgerMismatches: 1 });
  });

  it("caps the logged ids per class; the counts stay whole", async () => {
    const many = Array.from({ length: CREDIT_AUDIT_LOG_IDS_PER_CLASS + 3 }, (_, i) =>
      f(i + 1, 1, 0, 1),
    );
    const { service, error } = setup(true, many);
    expect(await service.run(NOW)).toMatchObject({ ledgerMismatches: many.length });
    const line = String(error.mock.calls[0]![0]);
    expect(line).toContain(key(CREDIT_AUDIT_LOG_IDS_PER_CLASS));
    expect(line).not.toContain(key(CREDIT_AUDIT_LOG_IDS_PER_CLASS + 1));
    expect(line).toContain("(+3 more)");
  });
});

describe("creditAuditAlertKey", () => {
  it("is one key per UTC day", () => {
    expect(creditAuditAlertKey(new Date("2026-11-19T00:00:00.000Z"))).toBe(
      creditAuditAlertKey(new Date("2026-11-19T23:59:59.999Z")),
    );
    expect(creditAuditAlertKey(new Date("2026-11-20T00:00:00.000Z"))).not.toBe(
      creditAuditAlertKey(new Date("2026-11-19T23:59:59.999Z")),
    );
  });
});
