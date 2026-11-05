import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_haptics.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_button.dart';

/// Shows the BadaBhai terminal alert — a message the payer cannot miss. It
/// takes the focus over the deep-blue scrim and closes ONLY on an explicit OK
/// tap (`barrierDismissible: false`), so a terminal message (e.g. the account is
/// gone) is always read, never dismissed by accident.
///
/// #2690 — it uses the ONE confirmation surface: a bottom sheet on phones, a
/// centred dialog on wide screens. It is never dismissible by tapping outside.
Future<void> showBbAlert(
  BuildContext context, {
  required String title,
  required String message,
  String okLabel = 'Theek hai',
}) async {
  // This alert carries a terminal error (e.g. the account is gone): the error
  // tick lands as it appears.
  AppHaptics.error();
  await _showBbMessage(
    context,
    title: title,
    body: Text(
      message,
      style: AppTypography.body(
        size: AppTypography.sizeMd,
        color: AppColors.textSecondary,
      ),
    ),
    confirmLabel: okLabel,
    cancelLabel: null,
    destructive: false,
    barrierDismissible: false,
  );
}

/// Shows the BadaBhai confirm — the ONE two-button confirmation surface for a
/// consequential choice (#2690, rule 4): a bottom sheet on phones, a centred
/// dialog on wide screens. The [title] names the action, [message] (or [body])
/// gives the consequence in one line, and the buttons are Cancel plus the verb.
///
/// [destructive] is only for irreversible actions (it makes the confirm crimson
/// and starts focus on Cancel). A tap outside reads as cancel and returns
/// `false`, the safe default. Returns `true` only when the payer confirms.
Future<bool> showBbConfirm(
  BuildContext context, {
  required String title,
  required String message,
  Widget? body,
  required String confirmLabel,
  String cancelLabel = 'Rehne do',
  bool destructive = false,
  IconData? confirmIcon,
  bool confirmHaptic = true,
}) async {
  final bool? result = await _showBbMessage(
    context,
    title: title,
    body: body ??
        Text(
          message,
          style: AppTypography.body(
            size: AppTypography.sizeMd,
            color: AppColors.textSecondary,
          ),
        ),
    confirmLabel: confirmLabel,
    cancelLabel: cancelLabel,
    destructive: destructive,
    barrierDismissible: true,
    confirmIcon: confirmIcon,
    confirmHaptic: confirmHaptic,
  );
  return result ?? false;
}

Future<bool?> _showBbMessage(
  BuildContext context, {
  required String title,
  required Widget body,
  required String confirmLabel,
  required String? cancelLabel,
  required bool destructive,
  required bool barrierDismissible,
  IconData? confirmIcon,
  bool confirmHaptic = true,
}) {
  final bool wide = MediaQuery.sizeOf(context).shortestSide >= 600;
  final Widget content = _BbConfirmContent(
    title: title,
    body: body,
    confirmLabel: confirmLabel,
    cancelLabel: cancelLabel,
    destructive: destructive,
    confirmIcon: confirmIcon,
    confirmHaptic: confirmHaptic,
  );

  if (wide) {
    return showDialog<bool>(
      context: context,
      barrierDismissible: barrierDismissible,
      barrierColor: AppColors.scrim,
      builder: (BuildContext dialogContext) => Dialog(
        backgroundColor: AppColors.surfaceCard,
        surfaceTintColor: Colors.transparent,
        // Design law §4: separation is the scrim + fill, never a shadow.
        elevation: 0,
        insetPadding: const EdgeInsets.all(AppSpacing.s6),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.xl)),
          side: BorderSide(color: AppColors.border),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.s5),
            child: content,
          ),
        ),
      ),
    );
  }

  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: barrierDismissible,
    isDismissible: barrierDismissible,
    enableDrag: barrierDismissible,
    backgroundColor: AppColors.surfaceCard,
    barrierColor: AppColors.scrim,
    sheetAnimationStyle: AppMotion.sheetStyle(context),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
    ),
    builder: (BuildContext sheetContext) {
      final double bottomInset = MediaQuery.viewInsetsOf(sheetContext).bottom;
      return SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          AppSpacing.gutter,
          AppSpacing.s2,
          AppSpacing.gutter,
          AppSpacing.s5 + bottomInset,
        ),
        child: content,
      );
    },
  );
}

class _BbConfirmContent extends StatelessWidget {
  const _BbConfirmContent({
    required this.title,
    required this.body,
    required this.confirmLabel,
    required this.cancelLabel,
    required this.destructive,
    required this.confirmIcon,
    required this.confirmHaptic,
  });

  final String title;
  final Widget body;
  final String confirmLabel;
  final String? cancelLabel;
  final bool destructive;
  final IconData? confirmIcon;
  final bool confirmHaptic;

  @override
  Widget build(BuildContext context) {
    final String? cancel = cancelLabel;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          title,
          style: AppTypography.heading(size: AppTypography.sizeLg),
        ),
        const SizedBox(height: AppSpacing.s2),
        body,
        const SizedBox(height: AppSpacing.s6),
        Row(
          children: <Widget>[
            if (cancel != null) ...<Widget>[
              Expanded(
                child: BbButton(
                  label: cancel,
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.md,
                  autofocus: destructive,
                  onPressed: () => Navigator.of(context).pop(false),
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
            ],
            Expanded(
              child: BbButton(
                label: confirmLabel,
                iconLeft: confirmIcon,
                variant: destructive
                    ? BbButtonVariant.danger
                    : BbButtonVariant.primary,
                size: BbButtonSize.md,
                onPressed: () {
                  if (confirmHaptic) AppHaptics.confirm();
                  Navigator.of(context).pop(true);
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}
