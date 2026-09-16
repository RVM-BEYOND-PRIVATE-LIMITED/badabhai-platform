import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// Colour tone of a [KitPill].
enum KitPillTone {
  /// Done / verified (spec §4 status).
  green,

  /// Yellow on a LIGHT surface — the 20% yellow wash reads warm there.
  yellow,

  /// On a NAVY surface — the banner's 'READY' and its count pill (spec §4).
  onNavy,

  /// A quiet state on a white card — 'DRAFT' (spec §4).
  neutral,

  /// A failure state.
  red,
}

/// A small status pill: 'READY', 'DRAFT' (spec §4).
///
/// Read-only and deliberately NOT tappable, so it is exempt from the 48dp
/// touch floor — it is a label, not a control.
class KitPill extends StatelessWidget {
  const KitPill({
    super.key,
    required this.label,
    this.tone = KitPillTone.neutral,
    this.fontSize = 10,
  });

  final String label;
  final KitPillTone tone;

  /// 10 on the navy banner, 9 for the quieter card pill (spec §4).
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final (Color background, Color foreground) = switch (tone) {
      KitPillTone.green => (
        OnboardingColors.successBg,
        OnboardingColors.successGreen,
      ),
      KitPillTone.yellow => (
        OnboardingColors.yellowTint20,
        OnboardingColors.safetyYellow,
      ),
      // ON NAVY the 20%-yellow wash is not yellow at all: 0x33FFB32C over
      // #05194C composites to about #373846 — a neutral slate — so the pill
      // read as a grey chip carrying a yellow numeral. Raising the alpha only
      // turns it brown; yellow over deep navy cannot be warm at any alpha. So
      // the fill is spec §1.1's own answer, `shiftBlueSurface` ("pill on
      // navy"), with the yellow kept for the label.
      KitPillTone.onNavy => (
        OnboardingColors.shiftBlueSurface,
        OnboardingColors.safetyYellow,
      ),
      KitPillTone.neutral => (
        OnboardingColors.pillMutedBg,
        OnboardingColors.ink500,
      ),
      KitPillTone.red => (OnboardingColors.errorBg, OnboardingColors.errorRed),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(OnboardingRadii.pillSm),
      ),
      child: Text(
        label,
        style: OnboardingTypography.pillLabel(
          color: foreground,
        ).copyWith(fontSize: fontSize),
      ),
    );
  }
}

/// A card header's count pill — '7' (spec §4).
///
/// **Digits only (ruling R8).** The spec's mock reads '7 Verified', but no
/// per-value verification signal exists on the wire: capability rows are
/// self-declared. Printing "Verified" beside a self-declared count would tell
/// an employer something nobody checked, so the pill carries the real integer
/// and nothing else.
class KitCountPill extends StatelessWidget {
  const KitCountPill({super.key, required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: OnboardingColors.pillMutedBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.countPill),
      ),
      child: Text('$count', style: OnboardingTypography.countPill()),
    );
  }
}
