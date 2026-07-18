import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/credits_screen_cubit.dart';

/// Credits — the REAL balance (`GET /payer/credits`, ink card) and the REAL
/// credit ledger (`GET /payer/credits/ledger`).
///
/// The purchase surface was REMOVED: there is no payment provider (the
/// "Secure checkout · Razorpay · UPI / card" line described one that does not
/// exist), and the pack catalogue's prices were hardcoded client-side and
/// contradicted the server's pricing catalog. This screen now only REPORTS what
/// the server says the payer has and has spent.
class CreditsScreen extends StatelessWidget {
  const CreditsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<CreditsScreenCubit>(
      create: (_) => locator<CreditsScreenCubit>()..load(),
      child: _CreditsView(onBack: onBack),
    );
  }
}

class _CreditsView extends StatelessWidget {
  const _CreditsView({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CreditsScreenCubit, CreditsScreenState>(
      builder: (BuildContext context, CreditsScreenState state) {
        if (state.status == CreditsScreenStatus.loading ||
            state.status == CreditsScreenStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == CreditsScreenStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<CreditsScreenCubit>().load(),
            ),
          );
        }

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Row(
              children: <Widget>[
                BbIconButton(
                  icon: Icons.arrow_back,
                  semanticLabel: 'Back',
                  onPressed: onBack,
                ),
                const SizedBox(width: AppSpacing.s3),
                // #376 — was 'Buy credits'. The purchase surface was removed
                // (see the class doc above): there is no pack, price, or
                // checkout element anywhere on this screen, so that title
                // promised the one capability it does not have. A payer sent
                // here by Home's "View ledger" with 0 credits would scroll for
                // a buy button that does not exist and conclude the app is
                // broken. The title now names what the screen actually is.
                Text(
                  'Credits',
                  style: AppTypography.display(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s2),
            // #376 — and say the missing capability out loud, so "where do I
            // buy?" is answered on the screen instead of read as a bug. Scoped
            // to this app (which is the true statement) — not a promise about
            // when or where purchasing will appear.
            Text(
              'Buying credits is not available in the app yet.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s4),
            BbCard(
              ink: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    'Current balance',
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.ink300,
                    ),
                  ),
                  RichText(
                    text: TextSpan(
                      style: AppTypography.mono(
                        size: AppTypography.size2xl,
                        weight: FontWeight.w700,
                        color: AppColors.paper0,
                      ),
                      children: <InlineSpan>[
                        TextSpan(text: '${state.balance ?? '—'} '),
                        TextSpan(
                          text: 'unlocks',
                          style: AppTypography.body(
                            size: AppTypography.sizeBase,
                            color: AppColors.ink300,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.s5),
            Text(
              'Unlock ledger',
              style: AppTypography.display(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            BbCard(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
              child: Column(
                children: <Widget>[
                  for (int i = 0; i < state.ledger.length; i++)
                    _LedgerRow(
                      entry: state.ledger[i],
                      showBorder: i < state.ledger.length - 1,
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _LedgerRow extends StatelessWidget {
  const _LedgerRow({required this.entry, required this.showBorder});

  final LedgerEntry entry;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    final Color amountColor = entry.direction == LedgerDirection.credit
        ? AppColors.success
        : AppColors.textMuted;
    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          Text(
            entry.label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
            ),
          ),
          Text(
            entry.amount,
            style: AppTypography.mono(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: amountColor,
            ),
          ),
        ],
      ),
    );
  }
}
