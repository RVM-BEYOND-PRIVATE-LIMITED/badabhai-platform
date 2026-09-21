import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';
import 'kit_content_column.dart';
import 'kit_pill.dart';

/// The navy status strip under a tab header (spec §4): a yellow headline, an
/// optional state pill, a muted subline, and a trailing mark.
///
/// Every part is optional because every part is REAL DATA. A worker whose PDF
/// is still rendering gets the title with no pill rather than a 'READY' badge
/// that is not true yet.
///
/// The title row is a [Wrap], so at a large system font the pill drops under
/// the headline instead of squeezing it to an ellipsis.
class KitStatusBanner extends StatelessWidget {
  const KitStatusBanner({
    super.key,
    required this.title,
    this.pillLabel,
    this.subline,
    this.trailing,
    this.actions = const <Widget>[],
  });

  final String title;

  /// A state the server actually reported — 'READY'. Null hides the pill.
  final String? pillLabel;
  final String? subline;

  /// The trailing mark. Defaults to nothing; pass [KitStatusCheck] for the
  /// spec's green tick.
  final Widget? trailing;

  /// Trailing controls, used instead of [trailing] when the banner owns
  /// actions rather than a status mark.
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final String? pill = pillLabel;
    final String? sub = subline;
    final Widget? mark = trailing;

    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        width: double.infinity,
        color: OnboardingColors.shiftBlue,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: KitContentColumn(
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 8,
                      runSpacing: 4,
                      children: <Widget>[
                        Text(
                          title,
                          style: OnboardingTypography.anek(
                            size: 15,
                            weight: FontWeight.w700,
                            color: OnboardingColors.safetyYellow,
                          ),
                        ),
                        if (pill != null && pill.isNotEmpty)
                          KitPill(label: pill, tone: KitPillTone.onNavy),
                      ],
                    ),
                    if (sub != null && sub.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(
                        sub,
                        style: OnboardingTypography.inter(
                          size: 11,
                          color: OnboardingColors.textOnBlue70,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (mark != null) ...<Widget>[const SizedBox(width: 12), mark],
              ...actions,
            ],
          ),
        ),
      ),
    );
  }
}

/// The banner's green tick (spec §4): a 32x32 disc with a white check.
class KitStatusCheck extends StatelessWidget {
  const KitStatusCheck({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: OnboardingColors.successGreen,
        shape: BoxShape.circle,
      ),
      child: const Icon(
        Icons.check_rounded,
        size: 20,
        color: OnboardingColors.textOnBlue,
      ),
    );
  }
}
