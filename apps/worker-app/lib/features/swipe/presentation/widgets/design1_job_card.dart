import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/bb_job_card.dart';
import '../../../../core/widgets/kit/kit_square_icon_button.dart';
import 'job_deck.dart' show kSkipSemanticLabel;

/// DESIGN1 — the Jobs-tab single job card, pixel-drawn from
/// `assets/fonts/image/design1.png` (Home → Jobs tab).
///
/// RENDER ONLY. Every fact shown is caller-supplied REAL feed data
/// ([BbJobCardData] + [payFull]); a null/absent field hides its row —
///
///  - [payFull] is `formatPayBandFull` (₹16,000 – ₹26,000), the design's
///    grouped figure. Null hides the whole salary box.
///  - shift / experience / neededBy / tags / benefits render as the
///    "Duty & Suvidhayein" chips; empty hides the section.
///  - [next] is the REAL next job in the queue (or null); its teaser
///    advances the pager via [onNextTap] — no backend decision is recorded.
///
/// Static chrome labels ("MAHINE KI SALARY", "Duty & Suvidhayein",
/// "AAPKE LIYE AUR OPTIONS", "Feedback", "Apply", "Dekhein", "Sab dekhein")
/// are the design pattern itself, not per-job data.
///
/// NO TRUST OR URGENCY CLAIM IS DRAWN. The "VERIFIED FACTORY" pill, the
/// "Urgent Hiring" pill and the "Direct Company Payroll • Zero Fees" strip were
/// removed with the #1651 ruling (2026-09-22, ADR-0024 addendum): the alpha
/// makes no trust claim to a worker, and `verification_status` is deliberately
/// never projected onto a worker-facing read. Do not reintroduce them without a
/// new ruling.
///
/// The salary box used to print "TAKE HOME PAY" + an "IN-HAND" pill as fixed
/// chrome. Nothing in the platform states net-vs-gross (no `pay_type` /
/// `in_hand` column exists on any route), so the box now names only what the
/// data really is — a MONTHLY BAND — and the pill renders only from
/// [BbJobCardData.payNote], i.e. only once a poster can state it.
class Design1JobCard extends StatelessWidget {
  const Design1JobCard({
    super.key,
    required this.data,
    required this.payFull,
    this.onTitleTap,
    this.onApply,
    this.onFeedback,
    this.next,
    this.nextPayFull,
    this.onNextTap,
    this.onSeeAll,
    this.showDock = true,
    this.showTeaser = true,
  }) : assert(
         !showDock || (onApply != null && onFeedback != null),
         'showDock needs onApply + onFeedback',
       );

  final BbJobCardData data;
  final String? payFull;
  final VoidCallback? onTitleTap;
  final VoidCallback? onApply;
  final VoidCallback? onFeedback;

  /// The REAL next job teaser (null hides it).
  final BbJobCardData? next;
  final String? nextPayFull;
  final VoidCallback? onNextTap;
  final VoidCallback? onSeeAll;

  /// False renders the face only (pills → match note): no teaser, no dock.
  /// The swipe deck hides both — its behind card already previews the next
  /// job and its own dock owns the actions.
  final bool showDock;
  final bool showTeaser;

  // Design1 pastels, measured off the mock. Kept local: they are this
  // card's drawing, not app-wide tokens.
  static const Color _salaryBg = Color(0xFFFFFBEB);
  static const Color _salaryBorder = Color(0xFFF59E0B);
  static const Color _payInk = Color(0xFF9A3412);
  static const Color _dutyGreyBg = Color(0xFFF1F5F9);

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        // THE PAPER FILLS ITS BOX; THE CONTENT CLIPS INSIDE IT.
        //
        // The clip belongs HERE, around the content — not around the whole
        // card. The deck hands this card a TIGHT height (the deck box less the
        // peek strip); measuring the PAPER at its own text height instead drew
        // a short card with a white gap above the dock, and let the taller card
        // behind it show through underneath. That is the "card became half"
        // a worker sees when a swipe brings a shorter job to the front.
        //
        // `ConstraintsTransformBox`, not `OverflowBox`: it lays the column out
        // at its natural height and takes the SMALLER of that and the height it
        // was given, so a card with more chips than fit clips at the bottom
        // edge instead of reporting an overflow. A scroll view here would steal
        // the deck's vertical follow-drag (#374), so the clip IS the contract.
        child: ConstraintsTransformBox(
          constraintsTransform: ConstraintsTransformBox.heightUnconstrained,
          alignment: Alignment.topLeft,
          clipBehavior: Clip.hardEdge,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _TitleRow(data: data, onTitleTap: onTitleTap),
              const SizedBox(height: 2),
              _PlaceRow(place: data.place),
              if (payFull != null) ...<Widget>[
                const SizedBox(height: 12),
                _SalaryBox(payFull: payFull!, payNote: data.payNote),
              ],
              _DutySection(data: data),
              if (data.matchNote != null) ...<Widget>[
                const SizedBox(height: 12),
                _MatchLine(text: data.matchNote!),
              ],
              if (showTeaser) ...<Widget>[
                const SizedBox(height: 16),
                _OptionsHeader(onSeeAll: onSeeAll),
                if (next != null) ...<Widget>[
                  const SizedBox(height: 8),
                  _NextTeaser(
                    next: next!,
                    nextPayFull: nextPayFull,
                    onTap: onNextTap,
                  ),
                ],
              ],
              if (showDock) ...<Widget>[
                const SizedBox(height: 14),
                _ActionRow(
                  onFeedback: onFeedback!,
                  onApply: onApply!,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Title + yellow chevron. The title keeps its exact feed string (and the
/// shared `jobCardTitleButton` key + TalkBack label) so it stays the ONE
/// route into the detail screen. Null [onTitleTap] renders a plain, inert
/// title — no button role, no chevron promising an unwired route (mirrors
/// [BbJobCard]; the deck passes null mid-commit).
class _TitleRow extends StatelessWidget {
  const _TitleRow({required this.data, required this.onTitleTap});

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  Text _title() => Text(
    data.title,
    maxLines: 2,
    overflow: TextOverflow.ellipsis,
    style: OnboardingTypography.anek(
      size: 17,
      weight: FontWeight.w800,
      height: 1.25,
    ),
  );

  @override
  Widget build(BuildContext context) {
    final VoidCallback? onTap = onTitleTap;
    if (onTap == null) return _title();
    return MergeSemantics(
      child: Semantics(
        button: true,
        label: kJobCardTitleSemanticLabel,
        child: Material(
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
                crossAxisAlignment: CrossAxisAlignment.center,
                children: <Widget>[
                  Expanded(child: _title()),
                  const SizedBox(width: 8),
                  const Icon(
                    Icons.chevron_right_rounded,
                    size: 26,
                    color: OnboardingColors.safetyYellow,
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

class _PlaceRow extends StatelessWidget {
  const _PlaceRow({required this.place});

  final String place;

  @override
  Widget build(BuildContext context) {
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
            place,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: OnboardingTypography.bodyMuted(),
          ),
        ),
      ],
    );
  }
}

/// The monthly-salary box: label + optional pay-type pill on top, grouped figure
/// below. No fixed-base split is rendered — the wire carries no such
/// breakdown, so a second line would be invented.
class _SalaryBox extends StatelessWidget {
  const _SalaryBox({required this.payFull, this.payNote});

  final String payFull;

  /// The poster's own pay-type wording ("IN-HAND" / "CTC"). Null hides the
  /// pill — the card never asserts a pay semantics nobody stated.
  final String? payNote;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Design1JobCard._salaryBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: Design1JobCard._salaryBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  'MAHINE KI SALARY',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.inter(
                    size: 11,
                    weight: FontWeight.w700,
                    letterSpacing: 0.6,
                    color: Design1JobCard._payInk,
                  ),
                ),
              ),
              if (payNote != null)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: OnboardingColors.paperWhite,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(
                      color: Design1JobCard._salaryBorder,
                    ),
                  ),
                  child: Text(
                    payNote!,
                    style: OnboardingTypography.inter(
                      size: 10,
                      weight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: Design1JobCard._payInk,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          // NOTE: [payFull] is `formatPayBandFull` and already carries its
          // own '/mah' suffix — no second suffix is appended.
          Text(
            payFull,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: OnboardingTypography.anek(
              size: 20,
              weight: FontWeight.w800,
              color: Design1JobCard._payInk,
            ),
          ),
        ],
      ),
    );
  }
}

/// "Duty & Suvidhayein" + the REAL posting facts as pastel chips. Empty
/// hides the whole section — never a placeholder row.
class _DutySection extends StatelessWidget {
  const _DutySection({required this.data});

  final BbJobCardData data;

  @override
  Widget build(BuildContext context) {
    final List<_DutyChip> chips = <_DutyChip>[
      if (data.shift != null)
        _DutyChip(
          label: '${data.shift} Shift',
          icon: Icons.schedule_outlined,
          bg: Design1JobCard._dutyGreyBg,
        ),
      if (data.experience != null)
        _DutyChip(
          label: data.experience!,
          icon: Icons.person_outline_rounded,
          bg: Design1JobCard._dutyGreyBg,
        ),
      if (data.neededBy != null)
        _DutyChip(
          label: data.neededBy!,
          icon: Icons.bolt_outlined,
          bg: OnboardingColors.infoBg,
        ),
      for (final String tag in data.tags)
        _DutyChip(
          label: tag,
          icon: Icons.build_outlined,
          bg: Design1JobCard._salaryBg,
        ),
      // A benefit is what the POSTER claims, not something the platform checked
      // — so the chip carries a neutral "perk" glyph. It used to carry
      // `Icons.verified_outlined`, a rosette that read as "we verified this".
      for (final String benefit in data.benefits)
        _DutyChip(
          label: benefit,
          icon: Icons.card_giftcard_outlined,
          bg: OnboardingColors.infoBg,
        ),
    ];
    if (chips.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const SizedBox(height: 14),
        Text(
          'Duty & Suvidhayein',
          style: OnboardingTypography.inter(
            size: 12,
            weight: FontWeight.w600,
            color: OnboardingColors.ink600,
          ),
        ),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: chips),
      ],
    );
  }
}

class _DutyChip extends StatelessWidget {
  const _DutyChip({
    required this.label,
    required this.icon,
    required this.bg,
  });

  final String label;
  final IconData icon;
  final Color bg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(OnboardingRadii.chip),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 14, color: OnboardingColors.ink600),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 12,
                weight: FontWeight.w600,
                color: OnboardingColors.ink900,
              ),
            ),
          ),
        ],
      ),
    );
  }
}


class _MatchLine extends StatelessWidget {
  const _MatchLine({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
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
            style: OnboardingTypography.inter(
              size: 12,
              weight: FontWeight.w600,
              height: 1.4,
              color: OnboardingColors.infoText,
            ),
          ),
        ),
      ],
    );
  }
}

class _OptionsHeader extends StatelessWidget {
  const _OptionsHeader({required this.onSeeAll});

  final VoidCallback? onSeeAll;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            'AAPKE LIYE AUR OPTIONS',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: OnboardingTypography.inter(
              size: 10,
              weight: FontWeight.w700,
              letterSpacing: 0.8,
              color: OnboardingColors.ink500,
            ),
          ),
        ),
        if (onSeeAll != null)
          Flexible(
            child: InkWell(
              onTap: onSeeAll,
              borderRadius: BorderRadius.circular(OnboardingRadii.chip),
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: OnboardingLayout.tapTarget,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Center(
                    widthFactor: 1,
                    child: Text(
                      'Sab dekhein',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: OnboardingTypography.inter(
                        size: 12,
                        weight: FontWeight.w600,
                        color: OnboardingColors.infoText,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// The next-job teaser: REAL title + place/pay, "Dekhein" advances.
class _NextTeaser extends StatelessWidget {
  const _NextTeaser({
    required this.next,
    required this.nextPayFull,
    required this.onTap,
  });

  final BbJobCardData next;
  final String? nextPayFull;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final String sub = nextPayFull == null
        ? next.place
        : '${next.place} • $nextPayFull';
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      next.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: OnboardingTypography.inter(
                        size: 13,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      sub,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: OnboardingTypography.bodyMuted(),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Container(
                key: const Key('design1NextButton'),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: OnboardingColors.pillMutedBg,
                  borderRadius: BorderRadius.circular(OnboardingRadii.chip),
                ),
                child: Text(
                  'Dekhein',
                  style: OnboardingTypography.inter(
                    size: 12,
                    weight: FontWeight.w700,
                    color: OnboardingColors.ink600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Bottom dock: navy Feedback + yellow Apply. Apply keeps the deck's
/// `swipeApplyButton` key so the feed's apply contract is unchanged.
///
/// Custom ink buttons (not FilledButton.icon): the label ellipsises instead
/// of overflowing at a 2.0 system font, while the 48dp touch floor holds.
class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.onFeedback, required this.onApply});

  final VoidCallback onFeedback;
  final VoidCallback onApply;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          flex: 2,
          child: _DockButton(
            buttonKey: const Key('design1FeedbackButton'),
            onPressed: onFeedback,
            bg: OnboardingColors.shiftBlue,
            fg: OnboardingColors.textOnBlue,
            icon: Icons.chat_bubble_outline_rounded,
            label: 'Feedback',
            labelStyle: OnboardingTypography.inter(
              size: 14,
              weight: FontWeight.w700,
              color: OnboardingColors.textOnBlue,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          flex: 3,
          child: _DockButton(
            buttonKey: const Key('swipeApplyButton'),
            onPressed: onApply,
            bg: OnboardingColors.safetyYellow,
            fg: OnboardingColors.textOnYellow,
            icon: Icons.check_rounded,
            label: 'Apply',
            labelStyle: OnboardingTypography.anek(
              size: 16,
              weight: FontWeight.w800,
              color: OnboardingColors.textOnYellow,
            ),
          ),
        ),
      ],
    );
  }
}

/// The swipe deck's docked row beneath a Design1 face: the ORIGINAL skip
/// square (same key, glyph and TalkBack label the deck always had) beside
/// the Design1 Feedback + Apply pair.
///
/// Used as the deck's [dockBuilder], so [onSkip]/[onApply] are the deck's
/// own visual commits (fly-off, then the fired event) — identical physics
/// to the swipe gesture, never a second dispatch path.
class Design1DeckDock extends StatelessWidget {
  const Design1DeckDock({
    super.key,
    required this.locked,
    required this.onSkip,
    required this.onFeedback,
    required this.onApply,
  });

  final bool locked;
  final VoidCallback onSkip;
  final VoidCallback onFeedback;
  final VoidCallback onApply;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        // #375 — an icon-only control announces nothing to TalkBack without
        // its label; the tap area stays ≥48dp.
        KitSquareIconButton(
          key: const Key('swipeSkipButton'),
          icon: Icons.close_rounded,
          semanticLabel: kSkipSemanticLabel,
          iconColor: OnboardingColors.ink600,
          onTap: locked ? null : onSkip,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _DockButton(
            buttonKey: const Key('design1FeedbackButton'),
            onPressed: locked ? null : onFeedback,
            bg: locked
                ? OnboardingColors.disabledBg
                : OnboardingColors.shiftBlue,
            fg: locked
                ? OnboardingColors.disabledText
                : OnboardingColors.textOnBlue,
            icon: Icons.chat_bubble_outline_rounded,
            label: 'Feedback',
            labelStyle: OnboardingTypography.inter(
              size: 14,
              weight: FontWeight.w700,
              color: locked
                  ? OnboardingColors.disabledText
                  : OnboardingColors.textOnBlue,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _DockButton(
            buttonKey: const Key('swipeApplyButton'),
            onPressed: locked ? null : onApply,
            bg: locked
                ? OnboardingColors.disabledBg
                : OnboardingColors.safetyYellow,
            fg: locked
                ? OnboardingColors.disabledText
                : OnboardingColors.textOnYellow,
            icon: Icons.check_rounded,
            label: 'Apply',
            labelStyle: OnboardingTypography.anek(
              size: 16,
              weight: FontWeight.w800,
              color: locked
                  ? OnboardingColors.disabledText
                  : OnboardingColors.textOnYellow,
            ),
          ),
        ),
      ],
    );
  }
}

class _DockButton extends StatelessWidget {
  const _DockButton({
    required this.buttonKey,
    required this.onPressed,
    required this.bg,
    required this.fg,
    required this.icon,
    required this.label,
    required this.labelStyle,
  });

  final Key buttonKey;
  final VoidCallback? onPressed;
  final Color bg;
  final Color fg;
  final IconData icon;
  final String label;
  final TextStyle labelStyle;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(OnboardingRadii.docked),
      child: InkWell(
        key: buttonKey,
        onTap: onPressed,
        borderRadius: BorderRadius.circular(OnboardingRadii.docked),
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: OnboardingLayout.tapTarget,
          ),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(icon, size: 19, color: fg),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: labelStyle,
                    ),
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
