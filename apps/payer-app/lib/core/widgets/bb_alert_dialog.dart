import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_button.dart';

/// Shows the BadaBhai centred alert — a modal the payer cannot miss. It takes the
/// whole screen focus over the deep-blue scrim and closes ONLY on an explicit OK
/// tap (`barrierDismissible: false`), so a terminal message (e.g. the account is
/// gone) is always read, never dismissed by accident.
///
/// JUL31 "Josh" chrome: a white [AppColors.surfaceCard] card, [AppRadii.lg]
/// corners, elevation 0 (separation is the scrim + fill, never a shadow — design
/// law §4), an Anek [title], a legible Roboto [message], and one full-width
/// primary [BbButton]. Returns when the payer taps OK.
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

/// Shows the BadaBhai centred CONFIRM — a two-button modal for a reversible-but-
/// consequential choice (e.g. Sign out). Same JUL31 "Josh" chrome as [showBbAlert]
/// (white [AppColors.surfaceCard] card, [AppRadii.lg] corners, elevation 0 —
/// separation is the scrim + fill, never a shadow, design law §4 — Anek [title],
/// Roboto [message]) but with a quiet [cancelLabel] ([BbButtonVariant.secondary])
/// beside the [confirmLabel] action.
///
/// Returns `true` only when the payer taps confirm; `false` on cancel OR a
/// barrier tap (tap-outside reads as cancel — the safe default for a destructive
/// prompt). Set [destructive] to render the confirm in crimson.
Future<bool> showBbConfirm(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Rehne do',
  bool destructive = false,
}) async {
  final bool? result = await showDialog<bool>(
    context: context,
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
            // Row + Expanded (not BbButton.block) keeps a FINITE intrinsic width
            // — AlertDialog wraps its column in an IntrinsicWidth, which throws
            // on a `width: infinity` child. md height (44) — sm is disallowed on
            // the danger face.
            Row(
              children: <Widget>[
                Expanded(
                  child: BbButton(
                    label: cancelLabel,
                    variant: BbButtonVariant.secondary,
                    size: BbButtonSize.md,
                    onPressed: () => Navigator.of(dialogContext).pop(false),
                  ),
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: BbButton(
                    label: confirmLabel,
                    variant: destructive
                        ? BbButtonVariant.danger
                        : BbButtonVariant.primary,
                    size: BbButtonSize.md,
                    onPressed: () => Navigator.of(dialogContext).pop(true),
                  ),
                ),
              ],
            ),
          ],
        ),
      );
    },
  );
  return result ?? false;
}
