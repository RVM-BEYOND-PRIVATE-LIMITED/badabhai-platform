import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_alert_dialog.dart';
import '../theme/bb_palette.dart';

/// The unlock CTA label on every candidate card — the spend in CREDITS, never a
/// ₹ price (#2589: no payment information of any kind in the app).
const String kUnlockCreditLabel = '1 credit';

/// The unlock confirmation — the ONE confirm sheet (#2690, rule 4): it names
/// the candidate (their redacted feed name), states the spend in credits only
/// ("1 credit will be used — N left after"; no ₹ amount, #2589), and carries the
/// deep-blue fair-use note. Confirm returns `true`.
///
/// The redacted name is passed in (the dialog never receives the real name);
/// the fair-use note states the unlock NEVER changes a worker's ranking.
/// [creditsAfter] is `null` when the balance is UNKNOWN (fetch failed) — the
/// preview then renders an honest '—', never a fabricated 0 (#189 fast-follow).
Future<bool?> showUnlockDialog(
  BuildContext context, {
  required String shownName,
  required int? creditsAfter,
  int credits = 1,
}) {
  final String price =
      credits == 0 ? 'Free' : '$credits ${credits == 1 ? 'credit' : 'credits'}';
  return showBbConfirm(
    context,
    title: credits == 0 ? 'Open this contact?' : 'Unlock this candidate?',
    message: '',
    body: _UnlockBody(
      shownName: shownName,
      creditsAfter: creditsAfter,
      credits: credits,
    ),
    confirmLabel: credits == 0 ? 'Open (free)' : 'Unlock for $price',
    cancelLabel: 'Cancel',
    confirmIcon: Icons.lock_open_rounded,
    // #2596 — the unlock's ONE medium haptic lands with the success stamp once
    // the server granted it, so the confirm itself does not buzz.
    confirmHaptic: false,
  );
}

/// #2750 — the honest not-enough-credits answer: no generic error, and the
/// Starter pack is the offered next step. Returns true when the payer asks to
/// see the Credits tab.
Future<bool> showInsufficientCreditsDialog(
  BuildContext context, {
  required int creditsNeeded,
  required int creditsAvailable,
}) {
  return showBbConfirm(
    context,
    title: 'Not enough credits',
    message:
        'You need $creditsNeeded ${creditsNeeded == 1 ? 'credit' : 'credits'}, '
        'you have $creditsAvailable. The Starter pack has more credits.',
    confirmLabel: 'Starter pack',
    cancelLabel: 'Close',
    confirmIcon: Icons.workspace_premium_rounded,
  );
}

class _UnlockBody extends StatelessWidget {
  const _UnlockBody({
    required this.shownName,
    required this.creditsAfter,
    required this.credits,
  });

  final String shownName;
  final int? creditsAfter;
  final int credits;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        RichText(
          text: TextSpan(
            style: AppTypography.body(
              size: AppTypography.sizeBase,
              color: p.textSecondary,
              height: 1.5,
            ),
            children: <InlineSpan>[
              const TextSpan(text: "You'll see "),
              TextSpan(
                text: shownName,
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                  color: p.textPrimary,
                ),
              ),
              const TextSpan(text: "'s real name and phone number. "),
              TextSpan(
                text: credits == 0
                    ? 'No credits'
                    : '$credits ${credits == 1 ? 'credit' : 'credits'}',
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                  color: p.textPrimary,
                ),
              ),
              TextSpan(text: credits == 0 ? ' will be used — ' : ' will be used — '),
              TextSpan(
                text: '${creditsAfter ?? '—'} left',
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                  color: p.textPrimary,
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
            color: p.infoBg,
            borderRadius: BorderRadius.circular(AppRadii.sm),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(Icons.info_rounded, size: 18, color: p.infoTitle),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  'Fair-use: up to 3 unlocks per worker per week. '
                  "Unlocking never changes a worker's ranking.",
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: p.infoTitle,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
