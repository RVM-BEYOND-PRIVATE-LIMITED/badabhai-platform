import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_icon_button.dart';

/// The shared back-header for the Earn sub-screens — `.bb-iconbtn--outline` +
/// a Baloo-2 title, optionally with a trailing widget (the KYC status badge).
/// Mirrors the kit's `<button …>↩</button> <h>Title</h>` header row.
class EarnHeader extends StatelessWidget {
  const EarnHeader({
    super.key,
    required this.title,
    required this.onBack,
    this.trailing,
  });

  final String title;
  final VoidCallback onBack;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        BbIconButton(
          icon: Icons.arrow_back,
          semanticLabel: 'Back',
          onPressed: onBack,
        ),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: Text(
            title,
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ),
        if (trailing != null) ...<Widget>[
          const SizedBox(width: AppSpacing.s2),
          trailing!,
        ],
      ],
    );
  }
}
