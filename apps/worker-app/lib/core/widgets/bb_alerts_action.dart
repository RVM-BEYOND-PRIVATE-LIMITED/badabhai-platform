import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/notifications/domain/notifications_repository.dart';
import '../../router.dart';
import '../di/locator.dart';
import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// App-bar action that opens the Alerts / notifications screen.
///
/// Notifications lost their bottom-nav tab in the kit's 4-tab set
/// (Jobs · Resume · Bada Bhai · Profile). This bell is the relocated entry
/// point: it pushes [Routes.alerts] FULL-SCREEN onto the root navigator (the
/// screen supplies its own back affordance) and overlays the reactive unread
/// count from [NotificationsRepository.unreadCount] — the SAME source the old
/// nav badge read, so the shell's on-open `refresh()` still lights it.
///
/// Mirrors [BbChatAction]: a themed header [IconButton]. When the notifications
/// repository is not wired (partial-locator widget tests) it degrades to a
/// plain, badge-less bell — the entry point still works, it just cannot show a
/// count.
class BbAlertsAction extends StatelessWidget {
  const BbAlertsAction({super.key, this.color = AppColors.brand});

  /// Bell icon colour. Defaults to haldi [AppColors.brand]; pass
  /// [AppColors.onBlue] on the blue swipe header where haldi collides with the
  /// haldi headline.
  final Color color;

  @override
  Widget build(BuildContext context) {
    if (!locator.isRegistered<NotificationsRepository>()) {
      return _bell(context, 0);
    }
    return ValueListenableBuilder<int>(
      valueListenable: locator<NotificationsRepository>().unreadCount,
      builder: (BuildContext context, int unread, Widget? _) =>
          _bell(context, unread),
    );
  }

  Widget _bell(BuildContext context, int unread) {
    return IconButton(
      tooltip: 'Alerts',
      onPressed: () => context.push(Routes.alerts),
      icon: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Icon(Icons.notifications_outlined, color: color),
          if (unread > 0)
            Positioned(
              top: -4,
              right: -6,
              child: _Badge(count: unread),
            ),
        ],
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 16),
      height: 16,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s1),
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: AppColors.danger,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
      ),
      child: Text(
        '$count',
        textAlign: TextAlign.center,
        style: AppTypography.body(
          size: AppTypography.size2xs,
          weight: FontWeight.w700,
          // White on the crimson badge — deep-blue textOnBrand read as dark.
          color: AppColors.onBlue,
        ),
      ),
    );
  }
}
