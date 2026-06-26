import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import 'bloc/swipe_bloc.dart';
import 'bloc/swipe_state.dart';
import 'widgets/filters_sheet.dart';
import 'widgets/job_deck.dart';

/// The Jobs tab — the rich swipe-to-apply Feed (spec §5.5 / `.aw-feed`).
///
/// Header + filter chips + the [JobDeck] card deck + swipe hint. All business
/// logic stays in [SwipeBloc]; this widget renders state and dispatches events.
/// The real feed contract ([FeedItem] / getFeed) is PII-free and unchanged — the
/// rich card fields are MOCK-ONLY display data (see [_mockCardData]).
class SwipeJobsScreen extends StatelessWidget {
  const SwipeJobsScreen({super.key, this.bloc});

  /// Test seam: inject a [SwipeBloc] over a real repository + MockClient.
  final SwipeBloc? bloc;

  @override
  Widget build(BuildContext context) {
    final SwipeBloc? injected = bloc;
    if (injected != null) {
      return BlocProvider<SwipeBloc>.value(
        value: injected,
        child: const _FeedView(),
      );
    }
    return BlocProvider<SwipeBloc>(
      create: (_) => locator<SwipeBloc>(),
      child: const _FeedView(),
    );
  }
}

class _FeedView extends StatefulWidget {
  const _FeedView();

  @override
  State<_FeedView> createState() => _FeedViewState();
}

class _FeedViewState extends State<_FeedView> {
  // Filter chips are visual-only on the Feed (real filtering lives in the
  // Filters sheet, stage 4). CNC is pre-selected to match the spec.
  final Set<String> _chips = <String>{'CNC'};

  /// The card the worker just applied to, captured at dispatch time so the
  /// Applied screen can show its details once the apply truly succeeds.
  BbJobCardData? _pendingApplied;
  int _shownAppliedNonce = 0;
  int _shownDecisionError = 0;

  /// Session-only filter selection (real filtered-feed query is a follow-up).
  FilterSelection _filters = FilterSelection.initial;

  @override
  void initState() {
    super.initState();
    context.read<SwipeBloc>().add(const SwipeFeedRequested());
  }

  void _toggleChip(String key) {
    setState(() => _chips.contains(key) ? _chips.remove(key) : _chips.add(key));
  }

  Future<void> _openFilters(BuildContext context) async {
    final FilterSelection? result = await showBbBottomSheet<FilterSelection>(
      context: context,
      builder: (_) => FiltersSheet(initial: _filters),
    );
    // Remember the selection (real filtered-feed query is a follow-up, §7).
    if (result != null && mounted) setState(() => _filters = result);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: BlocConsumer<SwipeBloc, SwipeState>(
          listenWhen: (SwipeState prev, SwipeState curr) =>
              prev.decisionError != curr.decisionError ||
              prev.appliedNonce != curr.appliedNonce,
          listener: (BuildContext context, SwipeState state) {
            if (state.appliedNonce != _shownAppliedNonce) {
              _shownAppliedNonce = state.appliedNonce;
              // Apply truly succeeded — now show the Applied confirmation.
              context.push(Routes.applied, extra: _pendingApplied);
            } else if (state.decisionError != _shownDecisionError) {
              _shownDecisionError = state.decisionError;
              ScaffoldMessenger.of(context)
                ..clearSnackBars()
                ..showSnackBar(
                  const SnackBar(
                      content: Text('Could not save. Please try again.')),
                );
            }
          },
          builder: (BuildContext context, SwipeState state) {
            return switch (state.status) {
              SwipeStatus.loading => const BbStatusView.loading(),
              SwipeStatus.error => _error(context),
              SwipeStatus.consentRequired => _consentRequired(context),
              SwipeStatus.empty => _empty(context),
              SwipeStatus.ready => _feed(context, state),
            };
          },
        ),
      ),
    );
  }

  Widget _feed(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    final FeedItem head = state.current!;
    final List<JobDeckItem> cards = state.queue
        .map((FeedItem i) => JobDeckItem(id: i.jobId, data: _mockCardData(i)))
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(context),
        _chipRow(),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter, AppSpacing.s2, AppSpacing.gutter, 0),
            child: JobDeck(
              cards: cards,
              deciding: state.deciding,
              onTitleTap: (String id) =>
                  context.push('${Routes.jobDetail}/$id'),
              onSkip: () => bloc.add(const SwipeSkipped()),
              onApply: () {
                // Capture the card now; navigate to Applied only once the bloc
                // confirms success (appliedNonce bump in the listener above).
                _pendingApplied = _mockCardData(head);
                bloc.add(const SwipeApplied());
              },
            ),
          ),
        ),
        _swipeHint(),
      ],
    );
  }

  Widget _header(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s3, AppSpacing.s3, AppSpacing.s3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('JOBS NEAR YOU', style: AppTypography.eyebrow()),
                const SizedBox(height: 2),
                Row(
                  children: <Widget>[
                    const Icon(Icons.place_outlined,
                        size: 20, color: AppColors.brand),
                    const SizedBox(width: AppSpacing.s1),
                    Text('Pune · 15 km',
                        style: AppTypography.display(
                            size: AppTypography.sizeMd,
                            weight: FontWeight.w800)),
                  ],
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Filter jobs',
            icon: const Icon(Icons.tune),
            onPressed: () => _openFilters(context),
          ),
        ],
      ),
    );
  }

  Widget _chipRow() {
    const List<(String, IconData)> chips = <(String, IconData)>[
      ('CNC', Icons.build_outlined),
      ('VMC', Icons.build_outlined),
      ('Verified', Icons.verified_user_outlined),
      ('Day shift', Icons.schedule),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, 0, AppSpacing.gutter, AppSpacing.s3),
      child: Row(
        children: <Widget>[
          for (final (String label, IconData icon) in chips) ...<Widget>[
            BbChip(
              label: label,
              icon: icon,
              selected: _chips.contains(label),
              onTap: () => _toggleChip(label),
            ),
            const SizedBox(width: AppSpacing.s2),
          ],
        ],
      ),
    );
  }

  Widget _swipeHint() {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const Icon(Icons.swipe, size: 18, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s2),
          Text('Skip · Apply',
              style: AppTypography.body(
                  size: AppTypography.sizeSm, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  Widget _empty(BuildContext context) {
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

  Widget _error(BuildContext context) {
    return BbStatusView(
      icon: Icons.cloud_off_rounded,
      title: 'Could not load jobs.',
      subtitle: 'Please check your internet and try again.',
      action: FilledButton(
        onPressed: () =>
            context.read<SwipeBloc>().add(const SwipeFeedRequested()),
        child: const Text('Try again'),
      ),
    );
  }

  Widget _consentRequired(BuildContext context) {
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

// MOCK-ONLY display fields (company name, pay band, spots-left, requirement
// tags, shift). The real worker-facing job contract is PII-sensitive — CLAUDE.md
// §2 lists employer names as PII — and exposing these on a LIVE endpoint needs an
// ADR ruling first. These values are fabricated client-side for the alpha and are
// NEVER sent to a real /feed, an event, ai_jobs, audit_logs, or a log. The real
// FeedItem/getFeed path stays PII-free and unchanged.
// (Stage 8 moves this synthesis into the MockApiClient.)
BbJobCardData _mockCardData(FeedItem item) {
  const List<String> companies = <String>[
    'Sharma Precision Works',
    'Deccan Auto Components',
    'Kalyani Industries',
    'MIDC Engineering Co.',
  ];
  const List<String> bands = <String>['18–24k', '22–28k', '25–32k', '28–36k'];
  final int seed = item.jobId.hashCode & 0x7fffffff;
  return BbJobCardData(
    title: item.title,
    company: companies[seed % companies.length],
    payBand: bands[seed % bands.length],
    place: item.area == null ? item.city : '${item.area}, ${item.city}',
    shift: seed.isEven ? 'Day' : 'Rotational',
    tags: const <String>['Fanuc', '2+ yrs', 'PF + ESI'],
    spotsLeft: 1 + seed % 5,
  );
}
