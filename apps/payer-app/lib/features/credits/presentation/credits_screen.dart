import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_refresh.dart';
import '../../../core/widgets/bb_skeleton.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_tab_scope.dart';
import 'cubit/credits_screen_cubit.dart';

/// Credits — the REAL balance (`GET /payer/credits`, ink card) and the REAL
/// credit ledger (`GET /payer/credits/ledger`), both READ-ONLY.
///
/// There is NO purchase surface and NO payment information here (#2589, owner
/// ruling 4 Nov 2026): no pack, no price, no "buy on web" pointer. Credits are
/// shown as credits only — never a ₹ amount. Credit packs are bought on the
/// payer WEB portal; this screen only REPORTS the balance and the spend.
class CreditsScreen extends StatelessWidget {
  const CreditsScreen({super.key, this.onBack});

  /// Draws the back arrow when non-null. Null when Credits is a bottom-nav
  /// TAB (M9, #2597): a tab root has nowhere to go back to.
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<CreditsScreenCubit>(
      create: (_) => locator<CreditsScreenCubit>()..load(),
      // #2592 — a return to the tab re-reads the ledger quietly (the shell
      // re-reads the shared balance itself). A no-op on the overlay.
      child: BbTabRefreshListener(
        onRefresh: (BuildContext context) => refreshWithToast(
          context,
          context.read<CreditsScreenCubit>().refresh,
        ),
        child: _CreditsView(onBack: onBack),
      ),
    );
  }
}

class _CreditsView extends StatelessWidget {
  const _CreditsView({required this.onBack});

  /// Draws the back arrow when non-null. Null when Credits is a bottom-nav
  /// TAB (M9, #2597): a tab root has nowhere to go back to.
  final VoidCallback? onBack;

  /// #2592 — pull-to-refresh: the balance and both ledgers, the current ones
  /// staying on screen; a failure says why in a toast. The app-wide balance
  /// (Home, the unlock dialog) is re-read alongside.
  static Future<void> _pullToRefresh(BuildContext context) {
    locator<CreditsCubit>().load();
    return refreshWithToast(
      context,
      context.read<CreditsScreenCubit>().refresh,
    );
  }

  @override
  Widget build(BuildContext context) {
    // #2592 — a balance panel over ledger-line skeletons while it loads; the
    // real screen cross-fades in over them.
    return BbLoadingBuilder<CreditsScreenCubit, CreditsScreenState>(
      isLoading: (CreditsScreenState s) =>
          s.status == CreditsScreenStatus.loading ||
          s.status == CreditsScreenStatus.initial,
      skeleton: const BbSkeletonList(
        header: BbSkeletonHeader(),
        items: <Widget>[BbSkeletonPanel(), BbSkeletonLedgerCard()],
        semanticLabel: 'Loading credits',
      ),
      builder: (BuildContext context, CreditsScreenState state) {
        if (state.status == CreditsScreenStatus.error) {
          final PayerFailure failure =
              state.failure ?? const PayerFailure(PayerFailureKind.unknown);
          return BbStatusView(
            icon: failure.icon,
            title: failure.title,
            subtitle: failure.message,
            action: BbButton(
              label: failure.isSessionExpired ? 'Log in' : 'Retry',
              onPressed: () => context.read<CreditsScreenCubit>().load(),
            ),
          );
        }

        final Widget list = ListView(
          // Over-scrolls even when short, so pull-to-refresh always works.
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Row(
              children: <Widget>[
                if (onBack != null) ...<Widget>[
                  BbIconButton(
                    icon: Icons.arrow_back_rounded,
                    semanticLabel: 'Back',
                    onPressed: onBack,
                  ),
                  const SizedBox(width: AppSpacing.s3),
                ],
                // #376 — was 'Buy credits'. There is no pack, price, or checkout
                // element anywhere on this screen (the purchase lives on the web),
                // so that title promised a capability it does not have. The title
                // now names what the screen actually is.
                Text(
                  'Credits',
                  style: AppTypography.header(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
              ],
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
                        TextSpan(
                            text:
                                '${state.balance != null ? formatIndianGrouped(state.balance!) : '—'} '),
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
            // #376 follow-up — this section reads `GET /payer/credits/ledger`
            // (pack purchases, unlock debits, grants, refunds), so it is the
            // CREDIT ledger. The old 'Unlock ledger' heading mislabelled it; the
            // real per-unlock history is a separate section below.
            Text(
              'Credit ledger',
              style: AppTypography.heading(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            if (state.ledger.isEmpty)
              _EmptyLedger(
                text: 'No credit activity yet.',
              )
            else
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
            // Per-unlock history (`GET /payer/unlocks`). Best-effort — only shown
            // when there is something to show, so a blip never leaves an empty
            // "Unlock history" card on screen.
            if (state.unlockLedger.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.s5),
              Text(
                'Unlock history',
                style: AppTypography.heading(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: AppSpacing.s2),
              BbCard(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
                child: Column(
                  children: <Widget>[
                    for (int i = 0; i < state.unlockLedger.length; i++)
                      _LedgerRow(
                        entry: state.unlockLedger[i],
                        showBorder: i < state.unlockLedger.length - 1,
                      ),
                  ],
                ),
              ),
            ],
          ],
        );
        return BbRefreshIndicator(
          onRefresh: () => _pullToRefresh(context),
          child: list,
        );
      },
    );
  }
}

/// A muted card shown in place of a ledger when there is nothing to list — an
/// honest empty state rather than a bare bordered card.
class _EmptyLedger extends StatelessWidget {
  const _EmptyLedger({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Text(
        text,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
        ),
      ),
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
          Flexible(
            child: Text(
              entry.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
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
