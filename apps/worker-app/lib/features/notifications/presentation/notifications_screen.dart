import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/app_notification.dart';
import 'cubit/notifications_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';

/// Below this width the trailing time stamp and the title fight for the same
/// row, so the time moves under the subtitle instead.
const double _kStackTimeBelowWidth = 360;

/// Same, past this system text scale.
const double _kStackTimeAboveTextScale = 1.3;

/// The unread marker's diameter (spec: an 8dp safety-yellow dot).
const double _kUnreadDot = 8;

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
        backgroundColor: OnboardingColors.canvasBg,
        body: Column(
          children: <Widget>[
            _header(context),
            Expanded(
              child: BlocBuilder<NotificationsCubit, NotificationsState>(
                builder: (BuildContext context, NotificationsState state) {
                  // #1059 — cross-fade between the load / empty / error / list
                  // states instead of flashing. Keyed by status so the switcher
                  // animates the swap (list→list item changes stay instant).
                  return BbAnimatedSwitcher(
                    child: KeyedSubtree(
                      key: ValueKey<NotificationsStatus>(state.status),
                      child: switch (state.status) {
                        NotificationsStatus.loading =>
                          const BbStatusView.loading(),
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
                        NotificationsStatus.empty => _empty(context),
                        NotificationsStatus.ready => _list(
                          context,
                          state.items,
                        ),
                      },
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The kit's navy header (spec §2.1). Copy is deliberately faceless: no
  /// employer/pay/phone content ever reaches this bar.
  ///
  /// Alerts is PUSHED full-screen from the header bell (it lost its bottom-nav
  /// tab in the kit 4-tab set), so it carries its own back affordance — a tab
  /// never needed one, and a tab root must not show a dead arrow.
  Widget _header(BuildContext context) {
    // Navigator (not go_router's context.pop): a go_router push still creates a
    // Navigator route, so this pops correctly AND does not require a GoRouter
    // ancestor — keeps the screen pumpable in a bare MaterialApp widget test.
    final bool canPop = Navigator.of(context).canPop();
    return ShiftBlueHeader(
      title: 'Alerts',
      subtitle: 'Aapke saare updates',
      onBack: canPop ? () => Navigator.of(context).maybePop() : null,
      // The body is a 600 list, so the navy row is too — one left edge per
      // screen.
      maxWidth: OnboardingLayout.maxTabContentWidth,
    );
  }

  /// Pull-to-refresh re-runs the same load the tab does on open: fetch fresh
  /// rows and mark them read. Returns the cubit's Future so the spinner stays up
  /// until the refetch settles. `loadAndMarkRead` keeps the current rows on
  /// screen while it runs (no loading flash) and self-guards a double-pull.
  Future<void> _refresh(BuildContext context) =>
      context.read<NotificationsCubit>().loadAndMarkRead();

  /// The alerts grouped into one white card; each row supplies its own hairline
  /// divider (kit grouped-list idiom, no shadows). Wrapped in a
  /// [RefreshIndicator] so a pull-down refetches.
  ///
  /// Rows build LAZILY via [SliverList.builder]; the single rounded card is
  /// painted once behind them by [DecoratedSliver], so the grouped-card look is
  /// preserved without constructing every off-screen row up front.
  Widget _list(BuildContext context, List<AppNotification> items) {
    final bool stackTime = _stackTime(context);
    return RefreshIndicator(
      color: OnboardingColors.shiftBlue,
      onRefresh: () => _refresh(context),
      child: CustomScrollView(
        // Always overscrollable so a short list (1–2 alerts that don't fill the
        // screen) still accepts the pull-to-refresh gesture on Android.
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: <Widget>[
          SliverPadding(
            // The SCROLL VIEW's own padding (D7): the card column centres on a
            // tablet while the scrollbar stays at the screen edge.
            padding: KitInsets.list(
              MediaQuery.sizeOf(context).width,
            ).copyWith(
              top: 14,
              // Plus the floating Feedback pill's band. See [FeedbackFabInset].
              bottom: 14 + FeedbackFabInset.of(context),
            ),
            sliver: DecoratedSliver(
              decoration: BoxDecoration(
                color: OnboardingColors.paperWhite,
                borderRadius: BorderRadius.circular(OnboardingRadii.card),
                border: Border.all(color: OnboardingColors.borderDefault),
              ),
              sliver: SliverList.builder(
                itemCount: items.length,
                itemBuilder: (BuildContext context, int i) =>
                    _row(items[i], stackTime: stackTime),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Empty state, made pull-refreshable: the status view sits in an
  /// always-scrollable viewport-height box so a pull registers even with no
  /// rows — a worker can pull to check for new alerts on an empty list.
  Widget _empty(BuildContext context) {
    return RefreshIndicator(
      color: OnboardingColors.shiftBlue,
      onRefresh: () => _refresh(context),
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          return SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: const BbStatusView(
                icon: Icons.notifications_none_rounded,
                title: 'Abhi koi alert nahi',
                subtitle: 'Resume, profile aur account updates yahin dikhenge.',
              ),
            ),
          );
        },
      ),
    );
  }

  /// Whether this screen is too narrow (or its text too large) for a trailing
  /// time stamp.
  ///
  /// `scale(10) > 13` is the 1.3 factor without the deprecated
  /// `textScaleFactor` getter, and it respects a non-linear scaler.
  static bool _stackTime(BuildContext context) {
    final double width = MediaQuery.sizeOf(context).width;
    final TextScaler scaler = MediaQuery.textScalerOf(context);
    return width < _kStackTimeBelowWidth ||
        scaler.scale(10) > 10 * _kStackTimeAboveTextScale;
  }

  Widget _row(AppNotification n, {required bool stackTime}) {
    final (IconData icon, BbNotiTone tone) = switch (n.kind) {
      NotificationKind.resumeReady => (Icons.description, BbNotiTone.brand),
      NotificationKind.profileReady => (Icons.badge_outlined, BbNotiTone.green),
      NotificationKind.voiceProcessed => (
        Icons.graphic_eq_rounded,
        BbNotiTone.brand,
      ),
      // Green is the DS's "go / success — an applied confirmation" tone; the
      // send glyph matches the app's existing sent affordance (chat/voice).
      NotificationKind.applicationSent => (
        Icons.send_rounded,
        BbNotiTone.green,
      ),
      // E0 item 5 — "you have a message", faceless. Brand tone (an inbound
      // signal), a message glyph.
      NotificationKind.messageReceived => (
        Icons.forum_outlined,
        BbNotiTone.brand,
      ),
      NotificationKind.security => (Icons.security_rounded, BbNotiTone.saffron),
    };
    final Widget row = stackTime
        ? _StackedAlertRow(
            icon: icon,
            tone: tone,
            title: n.title,
            subtitle: n.subtitle,
            time: n.time,
          )
        : BbListRow.notification(
            icon: icon,
            tone: tone,
            title: n.title,
            subtitle: n.subtitle,
            time: n.time,
          );
    // Unread marker — a small safety-yellow dot in the left gutter. Opening the
    // tab marks everything read, so this shows only genuinely-unread alerts (and
    // clears on the same visit); read rows render the plain row.
    if (n.read) return row;
    return Stack(
      children: <Widget>[
        row,
        const Positioned(
          left: 4,
          top: 0,
          bottom: 0,
          child: Center(
            child: SizedBox(
              width: _kUnreadDot,
              height: _kUnreadDot,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: OnboardingColors.safetyYellow,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// The narrow / large-text drawing of an alert row: the same 40dp tone tile,
/// title and subtitle as [BbListRow.notification], with the time moved UNDER the
/// subtitle instead of trailing it.
///
/// Why a second drawing at all: below 360dp — or past a 1.3 text scale — a
/// trailing time stamp and a two-line Hinglish title compete for one row, and
/// the title ends up wrapping four times beside a stub of time. The tones read
/// from the same v3 tokens the shared row uses, so the two drawings cannot drift
/// to different hexes.
class _StackedAlertRow extends StatelessWidget {
  const _StackedAlertRow({
    required this.icon,
    required this.tone,
    required this.title,
    required this.subtitle,
    required this.time,
  });

  final IconData icon;
  final BbNotiTone tone;
  final String title;
  final String subtitle;
  final String time;

  @override
  Widget build(BuildContext context) {
    final (Color background, Color iconColor) = switch (tone) {
      BbNotiTone.green => (
        OnboardingColors.successBg,
        OnboardingColors.successGreen,
      ),
      BbNotiTone.saffron => (
        OnboardingColors.errorBg,
        OnboardingColors.errorRed,
      ),
      BbNotiTone.brand => (OnboardingColors.infoBg, OnboardingColors.shiftBlue),
    };
    return DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: OnboardingColors.borderSubtle),
        ),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minHeight: OnboardingLayout.tapTarget,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: background,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: iconColor, size: 20),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      style: OnboardingTypography.inter(
                        size: 14,
                        weight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: OnboardingTypography.inter(
                        size: 12,
                        color: OnboardingColors.ink600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      time,
                      // MONO, like every other counter and timer in the app
                      // (spec §1.2): the OTP resend clock, the Building step
                      // count, the kit's question numbers and every salary.
                      // This relative time was the one place the numeric
                      // convention slipped.
                      style: OnboardingTypography.mono(
                        size: 11,
                        color: OnboardingColors.ink500,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
