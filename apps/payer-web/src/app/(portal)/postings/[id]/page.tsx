import { notFound } from "next/navigation";
import { z } from "zod";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { getPostingDetail } from "../../../../lib/payer-api";
import { requirePayer } from "../../../../lib/auth";
import { Badge } from "../../../../components/ds";
import { PageHeader, type PageHeaderAction } from "../../../../components/page-header";
import { JobCardPreview } from "../../../../components/job-card-preview";
import { toJobCardView } from "../../../../lib/job-card-view";
import { jobRoleLabel } from "../../../../lib/job-roles";
import { PUBLISHED_REACH_PARAM, parsePublishedReach } from "../../../../lib/published-reach";
import { PublishedReachNotice } from "../../../../components/published-reach-notice";

export const dynamic = "force-dynamic";

/**
 * Manage-posting DETAIL (PR-B) — the caller's OWN posting via the LIVE `GET /payer/job-postings/:id`
 * detail read (XB-A; unknown OR not-owned → neutral 404 → `notFound()`). FACELESS: the payer's own
 * fields only. Shows the SAME {@link JobCardPreview} the form previews (one mapper), plus the kv
 * facts. A DRAFT's one action is "Edit posting" — a draft reaches nobody until it is published
 * there ("Publish posting").
 *
 * An AGENT's older company posting is VIEW-ONLY (owner ruling 2026-10-01): no action at all — not
 * Edit (its page sends an agent back here) and not Applicants (that feed unlocks contacts; it
 * sends an agent back here too). The agency's own postings live under /agency/jobs.
 *
 * LAYOUT (F03): the head — and a draft's note — LEAD the details column, so the card rail beside
 * them starts at the top of the page. With the head above the whole layout, a head whose actions
 * wrapped (1280 / 1366) pushed the card down a row and its brand plate fell below a 720px fold.
 * On a phone the head still comes first, then the card, then the details (globals.css).
 */

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
}

export default async function PostingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?reached=N` — set by the edit page's PUBLISH (see `lib/published-reach.ts`). */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePayer();
  const { id } = await params;
  const query = (await searchParams) ?? {};
  if (!z.string().uuid().safeParse(id).success) notFound();
  const detail = await getPostingDetail(id);
  if (!detail) notFound();

  const { summary, card, description } = detail;
  const view = toJobCardView(card);
  const isDraft = summary.status === "draft";
  // An agent's OLDER company posting is view-only (owner ruling 2026-10-01; see ../page.tsx).
  const readOnly = session.role === "agent";
  const edit: PageHeaderAction = {
    href: `/postings/${summary.id}/edit`,
    label: "Edit posting",
    icon: ACTION_ICON.edit,
  };
  // One name per destination (F13): the faceless feed is "Applicants" on every company surface.
  const applicants: PageHeaderAction = {
    href: `/postings/${summary.id}/applicants`,
    label: "Applicants",
    icon: ACTION_ICON.users,
  };
  // ONE action per destination: a draft has no applicants yet, so its one action is to finish
  // it on the edit page (it used to offer "Finish and publish" AND "Edit posting", both → edit).
  // Read-only: none.
  const primary = readOnly ? undefined : isDraft ? edit : applicants;
  const secondaries = readOnly || isDraft ? [] : [edit];

  return (
    <div className="posting-layout posting-layout--detail">
      <div className="posting-layout__head">
        <PageHeader
          back={{ href: "/postings", label: readOnly ? "Older postings" : "Postings" }}
          title={summary.roleTitle}
          description={
            readOnly
              ? "What this older posting says and where it stands — it is view-only."
              : "What this posting says and where it stands — applicants stay masked until you unlock them."
          }
          status={
            <Badge tone={statusTone(summary.status)} upper>
              {summary.status}
            </Badge>
          }
          primaryAction={primary}
          secondaryActions={secondaries}
        />

        {/* Only a LIVE posting can claim a reach — a stale link onto a since-paused one shows none.
            It sits in the head (the details column), so on a laptop it never pushes the card rail
            down (F03); on a phone it follows the title, before the card. */}
        <PublishedReachNotice
          reached={
            summary.status === "open" ? parsePublishedReach(query[PUBLISHED_REACH_PARAM]) : null
          }
        />

        {isDraft ? (
          <div className="alert alert--info">
            <Icon name="info" className="alert__icon" />
            <div className="alert__text">
              <p className="alert__title">This posting is a draft</p>
              <p className="alert__body">
                {readOnly
                  ? "A draft reaches nobody, and older postings are view-only."
                  : "A draft reaches nobody. Finish the card and publish it so workers can find it."}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Posting details</h2>
        </div>
        <div className="panel__body">
          {/* Anything the card beside this list ALSO shows is formatted by the card's own mapper
              (`toJobCardView`), so the two can never disagree about one posting. */}
          <dl className="kv">
            <dt className="kv__k">Location</dt>
            <dd className="kv__v">{view.place || "—"}</dd>
            <dt className="kv__k">Location note</dt>
            <dd className="kv__v">{summary.locationLabel ?? "—"}</dd>
            <dt className="kv__k">Role</dt>
            <dd className="kv__v">{jobRoleLabel(card.role_kind) ?? "—"}</dd>
            <dt className="kv__k">Openings</dt>
            <dd className="kv__v bb-mono">{summary.vacancyBand}</dd>
            <dt className="kv__k">Applicants</dt>
            <dd className="kv__v">
              <span className="bb-mono">{summary.applicantCount}</span> /{" "}
              <span className="bb-mono">{summary.applicantQuota ?? "—"}</span>
            </dd>
            <dt className="kv__k">Posted</dt>
            <dd className="kv__v bb-mono">{day(summary.createdAt)}</dd>
            <dt className="kv__k">Description</dt>
            <dd className="kv__v kv__v--prose">{description ?? "—"}</dd>
          </dl>
        </div>
      </section>

      <aside className="posting-preview" aria-label="Worker card preview">
        <div className="posting-preview__scroll">
          <JobCardPreview fields={card} />
        </div>
      </aside>
    </div>
  );
}
