import 'package:flutter/material.dart';

import '../../features/notifications/domain/notifications_repository.dart';
import '../../router.dart';
import '../di/locator.dart';
import '../theme/onboarding_theme.dart';
import '../../core/util/push_once.dart';

/// Header action that opens the Alerts / notifications screen — UI kit v3 §4's
/// `notifications_outlined` bell.
///
/// Notifications lost their bottom-nav tab in the kit's 4-tab set
/// (Jobs · Resume · Bada Bhai · Profile). This bell is the relocated entry
/// point: it pushes [Routes.alerts] FULL-SCREEN onto the root navigator (the
/// screen supplies its own back affordance) and overlays the reactive unread
/// count from [NotificationsRepository.unreadCount] — the SAME source the old
/// nav badge read, so the shell's on-open `refresh()` still lights it.
///
/// The glyph is painted at [glyphSize] (the spec's 22) inside a
/// [OnboardingLayout.tapTarget] hit box, like every other header action
/// ([KitHeaderIconAction]) — the ink lands where the artboard puts it and the
/// tap area still clears the worker touch floor.
///
/// When the notifications repository is not wired (partial-locator widget
/// tests) it degrades to a plain, badge-less bell — the entry point still
/// works, it just cannot show a count.
class BbAlertsAction extends StatelessWidget {
  const BbAlertsAction({super.key, this.color = OnboardingColors.textOnBlue});

  /// Bell icon colour. Defaults to white, because every header that carries the
  /// bell is the navy band (spec §4). A caller on another surface passes its own
  /// ink.
  final Color color;

  /// The painted glyph size (spec §4: 22 in the navy tab header).
  static const double glyphSize = 22;

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
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      onPressed: () => context.pushOnce(Routes.alerts),
      icon: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Icon(Icons.notifications_outlined, size: glyphSize, color: color),
          if (unread > 0)
            Positioned(top: -4, right: -6, child: _Badge(count: unread)),
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
      padding: const EdgeInsets.symmetric(horizontal: 4),
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: OnboardingColors.errorRed,
        borderRadius: BorderRadius.all(Radius.circular(999)),
      ),
      child: Text(
        '$count',
        textAlign: TextAlign.center,
        style: OnboardingTypography.inter(
          size: 10,
          weight: FontWeight.w700,
          // White on the red disc — the navy ink the rest of the kit uses for
          // "on brand" surfaces read as dark here.
          color: OnboardingColors.paperWhite,
        ),
      ),
    );
  }
}
