import { BadaBhaiLogo } from "./logo";
import { COMPLIANCE_LINKS, SITE } from "../site-config";

/**
 * Global footer — rendered on EVERY public page (landing + all five
 * Razorpay compliance pages). All five mandatory pages reachable in 1 click.
 */
export function SiteFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-container mkt-footer__inner">
        <BadaBhaiLogo size={24} />
        <p className="mkt-footer__tagline">
          AI-first hiring for blue-collar, grey-collar, industrial-manufacturing,
          construction, and skilled-trade India. Worker data is collected with consent
          and shown to employers only as authorized.
        </p>
        <nav className="mkt-footer__links" aria-label="Legal and compliance">
          {COMPLIANCE_LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <address className="mkt-footer__contact">
          {SITE.legalName} · {SITE.registeredAddress.join(" ")} ·{" "}
          <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a> ·{" "}
          <a href={SITE.supportPhoneHref}>{SITE.supportPhoneDisplay}</a> ({SITE.supportHours})
        </address>
        <p className="mkt-footer__meta">
          <span>&copy; {new Date().getFullYear()} {SITE.legalName}</span>
          <span>{SITE.domain}</span>
        </p>
      </div>
    </footer>
  );
}
