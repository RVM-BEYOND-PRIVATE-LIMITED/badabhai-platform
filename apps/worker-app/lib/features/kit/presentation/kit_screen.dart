import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../domain/interview_kit.dart';
import 'cubit/kit_list_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';

/// Interview-kit list — the per-trade prep packs.
///
/// It keeps the shell's bottom bar (no own `bottomNavigationBar`) because it
/// sits inside the PROFILE tab (WA-3: it is entered from Profile, so back must
/// land on Profile).
///
/// v3 chrome: the compact [ShiftBlueHeader] every PUSHED screen uses — back
/// arrow and title on one row, no brand badge (the worker is mid-flow, not on a
/// tab root).
class KitScreen extends StatelessWidget {
  const KitScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<KitListCubit>(
      create: (_) => locator<KitListCubit>()..load(),
      child: const _KitView(),
    );
  }
}

class _KitView extends StatelessWidget {
  const _KitView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          // One header for every state — the chrome stays put through loading
          // and failure instead of being rebuilt per branch.
          ShiftBlueHeader(
            title: 'Interview kit',
            compact: true,
            // Matches this screen's 600 body column.
            maxWidth: OnboardingLayout.maxTabContentWidth,
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: BlocBuilder<KitListCubit, KitListState>(
              builder: (BuildContext context, KitListState state) {
                return switch (state.status) {
                  KitListStatus.loading => const BbStatusView.loading(),
                  KitListStatus.failed => BbStatusView(
                    icon: failureReason(state.failure).icon,
                    title: 'Kit load nahi hui.',
                    subtitle: failureReason(state.failure).reason,
                    action: FilledButton(
                      onPressed: () => context.read<KitListCubit>().load(),
                      child: const Text('Try again'),
                    ),
                  ),
                  KitListStatus.ready => _list(context, state.items),
                };
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _list(BuildContext context, List<KitListItem> items) {
    final List<Widget> rows = <Widget>[
      for (final KitListItem item in items)
        BbListRow.kit(
          icon: Icons.build_outlined,
          title: item.title,
          subtitle: item.subtitle,
          onTap: () => context.pushOnce('${Routes.kitDetail}/${item.tradeKey}'),
        ),
      // Coming-soon stub for the alpha — the per-day interview checklist
      // (documents / dress / timing) is a follow-up; tapping just nudges.
      BbListRow.kit(
        icon: Icons.assignment_outlined,
        iconBg: OnboardingColors.successBg,
        iconColor: OnboardingColors.successGreen,
        title: 'Interview din ki checklist',
        subtitle: 'Documents · pehnaava · timing',
        onTap: () => ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(const SnackBar(content: Text('Jald aa raha hai'))),
      ),
    ];

    final EdgeInsets side = KitInsets.list(
      MediaQuery.sizeOf(context).width,
      max: OnboardingLayout.maxTabContentWidth,
      gutter: 16,
    );
    return ListView(
      padding: EdgeInsets.fromLTRB(
        side.left,
        16,
        side.right,
        // Plus the floating Feedback pill's band, so it floats over empty
        // canvas rather than the last row. See [FeedbackFabInset].
        24 + FeedbackFabInset.of(context),
      ),
      children: <Widget>[
        Text(
          'Har trade ke common sawaal aur interview taiyari. '
          'Interview se pehle padhein.',
          style: OnboardingTypography.bodyMuted(),
        ),
        const SizedBox(height: 16),
        if (items.isEmpty) ...<Widget>[
          // Honest empty state — the list loaded but returned no kits (not a
          // fake kit, not a false "check internet").
          Text(
            'Abhi koi interview kit available nahi. Thodi der baad dekhein.',
            style: OnboardingTypography.bodyMuted(
              color: OnboardingColors.ink500,
            ),
          ),
          const SizedBox(height: 16),
        ],
        _group(rows),
      ],
    );
  }

  /// The kit rows grouped into one white card, split by hairlines (kit
  /// grouped-list idiom — [BbListRow.kit] draws no border of its own). The
  /// clip keeps a row's ink splash inside the card's 16dp corners.
  Widget _group(List<Widget> rows) {
    final List<Widget> children = <Widget>[];
    for (int i = 0; i < rows.length; i++) {
      if (i > 0) {
        children.add(
          const Divider(
            height: 1,
            thickness: 1,
            indent: 16,
            endIndent: 16,
            color: OnboardingColors.borderSubtle,
          ),
        );
      }
      children.add(rows[i]);
    }
    return KitCard(
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        child: Column(children: children),
      ),
    );
  }
}
