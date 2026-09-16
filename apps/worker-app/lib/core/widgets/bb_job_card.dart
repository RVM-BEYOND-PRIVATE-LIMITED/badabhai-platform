import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/onboarding_theme.dart';
import 'bb_tag.dart';
import 'kit/kit_callout.dart';
import 'kit/kit_info_chip.dart';
import 'kit/kit_salary_box.dart';

/// Immutable contents of a [BbJobCard] — the worker-facing job summary the feed
/// renders. Pure data, no behaviour.
class BbJobCardData {
  const BbJobCardData({
    required this.title,
    this.company,
    this.verified = false,
    this.payBand,
    required this.place,
    this.trade,
    this.shift,
    this.tags = const <String>[],
    this.spotsLeft,
    this.matchNote,
    this.hot = false,
    this.metaRight,
  });

  final String title;

  /// Employer name — NULL on the real feed. Employer names are PII (CLAUDE.md
  /// §2) and `GET /feed` deliberately does not return one. Optional (and unset
  /// in production) because an earlier build invented a company name per card
  /// from `jobId.hashCode` and rendered it as fact.
  final String? company;

  /// Pay band — the card's salary. NULL when no source supplies it (the salary
  /// row is then omitted, never invented).
  final String? payBand;

  final String place;

  /// The job's humanized TRADE / matched skill, when a screen has one.
  ///
  /// Its OWN line, never folded into [place]: the applied-jobs row used to
  /// print 'CNC Operator · Pimpri, Pune' behind the location pin, so the pin
  /// labelled a trade on some cards and a place on others depending on whether
  /// the trade key could be humanized at all. A pin labels a place.
  ///
  /// Already humanized by the caller — never a raw `trade_key` or `mskill_*`
  /// id, and null (the row is dropped) when no label exists.
  final String? trade;

  /// Shift — retained on the model; not rendered on the compact list card.
  final String? shift;

  /// Only ever shown for a REAL employer; never a badge on an invented name.
  final bool verified;

  /// Requirement tags — retained on the model; not rendered on the compact list
  /// card (the job-detail screen renders them).
  final List<String> tags;

  /// Remaining spots — retained on the model; surface it via [metaRight] if a
  /// screen wants it on the card.
  final int? spotsLeft;

  /// Matching V1 / E18 (ADR-0036): WHY this job is in the worker's feed, when
  /// the reason is not simply "you have this skill".
  ///
  /// Shown only for a RELATED match, because that is the case a man would
  /// otherwise find confusing — a lathe job appearing for someone who listed
  /// VMC work reads as a mistake unless we say why. An exact match needs no
  /// explanation, so it gets none rather than a line of noise on every card.
  ///
  /// NULL is the honest default: on the legacy feed, and whenever the server
  /// did not name the matched skill, the card says nothing instead of guessing.
  final String? matchNote;

  /// Featured / urgent: draws the 4px safety-yellow left rail and a [BbHotTag].
  /// EARNED, never uniform — set only for a genuinely featured posting.
  final bool hot;

  /// Muted right-hand meta on the salary row, shown when [BbJobCard.onApply] is
  /// not wired (e.g. "General shift", "Sirf 4 seat baaki"). When null the card
  /// falls back to [shift] for this slot (the kit uses the meta slot for shift).
  final String? metaRight;

  /// The value the card shows in its right-hand meta slot: an explicit
  /// [metaRight] wins, otherwise [shift].
  String? get effectiveMetaRight => metaRight ?? shift;
}

/// TalkBack label for the title button. Hinglish, matching the app voice and the
/// `Semantics(button: true, label: ...)` pattern the voice screen already ships.
const String kJobCardTitleSemanticLabel = 'Job kholein — poori jaankari';

/// TalkBack label for the APPLY action.
const String kJobCardApplySemanticLabel = 'Apply karein';

/// Which layout a [BbJobCard] renders.
///
/// The SAME data and the SAME semantics labels, arranged for two genuinely
/// different jobs — so the deck stops borrowing a row built for a list.
///
///  - [list] — the compact vertical-feed row (unchanged, the default).
///  - [deck] — the swipe card: it OWNS a full screen, so the facts a worker
///    decides on (pay, shift) get real size instead of list-row type, and the
///    card fills its space rather than floating at the top of an empty one.
enum BbJobCardLayout { list, deck }

/// The job card (UI kit v3 §4 card): white paper, a 1px
/// [OnboardingColors.borderDefault] hairline, radius 16, elevation 0. A
/// featured/urgent posting ([BbJobCardData.hot]) earns a 4px safety-yellow LEFT
/// RAIL and a [BbHotTag]; nothing else does.
///
/// Layout: title, then "company · location" behind a pin (with an optional
/// verified tick), then a bottom row of the salary (Roboto Mono green, `/mah`
/// muted) on the left and either a green Anek `APPLY →` action ([onApply]) or a
/// muted [BbJobCardData.metaRight] on the right. Designed for a VERTICAL LIST
/// feed.
///
/// **The card carries NO horizontal margin.** Its parent owns the gutter — the
/// feed list and the search results pad their scroll view with
/// [KitInsets.list] (so the scrollbar stays at the screen edge and the content
/// column caps on a tablet), and the deck pads its own column. The card used to
/// carry a built-in side margin, which meant two sources of inset and a deck
/// card that rendered narrower than the same card in the list.
///
/// Pass [onTitleTap] to make the title open the job detail (an accessible ≥48px
/// button, #362); pass [onApply] to wire the APPLY action.
class BbJobCard extends StatelessWidget {
  const BbJobCard({
    super.key,
    required this.data,
    this.onTitleTap,
    this.onApply,
    this.layout = BbJobCardLayout.list,
    this.compact = false,
  });

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  /// Which arrangement to render — see [BbJobCardLayout]. Defaults to the
  /// list row, so every existing call site is untouched.
  final BbJobCardLayout layout;

  /// Fired by the green `APPLY →` action. When null the action is not rendered
  /// (the salary row shows [BbJobCardData.metaRight] instead, if present).
  final VoidCallback? onApply;

  /// DECK ONLY: the card has less than ~300dp of height to fill (a 320x568
  /// handset, or any phone in landscape). The title drops to two lines, the
  /// match note to two, and the vertical rhythm tightens — so a short screen
  /// shows a whole card instead of a clipped one. Nothing is faked and nothing
  /// scrolls: a scroll view inside the deck would steal the #374 vertical
  /// follow-drag.
  final bool compact;

  bool get _hasSalaryRow =>
      data.payBand != null ||
      onApply != null ||
      data.effectiveMetaRight != null;

  @override
  Widget build(BuildContext context) {
    final bool isDeck = layout == BbJobCardLayout.deck;
    final BorderRadius radius = BorderRadius.circular(OnboardingRadii.card);
    return Container(
      // The deck card is sized by its Stack; the list row owns the gap to the
      // next card. Neither carries a side margin (see the class doc).
      margin: isDeck ? EdgeInsets.zero : const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: radius,
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: ClipRRect(
        borderRadius: radius,
        child: DecoratedBox(
          // Yellow left rail on featured/urgent cards ONLY — earned, never
          // uniform.
          decoration: BoxDecoration(
            border: data.hot
                ? const Border(
                    left: BorderSide(
                      color: OnboardingColors.safetyYellow,
                      width: 4,
                    ),
                  )
                : null,
          ),
          child: Padding(
            padding: EdgeInsets.all(isDeck ? 20 : 16),
            child: isDeck
                ? _DeckBody(
                    data: data,
                    onTitleTap: onTitleTap,
                    compact: compact,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      _HeaderRow(data: data, onTitleTap: onTitleTap),
                      // E18 — the "why am I seeing this" line, only for a
                      // related match.
                      if (data.matchNote != null) ...<Widget>[
                        const SizedBox(height: 10),
                        _MatchNote(text: data.matchNote!),
                      ],
                      if (_hasSalaryRow) ...<Widget>[
                        const SizedBox(height: 10),
                        _SalaryRow(data: data, onApply: onApply),
                      ],
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

/// Title (left, flexes) + optional [BbHotTag] (right).
class _HeaderRow extends StatelessWidget {
  const _HeaderRow({required this.data, required this.onTitleTap});

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // #362 — in a swipe deck this title is the ONLY route to the job
              // detail (the pan recognizer claims the rest of the card), so it
              // must be a real ≥48px button, not a bare tap on a text line.
              // Static cards (no callback) keep a plain, non-interactive title.
              if (onTitleTap == null)
                _titleText(data.title)
              else
                _TitleButton(onTap: onTitleTap!, title: _titleText(data.title)),
              if (data.trade != null && data.trade!.isNotEmpty) ...<Widget>[
                const SizedBox(height: 2),
                Text(
                  data.trade!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.inter(
                    size: 12,
                    weight: FontWeight.w600,
                    color: OnboardingColors.ink600,
                  ),
                ),
              ],
              const SizedBox(height: 2),
              _SubtitleRow(data: data),
            ],
          ),
        ),
        if (data.hot) ...<Widget>[const SizedBox(width: 8), const BbHotTag()],
      ],
    );
  }

  /// Spec §1.2 `subheadBold` — Anek 16 w700. A compact list row reads in the
  /// display voice at heading weight, not the deck card's 22.
  Text _titleText(String title) => Text(
    title,
    maxLines: 2,
    overflow: TextOverflow.ellipsis,
    style: OnboardingTypography.anek(
      size: 16,
      weight: FontWeight.w700,
      height: 1.25,
    ),
  );
}

/// "company · location" behind a pin, with an optional verified tick. On the
/// real feed [BbJobCardData.company] is null, so only the location shows.
class _SubtitleRow extends StatelessWidget {
  const _SubtitleRow({required this.data});

  final BbJobCardData data;

  @override
  Widget build(BuildContext context) {
    final String line = data.company == null
        ? data.place
        : '${data.company} · ${data.place}';
    return Row(
      children: <Widget>[
        const Icon(
          Icons.place_outlined,
          size: 14,
          color: OnboardingColors.ink500,
        ),
        const SizedBox(width: 5),
        Flexible(
          child: Text(
            line,
            overflow: TextOverflow.ellipsis,
            style: OnboardingTypography.bodyMuted(),
          ),
        ),
        if (data.verified) ...<Widget>[
          const SizedBox(width: 3),
          const Icon(
            Icons.verified,
            size: 14,
            color: OnboardingColors.shiftBlue,
          ),
        ],
      ],
    );
  }
}

/// Salary (mono green + muted `/mah`) on the left; the green `APPLY →` action or
/// a muted meta line on the right.
///
/// **It WRAPS instead of overflowing.** A pay figure and an APPLY action fit one
/// 390dp line at 100% font; on a 320dp handset at a 2.0 system font they do not,
/// and neither is a thing to ellipsise — the figure is the job's headline fact
/// and "APPLY" is the conversion. So the two sit side by side while there is
/// room and the action drops to its own line when there is not. It used to be a
/// `Row` with a non-flexible right-hand child, which painted overflow stripes
/// across the card at 2.0 (and across the applied-jobs list at 1.5, where the
/// right-hand child is the "Applied · N din pehle" line).
class _SalaryRow extends StatelessWidget {
  const _SalaryRow({required this.data, required this.onApply});

  final BbJobCardData data;
  final VoidCallback? onApply;

  /// Salary — a mono figure plus a muted "/mah". TWO Texts (not a rich span) so
  /// the bare pay string stays selectable/findable and the baseline aligns.
  Widget _pay(String band) => Row(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.baseline,
    textBaseline: TextBaseline.alphabetic,
    children: <Widget>[
      Flexible(
        child: Text(
          band,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: OnboardingTypography.mono(
            size: 15,
            weight: FontWeight.w700,
            color: OnboardingColors.successGreen,
          ),
        ),
      ),
      Text(
        ' /mah',
        style: OnboardingTypography.inter(
          size: 11,
          color: OnboardingColors.ink500,
        ),
      ),
    ],
  );

  /// The muted right-hand meta ("General shift", "Applied · 2 din pehle"). It
  /// WRAPS: inside a [Wrap] it is handed a bounded width, so a long label runs
  /// to a second line rather than off the card.
  Widget _meta(String text) => Text(
    text,
    style: OnboardingTypography.inter(
      size: 11,
      weight: FontWeight.w600,
      color: OnboardingColors.ink500,
    ),
  );

  @override
  Widget build(BuildContext context) {
    final String? band = data.payBand;
    final String? meta = data.effectiveMetaRight;
    final Widget? left = band == null ? null : _pay(band);
    final Widget? right = onApply != null
        ? _ApplyAction(onApply: onApply!)
        : (meta == null ? null : _meta(meta));

    // One side only: keep it on the edge it belongs to (the pay figure reads
    // left, the action reads right) rather than letting a Wrap pull it inward.
    if (left == null || right == null) {
      final Widget? only = left ?? right;
      if (only == null) return const SizedBox.shrink();
      return Align(
        alignment: left == null ? Alignment.centerRight : Alignment.centerLeft,
        child: only,
      );
    }

    // `width: double.infinity` so `spaceBetween` has a container to push the
    // two ends of: a Wrap in a start-aligned Column sizes to its content, and
    // the two children would sit shoulder to shoulder in the middle.
    return SizedBox(
      width: double.infinity,
      child: Wrap(
        spacing: 10,
        runSpacing: 6,
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: <Widget>[left, right],
      ),
    );
  }
}

/// Green Anek `APPLY →` — the kit's card-level apply action, wrapped in a
/// transparent [Material] so its ripple is visible over the opaque card fill.
///
/// NOT the yellow hero CTA: a screen has exactly one of those, and a yellow
/// button on every card in a list would be ten heroes shouting at once.
class _ApplyAction extends StatelessWidget {
  const _ApplyAction({required this.onApply});

  final VoidCallback onApply;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: kJobCardApplySemanticLabel,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: const Key('jobCardApplyButton'),
          onTap: onApply,
          borderRadius: BorderRadius.circular(OnboardingRadii.chip),
          // ≥48px hit target — the primary conversion action must clear the
          // worker tap floor, same as _TitleButton. Center keeps the label
          // where it was while the hit area grows.
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: OnboardingLayout.tapTarget,
            ),
            child: Center(
              widthFactor: 1,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        'APPLY',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.anek(
                          size: 14,
                          weight: FontWeight.w800,
                          color: OnboardingColors.successGreen,
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    const Icon(
                      Icons.arrow_forward_rounded,
                      size: 16,
                      color: OnboardingColors.successGreen,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The job title as a proper button (#362): a ≥48px hit target, a visible
/// ripple, a chevron so a low-literacy worker can SEE it opens something, and a
/// button role + Hinglish label for TalkBack.
class _TitleButton extends StatelessWidget {
  const _TitleButton({required this.onTap, required this.title});

  final VoidCallback onTap;
  final Widget title;

  @override
  Widget build(BuildContext context) {
    // MergeSemantics collapses the title Text + this annotation into ONE node,
    // so TalkBack reads "<job title>, job kholein — poori jaankari, button" as a
    // single focusable button. Without it the Text keeps its own node and the
    // label is dropped, which is exactly the "announced as plain text" defect.
    return MergeSemantics(
      child: Semantics(
        button: true,
        label: kJobCardTitleSemanticLabel,
        child: Material(
          // The card is a plain DecoratedBox with an OPAQUE white fill, so
          // without a local transparent Material the ink would splash on the
          // Scaffold underneath the card and never be seen.
          type: MaterialType.transparency,
          child: InkWell(
            key: const Key('jobCardTitleButton'),
            onTap: onTap,
            borderRadius: BorderRadius.circular(OnboardingRadii.chip),
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: OnboardingLayout.tapTarget,
              ),
              child: Row(
                children: <Widget>[
                  Expanded(child: title),
                  const SizedBox(width: 8),
                  const Icon(
                    Icons.chevron_right_rounded,
                    size: 22,
                    color: OnboardingColors.shiftBlue,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// E18's "why am I seeing this" line in the spec §4 informational callout, so it
/// reads as an explanation rather than another job fact.
class _MatchNote extends StatelessWidget {
  const _MatchNote({required this.text, this.maxLines});

  final String text;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    return KitCallout(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(
            Icons.info_outline,
            size: 16,
            color: OnboardingColors.shiftBlue,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              maxLines: maxLines,
              overflow: maxLines == null ? null : TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 12,
                weight: FontWeight.w600,
                height: 1.4,
                color: OnboardingColors.infoText,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── The DECK layout ─────────────────────────────────────────────────────────
//
// Same data, same semantics labels, arranged for a card that owns a screen.
//
// WHY IT IS NOT THE LIST ROW. The deck used to render the list row verbatim,
// so a card with a whole screen to fill showed a 15px title and a 16px pay
// figure crammed into the top ~120px with dead space beneath — the layout read
// as unfinished because it WAS a row, stretched. Here the two facts a worker
// actually decides on (pay, shift) get real size in their own panel, and the
// card fills its box instead of floating at the top of an empty one.
//
// NO SHADOW, and that is not an oversight: this system separates surfaces with
// hairline borders and flat fills only (spec §4 — every elevation is 0). Depth
// here comes from a tint panel and a border, never an elevation.

/// The swipe card's body: title, place, the money box, the shift chip and the
/// match note.
class _DeckBody extends StatelessWidget {
  const _DeckBody({
    required this.data,
    required this.onTitleTap,
    required this.compact,
  });

  final BbJobCardData data;
  final VoidCallback? onTitleTap;
  final bool compact;

  /// Anek display, big enough to be the card's anchor — the list row's 16px
  /// title is a row heading, not a card heading.
  Text _title() => Text(
    data.title,
    maxLines: compact ? 2 : 3,
    overflow: TextOverflow.ellipsis,
    style: OnboardingTypography.anek(
      size: 22,
      weight: FontWeight.w800,
      height: 1.2,
    ),
  );

  @override
  Widget build(BuildContext context) {
    // On a short screen the card's box is smaller than the drawing needs even
    // after [compact] has tightened it — a landscape phone leaves it about
    // 190dp. The narrative is then laid out at its NATURAL height and the
    // surplus clipped from its bottom, while the money block keeps its space.
    //
    // An ancestor `ClipRect` alone does NOT do this: a `RenderFlex` reports its
    // overflow wherever it is clipped, so the deck's ClipRect hid the stripes on
    // a device and still threw on every short screen in the matrix. Deliberately
    // not a scroll view: a Scrollable here would claim the vertical drag the
    // #374 follow-and-snap-back gesture owns.
    final String? meta = data.effectiveMetaRight;
    final String? pay = data.payBand;
    final bool hasFacts = pay != null || meta != null;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints box) {
        if (!box.maxHeight.isFinite) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _narrative(),
              if (hasFacts) ...<Widget>[
                SizedBox(height: compact ? 10 : 16),
                _facts(pay, meta),
              ],
            ],
          );
        }
        // WHAT GIVES WAY, AND WHAT NEVER DOES. The money block is an
        // INFLEXIBLE child, so the `Flexible` narrative above it gets only
        // what is left over and is the part that clips. A salary sliced
        // horizontally through its digits — which is what one clipped column
        // produced at 320x568 with a 2.0 system font — is worse than a
        // shortened title: the pay is the one fact this card exists to state.
        //
        // The money block is itself capped at the box, because a Column hands
        // an inflexible child UNBOUNDED main-axis space: without the cap a
        // money block taller than the whole card (a landscape phone at 2.0
        // leaves 148dp) overflowed the Column, and a RenderFlex reports its
        // overflow wherever it is clipped.
        final double gap = compact ? 10 : 16;
        final double factsMax = math.max(0, box.maxHeight - gap);
        return ClipRect(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Flexible(child: _clipped(_narrative())),
              if (hasFacts) ...<Widget>[
                SizedBox(height: gap),
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: factsMax),
                  child: _clipped(_facts(pay, meta)),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  /// Lays [child] out at its NATURAL height, takes the SMALLER of that and the
  /// space it was given, and clips the surplus off the bottom.
  ///
  /// `ConstraintsTransformBox`, not `OverflowBox`: an `OverflowBox` sizes
  /// itself to `constraints.biggest`, which is what made the deck card a
  /// full-height white slab, and inside a `Flexible` it then took the whole
  /// free run and shoved the money block off the card. This sizes to
  /// `constraints.constrain(child)`, and `Clip.hardEdge` keeps the debug
  /// overflow indicator (and its error report) out of it — the clip IS the
  /// intended behaviour here.
  static Widget _clipped(Widget child) => ConstraintsTransformBox(
    constraintsTransform: ConstraintsTransformBox.heightUnconstrained,
    alignment: Alignment.topLeft,
    clipBehavior: Clip.hardEdge,
    child: child,
  );

  /// Title, place and the "why am I seeing this" note — the part that gives way
  /// on a short card.
  Widget _narrative() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // #362 — the title stays the ONLY route into the job detail from a
            // deck card (the pan recognizer claims the rest), so it keeps the
            // same ≥48px button, key and TalkBack label as the list row.
            Expanded(
              child: onTitleTap == null
                  ? _title()
                  : _TitleButton(onTap: onTitleTap!, title: _title()),
            ),
            if (data.hot) ...<Widget>[
              const SizedBox(width: 8),
              const BbHotTag(),
            ],
          ],
        ),
        const SizedBox(height: 4),
        _SubtitleRow(data: data),
        if (data.matchNote != null) ...<Widget>[
          SizedBox(height: compact ? 8 : 12),
          _MatchNote(text: data.matchNote!, maxLines: compact ? 2 : null),
        ],
      ],
    );
  }

  /// The money and the shift — never clipped.
  ///
  /// WRAP, not a Row. The money box takes the full width it is given, so the
  /// shift chip drops to its own line rather than squeezing a ₹ figure and
  /// "Rotational shift" onto one 320dp line — and neither fact is one to
  /// ellipsize.
  Widget _facts(String? pay, String? meta) {
    return Wrap(
      spacing: 10,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: <Widget>[
        if (pay != null) KitSalaryBox(label: 'Salary', value: pay),
        if (meta != null)
          KitInfoChip(
            label: meta,
            dot: OnboardingColors.ink500,
            showCheck: false,
            maxLines: 1,
          ),
      ],
    );
  }
}
