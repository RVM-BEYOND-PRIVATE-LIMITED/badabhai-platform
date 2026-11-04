import type { AiCostSummary } from "../lib/dashboard";
import {
  basisInline,
  capBreachReasonLabel,
  describeAiCostBasis,
  describeAiCostCaveat,
  describeCapBreachScope,
  describeCostPerProfile,
  isPlatformWideBreach,
  providerLabel,
  providerNote,
  taskTypeLabel,
} from "../lib/ai-cost";
import { formatCount, formatDisplayRupees, formatExactRupees } from "../lib/format";
import { Timestamp } from "./timestamp";
import { Stat } from "./stat";
import { InfoPopover } from "./info-popover";
import { AboutData } from "./about-data";

/**
 * Platform AI spend — total, by provider, by task type, and the cap breaches in the window.
 *
 * PRESENTATIONAL ONLY. Every sentence it can say comes from `lib/ai-cost.ts`, and every ₹ from
 * `formatExactRupees`; nothing is decided here. That split is what makes the three honesty
 * rules below unit-testable without a DOM.
 *
 * ══ THE THREE RULES THIS PANEL EXISTS TO HOLD ═══════════════════════════════════════════
 *
 *  1. NO ₹ FIGURE IS EVER SHOWN WITHOUT ITS BASIS. `platform_ai_cost_totals` starts empty at
 *     migration 0077 and accrues forward with no backfill, so `is_lifetime_total` is `false`
 *     and `accruing_since` is the date every number here is "since". The date is in the STAT
 *     LABEL, not in a caption two elements away, so the figure cannot be read, screenshotted
 *     or quoted apart from what it measures.
 *
 *  2. `accruing_since === null` RENDERS NO ₹ AT ALL. Nothing has ever been recorded, so a
 *     "₹0.00" tile would state "we measured the platform and it spent nothing" — the strongest
 *     possible claim, and one nobody made. The ₹ tiles are replaced by a statement of absence.
 *
 *     ⚠ THAT RULE STOPS AT THE ₹ FIGURES. `cap_breaches` IS A DIFFERENT DATA SOURCE: the API
 *     counts `ai.spend_cap_exceeded` over the EVENT SPINE in a rolling window, not out of
 *     `platform_ai_cost_totals`, so `accruing_since: null` says nothing at all about whether a
 *     cap was breached. Two reachable states have both at once — a breach window reaching back
 *     past migration 0077 (the totals table starts empty there and was never backfilled), and
 *     the documented accrual-failure path in `ai-cost-recorder.service.ts` where the events
 *     commit while the savepointed `accrue()` fails and the totals trail the spine. Gating the
 *     breach block on the ₹ basis dropped `kill_switch_engaged` and `cumulative_cap_exceeded` —
 *     the most operationally urgent numbers on this page — behind "Nothing has accrued yet".
 *     So the breach tile and the breach block render on their OWN data, always.
 *
 *  3. `unknown` IS A PROVIDER ROW LIKE ANY OTHER. Every rupee that accrued before the
 *     ai-service learned the Sarvam model families is filed there permanently (a running sum is
 *     never backfilled). Dropping the row would understate the platform total by exactly that
 *     amount; folding it into "Sarvam" would move money between buckets after the fact and
 *     relabel every genuinely unrecognised model id. It renders, with its explanation attached.
 *
 * The provider and task-type sets are OPEN. A label this build has never seen renders
 * de-snaked with a note saying so, rather than being dropped or crashing the section.
 *
 * ══ THE COST-PER-PROFILE BLOCK ══════════════════════════════════════════════════════════
 * A ratio is two claims, and its shape hides both of them. Its numerator is the PROFILING
 * slice of spend (résumé generation is rendered from a profile that already exists and is not
 * billed to producing one) and its denominator is the profiles that FINISHED inside the very
 * same window — so the figure means "what it costs to produce one finished profile, including
 * everyone who started and did not finish", and NOT "what it costs to profile one worker".
 * Nothing on screen can tell those two readings apart, so the block leads with the distinction
 * and puts the window in both tile labels.
 *
 * THAT WINDOW IS THE BLOCK'S OWN, AND IT IS NOT THE SECTION'S. `per_profile.since` is the first
 * PROFILING accrual; `accruing_since` at the top of the section is the first accrual of any
 * kind, and it is earlier whenever something that is not profiling was paid for first. Both of
 * this block's tiles are dated from the former, and `describeCostPerProfile` returns `absent`
 * for the nothing-accrued state — which is what keeps rule 2 above absolute here too, and what
 * stops a ₹0.00 average from rendering on a platform whose only spend so far is résumés.
 *
 * ══ ONE BASIS, STATED ONCE (A2, #2572) ═══════════════════════════════════════════════════
 * Rule 1 used to be held by repeating "since <date>" in every ₹ label and in a yellow banner —
 * three copies of one fact, which read as alarm. The basis is now ONE chip at the head of the
 * section ("Since 19 Aug 2026 ⓘ") that every figure below sits under, with the detail behind
 * its ⓘ. The per-profile block carries its own chip ONLY when its bound differs from the
 * section's, so a figure is still never shown under a window it does not have. The real-call
 * share is a neutral fact, not a permanent warning. Spend on deleted accounts (#2554) is its
 * own figure.
 *
 * ══ LESS TEXT (A3, #2573) ═══════════════════════════════════════════════════════════════
 * The panel carried ~350 words of caveats in band. The CLAIMS stay on screen — the basis
 * headline in its warn banner, the date in every ₹ label, the per-profile basis headline, the
 * breach scope beside its count, and any self-contradiction warning — while the explanations
 * behind them sit one click away: the basis detail behind the banner's ⓘ, the per-profile
 * mechanics and the real-vs-test totals in that block's "About this data".
 */
export function AiSpendPanel({ cost }: { cost: AiCostSummary }) {
  const basis = describeAiCostBasis(cost);
  const measured = basis.kind !== "nothing_accrued";
  const breaches = cost.cap_breaches;
  const perProfile = cost.per_profile;
  const perProfileState = describeCostPerProfile(cost);
  const testSplit = perProfileState.kind === "measured" ? perProfileState.view.testSplit : null;
  const sectionWindow = basisInline(basis.headline);
  // The per-profile block shares the section's chip unless its own bound differs (rule 5 in
  // `describeCostPerProfile`): then it carries its own, so no figure sits under the wrong one.
  const perProfileOwnWindow =
    perProfileState.kind === "measured" && perProfileState.view.windowLabel !== sectionWindow
      ? perProfileState.view.windowLabel
      : null;

  return (
    <section className="panel" aria-labelledby="ai-spend-heading">
      <div className="panel__head">
        <h2 className="panel__title" id="ai-spend-heading">
          AI spend
        </h2>
        <p className="panel__sub">
          What the platform has paid providers, split by who was called and what for.
        </p>
      </div>

      {/* THE BASIS, ONCE (#2572): one chip above every figure in the section, never
          collapsible, with its explanation one click away behind the ⓘ. */}
      <div className="spend-basis" role="note">
        <span className="spend-basis__chip">{basis.headline}</span>
        <InfoPopover label="About this spend basis">
          <p>
            {basis.detail} {describeAiCostCaveat(cost.caveat)}
          </p>
        </InfoPopover>
      </div>

      {measured ? null : (
        <div className="state">
          <h3 className="state__title">Nothing has accrued yet</h3>
          <p className="state__body">{basis.detail}</p>
        </div>
      )}

      <div className="stats">
        {measured ? (
          <>
            <Stat
              /* Under the section chip above — "Spend recorded", not "Total AI spend". */
              label="Spend recorded"
              value={formatDisplayRupees(cost.total_cost_inr)}
              valueTitle={formatExactRupees(cost.total_cost_inr)}
              countUp={{ to: Number(cost.total_cost_inr), kind: "rupees" }}
              wide
            />
            <Stat
              /* NEUTRAL, not a warning (#2572). The share of calls that reached a real
                 provider is a fact about the posture; the rest were mocked. A dependency that
                 is actually simulated is announced once, in Needs attention. */
              label="Real-provider calls"
              value={realCallsText(cost.real_calls, cost.total_calls)}
            />
          </>
        ) : null}
        {/* OUTSIDE `measured` — see rule 2. This count is off the event spine, so it stands
            whether or not the cost table has ever been written to. */}
        <Stat
          label={`Cap breaches (last ${breaches.window_days} days)`}
          value={formatCount(breaches.total)}
          countUp={{ to: breaches.total, kind: "count" }}
          tone={breaches.total > 0 ? "warn" : undefined}
        />
      </div>

      {/* ── WHAT A FINISHED PROFILE COSTS ────────────────────────────────────────────────
          Sits directly ABOVE "By task type" on purpose: the numerator is some of that
          table's rows, the caption names exactly which, and an operator WILL try to add
          them up. Three states, and `describeCostPerProfile` decides which — `absent`
          renders nothing at all (no profiling spend has accrued, so there is no window and
          no ratio), `unsupported` renders the version-skew sentence and no ₹ anywhere, and
          only `measured` renders figures. */}
      {perProfileState.kind === "unsupported" ? (
        <div>
          <h3 className="panel__title" id="ai-spend-per-profile">
            What a finished profile costs
          </h3>
          {/* NOT SILENTLY DROPPED. An absent block is pixel-identical to "no profiling
              spend has accrued", which would be a false claim about a spending platform. */}
          <p className="notice notice--warn" role="note">
            {perProfileState.sentence}
          </p>
        </div>
      ) : null}

      {perProfileState.kind === "measured" && perProfile ? (
        <div>
          <h3 className="panel__title" id="ai-spend-per-profile">
            What a finished profile costs
          </h3>
          {perProfileOwnWindow ? (
            <div className="spend-basis" role="note">
              <span className="spend-basis__chip">{basisHeadline(perProfileOwnWindow)}</span>
            </div>
          ) : null}
          {/* THE BASIS RIDES ABOVE THE FIGURES, exactly as it does for the section total —
              and here it is doing more work, because "cost per profile" and "cost per
              worker" are both plausible readings of the same tile and only one is true. */}
          <p className="panel__sub">
            <strong>{perProfileState.view.basisHeadline}.</strong>
          </p>

          <div className="stats stats--compact">
            {/* Numerator, denominator, quotient — in that order, so the arithmetic the
                caption describes is the arithmetic on screen. BOTH dated labels come from
                the one `windowLabel`, which is derived from this block's own bound and
                never from the section's; see rule 5 in `describeCostPerProfile`. */}
            <Stat
              label="Profiling spend"
              value={formatDisplayRupees(perProfile.profiling_cost_inr)}
              valueTitle={formatExactRupees(perProfile.profiling_cost_inr)}
              countUp={{ to: Number(perProfile.profiling_cost_inr), kind: "rupees" }}
              wide
            />
            <Stat
              label="Profiles completed"
              value={formatCount(perProfile.profiles_extracted_or_confirmed)}
              countUp={{ to: perProfile.profiles_extracted_or_confirmed, kind: "count" }}
            />
            <Stat
              label="Average per profile produced"
              /* `averageText` is either an exact ₹ amount or the ABSENCE, and `absent`
                 stops the second from being set in the KPI face like the first. */
              value={perProfileState.view.averageText}
              valueTitle={perProfileState.view.averageExactText ?? undefined}
              absent={perProfileState.view.averageIsAbsent}
              wide
            />
            {/* THE HEADLINE ABOVE STAYS BLENDED. These two legs sit BESIDE it and never
                replace it: the headline is the platform's answer for the period, while the
                real leg is the investor-facing number and the test leg explains the gap.
                Each leg averages over its OWN denominator, exactly as the API computes it. */}
            {testSplit?.kind === "measured" ? (
              <>
                <Stat
                  label="Real accounts — average per profile"
                  value={testSplit.real.averageText}
                  valueTitle={testSplit.real.averageExactText ?? undefined}
                  absent={testSplit.real.averageIsAbsent}
                  wide
                />
                <Stat
                  label="Test accounts — average per profile"
                  value={testSplit.test.averageText}
                  valueTitle={testSplit.test.averageExactText ?? undefined}
                  absent={testSplit.test.averageIsAbsent}
                  wide
                />
                {/* #2554: deleted and worker-less spend is its own figure, never folded into
                    the real leg — an older API sends none, and then no tile renders. */}
                {testSplit.deleted ? (
                  <Stat
                    label="Spend on deleted accounts"
                    value={testSplit.deleted.spendText}
                    valueTitle={testSplit.deleted.spendExactText}
                    wide
                  />
                ) : null}
              </>
            ) : null}
          </div>

          {/* Not a clean split: an older API sent none, and the sentence says so in band. */}
          {testSplit?.kind === "unsupported" ? (
            <p className="notice notice--warn" role="note">
              {testSplit.sentence}
            </p>
          ) : null}

          {/* Only reachable if the server contradicts itself about the bound, or sends one that
              will not parse. In band and bolded, because the ratio above it is then not a ratio
              of anything. */}
          {perProfileState.view.windowMismatchSentence ? (
            <p className="notice notice--warn" role="note">
              <strong>{perProfileState.view.windowMismatchSentence}</strong>
            </p>
          ) : null}

          {/* The mechanics behind the figures (#2573): the basis detail, the legs' numerators
              and denominators (so each average is auditable) with the convergence caveat, and
              the scope, window, erasure and posture sentences. */}
          <AboutData title="How this is computed">
            <p>{perProfileState.view.basisDetail}</p>
            {testSplit?.kind === "measured" ? (
              <p>
                <strong>Real vs test.</strong> Real accounts recorded {testSplit.real.spendText}{" "}
                over {formatCount(testSplit.real.profiles)} profiles (
                {formatCount(testSplit.real.calls)} calls); test accounts recorded{" "}
                {testSplit.test.spendText} over {formatCount(testSplit.test.profiles)} profiles (
                {formatCount(testSplit.test.calls)} calls)
                {testSplit.deleted ? (
                  <>
                    ; deleted accounts and worker-less calls recorded {testSplit.deleted.spendText}{" "}
                    over {formatCount(testSplit.deleted.profiles)} profiles (
                    {formatCount(testSplit.deleted.calls)} calls)
                  </>
                ) : null}
                . {testSplit.caveatSentence} The headline average above stays blended across
                every leg.
              </p>
            ) : null}
            <p>
              {perProfileState.view.scopeSentence} {perProfileState.view.completedSentence}{" "}
              {perProfileState.view.windowSentence} {perProfileState.view.erasureSentence}
              {perProfileState.view.sectionBoundSentence ? (
                <> {perProfileState.view.sectionBoundSentence}</>
              ) : null}
              {perProfileState.view.averageAbsentSentence ? (
                <> {perProfileState.view.averageAbsentSentence}</>
              ) : null}
              {perProfileState.view.mockPostureSentence ? (
                <> {perProfileState.view.mockPostureSentence}</>
              ) : null}
            </p>
          </AboutData>
        </div>
      ) : null}

      {measured ? (
        <div className="cols">
          <div>
            <h3 className="panel__title" id="ai-spend-provider">
              By provider
            </h3>
            <p className="panel__sub">
              The raw stored label, biggest spender first. No remapping is applied.
            </p>
            {cost.by_provider.length === 0 ? (
              <p className="empty">No provider has recorded a call yet.</p>
            ) : (
              <ul className="funnel" aria-labelledby="ai-spend-provider">
                {cost.by_provider.map((p) => {
                  const note = providerNote(p.provider);
                  return (
                    <li className="funnel__row" key={p.provider}>
                      <span className="funnel__label">
                        {providerLabel(p.provider)}
                        {note ? (
                          <>
                            <br />
                            <span className="funnel__events">{note}</span>
                          </>
                        ) : null}
                      </span>
                      <span className="funnel__nums">
                        <span
                          className="funnel__distinct"
                          title={formatExactRupees(p.total_cost_inr)}
                        >
                          {formatDisplayRupees(p.total_cost_inr)}
                        </span>
                        <span className="funnel__events">
                          {formatCount(p.call_count)} calls · {formatCount(p.real_call_count)} real
                          · since <Timestamp iso={p.first_recorded_at} dateOnly />
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <h3 className="panel__title" id="ai-spend-task">
              By task type
            </h3>
            <p className="panel__sub">
              The other half of the cost table&rsquo;s key — and what makes the &ldquo;unknown
              provider&rdquo; row readable.
            </p>
            {cost.by_task_type.length === 0 ? (
              <p className="empty">No task type has recorded a call yet.</p>
            ) : (
              <ul className="funnel" aria-labelledby="ai-spend-task">
                {cost.by_task_type.map((t) => (
                  <li className="funnel__row" key={t.task_type}>
                    <span className="funnel__label">{taskTypeLabel(t.task_type)}</span>
                    <span className="funnel__nums">
                      <span
                        className="funnel__distinct"
                        title={formatExactRupees(t.total_cost_inr)}
                      >
                        {formatDisplayRupees(t.total_cost_inr)}
                      </span>
                      <span className="funnel__events">
                        {formatCount(t.call_count)} calls · {formatCount(t.real_call_count)} real
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {/* NOT GATED ON `measured` — see rule 2. Its numbers come off the event spine, so an
          empty cost table cannot suppress them, and the scope sentence the API put in band
          ships with the count either way. */}
      <div>
        <h3 className="panel__title" id="ai-spend-breaches">
          Spend-cap breaches
        </h3>
        {/* THE SCOPE SHIPS WITH THE NUMBER, always — a bare `0` reads as "no surface
            anywhere hit a cap", and exactly one surface emits this event today. */}
        <p className="panel__sub">{describeCapBreachScope(breaches.scope)}</p>
        {breaches.by_reason.length === 0 ? (
          <p className="empty">
            No spend cap tripped in profile extraction over the last {breaches.window_days} days.
            Other AI surfaces are not covered by this count.
          </p>
        ) : (
          <ul className="funnel" aria-labelledby="ai-spend-breaches">
            {breaches.by_reason.map((r) => (
              <li className="funnel__row" key={r.reason}>
                <span className="funnel__label">{capBreachReasonLabel(r.reason)}</span>
                <span className="funnel__nums">
                  <span className="funnel__distinct">{formatCount(r.count)}</span>
                  <span className="funnel__events">
                    {isPlatformWideBreach(r.reason)
                      ? "platform-wide — provider calls stopped"
                      : "per worker — self-limiting"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** "Since 19 Aug 2026" from the inline form the view carries ("since 19 Aug 2026"). */
function basisHeadline(inline: string): string {
  return inline.charAt(0).toUpperCase() + inline.slice(1);
}

/**
 * "5,602 / 6,187 (91%)". The share is FLOORED, so a posture with even one mocked call never
 * reads 100%. No calls at all is "0 / 0" — a percentage of nothing is not a figure.
 */
export function realCallsText(real: number, total: number): string {
  const base = `${formatCount(real)} / ${formatCount(total)}`;
  return total > 0 ? `${base} (${Math.floor((real / total) * 100)}%)` : base;
}
