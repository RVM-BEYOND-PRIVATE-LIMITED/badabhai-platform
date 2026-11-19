import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";

export const metadata: Metadata = {
  title: "For workers — BadaBhai",
  description: "Tell BadaBhai about your work by voice or chat and get found by verified employers. No resume required.",
};

export default function WorkersPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <div className="mkt-container mkt-legal">
          <div className="mkt-legal__inner">
            <p className="mkt-eyebrow">For workers — free</p>
            <h1>Kaam chahiye? Bada Bhai hai na.</h1>
            <p>
              Tell BadaBhai about your work by voice or by chat — no typing, no resume required.
              Our AI builds your professional profile, and verified employers reach out only once
              you choose to be found. Worker accounts are always free.
            </p>
            <h2>How it works</h2>
            <ul>
              <li>Talk about your trade, experience, city, and salary expectation.</li>
              <li>Get a clean profile + resume you control (photo/name visibility is yours).</li>
              <li>Appear in employer searches only with your consent — withdraw anytime.</li>
            </ul>
            <p>
              Questions? <a href="/contact">Contact us</a> · Read our{" "}
              <a href="/privacy">Privacy Policy</a>.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
