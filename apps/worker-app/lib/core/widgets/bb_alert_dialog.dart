import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_button.dart';

/// Shows the BadaBhai centred alert — the modal a low-literacy worker cannot
/// miss. It replaces the tiny inline red hint that a first-time worker scrolled
/// past or could not read: this takes the whole screen focus over the deep-blue
/// scrim and closes ONLY on an explicit OK tap (`barrierDismissible: false`), so
/// an error is always read, never dismissed by accident.
///
/// JUL31 "Josh" chrome: a white [AppColors.surfaceCard] card, 12-radius corners,
/// elevation 0 (separation is the scrim + fill, never a shadow — design law §4),
/// a big Anek [title] and a legible Roboto [message] at the worker size, and one
/// full-width primary [BbButton]. Returns when the worker taps OK.
///
/// The [okLabel] default ("Theek hai") is neutral aap-form copy — no vocative,
/// no exclamation — so it passes `persona_neutrality_test`. Callers must keep
/// [title]/[message] neutral too.
Future<void> showBbAlert(
  BuildContext context, {
  required String title,
  required String message,
  String okLabel = 'Theek hai',
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    barrierColor: AppColors.scrim,
    builder: (BuildContext dialogContext) {
      return AlertDialog(
        backgroundColor: AppColors.surfaceCard,
        // Design law §4: separation is the scrim + fill, never a shadow.
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.lg)),
        ),
        titlePadding: const EdgeInsets.fromLTRB(
          AppSpacing.s6,
          AppSpacing.s6,
          AppSpacing.s6,
          AppSpacing.s3,
        ),
        contentPadding: const EdgeInsets.fromLTRB(
          AppSpacing.s6,
          0,
          AppSpacing.s6,
          AppSpacing.s6,
        ),
        title: Text(
          title,
          textAlign: TextAlign.center,
          style: AppTypography.display(size: AppTypography.sizeMd),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeMd,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s6),
            // Row + Expanded (not BbButton.block) gives a full-width button while
            // keeping a FINITE intrinsic width — AlertDialog wraps its column in
            // an IntrinsicWidth, which throws on a `width: infinity` child.
            Row(
              children: <Widget>[
                Expanded(
                  child: BbButton(
                    label: okLabel,
                    onPressed: () => Navigator.of(dialogContext).pop(),
                  ),
                ),
              ],
            ),
          ],
        ),
      );
    },
  );
}
