import 'package:flutter/material.dart';

import '../../theme/bb_palette.dart';
import '../../theme/onboarding_theme.dart';

/// The reassurance line under a PIN or auth CTA (spec §3.4).
///
/// The spec draws an emoji shield. This uses the real [Icons.shield_outlined]
/// glyph instead: an emoji renders in a different font on every handset, is
/// announced literally by TalkBack, and changes size with the system emoji
/// setting rather than with the text.
class SecureNote extends StatelessWidget {
  const SecureNote({
    super.key,
    this.text = '100% Safe & Secure • No agent fees',
  });

  final String text;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        Icon(Icons.shield_outlined, size: 16, color: p.textMuted),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: OnboardingTypography.inter(
              size: 12,
              color: p.textMuted,
            ),
          ),
        ),
      ],
    );
  }
}
