"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Chip } from "../../../../components/ds";
import type { MatchSkillWire, ReachPreview } from "../../../../lib/contracts";
import { previewReachAction } from "./match-actions";

/**
 * Matching V1 — the posting form's SKILL half (ADR-0036, spec Part 2).
 *
 * Three things happen here, and they are the whole of how a company controls who sees
 * its job:
 *
 *  1. It picks up to `max_skills_per_posting` skills from a CLOSED vocabulary. No free
 *     text: a typed skill cannot match anything, because a worker's side of the join is
 *     closed too.
 *  2. Each posted skill brings its curated RELATED skills in PRE-TICKED (ruling #4).
 *     Unticking is how a company narrows; there is no control that widens past the
 *     curated relations, because Policy 10 gives breadth to the company only WITHIN
 *     them.
 *  3. A LIVE reach count updates on every change, so the trade-off is visible before
 *     any money moves (E13).
 *
 * THE CLIENT NEVER COMPUTES REACH. Every number on this screen came from
 * `POST /payer/match/reach-preview`; there is no local estimate and no cached count
 * that could drift from what publishing would actually do. The server resolves the
 * final reach set again at publish from the same inputs, so what is shown and what is
 * stored cannot disagree.
 *
 * PII-free: closed-set ids, checked-in labels, integer counts. No worker is named,
 * listed, or made identifiable by any count here — a reach of 1 is a number, not a
 * person.
 */

export interface MatchSelection {
  matchSkillIds: string[];
  untickedRelatedIds: string[];
}

/** Until the first preview returns, fall back to the ratified V1 cap. */
const FALLBACK_MAX_SKILLS = 3;

export function MatchSkillPicker({
  vocabulary,
  selection,
  onChange,
  onPreviewChange,
}: {
  vocabulary: MatchSkillWire[];
  selection: MatchSelection;
  onChange: (next: MatchSelection) => void;
  /** Lifted so the submit button can refuse a zero-reach publish (E13). */
  onPreviewChange?: (preview: ReachPreview | null) => void;
}) {
  const [preview, setPreview] = useState<ReachPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Monotonic request id: previews are fired per interaction and a slow earlier one
  // must never overwrite a fast later one. Without this the counter can settle on the
  // reach of a selection the payer has already changed — which is precisely the number
  // they would then decide on.
  const latest = useRef(0);

  const maxSkills = preview?.max_skills_per_posting ?? FALLBACK_MAX_SKILLS;
  const atCap = selection.matchSkillIds.length >= maxSkills;

  const key = `${selection.matchSkillIds.join(",")}|${selection.untickedRelatedIds.join(",")}`;
  useEffect(() => {
    if (selection.matchSkillIds.length === 0) {
      setPreview(null);
      setError(null);
      onPreviewChange?.(null);
      return;
    }
    const id = ++latest.current;
    setLoading(true);
    void previewReachAction({
      matchSkillIds: selection.matchSkillIds,
      untickedRelatedIds: selection.untickedRelatedIds,
    }).then((res) => {
      if (id !== latest.current) return; // a newer selection already won
      setLoading(false);
      if (res.ok) {
        setPreview(res.preview);
        setError(null);
        onPreviewChange?.(res.preview);
      } else {
        // Keep the LAST good preview on screen rather than blanking to nothing: a
        // transient failure should not look like "this posting reaches no one".
        setError(res.error);
        onPreviewChange?.(null);
      }
    });
    // `key` is the SERIALIZED selection, deliberately, and it is the only dependency:
    // the effect must re-run when the selection CHANGES, not every time the parent
    // re-renders and hands down fresh array identities for the same choice — that would
    // fire a preview request per keystroke in the unrelated demand fields above.
  }, [key]);

  function togglePosted(skillId: string) {
    const has = selection.matchSkillIds.includes(skillId);
    if (!has && atCap) return;
    const matchSkillIds = has
      ? selection.matchSkillIds.filter((s) => s !== skillId)
      : [...selection.matchSkillIds, skillId];
    // Drop unticks that no longer name a suggested skill. The server ignores them
    // anyway (`resolveReachSet` honours an untick only for a SUGGESTED related skill),
    // but carrying them would mean re-adding a skill silently restored a related one
    // the payer had explicitly turned off.
    const stillSuggested = new Set(
      matchSkillIds.flatMap(
        (id) => vocabulary.find((v) => v.skill_id === id)?.related_skill_ids ?? [],
      ),
    );
    onChange({
      matchSkillIds,
      untickedRelatedIds: selection.untickedRelatedIds.filter((u) => stillSuggested.has(u)),
    });
  }

  function toggleRelated(skillId: string) {
    const unticked = selection.untickedRelatedIds.includes(skillId);
    onChange({
      matchSkillIds: selection.matchSkillIds,
      untickedRelatedIds: unticked
        ? selection.untickedRelatedIds.filter((s) => s !== skillId)
        : [...selection.untickedRelatedIds, skillId],
    });
  }

  return (
    // A titled bordered block = the UI-1 `.panel`. `.match-picker` moves onto the body as the
    // column that spaces the chip rows, the reach strip and the zero-reach alert.
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Which skill are you hiring for?</h2>
        <p className="panel__sub">
          Pick up to {maxSkills}. Only workers who have one of these — or a closely
          related skill you keep ticked — will see this job.
        </p>
      </div>

      <div className="panel__body">
        <div className="match-picker">
          <div className="match-picker__vocab" role="group" aria-label="Match skills">
            {vocabulary.map((v) => {
              const selected = selection.matchSkillIds.includes(v.skill_id);
              return (
                <Chip
                  key={v.skill_id}
                  selected={selected}
                  disabled={!selected && atCap}
                  onClick={() => togglePosted(v.skill_id)}
                >
                  {v.label}
                </Chip>
              );
            })}
          </div>

          {selection.matchSkillIds.length === 0 ? (
            // Nothing picked ⇒ there is no reach to report yet. Say that, rather than
            // leaving the counter strip blank and letting it read as "reaches nobody".
            <div className="state">
              <span className="state__icon">
                <i className="ph ph-crosshair" aria-hidden="true" />
              </span>
              <h3 className="state__title">No skill picked yet</h3>
              <p className="state__body">
                Pick a skill to see how many workers this job would reach.
              </p>
            </div>
          ) : null}

          {preview?.skills.map((s) =>
            s.related.length === 0 ? null : (
              <div key={s.skill_id} className="match-picker__related">
                <p className="match-picker__related-label">
                  Also show to workers with these, near <strong>{s.label}</strong>:
                </p>
                <div role="group" aria-label={`Related to ${s.label}`}>
                  {s.related.map((r) => (
                    <Chip
                      key={r.skill_id}
                      selected={r.ticked}
                      onClick={() => toggleRelated(r.skill_id)}
                    >
                      {r.label} · +{r.reach_count}
                    </Chip>
                  ))}
                </div>
              </div>
            ),
          )}

          <div className="match-picker__reach" aria-live="polite">
            {preview ? (
              <>
                <Badge tone={preview.zero_reach ? "warning" : "brand"}>
                  Reaches <span className="bb-mono">{preview.reach_total}</span>{" "}
                  {preview.reach_total === 1 ? "worker" : "workers"}
                </Badge>
                <span className="match-picker__tier1">
                  <span className="bb-mono">{preview.reach_tier1}</span> have the exact skill
                </span>
              </>
            ) : null}
            {loading ? <span className="match-picker__loading">Checking reach…</span> : null}
            {/* A transient preview failure keeps the LAST good count on screen (see the
                effect above), so this stays an inline line beside it — promoting it to a
                full error state would imply the number above had gone away. */}
            {error ? <p className="match-picker__error">{error}</p> : null}
          </div>

          {/*
            E13 — the zero-reach interstitial. It does NOT block the payer: they may know
            supply is coming, and refusing outright would be us overriding their judgement.
            It blocks the SURPRISE. The submit control reads the same preview and downgrades
            its label, so nobody pays for a posting into a void without having been told.
          */}
          {preview?.zero_reach ? (
            <div className="alert alert--warning" role="alert">
              <i className="ph ph-warning alert__icon" aria-hidden="true" />
              <div className="alert__text">
                <p className="alert__title">No worker matches this yet</p>
                <p className="alert__body">
                  Nobody on BadaBhai currently has these skills, so this posting will not
                  appear in anyone&apos;s feed. Try ticking more related skills above, or pick
                  a broader skill. You can still post — we will show it as soon as a matching
                  worker joins.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
