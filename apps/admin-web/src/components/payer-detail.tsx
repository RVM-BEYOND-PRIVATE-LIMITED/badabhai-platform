import Link from "next/link";
import type { JobPostingListItem, PayerDetail } from "../lib/entities";
import { NAME_UNREADABLE, displayName, identityPosture } from "../lib/identity";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../lib/format";
import { can, type AdminCapability } from "../lib/auth/capabilities";
import { StatusPill } from "./status-pill";
import { NameCell } from "./name-cell";
import { IdentityCapNotice } from "./identity-notice";
import { DetailList } from "./detail-list";
import { Stat } from "./stat";
import { PayerDetailHeader } from "./payer-detail-header";
import { PayerCreditsPanel } from "./payer-credits-panel";

/**
 * One payer account — shared by Companies and Agencies, which differ only by `role`.
 *
 * ── TWO NAMES, AND THEY ARE NOT THE SAME NAME ───────────────────────────────────────────
 * `org_name` is the account's REGISTERED organisation name, decrypted for this response behind
 * `read_identity` (owner ruling 2026-08-18). The org LABELS further down are read off this
 * payer's own job postings — poster-typed free text that can vary between postings and that
 * every worker already sees in the feed.
 *
 * They are shown as two separate things, not merged, because they answer different questions and
 * disagreeing is the interesting case: an account registered as one entity and publishing under
 * another is exactly the shape of the spam an operator opens this screen to act on. Neither is a
 * verified legal name, and the page says so about both — on a screen that sits next to a suspend
 * button, "acting on identity" should never rest on a self-declared string alone.
 */
export function PayerDetailView({
  payer,
  postings,
  kind,
  backHref,
  capabilities,
}: {
  payer: PayerDetail;
  /** This payer's postings, or null when that read failed. */
  postings: JobPostingListItem[] | null;
  kind: "Company" | "Agency";
  backHref: string;
  capabilities: readonly AdminCapability[];
}) {
  // Distinct labels this payer has published under, most recent first.
  const labels = postings ? [...new Set(postings.map((p) => p.org_label))] : [];
  // Phase 1's per-entity timeline route. `backHref` is /companies or /agencies, so this
  // resolves to the section's own timeline page rather than the subject-type-wide feed.
  // Offered only to a reader who may open it: the timeline route is `read_events`.
  const timelineHref = can(capabilities, "read_events")
    ? `${backHref}/${payer.id}/timeline`
    : null;

  // One record, so the posture is read off this single row.
  const posture = identityPosture([payer], "org_name", can(capabilities, "read_identity"));
  const orgName = displayName(payer.org_name);

  // The id keeps its `mono` treatment; an organisation name does not get one.
  const header = {
    back: { href: backHref, label: kind === "Company" ? "Companies" : "Agencies" },
    title: orgName ?? shortId(payer.id),
    titleMono: orgName === null,
    description: (
      <>
        One {kind === "Company" ? "company" : "agency"} account — what it has posted and
        spent{orgName === null ? ", not who registered it" : ""}.{" "}
        {labels.length > 0 ? (
          <>
            Publishes as <strong>{labels.slice(0, 3).join(", ")}</strong>
            {labels.length > 3 && ` and ${labels.length - 3} more`} — self-declared on their
            postings, not a verified name.
          </>
        ) : (
          <>No postings yet, so there is no self-declared label to identify this account by.</>
        )}
      </>
    ),
  };

  return (
    <div className="page">
      <PayerDetailHeader
        header={header}
        payerId={payer.id}
        status={payer.status}
        canSuspend={can(capabilities, "suspend_payer")}
        timelineHref={timelineHref}
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see this account&apos;s registered name, so the heading above falls back
          to its id: this admin account has spent its hourly name budget.
        </IdentityCapNotice>
      )}

      {payer.status === "suspended" && (
        <section className="notice notice--bad" role="status">
          <strong>Suspended.</strong> Their postings are hidden from the worker feed and
          their sessions are revoked. Reinstating restores each posting to the state it held
          before the suspension
          {payer.previous_status ? ` (the account returns to ${payer.previous_status})` : ""}.
        </section>
      )}

      <div className="cols">
        <section className="panel" aria-labelledby="p-record">
          <div className="panel__head">
            <h2 className="panel__title" id="p-record">
              Account
            </h2>
            {/* THREE-VALUED, like the posture — see the worker detail page for the bug this
                shape replaces: a capped response asserting a name had been decrypted, directly
                under the banner saying none had. */}
            <p className="panel__sub">
              {posture === "faceless"
                ? "The registered organisation name is not served to your role. Email and phone are encrypted at rest and are served to no role at all."
                : posture === "capped"
                  ? "No registered name was decrypted for this response — see above. Email and phone are encrypted at rest and are served to no role at all."
                  : "The registered name is decrypted for this response only. Email and phone are encrypted at rest and are served to no role at all."}
            </p>
          </div>
          <DetailList
            items={[
              // Present only in the `named` posture — see `lib/identity.ts`.
              ...(posture === "named"
                ? [
                    {
                      label: "Registered name",
                      // `org_name_enc` is NOT NULL — a dash is unreadable, not unrecorded.
                      value: <NameCell value={payer.org_name} absentTitle={NAME_UNREADABLE} />,
                    },
                  ]
                : []),
              { label: `${kind} id`, value: <span className="mono">{payer.id}</span> },
              { label: "Account type", value: payer.role === "agent" ? "Agency" : "Company" },
              { label: "Status", value: <StatusPill value={payer.status} /> },
              {
                label: "Status before suspension",
                value: payer.previous_status ?? "never suspended",
              },
              {
                label: "Registered",
                value: (
                  <time dateTime={payer.created_at} title={formatTimestamp(payer.created_at)}>
                    {formatRelative(payer.created_at)}
                  </time>
                ),
              },
              {
                label: "Last updated",
                value: (
                  <time dateTime={payer.updated_at} title={formatTimestamp(payer.updated_at)}>
                    {formatRelative(payer.updated_at)}
                  </time>
                ),
              },
            ]}
          />
        </section>

        <section className="panel" aria-labelledby="p-usage">
          <div className="panel__head">
            <h2 className="panel__title" id="p-usage">
              Usage
            </h2>
            <p className="panel__sub">Postings, unlocks and the current credit balance.</p>
          </div>
          <div className="stats stats--compact">
            <Stat label="Open postings" value={formatCount(payer.open_posting_count)} />
            <Stat label="Postings, all time" value={formatCount(payer.posting_count)} />
            <Stat label="Contact unlocks" value={formatCount(payer.unlock_count)} />
            <Stat label="Credit balance" value={formatCount(payer.credit_balance)} />
          </div>
        </section>
      </div>

      {can(capabilities, "grant_credits") && (
        <PayerCreditsPanel
          payerId={payer.id}
          suspended={payer.status === "suspended"}
          timelineHref={timelineHref}
        />
      )}

      <section className="panel" aria-labelledby="p-postings">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="p-postings">
              Postings
            </h2>
            <p className="panel__sub">The most recent postings this account has created.</p>
          </div>
          {payer.posting_count > 0 && (
            <Link className="btn btn--ghost" href={`/jobs?payerId=${payer.id}`}>
              All their postings
            </Link>
          )}
        </div>

        {postings === null ? (
          <div className="state state--error">
            <h3 className="state__title">Their postings could not be loaded</h3>
            <p className="state__body">
              The account record above loaded, but the postings read failed — so this table
              is missing, not empty. The same read supplies the self-declared labels in the
              header, which is why this account is described without one.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={`${backHref}/${payer.id}`}>
                Retry
              </Link>
            </div>
          </div>
        ) : postings.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No postings yet</h3>
            <p className="state__body">
              This account has never created one, so it has published nothing to workers and
              carries no self-declared label. A registered account that never posts is the
              normal shape of an abandoned signup — its event timeline shows how far it got.
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Postings for this account</caption>
              <thead>
                <tr>
                  <th scope="col">Role title</th>
                  <th scope="col">Published as</th>
                  <th scope="col">Location</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {postings.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link className="link" href={`/jobs/${j.id}`}>
                        {j.role_title}
                      </Link>
                    </td>
                    <td>{j.org_label}</td>
                    <td className="table__meta">{j.city ?? j.location_label ?? "—"}</td>
                    <td>
                      <StatusPill value={j.status} />
                    </td>
                    <td>
                      <time dateTime={j.created_at} title={formatTimestamp(j.created_at)}>
                        {formatRelative(j.created_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
