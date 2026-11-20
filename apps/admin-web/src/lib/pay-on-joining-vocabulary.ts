import { formatCount } from "./format";

/**
 * The pay-on-joining pilot's client-safe vocabulary and money helpers.
 *
 * The API's two money fields are integer paise and the partner's share is server-owned. This
 * module names only what the console may display or collect, so a client form can share it
 * without importing the server-only read layer.
 */
export const PAY_ON_JOINING_PAYMENT_STATES = [
  "awaiting_factory",
  "partner_due",
  "settled",
] as const;
export type PayOnJoiningPaymentState = (typeof PAY_ON_JOINING_PAYMENT_STATES)[number];

export const PAY_ON_JOINING_PAYMENT_STATE_LABELS: Readonly<
  Record<PayOnJoiningPaymentState, string>
> = {
  awaiting_factory: "Awaiting factory",
  partner_due: "Partner due",
  settled: "Settled",
};

/** The API's note bound (`POJ_NOTE_MAX_CHARS`). */
export const PAY_ON_JOINING_NOTE_MAX = 500;

export const PAY_ON_JOINING_SWITCHED_OFF =
  "Pay-on-joining records are not switched on yet.";
export const PAY_ON_JOINING_ALREADY_RECORDED =
  "That hire is already recorded for this factory, worker and posting.";

/** One record, as the list and the edit dialog read it. Ids and dates only; no names. */
export interface PayOnJoiningHireRow {
  id: string;
  factory_payer_id: string;
  job_posting_id: string | null;
  worker_id: string;
  partner_payer_id: string | null;
  joined_on: string;
  stay_checked_on: string | null;
  stayed_30_days: boolean | null;
  fee_paise: number;
  partner_share_percent: number;
  partner_share_paise: number;
  invoiced_on: string | null;
  factory_paid_on: string | null;
  partner_paid_on: string | null;
  note: string | null;
  payment_state: PayOnJoiningPaymentState;
  created_by_admin_id: string;
  updated_by_admin_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * A fee typed in rupees → integer paise, or null when it is not a whole non-negative amount with
 * at most two decimal places. String arithmetic, because the API stores exact integers and a
 * float round-trip is how a ₹5,900 fee becomes 589999.
 */
export function rupeesToPaise(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0"));
  const total = rupees * 100 + paise;
  return Number.isSafeInteger(total) ? total : null;
}

/** Integer paise → the rupee text an edit form starts from ("5000", "5900.50"). */
export function paiseToRupeesInput(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) return "";
  const rupees = Math.trunc(paise / 100);
  const fraction = paise % 100;
  return fraction === 0 ? String(rupees) : `${rupees}.${String(fraction).padStart(2, "0")}`;
}

/** Integer paise → "₹5,000" or "₹5,000.50". Never paise, never a float. */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) return "—";
  const rupees = Math.trunc(paise / 100);
  const fraction = paise % 100;
  return fraction === 0
    ? `₹${formatCount(rupees)}`
    : `₹${formatCount(rupees)}.${String(fraction).padStart(2, "0")}`;
}
