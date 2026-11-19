/**
 * #2749 part 4 — issue the missing GST invoice of ONE captured payment.
 *
 *   pnpm --filter @badabhai/api build
 *   PAYMENTS_PROVIDER_KEY=<the rzp_* key ID the api runs with> \
 *   node apps/api/dist/invoices/issue-missing-invoice.cli.js --payment-order-id=<uuid> [--apply]
 *
 * WHEN. A settle recorded `payment.invoice_not_issued` (reason `seller_not_configured`,
 * `seller_config_invalid`, `price_line_missing` or `issue_failed`): the company paid and has its
 * credits, but no invoice. Fix the cause first (enter or correct the seller row), then run this per
 * order. `test_mode` orders never get an invoice and are refused.
 *
 * WHAT. The same `InvoiceIssuer.issueWithinTx` the settle uses, in its own transaction: the next
 * gap-free number, dated NOW (the database clock under the series row lock), the seller row and the
 * company's billing details as they are now, `invoice.issued`. Refuses (writes nothing) for an
 * unknown order, an order that is not a real captured paid one, an order that already has an
 * invoice, a test-mode or unknown key, or no usable seller row (`issue-missing-invoice.ts`).
 *
 * DRY RUN BY DEFAULT: it prints what it would do. `--apply` writes. NEVER edit
 * `invoice_number_series` by hand: a hand-set counter skips or reuses numbers in a series that must
 * be gap-free.
 *
 * `PAYMENTS_PROVIDER_KEY` is the key ID (public by design; never the key secret). It tells a
 * test-mode run from a live one; without it the runner refuses (`mode_unknown`).
 *
 * TARGET SAFETY: the shared ops guard — a write to a production-like database needs
 * `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=issue-missing-invoice`.
 * Prints ids and codes only: no GSTIN, name, address or amount beyond the outcome.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { PRODUCTION_WRITE_FLAG, createDbClient, enforceOpsGuard } from "@badabhai/db";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { InvoiceIssuer, usableSeller } from "./invoice-issuer.service";
import { InvoicesRepository } from "./invoices.repository";
import { issueMissingInvoice } from "./issue-missing-invoice";
import { isRazorpayTestKey } from "./test-mode";

export const ISSUE_MISSING_INVOICE_SCRIPT = "issue-missing-invoice";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssueMissingInvoiceArgs {
  orderId: string;
  apply: boolean;
}

/** Strict argv parsing: an unknown or malformed flag is an error, never a guess. */
export function parseIssueMissingInvoiceArgs(argv: readonly string[]): IssueMissingInvoiceArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "payment-order-id": { type: "string" },
      apply: { type: "boolean", default: false },
      [PRODUCTION_WRITE_FLAG.replace(/^--/, "")]: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const orderId = values["payment-order-id"];
  if (typeof orderId !== "string" || !UUID.test(orderId)) {
    throw new Error("--payment-order-id=<uuid> is required (the payment_orders.id)");
  }
  return { orderId, apply: values.apply === true };
}

/** Test mode from the key ID given: null when none was given (the run refuses). */
export function testModeFromEnv(env: Readonly<Record<string, string | undefined>>): boolean | null {
  const key = env.PAYMENTS_PROVIDER_KEY?.trim();
  if (!key) return null;
  return isRazorpayTestKey(key);
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseIssueMissingInvoiceArgs(argv);
  const { connectionString } = enforceOpsGuard({
    script: ISSUE_MISSING_INVOICE_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: args.apply,
  });
  const tag = `[${ISSUE_MISSING_INVOICE_SCRIPT}]`;
  console.log(`${tag} ${args.apply ? "APPLY" : "DRY-RUN"} payment_order=${args.orderId}`);

  const client = createDbClient(connectionString, { max: 2 });
  const invoices = new InvoicesRepository(client.db);
  // The real, registry-validating emitter. NODE_ENV labels the event's metadata only.
  const events = new EventsService(new EventsRepository(client.db), {
    NODE_ENV: process.env.NODE_ENV ?? "development",
  } as ServerConfig);
  const testMode = testModeFromEnv(process.env);
  const issuer = new InvoiceIssuer(invoices, events, {
    PAYMENTS_PROVIDER_KEY: process.env.PAYMENTS_PROVIDER_KEY,
  });
  const ctx = { correlationId: randomUUID(), requestId: ISSUE_MISSING_INVOICE_SCRIPT };

  try {
    const result = await issueMissingInvoice(
      {
        findOrder: (id) => invoices.findPaymentOrder(id),
        hasInvoice: async (id) => (await invoices.findInvoiceByOrder(invoices.reader, id)) !== undefined,
        sellerCheck: async () => {
          const usable = usableSeller(await invoices.activeSeller());
          return usable.ok ? "ok" : usable.reason;
        },
        issue: (order) => invoices.withTransaction((tx) => issuer.issueWithinTx(tx, order, ctx)),
      },
      { orderId: args.orderId, apply: args.apply, testMode },
    );
    switch (result.outcome) {
      case "refused":
        console.log(`${tag} REFUSED reason=${result.reason}; nothing written`);
        return 1;
      case "would_issue":
        console.log(`${tag} would issue the invoice; re-run with --apply to write it`);
        return 0;
      case "issued":
        console.log(`${tag} ISSUED invoice=${result.invoiceId}`);
        return 0;
    }
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
      // A guard refusal or an argument error says what to do; a database error's message can quote
      // a failing row (seller values), so only its class and SQLSTATE are printed.
      const pg = (err as { code?: unknown } | null)?.code;
      const line =
        err instanceof Error && pg === undefined
          ? err.message
          : `${err instanceof Error ? err.name : "UnknownError"} sqlstate=${String(pg)}`;
      console.error(`[${ISSUE_MISSING_INVOICE_SCRIPT}] failed: ${line}`);
      process.exitCode = 1;
    });
}
