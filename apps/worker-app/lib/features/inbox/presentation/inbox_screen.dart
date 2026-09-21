import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../domain/inbox_models.dart';
import 'cubit/inbox_cubit.dart';

/// The relay inbox (E0 in-app relay, FE #1628): the worker's own threads with
/// payers. FACELESS — the rows carry no counterparty identity because none
/// exists on the wire.
class InboxScreen extends StatelessWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<InboxCubit>(
      create: (_) => locator<InboxCubit>()..load(),
      child: const _InboxView(),
    );
  }
}

class _InboxView extends StatelessWidget {
  const _InboxView();

  @override
  Widget build(BuildContext context) {
    final bool canPop = Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: 'Sandesh',
            subtitle: 'Aapko mile sandesh',
            onBack: canPop ? () => Navigator.of(context).maybePop() : null,
            maxWidth: OnboardingLayout.maxTabContentWidth,
          ),
          Expanded(
            child: BlocBuilder<InboxCubit, InboxState>(
              builder: (BuildContext context, InboxState state) {
                return BbAnimatedSwitcher(
                  child: KeyedSubtree(
                    key: ValueKey<InboxStatus>(state.status),
                    child: switch (state.status) {
                      InboxStatus.loading => const BbStatusView.loading(),
                      InboxStatus.failed => BbStatusView(
                        icon: failureReason(state.failure).icon,
                        title: 'Sandesh load nahi hue.',
                        subtitle: failureReason(state.failure).reason,
                        action: FilledButton(
                          onPressed: () =>
                              context.read<InboxCubit>().load(),
                          child: const Text('Try again'),
                        ),
                      ),
                      InboxStatus.empty => const BbStatusView(
                        icon: Icons.forum_outlined,
                        title: 'Abhi koi sandesh nahi',
                        subtitle:
                            'Jab koi aapko sandesh bhejega, yahan dikhega.',
                      ),
                      InboxStatus.ready => _list(context, state.threads),
                    },
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _list(BuildContext context, List<InboxThread> threads) {
    return KitContentColumn(
      maxWidth: OnboardingLayout.maxTabContentWidth,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: threads.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (BuildContext context, int index) {
          final InboxThread t = threads[index];
          return BbListRow.kit(
            icon: Icons.forum_outlined,
            title: t.hasUnread ? 'Naya sandesh' : 'Sandesh',
            subtitle: _subtitle(t),
            iconBg: t.hasUnread
                ? OnboardingColors.selectedCardBg
                : OnboardingColors.pillMutedBg,
            iconColor: t.hasUnread
                ? OnboardingColors.textOnYellow
                : OnboardingColors.shiftBlue,
            onTap: () => context.pushOnce(Routes.inboxThreadOf(t.unlockId)),
          );
        },
      ),
    );
  }

  String _subtitle(InboxThread t) {
    final String when = _day(t.lastMessageAt);
    return t.hasUnread ? '$when • Naya' : when;
  }
}

/// `YYYY-MM-DD` — never a time-of-day, matching the app's date surfaces.
String _day(DateTime ts) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${ts.year}-${two(ts.month)}-${two(ts.day)}';
}
