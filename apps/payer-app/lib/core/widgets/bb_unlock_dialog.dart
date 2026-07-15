import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_button.dart';

/// The unlock confirmation — `.bb-dialog` over a scrim. Names the candidate
/// (their redacted feed name), states the spend ("1 credit (₹40) used —
/// N left after"), and carries the teal fair-use note. Confirm returns `true`.
///
/// The redacted name is passed in (the dialog never receives the real name);
/// the fair-use note states the unlock NEVER changes a worker's ranking.
/// [creditsAfter] is `null` when the balance is UNKNOWN (fetch failed) — the
/// preview then renders an honest '—', never a fabricated 0 (#189 fast-follow).
Future<bool?> showUnlockDialog(
  BuildContext context, {
  required String shownName,
  required int? creditsAfter,
}) {
  return showDialog<bool>(
    context: context,
    barrierColor: AppColors.scrim,
    builder: (BuildContext context) => _UnlockDialog(
      shownName: shownName,
      creditsAfter: creditsAfter,
    ),
  );
}

class _UnlockDialog extends StatelessWidget {
  const _UnlockDialog({
    required this.shownName,
    required this.creditsAfter,
  });

  final String shownName;
  final int? creditsAfter;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppColors.surfaceCard,
      insetPadding: const EdgeInsets.all(AppSpacing.s6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.xl),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.s5),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                'Unlock this candidate?',
                style: AppTypography.display(size: AppTypography.sizeLg),
              ),
              const SizedBox(height: AppSpacing.s3),
              RichText(
                text: TextSpan(
                  style: AppTypography.body(
                    size: AppTypography.sizeBase,
                    color: AppColors.textSecondary,
                    height: 1.5,
                  ),
                  children: <InlineSpan>[
                    const TextSpan(text: "You'll see "),
                    TextSpan(
                      text: shownName,
                      style: AppTypography.body(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const TextSpan(text: "'s real name and phone number. "),
                    TextSpan(
                      text: '1 credit (₹40)',
                      style: AppTypography.body(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const TextSpan(text: ' will be used — '),
                    TextSpan(
                      text: '${creditsAfter ?? '—'} left',
                      style: AppTypography.body(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const TextSpan(text: ' after this.'),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.s4),
              Container(
                padding: const EdgeInsets.all(AppSpacing.s3),
                decoration: BoxDecoration(
                  color: AppColors.infoTint,
                  borderRadius: BorderRadius.circular(AppRadii.sm),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Icon(Icons.info, size: 18, color: AppColors.teal700),
                    const SizedBox(width: AppSpacing.s2),
                    Expanded(
                      child: Text(
                        'Fair-use: up to 3 unlocks per worker per week. '
                        "Unlocking never changes a worker's ranking.",
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.teal700,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.s5),
              BbButton(
                label: 'Unlock for ₹40',
                iconLeft: Icons.lock_open,
                block: true,
                onPressed: () => Navigator.of(context).pop(true),
              ),
              const SizedBox(height: AppSpacing.s2),
              BbButton(
                label: 'Cancel',
                variant: BbButtonVariant.ghost,
                block: true,
                onPressed: () => Navigator.of(context).pop(false),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
