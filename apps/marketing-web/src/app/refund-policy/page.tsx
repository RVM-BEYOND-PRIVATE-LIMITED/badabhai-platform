import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";
import { SITE } from "../../site-config";

export const metadata: Metadata = {
  title: "Refund & Cancellation Policy — BadaBhai",
  description: `When ${SITE.legalName} approves or denies refunds for job-portal SaaS plans, and the exact processing timeline.`,
};

export default function RefundPolicyPage() {
  return (
    <>
      <a className="sr-only sr-only-focusable" href="#main-content">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">Refund &amp; Cancellation</p>
            <h1>Cancellations and refunds, in plain words</h1>
            <p className="mkt-legal__updated">Last updated: {SITE.lastUpdated} · {SITE.legalName}</p>
            <h2>1. How to cancel</h2>
            <ul>
              <li>Plans are prepaid and stop at the end of their window — there is nothing extra to cancel for one-time packs (contact credits, postings, boosts, capacity, managed hiring).</li>
              <li>To stop future purchases or close your employer account, write to <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a> from your account email with the order/invoice reference. Account closure takes effect within 2 business days.</li>
              <li>Cancelling stops future billing only; it does not refund already-activated or consumed value (see below).</li>
            </ul>
            <h2>2. When refunds are approved vs. denied</h2>
            <ul>
              <li><strong>Approved:</strong> duplicate payment for the same order; amount debited but the plan never activated; managed-hiring order where we delivered zero phone-confirmed workers and no extension was taken.</li>
              <li><strong>Denied:</strong> contact credits already used to unlock candidates; job views already consumed; boost days already elapsed; capacity window already started; change of hiring plans after activation.</li>
              <li>Partial refunds (e.g. debited twice, one activation kept) are issued for the non-activated leg only.</li>
            </ul>
            <h2>3. Processing timeline (unambiguous)</h2>
            <p>
              <strong>Approved refunds will be processed within 5–7 business days and credited
              back to the original payment method</strong> (UPI / card / netbanking via Razorpay).
              Bank settlement after our processing may take another 2–3 business days depending
              on your issuer. You receive the Razorpay refund reference by email.
            </p>
            <h2>4. Raise a refund request</h2>
            <p>
              Email <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a> with order ID,
              invoice, and reason. We acknowledge within 2 business days and decide within 5
              business days. Disputes are governed by {SITE.governingLaw}.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
