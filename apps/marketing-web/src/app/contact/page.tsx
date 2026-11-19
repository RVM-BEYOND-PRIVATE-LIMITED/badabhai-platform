import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";
import { SITE } from "../../site-config";

export const metadata: Metadata = {
  title: "Contact Us — BadaBhai",
  description: `Contact ${SITE.legalName}: registered office, support email and phone with hours.`,
};

export default function ContactPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">Contact Us</p>
            <h1>Talk to a human at BadaBhai</h1>
            <p>
              For sales, billing, refunds, or support with the job-portal SaaS, reach us on
              any of these verifiable operational channels — a contact form alone is never
              the only way to reach us.
            </p>
            <div className="mkt-contact-card">
              <p><strong>Legal entity:</strong> {SITE.legalName}</p>
              <address>
                <strong>Registered &amp; operational address:</strong>
                <br />
                {SITE.registeredAddress.map((line) => (
                  <span key={line}>
                    {line}
                    <br />
                  </span>
                ))}
              </address>
              <p>
                <strong>Support email:</strong>{" "}
                <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>
              </p>
              <p>
                <strong>Support phone:</strong>{" "}
                <a href={SITE.supportPhoneHref}>{SITE.supportPhoneDisplay}</a>
                <br />
                <span>Operational hours: {SITE.supportHours}</span>
              </p>
            </div>
            <h2>What to include in your message</h2>
            <ul>
              <li>Your company name and work email (the one on your BadaBhai account).</li>
              <li>For billing issues: invoice number and date of payment.</li>
              <li>For refunds: order reference and reason (see our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>).</li>
            </ul>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
