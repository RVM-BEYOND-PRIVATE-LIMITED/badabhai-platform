import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";
import { SITE } from "../../site-config";

export const metadata: Metadata = {
  title: "Privacy Policy — BadaBhai",
  description: `How ${SITE.legalName} collects, uses, shares, and protects worker and employer data, including payment processing via Razorpay.`,
};

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">Privacy Policy</p>
            <h1>How we handle your data</h1>
            <p className="mkt-legal__updated">Last updated: {SITE.lastUpdated} · Data fiduciary: {SITE.legalName}</p>
            <p>
              BadaBhai ({SITE.domain}), operated by {SITE.legalName}, collects worker and
              employer data to run an AI-matched job portal. This policy follows India&apos;s
              Digital Personal Data Protection Act and the IT Act framework: consent-first,
              purpose-limited, and erasable on request.
            </p>
            <h2>1. What we collect</h2>
            <ul>
              <li>Workers: name, phone, city/state, work history, skills, salary expectations, voice/chat transcripts for profiling, resume artefacts, consent records.</li>
              <li>Employers: company name, work email, phone, job postings, applicant decisions, billing details (name, address, GSTIN where given).</li>
              <li>Technical: device/session identifiers, logs, and cookies needed for sign-in and fraud prevention.</li>
            </ul>
            <h2>2. Why we collect it (purpose)</h2>
            <ul>
              <li>Build AI-guided worker profiles and match them to employer roles.</li>
              <li>Show employers faceless candidate cards; reveal contacts only after an explicit unlock the worker consented to be discoverable for.</li>
              <li>Bill plans, issue GST invoices, prevent fraud, and meet legal duties.</li>
            </ul>
            <h2>3. Third-party sharing — including Razorpay</h2>
            <ul>
              <li>Payment processing data (amount, invoice identity, payer contact/billing fields needed to charge and receipt) is shared with <strong>Razorpay</strong> to process UPI/card/netbanking payments. Razorpay handles card/bank credentials directly; we never store full card numbers.</li>
              <li>Infrastructure providers (hosting, SMS/OTP, email) process data only to deliver the service, under contract.</li>
              <li>We never sell personal data. Worker contacts reach an employer only through a consented, logged unlock.</li>
            </ul>
            <h2>4. Security &amp; cookies</h2>
            <ul>
              <li>Encryption in transit and at rest for PII, role-gated access, and append-only consent ledgers.</li>
              <li>Cookies/session storage keep you signed in and remember preferences; strictly-necessary storage cannot be disabled without breaking sign-in.</li>
            </ul>
            <h2>5. Your rights — correction &amp; deletion</h2>
            <p>
              You may request access, correction, or deletion of your personal data at any
              time by writing to <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>.
              We act on verified requests within 30 days and confirm once erased, subject to
              retention the law requires (e.g. financial records for invoices).
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
