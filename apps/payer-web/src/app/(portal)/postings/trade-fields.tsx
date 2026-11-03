"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@badabhai/icons";
import { Badge, Chip } from "../../../components/ds";
import type {
  MatchSkillWire,
  PostingTradeFormWire,
  PostingTradeQuestionWire,
  ReachPreview,
} from "../../../lib/contracts";
import { previewReachAction } from "./new/match-actions";

/**
 * THE TRADE-SPECIFIC POSTING FORM (migration 0141, owner ruling 2026-11-03).
 *
 * WHAT THIS REPLACES. The manual posting form used to ask for a role title and then a flat
 * list of every match skill in the vocabulary. The CEO launch pack says a vacancy states the
 * same facts the worker's trade interview asks (machine, controller, operations, materials,
 * programming depth, inspection work …), with two different jobs:
 *
 *   - a MATCH chip adds an `mskill_*`, so it changes who the posting reaches;
 *   - a FACET chip changes nobody's reach. It is the posting's requirement, and the
 *     employer's candidate list can lead with candidates who match it (same set, same
 *     count — see `docs/reference/...Spec A8`).
 *
 * The base trade skill is ALWAYS in the match set, even with every chip unticked: a
 * "CNC Turner" vacancy must reach turners. The rung is DISPLAY-ONLY (`trade_level`) and
 * never enters the match set.
 *
 * NO LOCAL REACH ARITHMETIC. Every count comes from `POST /payer/match/reach-preview`,
 * exactly as the old MatchSkillPicker did; this component only decides which ids to send.
 * That keeps the preview and the publish resolving from the same server rule.
 */
export interface TradeFormValue {
  tradeLevel: string;
  answers: Record<string, string[]>;
}

/** Until the first preview returns, fall back to the ratified V1 cap (same as the picker). */
const FALLBACK_MAX_SKILLS = 3;

export function TradePostingFields({
  trades,
  roleKind,
  value,
  onChange,
  onMatchSkillIdsChange,
  onPreviewChange,
  vocabulary,
}: {
  trades: readonly PostingTradeFormWire[];
  roleKind: string;
  value: TradeFormValue;
  onChange: (next: TradeFormValue) => void;
  /** Lifted because the publish button and the rail need the same derived match set. */
  onMatchSkillIdsChange: (ids: string[]) => void;
  onPreviewChange?: (preview: ReachPreview | null) => void;
  vocabulary: readonly MatchSkillWire[];
}) {
  const trade = trades.find((t) => t.role_kind === roleKind);
  const [preview, setPreview] = useState<ReachPreview | null>(null);
  // The live `match_config.max_skills_per_posting`, learned from the preview. The derived
  // set (base + match chips) is what the server caps; without this guard a 4th match chip
  // would only fail at publish. Fallback matches the legacy picker's ratified V1 cap.
  const [maxSkills, setMaxSkills] = useState(FALLBACK_MAX_SKILLS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const matchSkillIds = trade ? derivedMatchSkills(trade, value.answers) : [];
  const matchKey = matchSkillIds.join(",");

  useEffect(() => {
    if (matchSkillIds.length === 0) {
      setPreview(null);
      setError(null);
      onPreviewChange?.(null);
      return;
    }
    const id = ++latest.current;
    setLoading(true);
    void previewReachAction({
      matchSkillIds,
      untickedRelatedIds: [],
    }).then((res) => {
      if (id !== latest.current) return;
      setLoading(false);
      if (res.ok) {
        setPreview(res.preview);
        setMaxSkills(res.preview.max_skills_per_posting);
        setError(null);
        onPreviewChange?.(res.preview);
      } else {
        setError(res.error);
        onPreviewChange?.(null);
      }
    });
    // `matchKey` is the serialized derived set — the effect must re-run when the SELECTION
    // changes, not when the parent re-renders with fresh array identities.
  }, [matchKey]);

  function commit(next: TradeFormValue) {
    onChange(next);
    onMatchSkillIdsChange(trade ? derivedMatchSkills(trade, next.answers) : []);
  }

  function toggleRung(rung: string) {
    commit({ ...value, tradeLevel: value.tradeLevel === rung ? "" : rung });
  }

  function toggleOption(question: PostingTradeQuestionWire, optionKey: string) {
    const current = value.answers[question.question_key] ?? [];
    let next: string[];
    if (question.answer_type === "single_select") {
      next = current.includes(optionKey) ? [] : [optionKey];
    } else {
      next = current.includes(optionKey)
        ? current.filter((key) => key !== optionKey)
        : [...current, optionKey];
    }
    const answers = { ...value.answers };
    if (next.length === 0) delete answers[question.question_key];
    else answers[question.question_key] = next;
    // The server posts at most `maxSkills` skills (base + match chips). Refuse the tap that
    // would exceed it here, with the reason, rather than letting publish return a 400.
    if (trade && derivedMatchSkills(trade, answers).length > maxSkills) {
      setError(
        `Pick up to ${maxSkills} match skills — the rest are requirements and do not change reach.`,
      );
      return;
    }
    setError(null);
    commit({ ...value, answers });
  }

  if (!trade) {
    return (
      <section className="panel">
        <div className="panel__head">
          <div className="panel__text">
            <h2 className="panel__title">Trade requirements</h2>
            <p className="panel__sub">
              Pick a role above and the fields that role is hired on appear here.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const labels = matchSkillIds
    .map((id) => vocabulary.find((skill) => skill.skill_id === id)?.label ?? id)
    .join(", ");

  return (
    <section className="panel">
      <div className="panel__head">
        <div className="panel__text">
          <h2 className="panel__title">Trade requirements</h2>
          <p className="panel__sub">
            The facts this trade is hired on. Chips marked <strong>Match</strong> also decide who
            sees the posting; the rest are requirements your candidate list can lead with.
          </p>
        </div>
      </div>

      <div className="panel__body trade-fields">
        <fieldset className="trade-fields__group">
          <legend className="trade-fields__legend">Rung</legend>
          <p className="trade-fields__hint">
            Display only — the worker reads it as the role&rsquo;s level. It does not change who the
            posting reaches.
          </p>
          <div className="trade-fields__chips" role="group" aria-label="Rung">
            {trade.ladder.map((rung) => (
              <Chip
                key={rung.rung}
                selected={value.tradeLevel === rung.rung}
                onClick={() => toggleRung(rung.rung)}
              >
                {humaniseRung(rung.rung)}
              </Chip>
            ))}
          </div>
        </fieldset>

        {trade.questions.map((question) => (
          <fieldset key={question.question_key} className="trade-fields__group">
            <legend className="trade-fields__legend">{question.prompt}</legend>
            <div className="trade-fields__chips" role="group" aria-label={question.prompt}>
              {question.options.map((option) => {
                const selected = (value.answers[question.question_key] ?? []).includes(
                  option.option_key,
                );
                return (
                  <Chip
                    key={option.option_key}
                    selected={selected}
                    onClick={() => toggleOption(question, option.option_key)}
                    title={option.match ? "Also sets a match skill" : undefined}
                  >
                    {option.label}
                    {option.match ? (
                      <span className="trade-fields__match" aria-hidden="true">
                        {" "}
                        · Match
                      </span>
                    ) : null}
                  </Chip>
                );
              })}
            </div>
          </fieldset>
        ))}

        <div className="trade-fields__summary" aria-live="polite">
          <p className="trade-fields__summary-line">
            <strong>Matched as:</strong> {labels}
            <span className="trade-fields__cap">
              {" "}
              ({matchSkillIds.length}/{maxSkills})
            </span>
          </p>
          {preview ? (
            <Badge tone={preview.zero_reach ? "warning" : "brand"}>
              Reaches <span className="bb-mono">{preview.reach_total}</span>{" "}
              {preview.reach_total === 1 ? "worker" : "workers"}
            </Badge>
          ) : null}
          {loading ? <span className="trade-fields__loading">Checking reach…</span> : null}
          {error ? <p className="trade-fields__error">{error}</p> : null}
        </div>

        {preview?.zero_reach ? (
          <div className="alert alert--warning" role="alert">
            <Icon name="warning" className="alert__icon" />
            <div className="alert__text">
              <p className="alert__title">No worker matches this yet</p>
              <p className="alert__body">
                Nobody on BadaBhai currently has these skills. You can still post — workers who join
                later will see it.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The base skill plus every selected match chip, de-duplicated. */
export function derivedMatchSkills(
  trade: PostingTradeFormWire,
  answers: Record<string, string[]>,
): string[] {
  const out = new Set<string>([trade.match_skill_id]);
  for (const question of trade.questions) {
    const selected = answers[question.question_key] ?? [];
    for (const option of question.options) {
      if (!selected.includes(option.option_key)) continue;
      for (const id of option.match_skill_ids) out.add(id);
    }
  }
  return [...out];
}

/** `setter_programmer` → `Setter Programmer`; the wire key is a closed slug, never prose. */
function humaniseRung(rung: string): string {
  return rung
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
