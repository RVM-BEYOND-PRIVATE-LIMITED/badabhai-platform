import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../../lib/auth";
import { can } from "../../../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import {
  getSkillCandidateAudit,
  getSkillDiscoveryCandidate,
  type SkillCandidateAudit,
  type SkillDiscoveryDetail,
} from "../../../../../lib/skill-discovery";
import {
  ADMIN_SKILL_REVIEW_TIER_LABELS,
  SKILL_APPROVED_DOMAINS_NOTE,
  SKILL_AUDIT_CAP_NOTE,
  SKILL_AUDIT_MAX_ENTRIES,
  SKILL_AUDIT_SPINE_NOTE,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_SOURCE_TYPE_LABELS,
  SKILL_CANDIDATE_STATUS_LABELS,
  SKILL_CANDIDATE_STATUS_TONE,
  SKILL_PROVENANCE_RUN_NOTE,
  auditActionLabel,
  basisMarkerLabel,
  isTerminalSkillStatus,
  relationLabel,
  requirementLabel,
} from "../../../../../lib/skill-discovery-vocabulary";
import { formatRelative, formatTimestamp } from "../../../../../lib/format";
import { StatusPill } from "../../../../../components/status-pill";
import { DetailList } from "../../../../../components/detail-list";
import { SkillDecisionPanel } from "./decision-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skill Candidate" };

/**
 * One skill candidate, in full — the review screen (#1260).
 *
 * ── TWO REQUESTS, NO N+1 ────────────────────────────────────────────────────────────────
 * The candidate first, then its audit trail — and in that order rather than concurrently, so a
 * candidate that does not exist 404s without a second read being spent on it. Everything else on
 * this page arrives on the candidate response: sources, related skills, provenance and the
 * decision record. Nothing issues a read per source or per match.
 *
 * ── WHAT NEVER APPEARS HERE — AND WHAT WAS WRONGLY BEING HIDDEN ─────────────────────────
 * The rule this screen enforces is *no similarity measurement*: no cosine figure, no vector, no
 * number a reviewer could turn into an approval floor. The wire has no `score` key by
 * construction, this file renders none, and the contract-parity test fails if either side grows
 * one.
 *
 * `provenance.model` and `provenance.prompt_version` used to be dropped as well, under a blanket
 * reading of that rule which the pre-merge audit found to be stricter than the contract (#1280,
 * correction 5). They are configuration facts about the RUN, both inside the frozen 19-field
 * digest, and neither ranks or gates anything — while omitting them left a reviewer reading nine
 * of eleven fields under a heading that says "frozen record". They render now, under
 * `SKILL_PROVENANCE_RUN_NOTE`, which says what they are and what they are not.
 *
 * `embedding_status` is rendered as a sentence rather than the raw enum, for the reason it always
 * was: it states a provenance FACT ("this phrase needed no embedding") and measures nothing.
 */
export default async function SkillDiscoveryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("read_entities");
  const { id } = await params;

  let candidate: SkillDiscoveryDetail;
  try {
    candidate = await getSkillDiscoveryCandidate(id);
  } catch (err) {
    // 404 (unknown id) and 400 (not a uuid) both read as "no such candidate" from the
    // operator's point of view — a malformed id pasted from a chat log lands on not-found.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  /*
   * THE AUDIT TRAIL IS A SECOND, INDEPENDENT READ, and its failure must not take the review
   * screen with it. The decision controls, the evidence and the sources are all still usable
   * without it; blanking the page because a history panel could not load would cost a reviewer
   * the thing they came for. So it is settled separately and its absence renders as an absence.
   *
   * It is fetched AFTER the candidate rather than beside it because a 404 on the candidate is a
   * not-found for the whole screen — there is no point asking for the history of a row that does
   * not exist.
   */
  const auditRes = await Promise.allSettled([getSkillCandidateAudit(id)]);
  const audit = auditRes[0].status === "fulfilled" ? auditRes[0].value : null;

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
                <li
                  className="chip"
                  key={`${s.source_type}:${s.source_id}`}
                  title={SKILL_CANDIDATE_SOURCE_TYPE_LABELS[s.source_type]}
                >
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
            Every competing match this candidate has against the shipped catalogue — never just the
            best one. Never a similarity score: a relation, a strength, and a sentence.
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
          <p className="field__help">{SKILL_PROVENANCE_RUN_NOTE}</p>
        </div>
        <DetailList
          items={[
            { label: "Run id", value: <span className="mono">{candidate.provenance.run_id}</span> },
            {
              label: "Cluster key",
              value: <span className="mono">{candidate.provenance.cluster_key}</span>,
            },
            { label: "Classifier rule", value: candidate.provenance.classifier_rule },
            {
              label: "Occupation heads",
              value: candidate.provenance.occupation_heads.join(", ") || "—",
            },
            {
              label: "Evidence tokens",
              value: candidate.provenance.evidence_tokens.join(", ") || "—",
            },
            {
              label: "Embedding note",
              value: EMBEDDING_STATUS_NOTE[candidate.provenance.embedding_status],
            },
            /*
             * MODEL AND PROMPT VERSION ARE SHOWN, AND THE SCORE STILL IS NOT.
             *
             * This screen used to drop both, under a blanket "no model name in the UI" rule that
             * was stricter than the contract and cost real auditability: the two fields are inside
             * the frozen provenance digest, so hiding them left a reviewer reading nine of eleven
             * fields under a heading that says "frozen record".
             *
             * The rule that actually protects the decision is *no similarity measurement* — no
             * cosine figure, no vector, no number a reviewer converts into an approval floor. That
             * one is unchanged and is enforced by construction: the wire type has no `score` key,
             * this file never renders one, and the contract-parity test fails if either side grows
             * one. A configuration string ranks nothing (#1280, correction 5).
             */
            { label: "Model", value: candidate.provenance.model ?? "—" },
            { label: "Prompt version", value: candidate.provenance.prompt_version ?? "—" },
            {
              label: "Corpus fingerprint",
              value: <span className="mono">{candidate.provenance.corpus_fingerprint}</span>,
            },
            {
              label: "Provenance digest",
              value: <span className="mono">{candidate.provenance.provenance_digest}</span>,
            },
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
 * WHAT HAS HAPPENED TO THIS CANDIDATE — read from `GET /admin/skill-discovery/:id/audit`.
 *
 * ── BOTH HALVES, BECAUSE EITHER ALONE MISLEADS ─────────────────────────────────────────
 * `entries` is the EVENT SPINE: immutable, written on the same transaction as the decision, and
 * value-free by construction — who acted, what was recorded, when. `current` is the row as the
 * system of record holds it now. An auditor needs to see them agree, and on the day they do not,
 * that disagreement is the finding. A panel showing only one half could never surface it.
 *
 * ── IT IS NOT ASSEMBLED HERE ───────────────────────────────────────────────────────────
 * This screen used to have no audit route and could only narrate the candidate's own columns. It
 * does not any more: the order, the entries and the `current` block are rendered as served, and
 * nothing is inferred from timestamps or statuses to fill a gap.
 *
 * ── AND ITS ABSENCE IS AN ABSENCE ──────────────────────────────────────────────────────
 * A failed audit read renders as "could not be loaded", never as "nothing has happened". Those
 * are opposite claims, and on an audit surface the wrong one is the more dangerous.
 */
function AuditTrailPanel({ audit }: { audit: SkillCandidateAudit | null }) {
  return (
    <section className="panel" aria-labelledby="sd-audit">
      <div className="panel__head">
        <h2 className="panel__title" id="sd-audit">
          Audit trail
        </h2>
        <p className="panel__sub">{SKILL_AUDIT_SPINE_NOTE}</p>
      </div>

      {audit === null ? (
        <p className="state__body">
          The audit trail could not be loaded. That is a failed read, not an empty history — this
          panel makes no claim about what has or has not happened to this candidate.
        </p>
      ) : (
        <>
          {audit.entries.length === 0 ? (
            <p className="state__body">
              No decision has been recorded against this candidate yet. The spine has nothing to
              show because nothing has happened, which is different from a read that failed.
            </p>
          ) : (
            <>
              <ol className="chain">
                {audit.entries.map((e) => (
                  <li className="chain__item" key={e.event_id}>
                    <strong>{auditActionLabel(e.action_code)}</strong>
                    {" by "}
                    {/* An OPAQUE id. This console resolves no admin names anywhere on this surface. */}
                    <span className="mono">{e.admin_id ?? "—"}</span>
                    <span className="chain__time" title={formatTimestamp(e.occurred_at)}>
                      {formatRelative(e.occurred_at)}
                    </span>
                  </li>
                ))}
              </ol>
              {/*
               * THE CAP, DECLARED ONLY WHEN IT IS ACTUALLY REACHED.
               *
               * The audit read is `LIMIT 200` and carries no truncation flag, so a candidate with
               * 201 events and one with exactly 200 arrive identical. Below the cap nothing was
               * dropped and a warning would be noise; AT the cap this panel cannot tell the two
               * apart, and on an audit surface the only honest move is to stop claiming
               * completeness (#1280, correction 6).
               *
               * There is deliberately no "load the rest" control beside it. No route serves one,
               * and an affordance that cannot work is worse than the plain sentence.
               */}
              {audit.entries.length >= SKILL_AUDIT_MAX_ENTRIES && (
                <p className="field__help">{SKILL_AUDIT_CAP_NOTE}</p>
              )}
            </>
          )}

          <h3 className="panel__title">The record as it stands now</h3>
          <DetailList
            items={[
              {
                label: "Status",
                value: (
                  <StatusPill
                    value={audit.current.status}
                    label={SKILL_CANDIDATE_STATUS_LABELS[audit.current.status]}
                    tone={SKILL_CANDIDATE_STATUS_TONE[audit.current.status]}
                  />
                ),
              },
              { label: "Reviewer", value: audit.current.reviewer_admin_id ?? "—" },
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
              {
                label: "Trades named by the reviewer",
                value:
                  audit.current.approved_job_domain_ids.length > 0 ? (
                    <ul className="chips">
                      {audit.current.approved_job_domain_ids.map((d) => (
                        <li className="chip mono" key={d}>
                          {d}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    // Empty on every undecided row and on every decision that is not a create —
                    // an em dash, never "none", which would read as a reviewer having chosen none.
                    "—"
                  ),
              },
              {
                label: "How those trades need it",
                value:
                  audit.current.approved_job_domain_ids.length > 0
                    ? requirementLabel(audit.current.approved_requirement)
                    : "—",
              },
            ]}
          />
          {audit.current.approved_job_domain_ids.length > 0 ? (
            <p className="field__help">{SKILL_APPROVED_DOMAINS_NOTE}</p>
          ) : null}
          {/*
           * `corpus_effect`, rendered rather than merely parsed (#1280, correction 3). It is the
           * response's own statement that none of the entries above changed the taxonomy — the
           * thing a reader of a months-old "Approved as a new skill" entry most needs and is least
           * likely to assume.
           */}
          <p className="field__help">{basisMarkerLabel(audit.corpus_effect)}</p>
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
  return (
    <section className="panel" aria-labelledby="sd-record">
      <div className="panel__head">
        <h2 className="panel__title" id="sd-record">
          Decision record
        </h2>
        <p className="panel__sub">
          This candidate is terminal — the decision below cannot be changed here. A re-decision
          needs a new candidate from a new run.
        </p>
      </div>
      <DetailList
        items={[
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
          /*
           * THE REVIEWER'S OWN TRADE JUDGEMENT, shown beside the decision it belongs to.
           *
           * It is the half of a `create` approval nothing downstream can reconstruct, and until
           * the detail read started serving it this record was only half auditable: the screen
           * could say a skill had been approved but not which trades the human said it belonged
           * to. Empty renders as an em dash rather than "none" — every non-create decision has an
           * empty list, and "none" would read as a reviewer having deliberately chosen none.
           */
          {
            label: "Trades named by the reviewer",
            value:
              candidate.approved_job_domain_ids.length > 0 ? (
                <ul className="chips">
                  {candidate.approved_job_domain_ids.map((d) => (
                    <li className="chip mono" key={d}>
                      {d}
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              ),
          },
          {
            label: "How those trades need it",
            value:
              candidate.approved_job_domain_ids.length > 0
                ? requirementLabel(candidate.approved_requirement)
                : "—",
          },
        ]}
      />
      {candidate.approved_job_domain_ids.length > 0 ? (
        <p className="field__help">{SKILL_APPROVED_DOMAINS_NOTE}</p>
      ) : null}
    </section>
  );
}

/** `deferred` — a human decision that is NOT terminal, and is re-openable. */
function HeldRecordPanel({ candidate }: { candidate: SkillDiscoveryDetail }) {
  return (
    <section className="notice notice--warn" role="status" aria-labelledby="sd-held">
      <h3 id="sd-held">On hold</h3>
      <p>
        Somebody looked at this candidate and could not decide — that is a real answer, and it stays
        re-openable. Previous reason: <em>{candidate.review_reason ?? "none recorded"}</em>
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
        Your role can read this candidate but not decide it — the five decision controls are not
        shown. Ask an ops admin or super admin to record a decision.
      </p>
    </section>
  );
}
