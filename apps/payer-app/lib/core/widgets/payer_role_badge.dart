import 'package:flutter/material.dart';

import '../session/app_session.dart';
import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A small, unmissable pill that names the SIGNED-IN ROLE — `COMPANY` or
/// `AGENCY`. The role is locked at login and server-decided (see
/// [AppSessionCubit]); this badge just surfaces it so the payer can always tell
/// which portal they are in (the two roles have different tabs + access).
///
/// [onDark] styles it for the deep-blue identity header (light hairline + onBlue
/// text); the default styles it for a canvas surface (deep-blue outline + blue
/// label). Neutral by design — it never uses haldi, so it does not compete with
/// the single haldi CTA a view is allowed.
class PayerRoleBadge extends StatelessWidget {
  const PayerRoleBadge({super.key, required this.role, this.onDark = false});

  final PayerRole role;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final String label = role.isAgency ? 'AGENCY' : 'COMPANY';
    final Color fg = onDark ? AppColors.onBlue : AppColors.blue;
    final Color border = onDark ? AppColors.onBlueMuted : AppColors.blue;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.transparent,
        borderRadius: const BorderRadius.all(Radius.circular(AppRadii.pill)),
        border: Border.all(color: border, width: 1.2),
      ),
      child: Text(
        label,
        style: AppTypography.body(
          size: AppTypography.size2xs,
          weight: FontWeight.w800,
          color: fg,
        ).copyWith(letterSpacing: 0.8),
      ),
    );
  }
}
