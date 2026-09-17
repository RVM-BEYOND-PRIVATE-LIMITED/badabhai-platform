import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';
import '../bada_bhai_mark.dart';

/// The BadaBhai brand lockup in the Shift Blue header: the global two-figure
/// [BadaBhaiMark] beside the **BadaBhai** wordmark, drawn directly on the navy
/// band.
///
/// NO PILL. The lockup used to sit in a 12%-white wash with a 25%-white
/// hairline and an uppercase wordmark; the owner removed the border and
/// background permanently and moved the wordmark to mixed case ("BadaBhai").
/// There is deliberately no decoration here to restore — the mark and the text
/// are the whole lockup, so it reads the same on every screen that shows it.
class BrandBadge extends StatelessWidget {
  const BrandBadge({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const BadaBhaiMark(height: 14),
        const SizedBox(width: 6),
        Text(
          // Brand name is always one word, two capitals.
          'BadaBhai',
          style: OnboardingTypography.anek(
            size: 12,
            weight: FontWeight.w800,
            color: OnboardingColors.textOnBlue,
          ),
        ),
      ],
    );
  }
}
