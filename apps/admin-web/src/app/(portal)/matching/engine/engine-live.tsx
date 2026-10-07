"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import {
  NO_DIFF,
  advanceLiveDiff,
  clockTime,
  engineHref,
  funnelBalances,
  funnelSteps,
  monthsLabel,
  roleKindLabel,
  skillSourceLabel,
  tierBadgeLabel,
  tierBadgeTone,
  withExiting,
  type EngineCard,
  type LiveDiff,
  type EngineFunnel,
  type EnginePosting,
  type EngineWorker,
} from "../../../../lib/match-engine-view";

/** The demo's refresh period: a skill edit on the phone shows up within one tick. */
export const ENGINE_POLL_MS = 3000;
/** How long an arrival / departure / changed number stays highlighted. */
const HIGHLIGHT_MS = 1800;
/**
 * An unattended projector must not poll (and keep the admin session warm) forever: after this
 * long live it pauses itself, and one press of Resume carries on.
 */
export const ENGINE_AUTO_PAUSE_MS = 30 * 60 * 1000;

/**
 * The LIVE half of the Engine view. It owns no data: every tick is a `router.refresh()`, which
 * re-renders the server page (session re-checked, API re-read) and hands new props down. What
 * this component adds is the presenter layer — the live indicator, pause, and the diff between
 * two consecutive answers so a change on the phone is visible on the projector.
 *
 * Polling stops while the tab is hidden (and refreshes at once on return) and while paused. Motion is CSS-only and keyed on
 * classes; under `prefers-reduced-motion` the tokens zero every duration and the keyframes are
 * dropped, so a change is shown as a static highlight instead of an animation.
 */
export function EngineLive({
  worker,
  posting,
  workerId,
}: {
  worker: EngineWorker | null;
  posting: EnginePosting | null;
  /** The worker the posting tab was opened from, so links keep the selection. */
  workerId?: string;
}) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const diff = useLiveDiff(worker);

  useEffect(() => {
    if (paused) return;
    let id: number | undefined;
    const start = () => {
      if (id !== undefined || document.visibilityState !== "visible") return;
      id = window.setInterval(() => router.refresh(), ENGINE_POLL_MS);
    };
    const stop = () => {
      window.clearInterval(id);
      id = undefined;
    };
    // Hidden tab: no polling at all. Back in view: refresh at once, then resume the cadence.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [paused, router]);

  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => setPaused(true), ENGINE_AUTO_PAUSE_MS);
    return () => window.clearTimeout(id);
  }, [paused]);

  const generatedAt = worker?.generated_at ?? posting?.generated_at ?? null;

  return (
    <section className="engine__live" aria-label="Live engine view">
      <div className="engine__status">
        <span
          className={paused ? "engine__dot engine__dot--paused" : "engine__dot"}
          aria-hidden="true"
        />
        {/* Only the mode is a live region; the clock would be re-announced on every poll. */}
        <span className="engine__status-text" role="status" aria-live="polite">
          {paused ? "Paused" : "Live"}
        </span>
        {generatedAt ? (
          <span className="engine__status-time">Updated {clockTime(generatedAt)}</span>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost engine__pause"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
        >
          <Icon name={paused ? "play" : "pause"} />
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {worker ? <WorkerPanels worker={worker} diff={diff} /> : null}
      {posting ? <PostingPanels posting={posting} workerId={workerId} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The diff between two polls
// ---------------------------------------------------------------------------

/**
 * The highlight state, DERIVED DURING RENDER from the previous props (React's "store information
 * from previous renders" pattern) so the first paint of a new answer already shows its arrivals
 * and its departing cards in place — no one-frame jump.
 *
 * The reset timer is keyed on the diff OBJECT, not on the props: a poll that changes nothing
 * keeps the same diff (see `advanceLiveDiff`), so it neither re-arms nor cancels the pending
 * reset, and a highlight can never get stuck however the refreshes are spaced.
 */
function useLiveDiff(worker: EngineWorker | null): LiveDiff {
  const [state, setState] = useState<{ prev: EngineWorker | null; diff: LiveDiff }>({
    prev: worker,
    diff: NO_DIFF,
  });

  let { diff } = state;
  if (state.prev !== worker) {
    diff = advanceLiveDiff(state.prev, worker, state.diff);
    setState({ prev: worker, diff });
  }

  useEffect(() => {
    if (diff === NO_DIFF) return;
    const id = window.setTimeout(
      () => setState((s) => (s.diff === diff ? { ...s, diff: NO_DIFF } : s)),
      HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(id);
  }, [diff]);

  return diff;
}

// ---------------------------------------------------------------------------
// Worker tab: skills · funnel · feed
// ---------------------------------------------------------------------------

function WorkerPanels({ worker, diff }: { worker: EngineWorker; diff: LiveDiff }) {
  return (
    <div className="engine__grid">
      <SkillsPanel worker={worker} />
      <FunnelPanel funnel={worker.funnel} changed={diff.changed} />
      <FeedPanel worker={worker} diff={diff} />
    </div>
  );
}

function SkillsPanel({ worker }: { worker: EngineWorker }) {
  return (
    <section className="engine__panel" aria-labelledby="engine-skills">
      <h2 id="engine-skills" className="engine__panel-title">
        Worker <span className="mono">{worker.short_ref}</span>
      </h2>
      {worker.skills.length === 0 ? (
        <p className="engine__empty">No skills on record.</p>
      ) : (
        <ul className="engine__skills">
          {worker.skills.map((s) => (
            <li
              key={s.skill_id}
              className={s.wants ? "engine__skill" : "engine__skill engine__skill--off"}
            >
              <span className="engine__skill-label">{s.label}</span>
              <span className="engine__skill-meta">
                <span className={s.wants ? "engine__switch engine__switch--on" : "engine__switch"}>
                  {s.wants ? "On" : "Off"}
                </span>
                <span>{monthsLabel(s.months_bucketed)}</span>
                <span>{skillSourceLabel(s.source)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FunnelPanel({
  funnel,
  changed,
}: {
  funnel: EngineFunnel;
  changed: Set<keyof EngineFunnel>;
}) {
  return (
    <section className="engine__panel engine__panel--funnel" aria-labelledby="engine-funnel">
      <h2 id="engine-funnel" className="engine__panel-title">
        Reach
      </h2>
      <ol className="engine__funnel">
        {funnelSteps(funnel).map((step) => (
          <li
            key={step.key}
            className={[
              "engine__step",
              `engine__step--${step.key}`,
              changed.has(step.key) ? "engine__step--changed" : "",
            ].join(" ")}
          >
            <span className="engine__step-value">{step.value}</span>
            <span className="engine__step-label">{step.label}</span>
            <span className="engine__step-blurb">{step.blurb}</span>
            <span className="engine__bar" aria-hidden="true">
              <span className="engine__bar-fill" style={{ width: `${step.share}%` }} />
            </span>
          </li>
        ))}
      </ol>
      <p className="engine__note">
        {funnel.already_actioned} already applied or skipped, so not on the feed.
      </p>
      {funnelBalances(funnel) ? null : (
        <p className="engine__warn" role="alert">
          These counts do not add up. Report it to the backend team.
        </p>
      )}
    </section>
  );
}

function FeedPanel({ worker, diff }: { worker: EngineWorker; diff: LiveDiff }) {
  const rows = withExiting(worker.cards, diff.exited);
  return (
    <section className="engine__panel" aria-labelledby="engine-feed">
      <h2 id="engine-feed" className="engine__panel-title">
        Feed, in order
      </h2>
      {rows.length === 0 ? (
        <p className="engine__empty">Nothing on this worker&apos;s feed right now.</p>
      ) : (
        <ol className="engine__cards">
          {rows.map(({ card, exiting }) => (
            <li
              key={`${card.job_posting_id}${exiting ? ":out" : ""}`}
              className={[
                "engine-card",
                exiting ? "engine-card--exiting" : "",
                diff.entered.has(card.job_posting_id) ? "engine-card--entered" : "",
              ].join(" ")}
              aria-hidden={exiting ? true : undefined}
              inert={exiting ? true : undefined}
            >
              <FeedCard card={card} workerId={worker.worker_id} />
            </li>
          ))}
        </ol>
      )}
      {worker.cards.length >= worker.card_cap ? (
        <p className="engine__note">At most {worker.card_cap} cards are shown.</p>
      ) : null}
    </section>
  );
}

function FeedCard({ card, workerId }: { card: EngineCard; workerId: string }) {
  return (
    <Link
      className="engine-card__link"
      href={engineHref({ worker: workerId, tab: "posting", posting: card.job_posting_id })}
    >
      <span className="engine-card__rank">{card.rank}</span>
      {/* TODO(role-art): swap this neutral tile for the per-role illustration once
          packages/role-art exists; keyed on `role_kind`. */}
      <span className="engine-card__art" data-role-kind={card.role_kind ?? undefined}>
        <Icon name="briefcase" size="lg" />
        <span className="sr-only">{roleKindLabel(card.role_kind)}</span>
      </span>
      <span className="engine-card__body">
        <span className="engine-card__title">{card.role_title}</span>
        <span className="engine-card__meta">
          <span className={`engine-tier engine-tier--${tierBadgeTone(card.match_tier)}`}>
            {tierBadgeLabel(card.match_tier)}
          </span>
          {card.boosted ? <span className="engine-tier engine-tier--boosted">Boosted</span> : null}
          {card.city ? <span>{card.city}</span> : null}
        </span>
        <span className="engine-card__why">{card.why}</span>
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Posting tab: skills by tier · reach · ranked candidates
// ---------------------------------------------------------------------------

function PostingPanels({ posting, workerId }: { posting: EnginePosting; workerId?: string }) {
  return (
    <div className="engine__grid engine__grid--posting">
      <section className="engine__panel" aria-labelledby="engine-posting-skills">
        <h2 id="engine-posting-skills" className="engine__panel-title">
          {posting.role_title}
        </h2>
        <p className="engine__note">{[posting.city, posting.status].filter(Boolean).join(" · ")}</p>
        <h3 className="engine__subhead">Posted skills (direct)</h3>
        <SkillChips skills={posting.posted_skills} tone="direct" />
        <h3 className="engine__subhead">Related skills</h3>
        <SkillChips skills={posting.related_skills} tone="related" />
      </section>

      <section
        className="engine__panel engine__panel--funnel"
        aria-labelledby="engine-posting-reach"
      >
        <h2 id="engine-posting-reach" className="engine__panel-title">
          Reach
        </h2>
        <ol className="engine__funnel">
          <ReachStep
            label="Workers reached"
            value={posting.reach.total}
            total={posting.reach.total}
          />
          <ReachStep label="Direct" value={posting.reach.tier1} total={posting.reach.total} />
          <ReachStep label="Related" value={posting.reach.tier2} total={posting.reach.total} />
        </ol>
        <p className="engine__note">
          A related-skill applicant ranks with direct ones after {posting.tier_floor_months} months
          on that skill.
        </p>
      </section>

      <section
        className="engine__panel engine__panel--candidates"
        aria-labelledby="engine-candidates"
      >
        <h2 id="engine-candidates" className="engine__panel-title">
          Ranked applicants
        </h2>
        {posting.candidates.length === 0 ? (
          <p className="engine__empty">No applicants yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="table engine__table">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Worker</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Ranked as</th>
                  <th scope="col">Skill months</th>
                  <th scope="col">Industry months</th>
                  <th scope="col">Last worked</th>
                </tr>
              </thead>
              <tbody>
                {posting.candidates.map((c) => (
                  <tr key={c.application_id}>
                    <th scope="row">{c.rank}</th>
                    <td>
                      <Link className="mono" href={engineHref({ worker: c.worker_id })}>
                        {c.short_ref}
                      </Link>
                    </td>
                    <td>{tierBadgeLabel(c.match_tier)}</td>
                    <td>{tierBadgeLabel(c.effective_tier)}</td>
                    <td>{c.skill_months ?? "—"}</td>
                    <td>{c.industry_months ?? "—"}</td>
                    <td>{c.last_worked_at ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {workerId ? (
          <Link className="btn btn--ghost engine__back" href={engineHref({ worker: workerId })}>
            <Icon name="arrow-left" />
            Back to the worker
          </Link>
        ) : null}
      </section>
    </div>
  );
}

function SkillChips({
  skills,
  tone,
}: {
  skills: EnginePosting["posted_skills"];
  tone: "direct" | "related";
}) {
  if (skills.length === 0) return <p className="engine__empty">None.</p>;
  return (
    <ul className="engine__chips">
      {skills.map((s) => (
        <li key={s.skill_id} className={`engine-tier engine-tier--${tone}`}>
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function ReachStep({ label, value, total }: { label: string; value: number; total: number }) {
  const share = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <li className="engine__step">
      <span className="engine__step-value">{value}</span>
      <span className="engine__step-label">{label}</span>
      <span className="engine__bar" aria-hidden="true">
        <span className="engine__bar-fill" style={{ width: `${share}%` }} />
      </span>
    </li>
  );
}
