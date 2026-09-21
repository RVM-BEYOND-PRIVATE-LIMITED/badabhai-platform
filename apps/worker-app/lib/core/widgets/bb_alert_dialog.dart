import 'package:flutter/material.dart';

import '../theme/onboarding_theme.dart';
import 'bb_button.dart';

/// Shows the BadaBhai centred alert — the modal a low-literacy worker cannot
/// miss. It replaces the tiny inline red hint that a first-time worker scrolled
/// past or could not read: this takes the whole screen focus over the navy
/// scrim and closes ONLY on an explicit OK tap (`barrierDismissible: false`), so
/// an error is always read, never dismissed by accident.
///
/// v3 chrome: a white card, 16-radius corners, elevation 0 (separation is the
/// scrim + fill, never a shadow), an Anek [title], a legible Inter [message],
/// and one full-width primary [BbButton]. Returns when the worker taps OK.
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
    barrierColor: OnboardingColors.scrim,
    builder: (BuildContext dialogContext) {
      return AlertDialog(
        backgroundColor: OnboardingColors.paperWhite,
        // Design law: separation is the scrim + fill, never a shadow.
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.card)),
        ),
        titlePadding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
        contentPadding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        title: Text(
          title,
          textAlign: TextAlign.center,
          style: OnboardingTypography.anek(size: 18, weight: FontWeight.w800),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              message,
              textAlign: TextAlign.center,
              style: OnboardingTypography.inter(
                size: 14,
                height: 1.45,
                color: OnboardingColors.ink600,
              ),
            ),
            const SizedBox(height: 24),
            // Row + Expanded (not BbButton.block) gives a full-width button while
            // keeping a FINITE intrinsic width — AlertDialog wraps its column in
            // an IntrinsicWidth, which throws on a `width: infinity` child.
            Row(
              children: <Widget>[
                Expanded(
                  child: BbButton(
                    label: okLabel,
                    size: BbButtonSize.md,
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

/// Asks the worker to confirm something, and resolves `true` ONLY on an
/// explicit tap of the confirm button.
///
/// A dismiss — the barrier, the back button, a cancel — resolves `false`, never
/// null, so a caller can never mistake "they backed out" for "they agreed":
/// `if (await showBbConfirm(...))` is safe by construction.
///
/// [destructive] paints the confirm button crimson (delete account, log out
/// everywhere). The content scrolls, so a long explanation at a large system
/// font is reachable instead of overflowing the card.
Future<bool> showBbConfirm(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = 'Theek hai',
  String cancelLabel = 'Rehne dein',
  bool destructive = false,
  bool barrierDismissible = true,
}) async {
  final bool? confirmed = await showDialog<bool>(
    context: context,
    barrierDismissible: barrierDismissible,
    barrierColor: OnboardingColors.scrim,
    builder: (BuildContext dialogContext) {
      return AlertDialog(
        backgroundColor: OnboardingColors.paperWhite,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.card)),
        ),
        titlePadding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
        contentPadding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        title: Text(
          title,
          textAlign: TextAlign.center,
          style: OnboardingTypography.anek(size: 18, weight: FontWeight.w800),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Flexible(
              child: SingleChildScrollView(
                child: Text(
                  message,
                  textAlign: TextAlign.center,
                  style: OnboardingTypography.inter(
                    size: 14,
                    height: 1.45,
                    color: OnboardingColors.ink600,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 24),
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
                const SizedBox(width: 10),
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
  // A dismissed dialog pops with null; only the confirm button means yes.
  return confirmed ?? false;
}
