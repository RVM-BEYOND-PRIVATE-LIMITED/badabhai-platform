import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../domain/app_notification.dart';
import 'cubit/notifications_cubit.dart';

/// Alerts / notifications (spec §5.11). Mark-all-read clears the bottom-nav
/// unread badge (the repository owns the reactive count).
class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<NotificationsCubit>(
      create: (_) => locator<NotificationsCubit>()..load(),
      child: const _NotificationsView(),
    );
  }
}

class _NotificationsView extends StatelessWidget {
  const _NotificationsView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: BbAppBar(
        title: 'Alerts',
        actions: <Widget>[
          IconButton(
            tooltip: 'Mark all read',
            icon: const Icon(Icons.check),
            onPressed: () => context.read<NotificationsCubit>().markAllRead(),
          ),
        ],
      ),
      body: BlocBuilder<NotificationsCubit, NotificationsState>(
        builder: (BuildContext context, NotificationsState state) {
          return switch (state.status) {
            NotificationsStatus.loading => const BbStatusView.loading(),
            NotificationsStatus.failed => BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Alerts load nahi hue.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: () => context.read<NotificationsCubit>().load(),
                  child: const Text('Try again'),
                ),
              ),
            NotificationsStatus.empty => const BbStatusView(
                icon: Icons.notifications_none_rounded,
                title: 'Abhi koi alert nahi',
                subtitle: 'Naye job aur updates yahin dikhenge.',
              ),
            NotificationsStatus.ready => ListView(
                padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.gutter, vertical: AppSpacing.s2),
                children: <Widget>[
                  for (final AppNotification n in state.items)
                    _row(n),
                ],
              ),
          };
        },
      ),
    );
  }

  Widget _row(AppNotification n) {
    final (IconData icon, BbNotiTone tone) = switch (n.kind) {
      NotificationKind.newJob => (Icons.work, BbNotiTone.green),
      NotificationKind.profileViewed => (
          Icons.visibility_outlined,
          BbNotiTone.saffron
        ),
      NotificationKind.resumeReady => (Icons.description, BbNotiTone.brand),
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
