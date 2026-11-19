import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";
import { SITE } from "../../site-config";

export const metadata: Metadata = {
  title: "Terms & Conditions — BadaBhai",
  description: `Terms of use for the BadaBhai job-portal SaaS, operated by ${SITE.legalName}.`,
};

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">Terms &amp; Conditions</p>
            <h1>Terms of using BadaBhai</h1>
            <p className="mkt-legal__updated">Last updated: {SITE.lastUpdated} · Operated by {SITE.legalName}</p>
            <p>
              These terms govern your use of the BadaBhai job-portal SaaS at {SITE.domain} —
              for workers getting profiled and for employers posting roles, unlocking
              contacts, and paying for plans. By creating an account or paying for a plan,
              you accept these terms on behalf of yourself or your employer organisation.
            </p>
            <h2>1. Who we are</h2>
            <p>
              BadaBhai is operated by {SITE.legalName}, {SITE.registeredAddress.join(" ")}.
              Support: <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>,{" "}
              <a href={SITE.supportPhoneHref}>{SITE.supportPhoneDisplay}</a> ({SITE.supportHours}).
            </p>
            <h2>2. Employer &amp; user responsibilities</h2>
            <ul>
              <li>Provide true company, role, salary, and location details on every posting.</li>
              <li>Never post contact details, company names as clickbait, or links inside worker-visible title/description fields.</li>
              <li>Use unlocked worker contacts only for the hiring purpose consented to; never resell, scrape, or disclose them.</li>
              <li>Keep login credentials (OTP / session) confidential; you are responsible for actions under your account.</li>
            </ul>
            <h2>3. Acceptable use &amp; suspension</h2>
            <ul>
              <li>No spam, harassment, discrimination, fraud, or unlawful hiring practices.</li>
              <li>No attempts to bypass consent gates, masking, rate limits, or access controls.</li>
              <li>We may warn, rate-limit, suspend, or terminate accounts that breach these terms, with notice where reasonable and immediate action for safety or legal risk.</li>
            </ul>
            <h2>4. Payment terms &amp; billing</h2>
            <ul>
              <li>Plans are prepaid in INR; prices on <a href="/pricing">/pricing</a> are exclusive of 18% GST. A GST invoice is issued per purchase.</li>
              <li>Payments are processed by Razorpay. Billing cycles follow the plan window (e.g. 14 days for contact packs, 30 days for capacity).</li>
              <li>Unused credits/views expire at window end and do not roll over unless stated.</li>
              <li>Cancellations and refunds follow our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.</li>
            </ul>
            <h2>5. Intellectual property</h2>
            <p>
              The platform, brand, matching models, and content are owned by {SITE.legalName} or
              its licensors. Employers own their job content; workers own their profile data
              subject to the consents they grant. No licence beyond using the SaaS as provided.
            </p>
            <h2>6. Governing law &amp; jurisdiction</h2>
            <p>
              These terms are governed by {SITE.governingLaw}.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
