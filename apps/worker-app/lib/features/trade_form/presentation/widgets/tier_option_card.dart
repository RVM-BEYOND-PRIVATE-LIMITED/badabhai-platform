import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/selection_cards.dart';
import '../../domain/profiling_tier.dart';

/// The "BadaBhai Standard" badge's gold, as a GRADIENT rather than a flat fill.
///
/// WHERE THE GOLD LIVES, AND WHY IT IS NOT THE BORDER (#1698 design ruling).
/// The issue asks for "a soft metallic gold gradient on the border **and/or** a
/// very light gradient wash on the background". Only the second is taken, plus
/// this badge, for two reasons that the border option cannot answer:
///
///  1. **It would collide with the app's single most reused signal.** A yellow
///     1.8dp border means SELECTED — on every option card, chip, radio and
///     checkbox in the app (`_SelectionCardShell`, `OnboardingColors.borderActive`).
///     A permanent gold border on the Hard card would read as "already chosen"
///     before the worker touches it, and once they did choose it there would be
///     nothing left to escalate to.
///  2. **A gold gradient was deliberately removed from this codebase once
///     already** (#374, with a do-not-reintroduce note at `job_deck.dart`).
///     Re-adding one to a border reads as a regression; confining it to a badge
///     and a wash keeps the removal's intent intact.
///
/// The wash and the badge together still make the card unmistakable, which is
/// what the issue actually asks for ("stand out without looking like an error").
const LinearGradient kBadaBhaiStandardBadge = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: <Color>[
    Color(0xFFF6E27A),
    Color(0xFFD4AF37),
    Color(0xFFB8860B),
    Color(0xFFF3D98B),
  ],
  stops: <double>[0.0, 0.45, 0.75, 1.0],
);

/// The Hard card's background wash — a very light warm tint, not flat gold, so
/// the text on it stays well clear of WCAG AA. Dark ink on a near-white wash,
/// never gold ink on white.
const LinearGradient kBadaBhaiStandardWash = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: <Color>[Color(0xFFFFFBEA), Color(0xFFFFF3C4)],
);

/// The badge's own label. Not translated and not shortened: it is a product
/// name, the way "BadaBhai" itself is.
const String kBadaBhaiStandardLabel = 'BadaBhai Standard';

/// One tier the worker can choose (#1698).
///
/// WHY NOT `SingleSelectQuestionCard`: that card has exactly two text slots
/// (title + one subtitle) and no room for a third line or a badge, and the Hard
/// card needs title → badge → description → time. Rather than widen the shared
/// card for one screen, this composes the same parts the kit card composes —
/// [OptionRadio] for the indicator — and repaints the SAME selected grammar:
/// `selectedCardBg` fill, safety-yellow border at 1.8dp (1.2 unselected),
/// `FormFlowLayout.cardRadius`, the hairline on the Material shape so content
/// never shifts when selection changes. That is the precedent `FinishingGridOptionCard`
/// set for a card the kit could not express.
class TierOptionCard extends StatelessWidget {
  const TierOptionCard({
    super.key,
    required this.estimate,
    required this.title,
    required this.description,
    required this.isSelected,
    required this.onTap,
  });

  final TierEstimate estimate;
  final String title;
  final String description;
  final bool isSelected;
  final VoidCallback? onTap;

  /// Hard is the only tier that carries the product badge.
  bool get _isStandard => estimate.tier == ProfilingTier.hard;

  /// "About 5–7 min" — an EN DASH between the numbers, and the minutes come
  /// from the server every time (see [TierEstimate]).
  String get timeLabel =>
      'About ${estimate.minMinutes}–${estimate.maxMinutes} min';

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(
      FormFlowLayout.cardRadius,
    );
    final BorderSide side = BorderSide(
      color: isSelected
          ? OnboardingColors.safetyYellow
          : FormFlowColors.cardBorder,
      width: isSelected ? 1.8 : 1.2,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        button: true,
        checked: isSelected,
        inMutuallyExclusiveGroup: true,
        // Spoken as one thing, in the order the card reads: what it is, the
        // badge if it has one, how long it takes. Without this a screen reader
        // announces four disconnected fragments and the badge lands last.
        label: <String>[
          title,
          if (_isStandard) kBadaBhaiStandardLabel,
          description,
          timeLabel,
        ].join('. '),
        excludeSemantics: true,
        child: Material(
          // Selection wins over the Hard wash: a selected Hard card is painted
          // like every other selected card in the app, so "chosen" never has to
          // compete with "premium".
          // Unselected cards are white; the Hard card's wash is painted by the
          // [Ink] below so it can be a gradient, which a Material colour
          // cannot be.
          color: isSelected
              ? OnboardingColors.selectedCardBg
              : OnboardingColors.paperWhite,
          shape: RoundedRectangleBorder(borderRadius: radius, side: side),
          child: InkWell(
            onTap: onTap,
            borderRadius: radius,
            child: Ink(
              decoration: BoxDecoration(
                borderRadius: radius,
                gradient: _isStandard && !isSelected
                    ? kBadaBhaiStandardWash
                    : null,
              ),
              child: Container(
                constraints: const BoxConstraints(
                  minHeight: OnboardingLayout.tapTarget,
                ),
                padding: const EdgeInsets.all(FormFlowLayout.cardInset),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Text(title, style: OnboardingTypography.formCardTitle()),
                          if (_isStandard) ...<Widget>[
                            const SizedBox(height: 6),
                            const _StandardBadge(),
                          ],
                          const SizedBox(height: 4),
                          Text(
                            description,
                            style: OnboardingTypography.formCardSubtitle(),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            timeLabel,
                            style: OnboardingTypography.inter(
                              size: 12,
                              weight: FontWeight.w600,
                              color: OnboardingColors.ink500,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: OptionRadio(
                        isSelected: isSelected,
                        variant: OnboardingVariant.formFlow,
                      ),
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

/// The gold-gradient "BadaBhai Standard" pill.
///
/// Dark navy ink on the gradient, never gold ink on white: at the light end of
/// the gradient (#F6E27A) navy clears AA comfortably, which gold on white does
/// not come close to.
class _StandardBadge extends StatelessWidget {
  const _StandardBadge();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        gradient: kBadaBhaiStandardBadge,
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
      ),
      child: Text(
        kBadaBhaiStandardLabel,
        style: OnboardingTypography.inter(
          size: 11,
          weight: FontWeight.w800,
          letterSpacing: 0.3,
          color: OnboardingColors.shiftBlue,
        ),
      ),
    );
  }
}
