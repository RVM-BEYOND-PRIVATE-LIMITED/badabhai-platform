import type { PaymentOrder } from "@badabhai/db";

/**
 * The line an invoice prints for what was sold (#2749 part 4). PURE, and NO PII: it names the
 * product, never the buyer. Generic over `payment_orders.product_kind`, so #2751's other kinds get
 * an invoice too; each new kind is one more case.
 *
 *   credit_pack, pack_starter, 20 credits, 30 days → "Credit pack — Starter, 20 contact credits, valid 30 days"
 */
export function invoiceDescription(
  order: Pick<PaymentOrder, "productKind" | "packCode" | "creditsGranted" | "creditValidityDays">,
): string {
  switch (order.productKind) {
    case "credit_pack": {
      const parts = [`Credit pack — ${packName(order.packCode)}`, `${order.creditsGranted} contact credits`];
      if (order.creditValidityDays !== null) parts.push(`valid ${order.creditValidityDays} days`);
      return parts.join(", ");
    }
    default:
      // A kind added without its own line (#2751) still invoices, under its code made readable.
      return humanise(String(order.productKind));
  }
}

/** `pack_starter` → `Starter`; `pack_big` → `Big`; any other code readable the same way. */
export function packName(packCode: string | null): string {
  if (packCode === null || packCode.length === 0) return "Pack";
  return humanise(packCode.replace(/^pack_/, ""));
}

function humanise(code: string): string {
  const words = code
    .split(/[_\s-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : code;
}
