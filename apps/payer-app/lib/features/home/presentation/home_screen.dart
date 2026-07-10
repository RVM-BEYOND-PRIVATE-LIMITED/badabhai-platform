import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_stat.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/home_cubit.dart';

/// Home — identity header, (agency) saffron Earn·Supply card, the Hire·Demand
/// hero stat, a 2x2 metric grid, quick actions, and recent activity.
class HomeScreen extends StatelessWidget {
  const HomeScreen({
    super.key,
    required this.session,
    required this.onPost,
    required this.onBrowse,
    required this.onBuyCredits,
    required this.onOpenEarn,
  });

  final AppSession session;
  final VoidCallback onPost;
  final VoidCallback onBrowse;
  final VoidCallback onBuyCredits;
  final VoidCallback onOpenEarn;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<HomeCubit>(
      create: (_) => locator<HomeCubit>()..load(agency: session.isAgency),
      child: _HomeView(
        session: session,
        onPost: onPost,
        onBrowse: onBrowse,
        onBuyCredits: onBuyCredits,
        onOpenEarn: onOpenEarn,
      ),
    );
  }
}

class _HomeView extends StatelessWidget {
  const _HomeView({
    required this.session,
    required this.onPost,
    required this.onBrowse,
    required this.onBuyCredits,
    required this.onOpenEarn,
  });

  final AppSession session;
  final VoidCallback onPost;
  final VoidCallback onBrowse;
  final VoidCallback onBuyCredits;
  final VoidCallback onOpenEarn;

  @override
  Widget build(BuildContext context) {
    final PayerAccount acct = session.account;
    return BlocBuilder<HomeCubit, HomeState>(
      builder: (BuildContext context, HomeState state) {
        if (state.status == HomeStatus.loading ||
            state.status == HomeStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == HomeStatus.error || state.metrics == null) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load',
            subtitle: 'Check your connection and try again.',
            action: BbButton(
              label: 'Retry',
              onPressed: () =>
                  context.read<HomeCubit>().load(agency: session.isAgency),
            ),
          );
        }

        final HomeMetrics m = state.metrics!;
        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            _Header(acct: acct),
            const SizedBox(height: AppSpacing.s4),
            if (session.isAgency && state.earn != null) ...<Widget>[
              _EarnCard(earn: state.earn!, onOpen: onOpenEarn),
              const SizedBox(height: AppSpacing.s4),
            ],
            _eyebrow('Hire · Demand', Icons.work),
            const SizedBox(height: AppSpacing.s2),
            _HeroStat(metrics: m),
            const SizedBox(height: AppSpacing.s4),
            _StatGrid(metrics: m, onBuyCredits: onBuyCredits),
            const SizedBox(height: AppSpacing.s4),
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
            const SizedBox(height: AppSpacing.s5),
            Text(
              'Recent activity',
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
                  for (int i = 0; i < state.activity.length; i++)
                    _ActivityRow(
                      item: state.activity[i],
                      showBorder: i < state.activity.length - 1,
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _eyebrow(String text, IconData icon) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 14, color: AppColors.textMuted),
        const SizedBox(width: 6),
        Text(
          text.toUpperCase(),
          style: AppTypography.eyebrow(color: AppColors.textMuted),
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
        BbIconButton(
          icon: Icons.notifications_outlined,
          semanticLabel: 'Notifications',
          onPressed: () {},
        ),
      ],
    );
  }
}

class _EarnCard extends StatelessWidget {
  const _EarnCard({required this.earn, required this.onOpen});

  final EarnSummary earn;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s4),
      gradient: const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: <Color>[Color(0xFF7A4E08), Color(0xFF3D2A08)],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              Row(
                children: <Widget>[
                  const Icon(Icons.account_balance_wallet,
                      size: 16, color: AppColors.saffron200),
                  const SizedBox(width: 6),
                  Text(
                    'EARN · SUPPLY',
                    style: AppTypography.eyebrow(color: AppColors.saffron200),
                  ),
                ],
              ),
              TextButton(
                onPressed: onOpen,
                style: TextButton.styleFrom(
                  foregroundColor: AppColors.paper0,
                  backgroundColor: Colors.white.withValues(alpha: 0.14),
                  shape: const StadiumBorder(),
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.s3,
                    vertical: AppSpacing.s1,
                  ),
                  minimumSize: const Size(0, 36),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      'Open',
                      style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        weight: FontWeight.w700,
                        color: AppColors.paper0,
                      ),
                    ),
                    const SizedBox(width: 4),
                    const Icon(Icons.arrow_forward,
                        size: 14, color: AppColors.paper0),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              _earnStat(earn.earnedThisMonth, 'Earned this month'),
              const SizedBox(width: AppSpacing.s5),
              _earnStat(earn.pendingPayout, 'Pending payout'),
              const SizedBox(width: AppSpacing.s5),
              _earnStat(earn.inWindow, 'In window'),
            ],
          ),
        ],
      ),
    );
  }

  Widget _earnStat(String value, String label) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          value,
          style: AppTypography.mono(
            size: AppTypography.sizeXl,
            weight: FontWeight.w700,
            color: AppColors.paper0,
          ),
        ),
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.size2xs,
            color: AppColors.saffron100,
          ),
        ),
      ],
    );
  }
}

class _HeroStat extends StatelessWidget {
  const _HeroStat({required this.metrics});

  final HomeMetrics metrics;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      festive: true,
      padding: const EdgeInsets.all(AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Paid unlocks this week',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w600,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            metrics.paidUnlocksThisWeek,
            style: AppTypography.mono(
              size: AppTypography.size4xl,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.trending_up, size: 16, color: AppColors.success),
              const SizedBox(width: 4),
              Text(
                metrics.paidUnlocksDelta,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w600,
                  color: AppColors.success,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatGrid extends StatelessWidget {
  const _StatGrid({required this.metrics, required this.onBuyCredits});

  final HomeMetrics metrics;
  final VoidCallback onBuyCredits;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CreditsCubit, int?>(
      bloc: locator<CreditsCubit>(),
      builder: (BuildContext context, int? credits) {
        // Content-sized 2x2 grid: each row is an IntrinsicHeight so both cards
        // match the taller one AND the height follows the content — no fixed
        // aspect ratio to overflow on larger fonts / smaller devices (responsive).
        final List<Widget> cells = <Widget>[
          BbStat(
            label: 'Repeat-unlock rate',
            value: metrics.repeatUnlockRate,
            icon: Icons.repeat,
            deltaText: 'health metric',
          ),
          BbStat(
            label: 'Credit balance',
            value: '${credits ?? '—'}',
            icon: Icons.lock_open,
            deltaText: 'Buy credits',
            delta: BbStatDelta.up,
            onDeltaTap: onBuyCredits,
          ),
          BbStat(
            label: 'Active jobs',
            value: metrics.activeJobs,
            icon: Icons.work_outline,
            deltaText: metrics.activeJobsNote,
            delta: BbStatDelta.up,
          ),
          BbStat(
            label: 'Candidates for you',
            value: '${metrics.candidatesForYou}',
            icon: Icons.people_outline,
            deltaText: 'relevant now',
            delta: BbStatDelta.up,
          ),
        ];

        Widget row(Widget a, Widget b) => IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Expanded(child: a),
                  const SizedBox(width: AppSpacing.s3),
                  Expanded(child: b),
                ],
              ),
            );

        return Column(
          children: <Widget>[
            row(cells[0], cells[1]),
            const SizedBox(height: AppSpacing.s3),
            row(cells[2], cells[3]),
          ],
        );
      },
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.item, required this.showBorder});

  final ActivityItem item;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg, IconData icon) = switch (item.tone) {
      ActivityTone.success => (
          AppColors.successTint,
          AppColors.green700,
          Icons.lock_open,
        ),
      ActivityTone.brand => (
          AppColors.brandTint,
          AppColors.brandPress,
          Icons.swipe,
        ),
      ActivityTone.warning => (
          AppColors.warningTint,
          AppColors.saffronDeep,
          Icons.warning_amber,
        ),
    };

    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        children: <Widget>[
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
            child: Icon(icon, size: 18, color: fg),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  item.title,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textPrimary,
                  ),
                ),
                Text(
                  item.time,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
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
