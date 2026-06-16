import { getPricingCatalog, type ActiveCatalog } from "@/lib/api";
import {
  toProductTierRows,
  extractCreditPacks,
  formatCatalogJson,
} from "@/lib/pricing-view";
import { PricingEditor } from "./pricing-editor";
import { CreditsPanel } from "./credits-panel";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/** Format an ISO timestamp, falling back to the raw string if unparseable. */
function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/** Render a kind-specific grant column value, or an em-dash when N/A. */
function cell(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value}${suffix}`;
}

/**
 * Ops Pricing screen (ADR-0013 config-driven Pricing Engine). Reads the active,
 * validated catalog from the PUBLIC `GET /pricing/catalog` and renders a readable
 * summary (products → tiers, offers, coupons) + the revision + a fail-closed
 * warning when a stored row was rejected and the DEFAULT is served. Below it: the
 * catalog editor and the payer credit balance / MOCK top-up panel.
 *
 * The catalog is PII-FREE by construction (codes + integer ₹ + ISO timestamps).
 */
export default async function PricingPage() {
  let active: ActiveCatalog | null = null;
  let error: string | null = null;
  try {
    active = await getPricingCatalog();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !active) {
    return (
      <>
        <h1 className="page-title">Pricing</h1>
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      </>
    );
  }

  const rows = toProductTierRows(active.catalog);
  const packs = extractCreditPacks(active.catalog);
  const { offers, coupons } = active.catalog;
  const servingDefault = active.source === "default";

  return (
    <>
      <h1 className="page-title">Pricing</h1>
      <p className="page-sub">
        Config-driven pricing catalog (ADR-0013). Codes + integer ₹ only — PII-free.{" "}
        <span className="badge">Revision {active.revision}</span>{" "}
        <span className="badge">source: {active.source}</span>
      </p>

      {servingDefault ? (
        <p className="note">
          <strong>Serving the DEFAULT catalog (fail-closed).</strong> The stored
          catalog row was rejected by validation (or none exists), so the engine is
          serving the typed default — never an unvalidated/garbage price. Publish a
          valid catalog below to replace it.
        </p>
      ) : null}

      <h2 className="page-title" style={{ fontSize: 17, marginTop: 28 }}>
        Products &amp; tiers
      </h2>
      {rows.length === 0 ? (
        <p className="page-sub">No products in the catalog.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Kind</th>
              <th>Tier</th>
              <th>Price (₹)</th>
              <th>Validity / window</th>
              <th>Applicant quota</th>
              <th>Boost days</th>
              <th>Credits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.productCode}:${r.tierCode}`}>
                <td className="mono">{r.productCode}</td>
                <td>{r.kindLabel}</td>
                <td className="mono">{r.tierCode}</td>
                <td>{r.priceInr}</td>
                <td>{cell(r.validityDays, "d")}</td>
                <td>{cell(r.applicantVisibilityQuota)}</td>
                <td>{cell(r.boostDays, "d")}</td>
                <td>{cell(r.credits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="page-title" style={{ fontSize: 17, marginTop: 28 }}>
        Offers (automatic, time-boxed)
      </h2>
      {offers.length === 0 ? (
        <p className="page-sub">No offers configured.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Scope</th>
              <th>Discount</th>
              <th>From</th>
              <th>Until</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.code}>
                <td className="mono">{o.code}</td>
                <td className="mono">
                  {o.scope.productCode}
                  {o.scope.tierCode ? ` / ${o.scope.tierCode}` : ""}
                </td>
                <td>{o.kind === "percent" ? `${o.value}%` : `₹${o.value}`}</td>
                <td>{fmt(o.from)}</td>
                <td>{fmt(o.until)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="page-title" style={{ fontSize: 17, marginTop: 28 }}>
        Coupons (code-redeemed, capped)
      </h2>
      {coupons.length === 0 ? (
        <p className="page-sub">No coupons configured.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Scope</th>
              <th>Discount</th>
              <th>From</th>
              <th>Until</th>
              <th>Total cap</th>
              <th>Per-payer</th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.code}>
                <td className="mono">{c.code}</td>
                <td className="mono">
                  {c.scope.productCode}
                  {c.scope.tierCode ? ` / ${c.scope.tierCode}` : ""}
                </td>
                <td>{c.kind === "percent" ? `${c.value}%` : `₹${c.value}`}</td>
                <td>{fmt(c.from)}</td>
                <td>{fmt(c.until)}</td>
                <td>{c.totalUsageCap}</td>
                <td>{c.perPayerLimit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="page-title" style={{ fontSize: 17, marginTop: 32 }}>
        Edit catalog
      </h2>
      <p className="page-sub">
        Publishes a new revision. An invalid catalog is rejected with the server&rsquo;s
        validation message (verbatim) and never stored.
      </p>
      <PricingEditor initialCatalogJson={formatCatalogJson(active.catalog)} />

      <h2 className="page-title" style={{ fontSize: 17, marginTop: 32 }}>
        Payer credits
      </h2>
      <p className="page-sub">
        A payer&rsquo;s own credit balance + a MOCK top-up (alpha, no real money). The
        credit packs below are derived from the catalog&rsquo;s credit_pack products —
        these are what the contact-unlock flow consumes.
      </p>
      <CreditsPanel packs={packs} />

      <div className="footer">
        Internal pricing register. The catalog is PII-free (codes + integer ₹). Credit
        endpoints are behind the InternalServiceGuard — the secret stays server-side.
      </div>
    </>
  );
}
