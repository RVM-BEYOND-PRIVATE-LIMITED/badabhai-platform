import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
import '../../../core/widgets/bb_toast.dart';
import 'cubit/referral_cubit.dart';

/// Agency Refer-&-earn — the agent's shareable invite link + the referral
/// FUNNEL summary (created / clicked / accepted). Agent-only (the routes 403 for
/// a company session, so this is only reachable from the agency Account entry).
///
/// PII-free: an opaque invite code + link and aggregate counts (k-anon floor
/// applied server-side). NO per-worker rows exist on this seam. Payouts / KYC
/// remain launch-gated and are intentionally absent here.
class ReferralScreen extends StatelessWidget {
  const ReferralScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ReferralCubit>(
      create: (_) => locator<ReferralCubit>()..load(),
      child: const _ReferralView(),
    );
  }
}

class _ReferralView extends StatelessWidget {
  const _ReferralView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _Header(onBack: () => Navigator.of(context).pop()),
            Expanded(
              child: BlocBuilder<ReferralCubit, ReferralState>(
                builder: (BuildContext context, ReferralState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, ReferralState state) {
    switch (state.status) {
      case ReferralStatus.initial:
      case ReferralStatus.loading:
        return const BbStatusView.loading(caption: 'Loading…');
      case ReferralStatus.error:
        return BbStatusView(
          icon: Icons.wifi_off,
          title: 'Could not load',
          subtitle: 'Please check your connection and try again.',
          action: BbButton(
            label: 'Retry',
            onPressed: () => context.read<ReferralCubit>().load(),
          ),
        );
      case ReferralStatus.ready:
        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Text(
              'Invite workers you know. When they join and get placed, you earn.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
                height: 1.45,
              ),
            ),
            const SizedBox(height: AppSpacing.s4),
            if (state.link != null) _LinkCard(link: state.link!),
            const SizedBox(height: AppSpacing.s5),
            Text(
              'Your funnel',
              style: AppTypography.display(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            if (state.summary != null) _FunnelCard(summary: state.summary!),
          ],
        );
    }
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Text(
            'Refer & earn',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

/// The shareable invite link + code, with a copy action that also records the
/// share (a best-effort funnel signal).
class _LinkCard extends StatelessWidget {
  const _LinkCard({required this.link});

  final ReferralLink link;

  Future<void> _copy(BuildContext context) async {
    final ReferralCubit cubit = context.read<ReferralCubit>();
    await Clipboard.setData(ClipboardData(text: link.url));
    // Record the share as a soft funnel signal (fire-and-forget).
    await cubit.recordShare();
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Link copied',
      message: 'Share it on WhatsApp with workers you trust.',
      icon: Icons.check_circle,
    );
  }

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Your invite link',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            link.url,
            style: AppTypography.mono(
              size: AppTypography.sizeBase,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            'Code ${link.code}',
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: 'Copy link',
            iconLeft: Icons.copy,
            block: true,
            onPressed: () => _copy(context),
          ),
        ],
      ),
    );
  }
}

/// Aggregate funnel counts. A k-anon floor is applied server-side — a `0` may
/// mean "below the floor", so we say so instead of implying literally none.
class _FunnelCard extends StatelessWidget {
  const _FunnelCard({required this.summary});

  final ReferralsSummary summary;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              _Stat(label: 'Invited', value: summary.created),
              _Stat(label: 'Clicked', value: summary.clicked),
              _Stat(label: 'Joined', value: summary.accepted),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Small counts (under ${summary.minBucket}) are hidden to protect '
            'privacy, so a 0 can mean "just a few".',
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
              height: 1.45,
            ),
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            '$value',
            style: AppTypography.display(
              size: AppTypography.sizeXl,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}
