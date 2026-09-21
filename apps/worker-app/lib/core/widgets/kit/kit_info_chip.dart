import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// A read-only fact chip — a machine, an alloy, a skill (spec §4): a coloured
/// dot, the label, and an optional green check.
///
/// **The check is opt-in and defaults OFF.** A tick means "someone verified
/// this", and no per-value verification signal exists on the wire yet
/// (capability rows are self-declared). Ticking every chip by default would
/// put a verified claim on a worker's profile that nobody checked.
///
/// Read-only, so it is exempt from the 48dp touch floor. The label WRAPS
/// rather than overflowing: a server-supplied label can run long, and at a
/// large system font a single-line chip would paint overflow stripes across
/// the card.
class KitInfoChip extends StatelessWidget {
  const KitInfoChip({
    super.key,
    required this.label,
    this.dot = OnboardingColors.successGreen,
    this.showDot = true,
    this.showCheck = false,
    this.maxLines = 2,
  });

  final String label;

  /// The leading dot's colour — a category tint where the data supports one.
  final Color dot;
  final bool showDot;
  final bool showCheck;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints incoming) {
        // Only cap-and-wrap when the parent hands down a BOUNDED width (a Wrap
        // on a card — the common case). In a horizontally scrolling row the
        // width is unbounded and a chip is allowed to size to its own label.
        final bool bounded = incoming.maxWidth.isFinite;
        final Widget text = Text(
          label,
          maxLines: maxLines,
          softWrap: bounded,
          overflow: TextOverflow.ellipsis,
          style: OnboardingTypography.chipLabel(),
        );
        return ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: bounded ? incoming.maxWidth : double.infinity,
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: OnboardingColors.paperWhite,
              borderRadius: BorderRadius.circular(OnboardingRadii.chip),
              border: Border.all(color: OnboardingColors.borderDefault),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (showDot) ...<Widget>[
                  Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: dot,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 6),
                ],
                if (bounded) Flexible(child: text) else text,
                if (showCheck) ...<Widget>[
                  const SizedBox(width: 4),
                  const Icon(
                    Icons.check_rounded,
                    size: 14,
                    color: OnboardingColors.successGreen,
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}
