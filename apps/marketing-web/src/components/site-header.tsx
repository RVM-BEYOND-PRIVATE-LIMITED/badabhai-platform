import { BadaBhaiLogo } from "./logo";

/** Public site header — brand kit lockup + anchor nav + pricing link. */
export function SiteHeader() {
  return (
    <header className="mkt-header">
      <div className="mkt-container mkt-header__inner">
        <a href="/" aria-label="BadaBhai home">
          <BadaBhaiLogo />
        </a>
        <nav className="mkt-nav" aria-label="Primary">
          <a href="/#workers">For workers</a>
          <a href="/#employers">For employers</a>
          <a href="/pricing">Pricing</a>
          <a href="/contact">Contact</a>
        </nav>
      </div>
    </header>
  );
}
