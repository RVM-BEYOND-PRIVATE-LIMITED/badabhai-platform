import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// Pieces of the form-flow question screens, drawn from the Workholding (15),
/// Measuring Instruments (16) and Turning Operations (14) mockups. Only the
/// form flow (trade form + finishing) uses them, so they draw the mockups
/// directly from [FormFlowLayout] / [FormFlowColors].

/// The white strip under the header: an uppercase topic on the left, the
/// completion on the right, and the yellow bar beneath.
///
/// The percentage is the worker's TRUE position through the walk
/// ([position] of [total]) — the same two numbers the STEP badge shows — never
/// an invented figure. At 100% the right side becomes the mockup's green
/// "100% complete" pill.
///
/// The strip also paints the soft shadow the header casts onto it: the header
/// is laid out ABOVE the strip in a column, so a shadow of its own would be
/// painted over by the strip.
class FormProgressStrip extends StatelessWidget {
  const FormProgressStrip({
    super.key,
    required this.topic,
    required this.position,
    required this.total,
  });

  final String topic;
  final int position;
  final int total;

  @override
  Widget build(BuildContext context) {
    final double fraction =
        total <= 0 ? 0 : (position / total).clamp(0.0, 1.0).toDouble();
    final int percent = (fraction * 100).round();
    final bool complete = total > 0 && position >= total;
    final BorderRadius barRadius =
        BorderRadius.circular(FormFlowLayout.progressBarHeight / 2);
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: OnboardingColors.paperWhite,
          border: Border(
            bottom: BorderSide(color: FormFlowColors.stripBorder),
          ),
        ),
        child: Stack(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(
                FormFlowLayout.gutter,
                FormFlowLayout.stripPaddingTop,
                FormFlowLayout.gutter,
                FormFlowLayout.stripPaddingBottom,
              ),
              child: Center(
                heightFactor: 1,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: OnboardingLayout.maxContentWidth,
                  ),
                  child: Semantics(
                    label: 'Progress',
                    value: total <= 0 ? null : '$percent percent',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            Expanded(
                              child: Text(
                                topic.toUpperCase(),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: OnboardingTypography.formStripLabel(),
                              ),
                            ),
                            const SizedBox(width: 8),
                            if (complete)
                              const _CompletePill()
                            else
                              Text(
                                '$percent% COMPLETED',
                                style: OnboardingTypography.formStripLabel(),
                              ),
                          ],
                        ),
                        const SizedBox(
                          height: FormFlowLayout.stripLabelToBarGap,
                        ),
                        ClipRRect(
                          borderRadius: barRadius,
                          child: Container(
                            height: FormFlowLayout.progressBarHeight,
                            color: OnboardingColors.borderSubtle,
                            alignment: Alignment.centerLeft,
                            child: FractionallySizedBox(
                              widthFactor: fraction,
                              child: Container(
                                decoration: BoxDecoration(
                                  color: OnboardingColors.safetyYellow,
                                  borderRadius: barRadius,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            const Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: _HeaderShadow(),
            ),
          ],
        ),
      ),
    );
  }
}

/// The last step's green "100% complete" pill.
///
/// Laid out as its text alone, so the label row is exactly as tall as on any
/// other step; the pill's vertical padding is painted as an overhang above and
/// below that line (mockup 16), inside the strip's own top/bottom padding.
class _CompletePill extends StatelessWidget {
  const _CompletePill();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: FormFlowLayout.completePillPaddingH,
      ),
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Positioned(
            left: -FormFlowLayout.completePillPaddingH,
            right: -FormFlowLayout.completePillPaddingH,
            top: -FormFlowLayout.completePillPaddingV,
            bottom: -FormFlowLayout.completePillPaddingV,
            child: const DecoratedBox(
              decoration: BoxDecoration(
                color: FormFlowColors.completeBg,
                borderRadius: BorderRadius.all(
                  Radius.circular(FormFlowLayout.completePillRadius),
                ),
              ),
            ),
          ),
          Text(
            '100% complete',
            style: OnboardingTypography.inter(
              size: FormFlowLayout.completePillTextSize,
              weight: FontWeight.w700,
              color: FormFlowColors.completeText,
            ),
          ),
        ],
      ),
    );
  }
}

/// The header's shadow, fading down over the top of the strip. Paint only.
class _HeaderShadow extends StatelessWidget {
  const _HeaderShadow();

  @override
  Widget build(BuildContext context) {
    return const IgnorePointer(
      child: SizedBox(
        height: FormFlowLayout.headerShadowExtent,
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[
                FormFlowColors.headerShadow,
                Color(0x00000000),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The small yellow-tint pill under a question ("ⓘ Multiple options select kar
/// sakte hain").
class FormHintChip extends StatelessWidget {
  const FormHintChip({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: FormFlowLayout.hintPaddingH,
          vertical: FormFlowLayout.hintPaddingV,
        ),
        decoration: BoxDecoration(
          color: OnboardingColors.safetyYellow.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(
              Icons.info_rounded,
              size: FormFlowLayout.hintIconSize,
              color: OnboardingColors.shiftBlue,
            ),
            const SizedBox(width: FormFlowLayout.hintIconGap),
            Flexible(
              child: Text(
                text,
                style: OnboardingTypography.inter(
                  size: FormFlowLayout.hintTextSize,
                  weight: FontWeight.w600,
                  color: OnboardingColors.ink600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The centred fallback link under the options ("ⓘ Pata nahi / Baad mein
/// batayein"): a light help glyph and muted text over a separate pale hairline,
/// full 48px tap height.
class FormDeclineLink extends StatelessWidget {
  const FormDeclineLink({
    super.key,
    required this.label,
    required this.onTap,
  });

  final String label;
  final VoidCallback? onTap;

  /// Drops the hairline just clear of the text's descenders.
  static const double _underlineDrop = 1;

  @override
  Widget build(BuildContext context) {
    // Greyed while [onTap] is null (e.g. a submit is in flight), so a link
    // that cannot act does not look like one that can.
    final bool enabled = onTap != null;
    final Color ink =
        enabled ? OnboardingColors.ink600 : OnboardingColors.disabledText;
    final Color glyph =
        enabled ? FormFlowColors.declineIcon : OnboardingColors.disabledText;
    return Center(
      child: TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(
          minimumSize: const Size(
            OnboardingLayout.tapTarget,
            OnboardingLayout.tapTarget,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.help_outline_rounded,
              size: FormFlowLayout.declineIconSize,
              color: glyph,
            ),
            const SizedBox(width: FormFlowLayout.declineIconGap),
            Flexible(
              child: Container(
                padding: const EdgeInsets.only(bottom: _underlineDrop),
                decoration: const BoxDecoration(
                  border: Border(
                    bottom: BorderSide(color: FormFlowColors.declineUnderline),
                  ),
                ),
                child: Text(
                  label,
                  textAlign: TextAlign.center,
                  style: OnboardingTypography.inter(
                    size: 12,
                    weight: FontWeight.w600,
                    color: ink,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
