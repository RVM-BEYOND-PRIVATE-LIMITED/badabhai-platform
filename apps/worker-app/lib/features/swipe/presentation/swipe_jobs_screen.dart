import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_festive_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import 'bloc/swipe_bloc.dart';
import 'bloc/swipe_state.dart';

/// Alpha swipe-to-apply screen (ADR-0009 Stream C).
///
/// Shows one seeded job at a time. APPLY (swipe right / green button) or SKIP
/// (swipe left / outlined button). PII-free coarse fields only. All logic lives
/// in [SwipeBloc]; this widget only renders state and dispatches events.
class SwipeJobsScreen extends StatelessWidget {
  const SwipeJobsScreen({super.key, this.bloc});

  /// Test seam: inject a [SwipeBloc] (over a real repository + MockClient) so the
  /// widget test exercises the exact HTTP paths. Production resolves it from DI.
  final SwipeBloc? bloc;

  @override
  Widget build(BuildContext context) {
    final SwipeBloc? injected = bloc;
    if (injected != null) {
      return BlocProvider<SwipeBloc>.value(
        value: injected,
        child: const _SwipeView(),
      );
    }
    return BlocProvider<SwipeBloc>(
      create: (_) => locator<SwipeBloc>(),
      child: const _SwipeView(),
    );
  }
}

class _SwipeView extends StatefulWidget {
  const _SwipeView();

  @override
  State<_SwipeView> createState() => _SwipeViewState();
}

class _SwipeViewState extends State<_SwipeView> {
  @override
  void initState() {
    super.initState();
    context.read<SwipeBloc>().add(const SwipeFeedRequested());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const BbAppBar(title: 'Jobs for you'),
      body: BlocConsumer<SwipeBloc, SwipeState>(
        // Fire exactly one snackbar per failed apply/skip (the nonce bump).
        listenWhen: (SwipeState prev, SwipeState curr) =>
            prev.decisionError != curr.decisionError,
        listener: (BuildContext context, SwipeState state) {
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              const SnackBar(content: Text('Could not save. Please try again.')),
            );
        },
        builder: (BuildContext context, SwipeState state) {
          return switch (state.status) {
            SwipeStatus.loading => const BbStatusView.loading(),
            SwipeStatus.error => _buildError(context),
            SwipeStatus.consentRequired => _buildConsentRequired(context),
            SwipeStatus.empty => _buildEmpty(context),
            SwipeStatus.ready => _buildCard(context, state),
          };
        },
      ),
    );
  }

  Widget _buildCard(BuildContext context, SwipeState state) {
    final FeedItem job = state.current!;
    final SwipeBloc bloc = context.read<SwipeBloc>();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.s4),
        child: Column(
          children: <Widget>[
            const SizedBox(height: AppSpacing.s2),
            Text(
              'Swipe right to apply, left to skip',
              textAlign: TextAlign.center,
              style: AppTypography.body(color: AppColors.textSecondary),
            ),
            const SizedBox(height: AppSpacing.s3),
            Expanded(
              child: Dismissible(
                key: ValueKey<String>(job.jobId),
                direction: state.deciding
                    ? DismissDirection.none
                    : DismissDirection.horizontal,
                background: _swipeBackground(
                  alignment: Alignment.centerLeft,
                  color: AppColors.green100,
                  foreground: AppColors.green700,
                  icon: Icons.check_circle,
                  label: 'Apply',
                ),
                secondaryBackground: _swipeBackground(
                  alignment: Alignment.centerRight,
                  color: AppColors.surfaceSunken,
                  foreground: AppColors.ink600,
                  icon: Icons.cancel,
                  label: 'Skip',
                ),
                confirmDismiss: (DismissDirection dir) async {
                  if (dir == DismissDirection.startToEnd) {
                    bloc.add(const SwipeApplied());
                  } else {
                    bloc.add(const SwipeSkipped());
                  }
                  // The bloc advances the queue on success; never let Dismissible
                  // also remove the card.
                  return false;
                },
                child: _jobCard(job),
              ),
            ),
            const SizedBox(height: AppSpacing.s4),
            _actionButtons(context, state),
          ],
        ),
      ),
    );
  }

  Widget _jobCard(FeedItem job) {
    return Align(
      alignment: Alignment.topCenter,
      child: BbFestiveCard(
        padding: const EdgeInsets.all(AppSpacing.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: AppColors.brandTint,
                    borderRadius: BorderRadius.circular(AppRadii.md),
                  ),
                  child: const Icon(Icons.work_rounded,
                      size: 26, color: AppColors.brand),
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: Text(
                    job.title,
                    style: AppTypography.display(size: AppTypography.sizeXl),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s6),
            _infoRow(Icons.handyman_outlined, job.tradeKey),
            const SizedBox(height: AppSpacing.s4),
            _infoRow(
              Icons.place_outlined,
              job.area == null ? job.city : '${job.area}, ${job.city}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _infoRow(IconData icon, String text) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 22, color: AppColors.saffronDeep),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: Text(text,
              style: AppTypography.body(size: AppTypography.sizeMd)),
        ),
      ],
    );
  }

  Widget _actionButtons(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    return Row(
      children: <Widget>[
        Expanded(
          child: OutlinedButton.icon(
            key: const Key('swipeSkipButton'),
            onPressed:
                state.deciding ? null : () => bloc.add(const SwipeSkipped()),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(56),
            ),
            icon: const Icon(Icons.close_rounded),
            label: const Text('Skip', style: TextStyle(fontSize: 18)),
          ),
        ),
        const SizedBox(width: AppSpacing.s4),
        Expanded(
          child: FilledButton.icon(
            key: const Key('swipeApplyButton'),
            onPressed:
                state.deciding ? null : () => bloc.add(const SwipeApplied()),
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(56),
            ),
            icon: const Icon(Icons.check_rounded),
            label: const Text('Apply', style: TextStyle(fontSize: 18)),
          ),
        ),
      ],
    );
  }

  Widget _swipeBackground({
    required Alignment alignment,
    required Color color,
    required Color foreground,
    required IconData icon,
    required String label,
  }) {
    return Container(
      alignment: alignment,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s7),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(icon, size: 40, color: foreground),
          const SizedBox(height: AppSpacing.s1),
          Text(label,
              style: AppTypography.display(
                  size: AppTypography.sizeBase, color: foreground)),
        ],
      ),
    );
  }

  Widget _buildEmpty(BuildContext context) {
    return BbStatusView(
      icon: Icons.check_circle_outline_rounded,
      iconColor: AppColors.success,
      title: 'No more jobs right now.',
      subtitle: 'Check back later for new jobs.',
      action: FilledButton(
        onPressed: () =>
            context.read<SwipeBloc>().add(const SwipeFeedRequested()),
        child: const Text('Refresh'),
      ),
    );
  }

  Widget _buildError(BuildContext context) {
    return BbStatusView(
      icon: Icons.cloud_off_rounded,
      iconColor: AppColors.textMuted,
      title: 'Could not load jobs.',
      subtitle: 'Please check your internet and try again.',
      action: FilledButton(
        onPressed: () =>
            context.read<SwipeBloc>().add(const SwipeFeedRequested()),
        child: const Text('Try again'),
      ),
    );
  }

  Widget _buildConsentRequired(BuildContext context) {
    return BbStatusView(
      icon: Icons.privacy_tip_outlined,
      iconColor: AppColors.brand,
      title: 'Please accept consent to see jobs.',
      subtitle: 'It only takes a moment.',
      action: FilledButton(
        onPressed: () => context.go(Routes.consent),
        child: const Text('Go to consent'),
      ),
    );
  }
}

