import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../../lib/auth";
import { can } from "../../../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import {
  getSkillDiscoveryAudit,
  getSkillDiscoveryCandidate,
  type SkillCandidateAudit,
  type SkillDiscoveryDetail,
} from "../../../../../lib/skill-discovery";
import {
  ADMIN_SKILL_REVIEW_TIER_LABELS,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_SOURCE_TYPE_LABELS,
  SKILL_CANDIDATE_STATUS_LABELS,
  SKILL_CANDIDATE_STATUS_TONE,
  auditActionLabel,
  isTerminalSkillStatus,
  relationLabel,
} from "../../../../../lib/skill-discovery-vocabulary";
import { formatRelative, formatTimestamp, shortId } from "../../../../../lib/format";
import { StatusPill } from "../../../../../components/status-pill";
import { DetailList } from "../../../../../components/detail-list";
import { SkillDecisionPanel } from "./decision-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skill Candidate" };

/**
 * One skill candidate, in full — the review screen (#1260, extended #1280).
 *
 * ── TWO REQUESTS, IN PARALLEL, NO N+1 ────────────────────────────────────────────────────
 * `getSkillDiscoveryCandidate` and `getSkillDiscoveryAudit` fire together via
 * `Promise.allSettled` — sources, related skills, provenance and the decision record all
 * arrive on the candidate response; nothing on this page issues a second read per source or
 * per match. The audit read is a genuinely separate route (the event spine plus the row's own
 * state, #1280) and is allowed to fail independently: a 404/400 on the CANDIDATE read is fatal
 * (there is no candidate to show), but a failed AUDIT read degrades to an inline notice — the
 * same "don't blank the whole page for a secondary read" discipline `page.tsx`'s metrics tiles
 * already use.
 *
 * ── WHAT NEVER APPEARS HERE, DELIBERATELY, EVEN THOUGH THE FIELD EXISTS ON THE WIRE ─────
 * `provenance.model` / `provenance.prompt_version` are OMITTED from the rendered record. The
 * DTO serves them because they are part of the frozen 19-field digest, but the issue's own
 * hard rule is absolute — "a reviewer is never shown the words cosine, embedding or vector",
 * and a model identifier IS the embedding model name that rule refuses. Every other frozen
 * field renders as a plain record below; these two do not. `embedding_status` is rendered,
 * translated to a sentence rather than the raw enum, because it states a provenance FACT
 * ("this phrase needed no embedding") without naming a model or a score — closer in kind to
 * `classifier_rule` than to a model identifier.
 *
 * ── `admin_id` ON THE AUDIT TRAIL IS ALWAYS AN OPAQUE ID ─────────────────────────────────
 * Rendered through `shortId`, never resolved to a name or email — this console's one path to a
 * worker or admin's real name is the separate, reason-gated `reveal_pii` capability, and
 * nothing on this read-only history route goes near it.
 */
export default async function SkillDiscoveryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("read_entities");
  const { id } = await params;

  const [candidateRes, auditRes] = await Promise.allSettled([
    getSkillDiscoveryCandidate(id),
    getSkillDiscoveryAudit(id),
  ]);

  if (candidateRes.status === "rejected") {
    const err = candidateRes.reason;
    // 404 (unknown id) and 400 (not a uuid) both read as "no such candidate" from the
    // operator's point of view — a malformed id pasted from a chat log lands on not-found.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const candidate: SkillDiscoveryDetail = candidateRes.value;
  const audit: SkillCandidateAudit | null = auditRes.status === "fulfilled" ? auditRes.value : null;

  const terminal = isTerminalSkillStatus(candidate.status);
  const deferred = candidate.status === "deferred";
  const mayDecide = can(session.capabilities, "review_skill_candidates");

  const sourceJobDomainIds = [
    ...new Set(
      candidate.sources
        .map((s) => s.job_domain_id)
        .filter((v): v is string => v !== null && v !== ""),
    ),
  ];

  const strongMatches = candidate.related_skills.filter((m) => m.strength === "strong");
  const weakMatches = candidate.related_skills.filter((m) => m.strength === "weak");

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href="/skills/discovery">
              Skill Discovery
            </Link>
          </p>
          <h1 className="page__title">{candidate.normalized_phrase}</h1>
          <p className="page__sub">{candidate.phrase_class_label}</p>
        </div>
      </header>

      <div className="cols">
        <section className="panel" aria-labelledby="sd-summary">
          <div className="panel__head">
            <h2 className="panel__title" id="sd-summary">
              Skill candidate
            </h2>
          </div>
          <DetailList
            items={[
              { label: "Suggested skill", value: candidate.proposed_skill_name ?? "—" },
              { label: "Description", value: candidate.proposed_description ?? "—" },
              { label: "Confidence", value: candidate.confidence_band },
              { label: "Classification", value: candidate.phrase_class_label },
              { label: "Trade family", value: candidate.trade_family ?? "—" },
              {
                label: "Review tier",
                value: ADMIN_SKILL_REVIEW_TIER_LABELS[candidate.review_tier],
              },
              {
                label: "Status",
                value: (
                  <StatusPill
                    value={candidate.status}
                    label={SKILL_CANDIDATE_STATUS_LABELS[candidate.status]}
                    tone={SKILL_CANDIDATE_STATUS_TONE[candidate.status]}
                  />
                ),
              },
              {
                label: "Suggested action",
                value: SKILL_CANDIDATE_ACTION_LABELS[candidate.proposed_action],
              },
            ]}
          />
          <p className="field__help">
            <strong>Why this was surfaced.</strong> {candidate.rationale}
          </p>
        </section>

        <section className="panel" aria-labelledby="sd-sources">
          <div className="panel__head">
            <h2 className="panel__title" id="sd-sources">
              Sources ({candidate.sources.length})
            </h2>
            <p className="panel__sub">
              {candidate.source_domain_count} job domain
              {candidate.source_domain_count === 1 ? "" : "s"} attested this phrase.
            </p>
          </div>
          {candidate.sources.length === 0 ? (
            <p className="field__help">No source rows recorded.</p>
          ) : (
            <ul className="chips">
              {candidate.sources.map((s) => (
                <li className="chip" key={`${s.source_type}:${s.source_id}`} title={SKILL_CANDIDATE_SOURCE_TYPE_LABELS[s.source_type]}>
                  {s.original_text}
                </li>
              ))}
            </ul>
          )}
          {candidate.suggested_aliases.length > 0 && (
            <>
              <p className="field__help">
                Aliases a CREATE approval would mint (preview, nothing is written yet):
              </p>
              <ul className="chips">
                {candidate.suggested_aliases.map((a) => (
                  <li className="chip" key={a}>
                    {a}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="field__help">
            Source job domains ({sourceJobDomainIds.length}):{" "}
            {sourceJobDomainIds.length === 0
              ? "none recorded"
              : sourceJobDomainIds.map((jd) => (
                  <span className="mono" key={jd}>
                    {jd}{" "}
                  </span>
                ))}
          </p>
        </section>
      </div>

      <section className="panel" aria-labelledby="sd-matches">
        <div className="panel__head">
          <h2 className="panel__title" id="sd-matches">
            Existing related skills ({candidate.related_skills.length})
          </h2>
          <p className="panel__sub">
            Every competing match this candidate has against the shipped catalogue — never
            just the best one. Never a similarity score: a relation, a strength, and a
            sentence.
          </p>
        </div>
        {candidate.related_skills.length === 0 ? (
          <p className="field__help">No existing skill plausibly answers to this phrase.</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Related skills, strongest first</caption>
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col">Relation</th>
                  <th scope="col">Strength</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {[...strongMatches, ...weakMatches].map((m) => (
                  <tr key={m.skill_id}>
                    <td>
                      {/* Weak matches are visually SUBORDINATE but present — `.table__meta`
                          demotes the label to the same faint, small treatment every other
                          secondary cell on this console already uses, rather than hiding the
                          row or collapsing it behind the strong ones. */}
                      <span className={m.strength === "weak" ? "table__meta" : undefined}>
                        {m.skill_label}
                      </span>
                    </td>
                    <td className="table__meta">{relationLabel(m.relation)}</td>
                    <td>
                      <StatusPill
                        value={m.strength}
                        tone={m.strength === "strong" ? "warn" : "muted"}
                        title={
                          m.strength === "weak"
                            ? "Context, not an option — worth a look, not a match."
                            : undefined
                        }
                      />
                    </td>
                    <td className="table__meta">{m.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="sd-provenance">
        <div className="panel__head">
          <h2 className="panel__title" id="sd-provenance">
            Provenance
          </h2>
          <p className="panel__sub">
            A frozen record, never a form — nothing on this screen can edit any of it.
          </p>
        </div>
        <DetailList
          items={[
            { label: "Run id", value: <span className="mono">{candidate.provenance.run_id}</span> },
            { label: "Cluster key", value: <span className="mono">{candidate.provenance.cluster_key}</span> },
            { label: "Classifier rule", value: candidate.provenance.classifier_rule },
            { label: "Occupation heads", value: candidate.provenance.occupation_heads.join(", ") || "—" },
            { label: "Evidence tokens", value: candidate.provenance.evidence_tokens.join(", ") || "—" },
            { label: "Embedding note", value: EMBEDDING_STATUS_NOTE[candidate.provenance.embedding_status] },
            { label: "Corpus fingerprint", value: <span className="mono">{candidate.provenance.corpus_fingerprint}</span> },
            { label: "Provenance digest", value: <span className="mono">{candidate.provenance.provenance_digest}</span> },
          ]}
        />
      </section>

      <AuditTrailPanel audit={audit} />

      {terminal ? (
        <TerminalRecordPanel candidate={candidate} />
      ) : (
        <>
          {deferred && <HeldRecordPanel candidate={candidate} />}
          {mayDecide ? (
            <SkillDecisionPanel
              candidateId={candidate.id}
              expectedStatus={candidate.status}
              sourceJobDomainIds={sourceJobDomainIds}
              proposedSkillNameFromRun={candidate.proposed_skill_name}
            />
          ) : (
            <CapabilityDeniedNotice />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The decision history (#1280) — the immutable event spine, oldest first, plus the decision as
 * the row holds it right now.
 *
 * ── A SEPARATE, DEGRADABLE READ ─────────────────────────────────────────────────────────
 * `audit === null` means the audit fetch failed (network, 5xx) — never a candidate with no
 * history, which the spine still returns as an EMPTY `entries` array plus a `current` whose
 * fields are null. Those are two different, honest states and this panel renders them
 * differently rather than collapsing "nothing happened" and "we could not check" into one.
 *
 * ── ENTRIES AND `current` ARE SHOWN AS-IS, NEVER RECONCILED ────────────────────────────
 * If the two ever disagree, that disagreement IS the finding an auditor is looking for — this
 * panel does not attempt to explain or paper over a mismatch.
 */
function AuditTrailPanel({ audit }: { audit: SkillCandidateAudit | null }) {
  return (
    <section className="panel" aria-labelledby="sd-audit">
      <div className="panel__head">
        <h2 className="panel__title" id="sd-audit">
          Audit trail
        </h2>
        <p className="panel__sub">
          The immutable event spine, oldest first, plus the decision as this row holds it right
          now. Shown as-is — if the two ever disagree, that disagreement is the finding.
        </p>
      </div>
      {audit === null ? (
        <p className="field__help">
          The audit trail is unavailable right now — a fault on our side, not a decision problem.
        </p>
      ) : (
        <>
          {audit.entries.length === 0 ? (
            <p className="field__help">No recorded events yet.</p>
          ) : (
            <div className="tablewrap">
              <table className="table">
                <caption className="sr-only">Audit events, oldest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.entries.map((e) => (
                    <tr key={e.event_id}>
                      <td>
                        <time dateTime={e.occurred_at} title={formatTimestamp(e.occurred_at)}>
                          {formatRelative(e.occurred_at)}
                        </time>
                      </td>
                      <td className="table__meta">{auditActionLabel(e.action_code)}</td>
                      <td className="mono table__meta">{shortId(e.admin_id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <DetailList
            items={[
              {
                label: "Current status",
                value: (
                  <StatusPill
                    value={audit.current.status}
                    label={SKILL_CANDIDATE_STATUS_LABELS[audit.current.status]}
                    tone={SKILL_CANDIDATE_STATUS_TONE[audit.current.status]}
                  />
                ),
              },
              { label: "Reviewer", value: shortId(audit.current.reviewer_admin_id) },
              {
                label: "Reviewed",
                value: audit.current.reviewed_at ? (
                  <time
                    dateTime={audit.current.reviewed_at}
                    title={formatTimestamp(audit.current.reviewed_at)}
                  >
                    {formatRelative(audit.current.reviewed_at)}
                  </time>
                ) : (
                  "—"
                ),
              },
              { label: "Reason", value: audit.current.review_reason ?? "—" },
              {
                label: "Resulting skill",
                value: audit.current.resulting_skill_id ? (
                  <span className="mono">{audit.current.resulting_skill_id}</span>
                ) : (
                  "—"
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}

const EMBEDDING_STATUS_NOTE: Record<string, string> = {
  reused: "An existing embedding was reused for this pass.",
  needs_embedding: "This phrase still needs an embedding pass.",
  not_required: "No embedding was needed for this phrase — a purely lexical match.",
};

/** `approved_*` / `rejected` — never re-decided. A record, with no controls. */
function TerminalRecordPanel({ candidate }: { candidate: SkillDiscoveryDetail }) {
  const items: Array<{ label: string; value: ReactNode }> = [
    {
      label: "Recorded status",
      value: (
        <StatusPill
          value={candidate.status}
          label={SKILL_CANDIDATE_STATUS_LABELS[candidate.status]}
          tone={SKILL_CANDIDATE_STATUS_TONE[candidate.status]}
        />
      ),
    },
    { label: "Reviewer", value: candidate.reviewer_admin_id ?? "—" },
    {
      label: "Reviewed",
      value: candidate.reviewed_at ? (
        <time dateTime={candidate.reviewed_at} title={formatTimestamp(candidate.reviewed_at)}>
          {formatRelative(candidate.reviewed_at)}
        </time>
      ) : (
        "—"
      ),
    },
    { label: "Reason", value: candidate.review_reason ?? "—" },
    {
      label: "Resulting skill",
      value: candidate.resulting_skill_id ? (
        <span className="mono">{candidate.resulting_skill_id}</span>
      ) : candidate.status === "approved_create" ? (
        // NULL ON PURPOSE, and this is the feature: it stays null until the offline
        // corpus chain actually mints the skill and somebody backfills it — the honest
        // answer to "did this approval ever ship?".
        "not yet backfilled — the offline corpus chain has not minted it"
      ) : (
        // A rejection never resolves to anything; "not yet backfilled" would wrongly
        // imply one is still coming.
        "—"
      ),
    },
  ];

  // ── the SCOPE of a `create` approval (#1280) ─────────────────────────────────────────
  // `approved_job_domain_ids`/`approved_requirement` are only ever populated by a `create`
  // decision — every other terminal status leaves them empty/default, so showing them there
  // would render a scope that was never approved. A second reviewer re-opening a decided
  // candidate needs to see WHAT was approved, not only the verdict: a wrong trade produces a
  // skill on the wrong picker rather than an obviously broken one.
  if (candidate.status === "approved_create") {
    items.push(
      {
        label: "Approved trades",
        value:
          candidate.approved_job_domain_ids.length > 0 ? (
            <span className="mono">{candidate.approved_job_domain_ids.join(", ")}</span>
          ) : (
            "—"
          ),
      },
      {
        label: "Requirement",
        value: candidate.approved_requirement === "required" ? "Required" : "Preferred",
      },
    );
  }

  return (
    <section className="panel" aria-labelledby="sd-record">
      <div className="panel__head">
        <h2 className="panel__title" id="sd-record">
          Decision record
        </h2>
        <p className="panel__sub">
          This candidate is terminal — the decision below cannot be changed here. A
          re-decision needs a new candidate from a new run.
        </p>
      </div>
      <DetailList items={items} />
    </section>
  );
}

/** `deferred` — a human decision that is NOT terminal, and is re-openable. */
function HeldRecordPanel({ candidate }: { candidate: SkillDiscoveryDetail }) {
  return (
    <section className="notice notice--warn" role="status" aria-labelledby="sd-held">
      <h3 id="sd-held">On hold</h3>
      <p>
        Somebody looked at this candidate and could not decide — that is a real answer, and it
        stays re-openable. Previous reason: <em>{candidate.review_reason ?? "none recorded"}</em>
        {candidate.reviewed_at && (
          <>
            {" "}
            ({formatRelative(candidate.reviewed_at)}, {formatTimestamp(candidate.reviewed_at)})
          </>
        )}
        .
      </p>
    </section>
  );
}

/** An admin with `read_entities` but not `review_skill_candidates` — absent, not broken. */
function CapabilityDeniedNotice() {
  return (
    <section className="panel" aria-labelledby="sd-denied">
      <div className="panel__head">
        <h2 className="panel__title" id="sd-denied">
          Decision
        </h2>
      </div>
      <p className="field__help">
        Your role can read this candidate but not decide it — the five decision controls are
        not shown. Ask an ops admin or super admin to record a decision.
      </p>
    </section>
  );
}
