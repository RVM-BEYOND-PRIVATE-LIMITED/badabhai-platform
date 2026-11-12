import { ACTION_ICON, Icon } from "@badabhai/icons";
import { getCreditTopUps, getDashboard } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { lowBalanceThreshold, offeredCreditPacks } from "../../../lib/pricing-config";
import { buildTransactionHistory } from "../../../lib/credit-history";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { payerServerConfig } from "../../../lib/server-config";
import { formatInr } from "../../../lib/format";
import { opaqueId } from "../../../lib/masking";
import type { CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";
import { Badge, Card } from "../../../components/ds";
import { PageHeader } from "../../../components/page-header";
import { RetryButton } from "../../../components/retry-button";
import { CreditsPanel } from "./credits-panel";

export const dynamic = "force-dynamic";

/** The Buy Credits section's id — what the out-of-credits notice links to (#2744). */
const PACKS_ANCHOR = "packs";

/** ISO → yyyy-mm-dd for display; echoes the input on a parse failure. */
function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/**
 * Credit top-up + history (ADR-0019 Phase 1 — MOCK ledger, no real money / XT5) — composed
 * onto the UI-1 page spine (`page-head` / `stat-row` / `section` / `panel--table` / `alert` /
 * `state`). PRESENTATION ONLY: data + config + RBAC + copy semantics are unchanged.
 *
 * Packs are read from the LIVE catalog (D-6: `getLiveCatalog` → GET /payer/pricing/catalog via
 * pricing-config), never hardcoded — an ops price edit shows here without a rebuild. No
 * per-unlock price shows anywhere on the page: not in the description, the balance hero or a
 * tile (#2744). Pack tiles come from the catalogue API ONLY (#2744): on a catalog fetch failure
 * the page renders no packs — an error state with a retry — and never the compile-time default
 * packs. That reverses D-6's fail-open (defaults + a cached-pricing note) for this page only; the
 * balance and the history still render.
 * All ₹ / counts render in mono tabular.
 *
 * MOCK vs REAL is decided SERVER-SIDE by `payerServerConfig().paymentsEnableReal` and
 * passed down as one boolean. The client cannot choose its own mode, and the browser only
 * ever learns the PUBLIC `rzp_*` key id — which arrives on the order response, not from
 * this page and not from any `NEXT_PUBLIC_*` value. Only REAL mode adds copy (the Razorpay
 * lines). There is no "mock" / "staging preview" copy in either mode (owner ruling 2026-10-07,
 * F35: "mock wording is not needing on plans and credit") and no replacement disclaimer.
 *
 * PII-free (ids/amounts only — never a worker name/phone). OPEN TO EVERY PAYER MEMBER (owner
 * ruling 2026-10-07): an Owner AND a Recruiter can view the wallet and buy credits, so the gate is
 * `requirePayer()` (signed in, any org role) — not the org-role gate, which now guards Team only.
 * The API's own owner check on the purchase routes is being lifted to match; until it deploys a
 * Recruiter's purchase may 403, which the actions answer with one neutral line (actions.ts).
 */
export default async function CreditsPage() {
  await requirePayer(); // Signed-in payer, any org role — unauthenticated ⇒ /login.

  // Server-resolved payment mode. Fail-closed: anything but an explicit "true" is MOCK.
  const realPayments = payerServerConfig().paymentsEnableReal;
  // Priced at what each pack is charged (#2085 — the catalog's `prices[]`). Only a LIVE read
  // yields packs (#2744): a failed one (`live:false`) is null, never the compile-time defaults.
  const catalog = await getLiveCatalog();
  const packs = catalog.live ? offeredCreditPacks(catalog) : null;
  const threshold = lowBalanceThreshold();

  let dashboard: Dashboard | null = null;
  let error: string | null = null;
  try {
    // The balance + the unlock half of the ledger; this page shows no postings, so it never
    // asks for the company postings list.
    dashboard = await getDashboard({ withPostings: false });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // The mock-ledger top-ups are a SEPARATE concern from the live balance — fetched in their
  // own try/catch so a ledger hiccup never blanks the balance/packs (C2 decoupling).
  let topUps: CreditTopUp[] = [];
  try {
    topUps = await getCreditTopUps();
  } catch {
    topUps = [];
  }

  const unlocks: UnlockHistoryItem[] = dashboard?.unlocks ?? [];
  const history = buildTransactionHistory({ unlocks, topUps });
  const balance = dashboard?.credits.balance ?? null;
  // Out of credits outranks "running low" (the dashboard's rule too): one notice, never both. An
  // unread balance (null) is neither.
  const outOfCredits = balance !== null && balance <= 0;
  const lowBalance = balance !== null && balance < threshold;

  return (
    <>
      <PageHeader
        title="Credits"
        description={`Your credit balance, the packs on sale, and every credit you have bought or spent${realPayments ? " — pay securely via Razorpay; credits are added as soon as the payment is confirmed." : "."}`}
        actionsSlot={
          <span className="cred-info">
            <Icon name="info" />
            <span>Purchased credits reflect immediately</span>
          </span>
        }
      />

      {outOfCredits ? (
        <div className="alert alert--danger">
          <Icon name="warning-octagon" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">You are out of unlock credits</p>
            <p className="alert__body">
              Applicants stay masked until you buy credits. Existing unlocks are unaffected.
            </p>
          </div>
          <div className="alert__actions">
            {/* Same-page link to the packs below (#2744 item 6). */}
            <a className="bb-btn bb-btn--secondary bb-btn--sm" href={`#${PACKS_ANCHOR}`}>
              <Icon name={ACTION_ICON.credits} />
              <span>Buy credits</span>
            </a>
          </div>
        </div>
      ) : lowBalance ? (
        <div className="alert alert--warning">
          <Icon name="warning" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">Running low</p>
            <p className="alert__body">
              You&rsquo;re running low — <span className="bb-mono">{balance}</span> credit
              {balance === 1 ? "" : "s"} left. Buy credits below to keep unlocking applicants. We
              nudge below {threshold} credits — this is your own balance, never a signal about any
              applicant.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h2 className="state__title">Service unavailable</h2>
            <p className="state__body">
              We couldn&rsquo;t load your balance right now. Nothing has changed — please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : dashboard ? (
        <>
          <section className="cred-hero">
            <span className="cred-hero__icon">
              <Icon name={ACTION_ICON.credits} />
            </span>
            <div className="cred-hero__body">
              <p className="cred-hero__label">
                CURRENT CREDIT BALANCE <span className="cred-dot" aria-hidden="true" />
              </p>
              <p className="cred-hero__value">
                <span className="cred-hero__num bb-mono">{dashboard.credits.balance}</span>
                <span className="cred-hero__unit">available unlocks</span>
              </p>
            </div>
            {/* The balance only. No per-unlock value or rate (#2744), and no credit validity /
                expiry: the server applies none yet (BB-D-04, #2741). */}
          </section>

          {/* `anchor-target`: the notice's link lands this below the sticky header. */}
          <section className="cred-buy anchor-target" id={PACKS_ANCHOR}>
            <div className="cred-buy__head">
              <div>
                <h2 className="cred-section__title">Buy Credits</h2>
                <p className="cred-section__sub">
                  Pick a pack — the credits land in the balance above immediately and can be spent
                  on any contact unlock.
                </p>
              </div>
            </div>
            {packs !== null ? (
              <CreditsPanel packs={packs} real={realPayments} />
            ) : (
              <div className="state state--error">
                <span className="state__icon">
                  <Icon name="warning-circle" />
                </span>
                <h3 className="state__title">Packs unavailable</h3>
                <p className="state__body">
                  We couldn&rsquo;t load the packs on sale right now. Your balance is unaffected —
                  please retry.
                </p>
                <div className="state__actions">
                  <RetryButton />
                </div>
              </div>
            )}
          </section>
        </>
      ) : null}

      <section className="cred-panel">
        <div className="cred-panel__head">
          <div>
            <h2 className="cred-panel__title">Credit Movement &amp; History</h2>
            <p className="cred-panel__sub">Your purchases and candidate unlock spends</p>
          </div>
        </div>
        <div className="cred-panel__body">
          {history.length > 0 ? (
            <div className="tablewrap" tabIndex={0} role="region" aria-label="Credit history">
              <table className="table table--nowrap">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th className="num">Credits</th>
                    <th className="num">Amount</th>
                    <th>Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{day(t.at)}</td>
                      <td>
                        {t.kind === "topup" ? (
                          <Badge tone="success">Purchase</Badge>
                        ) : (
                          <Badge tone="neutral">Unlock</Badge>
                        )}
                      </td>
                      <td className="num">{t.credits > 0 ? `+${t.credits}` : t.credits}</td>
                      <td className="num">
                        {t.kind === "topup" && t.priceInr !== undefined
                          ? formatInr(t.priceInr)
                          : "—"}
                      </td>
                      <td className="mono">{opaqueId(t.id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : error ? (
            <div className="state state--error">
              <span className="state__icon">
                <Icon name="warning-circle" />
              </span>
              <h3 className="state__title">History unavailable</h3>
              <p className="state__body">
                We couldn&rsquo;t load your credit movements right now. Nothing has changed —
                please retry.
              </p>
              <div className="state__actions">
                <RetryButton />
              </div>
            </div>
          ) : (
            <div className="cred-empty">
              <span className="cred-empty__icon">
                <Icon name="receipt" />
              </span>
              <h3 className="cred-empty__title">No recent credit movements</h3>
              <p className="cred-empty__body">
                Credit purchases and unlocked applicant contact details will be logged securely
                here.
              </p>
            </div>
          )}
        </div>
        <div className="cred-panel__foot">
          <span>All candidate identities protected</span>
          <span className="cred-panel__footend">
            <Icon name="shield-check" /> Encrypted Audit
          </span>
        </div>
      </section>

      {realPayments ? (
        <div className="alert alert--info">
          <Icon name="shield-check" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">Payments by Razorpay.</p>
            <p className="alert__body">
              Card and UPI details are entered on Razorpay&rsquo;s secure form — BadaBhai never sees
              or stores them. Credits are added once the payment is confirmed.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );

}
