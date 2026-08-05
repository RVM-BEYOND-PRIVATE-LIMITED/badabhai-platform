import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
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
        body: Column(
          children: <Widget>[
            _header(context),
            Expanded(
              child: BlocBuilder<NotificationsCubit, NotificationsState>(
                builder: (BuildContext context, NotificationsState state) {
                  return switch (state.status) {
                    NotificationsStatus.loading => const BbStatusView.loading(),
                    NotificationsStatus.failed => BbStatusView(
                        icon: failureReason(state.failure).icon,
                        title: 'Alerts load nahi hue.',
                        subtitle: failureReason(state.failure).reason,
                        action: FilledButton(
                          // Retry behaves like re-opening the tab: a successful
                          // load marks the alerts read and clears the badge.
                          onPressed: () => context
                              .read<NotificationsCubit>()
                              .loadAndMarkRead(),
                          child: const Text('Try again'),
                        ),
                      ),
                    NotificationsStatus.empty => const BbStatusView(
                        icon: Icons.notifications_none_rounded,
                        title: 'Abhi koi alert nahi',
                        subtitle:
                            'Resume, profile aur account updates yahin dikhenge.',
                      ),
                    NotificationsStatus.ready => _list(state.items),
                  };
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Full-bleed blue header — kit language (blue = structure / trust). Copy is
  /// deliberately faceless: no employer/pay/phone content ever reaches this bar.
  Widget _header(BuildContext context) {
    return Container(
      width: double.infinity,
      color: AppColors.blue,
      padding: EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        MediaQuery.of(context).padding.top + AppSpacing.s3,
        AppSpacing.gutter,
        AppSpacing.s3,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Alerts is PUSHED full-screen from the header bell now (it lost its
          // bottom-nav tab in the kit 4-tab set), so it must carry its own back
          // affordance — a tab never needed one.
          if (Navigator.of(context).canPop()) ...<Widget>[
            IconButton(
              tooltip: 'Wapas',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.arrow_back, color: AppColors.onBlue),
              // Navigator (not go_router's context.pop): a go_router push still
              // creates a Navigator route, so this pops correctly AND does not
              // require a GoRouter ancestor — keeps the screen pumpable in a bare
              // MaterialApp widget test.
              onPressed: () => Navigator.of(context).maybePop(),
            ),
            const SizedBox(width: AppSpacing.s3),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Alerts',
                    style: AppTypography.display(
                        size: AppTypography.sizeXl,
                        weight: FontWeight.w800,
                        color: AppColors.onBlue)),
                const SizedBox(height: 2),
                Text('Aapke saare updates',
                    style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: AppColors.onBlueMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The alerts grouped into one white card; each row supplies its own hairline
  /// divider (kit grouped-list idiom, no shadows).
  Widget _list(List<AppNotification> items) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      children: <Widget>[
        Container(
          decoration: BoxDecoration(
            color: AppColors.surfaceCard,
            borderRadius: BorderRadius.circular(AppRadii.lg),
            border: Border.all(color: AppColors.borderSubtle),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: <Widget>[
              for (final AppNotification n in items) _row(n),
            ],
          ),
        ),
      ],
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
    final Widget row = BbListRow.notification(
      icon: icon,
      tone: tone,
      title: n.title,
      subtitle: n.subtitle,
      time: n.time,
    );
    // Unread marker — a small haldi dot in the left gutter. Opening the tab
    // marks everything read, so this shows only genuinely-unread alerts (and
    // clears on the same visit); read rows render the plain row.
    if (n.read) return row;
    return Stack(
      children: <Widget>[
        row,
        Positioned(
          left: AppSpacing.s1,
          top: 0,
          bottom: 0,
          child: Center(
            child: Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(
                color: AppColors.haldi,
                shape: BoxShape.circle,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
