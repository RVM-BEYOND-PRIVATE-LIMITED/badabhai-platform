import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_stat.dart';

/// Home — the identity header, the REAL credit balance, and the two real
/// actions (Post a job · Browse candidates).
///
/// Everything else this screen used to show was fabricated: the "paid unlocks
/// this week" hero, the repeat-unlock-rate / active-jobs / candidates-for-you
/// grid, the agency Earn·Supply ₹ card, and the "Recent activity" feed (which
/// invented rows like "Unlocked Ramesh K. · CNC Setter"). None had a backend
/// route — they were served by a mock the real HTTP client delegated to — so
/// they are REMOVED rather than empty-stated. The balance below is server-truth
/// from `GET /payer/credits` via the shared [CreditsCubit].
class HomeScreen extends StatelessWidget {
  const HomeScreen({
    super.key,
    required this.session,
    required this.onPost,
    required this.onBrowse,
    required this.onOpenCredits,
  });

  final AppSession session;
  final VoidCallback onPost;
  final VoidCallback onBrowse;
  final VoidCallback onOpenCredits;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      children: <Widget>[
        _Header(acct: session.account),
        const SizedBox(height: AppSpacing.s5),
        _CreditBalanceCard(onOpenCredits: onOpenCredits),
        const SizedBox(height: AppSpacing.s5),
        Row(
          children: <Widget>[
            Expanded(
              child: BbButton(
                label: 'Post a job',
                iconLeft: Icons.add_circle_outline,
                onPressed: onPost,
              ),
            ),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: BbButton(
                label: 'Browse',
                variant: BbButtonVariant.secondary,
                iconLeft: Icons.search,
                onPressed: onBrowse,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.acct});

  final PayerAccount acct;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        BbAvatar(initials: acct.initials, size: 44),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                acct.name,
                style: AppTypography.display(
                  size: AppTypography.sizeMd,
                  weight: FontWeight.w700,
                ),
              ),
              Text(
                acct.plan,
                style: AppTypography.body(
                  size: AppTypography.sizeXs,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// The one real figure on Home: the server-truth credit balance. Renders "—"
/// until the first load resolves (and if it fails) — never a fabricated 0.
class _CreditBalanceCard extends StatelessWidget {
  const _CreditBalanceCard({required this.onOpenCredits});

  final VoidCallback onOpenCredits;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CreditsCubit, int?>(
      bloc: locator<CreditsCubit>(),
      builder: (BuildContext context, int? credits) {
        return BbStat(
          label: 'Credit balance',
          value: '${credits ?? '—'}',
          icon: Icons.lock_open,
          deltaText: 'View ledger',
          onDeltaTap: onOpenCredits,
        );
      },
    );
  }
}
