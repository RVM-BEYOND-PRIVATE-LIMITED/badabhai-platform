import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../domain/app_notification.dart';
import 'cubit/notifications_cubit.dart';

/// Alerts / notifications (spec §5.11). Opening the tab marks the rows read and
/// clears the bottom-nav unread badge (the repository owns the reactive count).
class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<NotificationsCubit>(
      // Opening the tab IS the read (T5): load, show, then mark read. The tick
      // action is gone — reading your alerts is not a thing you should have to
      // confirm.
      create: (_) => locator<NotificationsCubit>()..loadAndMarkRead(),
      child: const _NotificationsView(),
    );
  }
}

class _NotificationsView extends StatelessWidget {
  const _NotificationsView();

  @override
  Widget build(BuildContext context) {
    // The IndexedStack keeps this branch mounted, so create: runs only on the
    // FIRST visit — without this, alerts arriving later would never auto-mark
    // and the badge would stay lit forever (T4).
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.alerts,
      onFocused: () => context.read<NotificationsCubit>().loadAndMarkRead(),
      child: Scaffold(
        appBar: const BbAppBar(title: 'Alerts'),
        body: BlocBuilder<NotificationsCubit, NotificationsState>(
          builder: (BuildContext context, NotificationsState state) {
            return switch (state.status) {
              NotificationsStatus.loading => const BbStatusView.loading(),
              NotificationsStatus.failed => BbStatusView(
                  icon: failureReason(state.failure).icon,
                  title: 'Alerts load nahi hue.',
                  subtitle: failureReason(state.failure).reason,
                  action: FilledButton(
                    // Retry behaves like re-opening the tab: a successful load
                    // marks the alerts read and clears the badge.
                    onPressed: () =>
                        context.read<NotificationsCubit>().loadAndMarkRead(),
                    child: const Text('Try again'),
                  ),
                ),
              NotificationsStatus.empty => const BbStatusView(
                  icon: Icons.notifications_none_rounded,
                  title: 'Abhi koi alert nahi',
                  subtitle:
                      'Resume, profile aur account updates yahin dikhenge.',
                ),
              NotificationsStatus.ready => ListView(
                  padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.gutter, vertical: AppSpacing.s2),
                  children: <Widget>[
                    for (final AppNotification n in state.items) _row(n),
                  ],
                ),
            };
          },
        ),
      ),
    );
  }

  Widget _row(AppNotification n) {
    final (IconData icon, BbNotiTone tone) = switch (n.kind) {
      NotificationKind.resumeReady => (Icons.description, BbNotiTone.brand),
      NotificationKind.profileReady => (Icons.badge_outlined, BbNotiTone.green),
      NotificationKind.voiceProcessed => (
          Icons.graphic_eq_rounded,
          BbNotiTone.brand
        ),
      // Green is the DS's "go / success — an applied confirmation" tone; the
      // send glyph matches the app's existing sent affordance (chat/voice).
      NotificationKind.applicationSent => (
          Icons.send_rounded,
          BbNotiTone.green
        ),
      NotificationKind.security => (Icons.security_rounded, BbNotiTone.saffron),
    };
    return BbListRow.notification(
      icon: icon,
      tone: tone,
      title: n.title,
      subtitle: n.subtitle,
      time: n.time,
    );
  }
}
