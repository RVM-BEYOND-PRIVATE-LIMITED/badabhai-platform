import Link from "next/link";
import { CUSTOMER_KIND_LABELS, customerHref, type PayerRole } from "../lib/customer";
import { shortId } from "../lib/format";

/**
 * A customer cell — the payer behind a posting, a ledger movement, a payment order or a balance
 * — as its short id, linked to the customer's own page through `customerHref`, the one place
 * that address is built.
 *
 * When the row carries the payer's role (`payer_role`, #2032) the link goes straight to the
 * Company or the Agency, and the persona is named beside the id, so an operator scanning a list
 * tells the two apart without opening either. Without it (an older API, an orphaned id, a row
 * that never carries the role) the link falls back to `/companies/:id`, which redirects an
 * agency on, and no persona is claimed: the console does not guess one.
 *
 * The full id stays in the `title`, the way every other short id on the console does.
 */
export function CustomerLink({
  payerId,
  payerRole,
}: {
  payerId: string;
  payerRole?: PayerRole | null;
}) {
  return (
    <>
      <Link className="link mono" href={customerHref(payerId, payerRole)} title={payerId}>
        {shortId(payerId)}
      </Link>
      {payerRole ? <span className="table__meta">{CUSTOMER_KIND_LABELS[payerRole]}</span> : null}
    </>
  );
}
