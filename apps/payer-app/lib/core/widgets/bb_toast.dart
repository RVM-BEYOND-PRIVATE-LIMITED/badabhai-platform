import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The shared success toast — `.bb-toast--success`. A floating ink card with a
/// green check, a bold title, and a muted message, auto-dismissed after ~2.4s.
///
/// Call [showBbToast] from any screen; it routes through [ScaffoldMessenger] so
/// it survives navigation and stacks correctly.
void showBbToast(
  BuildContext context, {
  required String title,
  required String message,
  IconData icon = Icons.check_circle,
}) {
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  messenger
    ..clearSnackBars()
    ..showSnackBar(
      SnackBar(
        duration: const Duration(milliseconds: 2400),
        backgroundColor: Colors.transparent,
        elevation: 0,
        behavior: SnackBarBehavior.floating,
        padding: EdgeInsets.zero,
        margin: const EdgeInsets.fromLTRB(
          AppSpacing.s4,
          0,
          AppSpacing.s4,
          AppSpacing.s5,
        ),
        content: _ToastBody(title: title, message: message, icon: icon),
      ),
    );
}

class _ToastBody extends StatelessWidget {
  const _ToastBody({
    required this.title,
    required this.message,
    required this.icon,
  });

  final String title;
  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      decoration: BoxDecoration(
        color: AppColors.surfaceInk,
        borderRadius: BorderRadius.circular(AppRadii.md),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.ink950.withValues(alpha: 0.30),
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, color: AppColors.green300, size: 24),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  title,
                  style: AppTypography.body(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                    color: AppColors.paper1,
                  ),
                ),
                Text(
                  message,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.ink200,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
