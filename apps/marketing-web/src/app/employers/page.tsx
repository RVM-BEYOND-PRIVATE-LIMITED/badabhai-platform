import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";

export const metadata: Metadata = {
  title: "For employers — BadaBhai",
  description: "Post roles, see faceless candidates ranked by skill match, and unlock verified contacts. Transparent INR pricing.",
};

export default function EmployersPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">For employers</p>
            <h1>Hire skilled workers, without the guesswork</h1>
            <p>
              Post a role and see candidates ranked by real skill and experience match. Every
              applicant is faceless until you choose to unlock them — you review the work before
              the person — then unlock verified contact details for the candidates worth a call.
            </p>
            <h2>Start here</h2>
            <ul>
              <li><a href="/pricing">Pricing</a> — contact packs from ₹2,000 + 18% GST; postings, boosts, capacity, managed hiring.</li>
              <li><a href="/terms">Terms</a>, <a href="/privacy">Privacy</a>, and <a href="/refund-policy">Refunds</a> — the audit pack, one click from every footer.</li>
              <li><a href="/contact">Contact us</a> — sales, billing, and support.</li>
            </ul>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
