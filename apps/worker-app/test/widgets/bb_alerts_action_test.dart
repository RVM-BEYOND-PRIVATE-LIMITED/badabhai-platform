import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_alerts_action.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';
import 'package:badabhai_worker_app/features/notifications/domain/notifications_repository.dart';

import '../support/kit_matrix.dart';

/// The unread count is the only thing the bell reads, so the fake is the
/// count — no HTTP, no store.
class _FakeNotifications implements NotificationsRepository {
  _FakeNotifications(int unread) : unreadCount = ValueNotifier<int>(unread);

  @override
  final ValueNotifier<int> unreadCount;

  @override
  Future<List<AppNotification>> list() async => <AppNotification>[];

  @override
  Future<void> markAllRead() async {}

  @override
  Future<void> refresh() async {}

  @override
  void onLogout() {}
}

Widget _host(Widget bell) => Scaffold(
  // The navy band the bell actually sits on (spec §4), so a white-on-white
  // regression would be visible here too.
  body: ColoredBox(
    color: OnboardingColors.shiftBlue,
    child: Row(children: <Widget>[bell]),
  ),
);

Future<void> _register(int unread) async {
  await locator.reset();
  locator.registerSingleton<NotificationsRepository>(
    _FakeNotifications(unread),
  );
}

void main() {
  setUp(() => locator.reset());
  tearDown(() => locator.reset());

  group('BbAlertsAction — spec §4 bell', () {
    testWidgets('paints notifications_outlined white at 22 by default', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      final Icon bell = tester.widget<Icon>(
        find.byIcon(Icons.notifications_outlined),
      );
      expect(bell.color, OnboardingColors.textOnBlue);
      expect(bell.size, BbAlertsAction.glyphSize);
      expect(BbAlertsAction.glyphSize, 22);
    });

    testWidgets("a caller's own colour still wins", (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(const BbAlertsAction(color: OnboardingColors.shiftBlue)),
        ),
      );

      expect(
        tester.widget<Icon>(find.byIcon(Icons.notifications_outlined)).color,
        OnboardingColors.shiftBlue,
      );
    });

    testWidgets('the tap box is 48x48 while the ink stays 22', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      expect(
        tester.getSize(find.byType(IconButton)),
        const Size(OnboardingLayout.tapTarget, OnboardingLayout.tapTarget),
      );
      expect(
        tester.getSize(find.byIcon(Icons.notifications_outlined)),
        const Size(BbAlertsAction.glyphSize, BbAlertsAction.glyphSize),
      );
    });

    testWidgets('its accessible name is the Alerts tooltip, and it is armed', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      expect(find.byTooltip('Alerts'), findsOneWidget);
      expect(
        tester.widget<IconButton>(find.byType(IconButton)).onPressed,
        isNotNull,
      );
    });

    testWidgets('with no repository wired it degrades to a badge-less bell', (
      WidgetTester tester,
    ) async {
      // A partial-locator widget test, and a real partial boot: the entry
      // point must still work, it just cannot show a count.
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      expect(find.byIcon(Icons.notifications_outlined), findsOneWidget);
      expect(find.byType(Text), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an unread count rides on an errorRed disc in Inter 10 w700 '
        'white', (WidgetTester tester) async {
      await _register(3);
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      expect(find.text('3'), findsOneWidget);
      final Finder disc = find
          .ancestor(of: find.text('3'), matching: find.byType(Container))
          .first;
      final BoxDecoration decoration =
          tester.widget<Container>(disc).decoration! as BoxDecoration;
      expect(decoration.color, OnboardingColors.errorRed);
      expect(tester.getSize(disc).height, 16);

      final TextStyle style = tester.widget<Text>(find.text('3')).style!;
      expect(style.fontFamily, OnboardingTypography.bodyFamily);
      expect(style.fontSize, 10);
      expect(style.fontWeight, FontWeight.w700);
      expect(style.color, OnboardingColors.paperWhite);
    });

    testWidgets('a three-digit count is shown in full — no cap was ever '
        'applied, and inventing one would understate the truth', (
      WidgetTester tester,
    ) async {
      await _register(128);
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      expect(find.text('128'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('zero unread paints no badge at all', (
      WidgetTester tester,
    ) async {
      await _register(0);
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));

      expect(find.byType(Text), findsNothing);
    });

    testWidgets('the count follows the shared listenable without a rebuild '
        'plumbed through the tree', (WidgetTester tester) async {
      await _register(1);
      await tester.pumpWidget(kitTestApp(_host(const BbAlertsAction())));
      expect(find.text('1'), findsOneWidget);

      (locator<NotificationsRepository>() as _FakeNotifications)
              .unreadCount
              .value =
          5;
      await tester.pump();

      expect(find.text('5'), findsOneWidget);
      expect(find.text('1'), findsNothing);
    });
  });
}
