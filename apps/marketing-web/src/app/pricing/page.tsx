import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";
import { PRICING, SITE, inr } from "../../site-config";

export const metadata: Metadata = {
  title: "Pricing — BadaBhai employer plans",
  description:
    "Transparent INR pricing for BadaBhai's job-portal SaaS: contact-credit packs, job postings, boosts, hiring capacity and managed hiring. All prices exclusive of 18% GST.",
};

function TierGrid({ tiers, featured }: { tiers: { code: string; name: string; priceInr: number; blurb: string }[]; featured?: string }) {
  return (
    <div className="mkt-price-grid">
      {tiers.map((t) => (
        <article key={t.code} className={`mkt-price-card${t.code === featured ? " mkt-price-card--featured" : ""}`}>
          <h3 className="mkt-price-card__name">{t.name}</h3>
          <p className="mkt-price-card__amount">{inr(t.priceInr)}</p>
          <p className="mkt-price-card__blurb">{t.blurb}</p>
        </article>
      ))}
    </div>
  );
}

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">Pricing in INR</p>
            <h1>What BadaBhai sells, and what it costs</h1>
            <p>
              BadaBhai is a job-portal SaaS for employers hiring blue-collar, grey-collar,
              industrial-manufacturing, construction, and skilled-trade workers in India.
              Employers buy <strong>contact-credit packs</strong> to unlock verified candidate
              contacts, <strong>job postings</strong> to go live, <strong>boosts</strong> for
              priority rank, <strong>hiring capacity</strong> for concurrent vacancies, and{" "}
              <strong>managed hiring</strong> where our team delivers phone-confirmed workers.
            </p>
            <p className="mkt-gst-note">{SITE.gstNote}. GST invoice is issued for every purchase.</p>

            <h2>Contact-credit packs (candidate unlocks)</h2>
            <p>One unlock opens one verified worker&apos;s contact via a routed relay — never a raw phone dump. Re-opening an already-opened contact is free.</p>
            <TierGrid tiers={PRICING.contactPacks} featured="pack_200" />

            <h2>Job postings</h2>
            <TierGrid tiers={PRICING.postings} />

            <h2>Boosts (priority rank in worker feed)</h2>
            <TierGrid tiers={PRICING.boosts} />

            <h2>Hiring capacity (concurrent vacancies)</h2>
            <TierGrid tiers={PRICING.capacity} />

            <h2>Managed hiring (done-for-you shortlists)</h2>
            <p>Prepaid, per job, GST extra. Both tiers target 5 phone-confirmed interested workers in 7 working days (Mon–Sat), with a free extension to day 30. Above 10 vacancies, request a callback instead of checkout. We never promise a hire.</p>
            <TierGrid tiers={PRICING.managedHiring} />

            <h2>Billing notes</h2>
            <ul>
              <li>Payments are processed securely by Razorpay (UPI, cards, netbanking).</li>
              <li>Unused credits expire at the end of their window (14 days for contact packs, 30 days for capacity).</li>
              <li>Questions? Write to <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>.</li>
            </ul>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
