import { SiteHeader } from "../components/site-header";
import { SiteFooter } from "../components/site-footer";
import { PRICING, inr } from "../site-config";

/**
 * CTA DESTINATIONS — PLACEHOLDER, pending a product decision.
 *
 * The real destinations are one of two things this app cannot decide on its own:
 *   - Workers: an app-store / Play-Store listing, or a deep link into the worker app —
 *     neither is confirmed public yet.
 *   - Employers: the live payer portal (apps/payer-web) — currently reachable at
 *     `app.badabhai.in`, but the `.in` → `.ai` domain rename is explicitly blocked
 *     (issue #920 / GAP-XC-06) and DNS for `badabhai.ai` is not live. Hardcoding
 *     either domain here would ship a link this app cannot promise resolves.
 *
 * Relative paths are used instead — they render as real, keyboard/screen-reader
 * reachable links today (no dead "#" href) and become the actual routes, or a
 * redirect to the chosen external destination, once that decision is made.
 */
const WORKER_CTA_HREF = "/workers";
const EMPLOYER_CTA_HREF = "/employers";

export default function HomePage() {
  return (
    <>
      <a className="sr-only sr-only-focusable" href="#main-content">
        Skip to content
      </a>

      <SiteHeader />

      <main id="main-content">
        <section className="mkt-hero">
          <div className="mkt-container mkt-hero__inner">
            <p className="mkt-eyebrow">AI-first hiring platform</p>
            <h1 className="mkt-hero__title">Skilled workers. Verified employers. Matched by AI.</h1>
            <p className="mkt-hero__sub">
              BadaBhai digitizes blue-collar, grey-collar, industrial-manufacturing, construction,
              and skilled-trade workers through AI-guided profiling — no resume required — and
              connects them with the employers who need exactly their skills.
            </p>
            <div className="mkt-hero__ctas">
              <a className="mkt-btn mkt-btn--primary" href={EMPLOYER_CTA_HREF}>
                Post a job
              </a>
              <a className="mkt-btn mkt-btn--secondary" href={WORKER_CTA_HREF}>
                Get hired
              </a>
            </div>
          </div>
        </section>

        <section className="mkt-section" aria-labelledby="what-badabhai-does">
          <div className="mkt-container">
            <div className="mkt-section__head">
              <h2 className="mkt-section__title" id="what-badabhai-does">
                What BadaBhai does
              </h2>
              <p className="mkt-section__sub">
                One platform, two sides of the same hiring loop — a worker&rsquo;s profile and an
                employer&rsquo;s search, both driven by the same AI matching.
              </p>
            </div>

            <div className="mkt-split">
              <article className="mkt-panel" id="workers" aria-labelledby="for-workers-title">
                <h3 className="mkt-panel__title" id="for-workers-title">
                  For workers
                </h3>
                <ul className="mkt-panel__list">
                  <li className="mkt-panel__item">
                    <span className="mkt-panel__item-mark" aria-hidden="true">
                      1
                    </span>
                    <span>Tell BadaBhai about your work by voice or by chat — no typing required.</span>
                  </li>
                  <li className="mkt-panel__item">
                    <span className="mkt-panel__item-mark" aria-hidden="true">
                      2
                    </span>
                    <span>AI turns that conversation into a clean, professional profile and resume.</span>
                  </li>
                  <li className="mkt-panel__item">
                    <span className="mkt-panel__item-mark" aria-hidden="true">
                      3
                    </span>
                    <span>Verified employers reach out only once you choose to be found.</span>
                  </li>
                </ul>
                <a className="mkt-btn mkt-btn--secondary mkt-panel__cta" href={WORKER_CTA_HREF}>
                  Get the BadaBhai app
                </a>
              </article>

              <article className="mkt-panel" id="employers" aria-labelledby="for-employers-title">
                <h3 className="mkt-panel__title" id="for-employers-title">
                  For employers
                </h3>
                <ul className="mkt-panel__list">
                  <li className="mkt-panel__item">
                    <span className="mkt-panel__item-mark" aria-hidden="true">
                      1
                    </span>
                    <span>Post a role and see candidates ranked by real skill and experience match.</span>
                  </li>
                  <li className="mkt-panel__item">
                    <span className="mkt-panel__item-mark" aria-hidden="true">
                      2
                    </span>
                    <span>
                      Every applicant is faceless until you choose to unlock them — you review the
                      work before the person.
                    </span>
                  </li>
                  <li className="mkt-panel__item">
                    <span className="mkt-panel__item-mark" aria-hidden="true">
                      3
                    </span>
                    <span>Unlock verified contact details for the candidates worth a call.</span>
                  </li>
                </ul>
                <a className="mkt-btn mkt-btn--primary mkt-panel__cta" href={EMPLOYER_CTA_HREF}>
                  Start hiring
                </a>
              </article>
            </div>
          </div>
        </section>

        <section className="mkt-section" aria-labelledby="employer-pricing-title">
          <div className="mkt-container">
            <div className="mkt-section__head">
              <h2 className="mkt-section__title" id="employer-pricing-title">
                Transparent employer pricing, in rupees
              </h2>
              <p className="mkt-section__sub">
                Contact-credit packs, postings, boosts, capacity, and managed hiring — all in
                INR, exclusive of 18% GST. Full detail on the pricing page.
              </p>
            </div>
            <div className="mkt-price-grid">
              {PRICING.contactPacks.map((t) => (
                <article key={t.code} className="mkt-price-card">
                  <h3 className="mkt-price-card__name">{t.name}</h3>
                  <p className="mkt-price-card__amount">{inr(t.priceInr)}</p>
                  <p className="mkt-price-card__blurb">{t.blurb} · +18% GST</p>
                </article>
              ))}
            </div>
            <p className="mkt-gst-note">
              <a className="mkt-btn mkt-btn--primary mkt-cta-block" href="/pricing">
                See full pricing
              </a>
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
