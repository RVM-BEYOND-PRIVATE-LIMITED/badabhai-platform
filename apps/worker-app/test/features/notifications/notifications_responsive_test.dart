import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_list_row.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';
import 'package:badabhai_worker_app/features/notifications/domain/notifications_repository.dart';
import 'package:badabhai_worker_app/features/notifications/presentation/cubit/notifications_cubit.dart';
import 'package:badabhai_worker_app/features/notifications/presentation/notifications_screen.dart';

import '../../support/kit_matrix.dart';

class _MockNotificationsRepository extends Mock
    implements NotificationsRepository {}

AppNotification _n(
  String id,
  NotificationKind kind, {
  String title = 'Resume taiyaar hai',
  String subtitle = 'Aapka naya resume ban gaya.',
  String time = 'Abhi',
  bool read = false,
}) => AppNotification(
  id: id,
  kind: kind,
  title: title,
  subtitle: subtitle,
  time: time,
  read: read,
);

/// The long-title row is the real one: server copy runs long in Hinglish, and a
/// trailing time stamp beside it is what used to squeeze a 320dp screen.
const String _kLongTitle =
    'Aapka resume taiyaar hai aur employer ko bhejne layak ho gaya hai';

/// A yellow circular unread marker, found by what it PAINTS — the dot has no
/// key, and a key would be the only thing the test proved.
Finder _unreadDots() => find.byWidgetPredicate((Widget w) {
  if (w is! DecoratedBox) return false;
  final Decoration d = w.decoration;
  return d is BoxDecoration &&
      d.shape == BoxShape.circle &&
      d.color == OnboardingColors.safetyYellow;
});

void main() {
  late _MockNotificationsRepository repo;

  setUp(() async {
    repo = _MockNotificationsRepository();
    when(() => repo.markAllRead()).thenAnswer((_) async {});
    when(() => repo.list()).thenAnswer(
      (_) async => <AppNotification>[_n('e1', NotificationKind.resumeReady)],
    );
    await locator.reset();
    locator.registerFactory<NotificationsCubit>(() => NotificationsCubit(repo));
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
  });

  tearDown(() async => locator.reset());

  Future<void> pump(
    WidgetTester tester, {
    Size size = const Size(390, 844),
    double textScale = 1.0,
  }) async {
    setKitSurface(tester, size);
    await tester.pumpWidget(
      kitTestApp(const NotificationsScreen(), textScale: textScale),
    );
    await tester.pump(); // loading
    await tester.pump(); // load() resolves
  }

  testWidgets(
    'at 320 and 2.0 the time moves UNDER the subtitle and nothing overflows',
    (WidgetTester tester) async {
      when(() => repo.list()).thenAnswer(
        (_) async => <AppNotification>[
          _n('e1', NotificationKind.resumeReady, title: _kLongTitle),
        ],
      );

      await pump(tester, size: const Size(320, 568), textScale: 2.0);

      expect(tester.takeException(), isNull);
      expect(find.text(_kLongTitle), findsOneWidget);
      // The time is still on screen — it moved, it was not dropped.
      expect(find.text('Abhi'), findsOneWidget);
      // …and the row is the stacked drawing, not the trailing-time one.
      expect(find.byType(BbListRow), findsNothing);
    },
  );

  testWidgets('on a normal handset the row keeps the shared trailing drawing', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(find.byType(BbListRow), findsOneWidget);
    expect(find.text('Abhi'), findsOneWidget);
  });

  testWidgets('a tab-rooted Alerts screen shows no dead back arrow', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(find.text('Alerts'), findsOneWidget);
    expect(find.byTooltip('Wapas'), findsNothing);
  });

  testWidgets('pushed full-screen, it carries its own back affordance', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      kitTestApp(
        Scaffold(
          body: Builder(
            builder: (BuildContext context) => TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const NotificationsScreen(),
                ),
              ),
              child: const Text('open alerts'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open alerts'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Alerts'), findsOneWidget);
    expect(find.byTooltip('Wapas'), findsOneWidget);
  });

  testWidgets(
    'the unread dot marks ONLY the unread row — and clears on the same visit',
    (WidgetTester tester) async {
      when(() => repo.list()).thenAnswer(
        (_) async => <AppNotification>[
          _n('e1', NotificationKind.resumeReady),
          _n(
            'e2',
            NotificationKind.security,
            title: 'Naye device se login',
            subtitle: 'Aapke account mein ek naye device se login hua.',
            read: true,
          ),
        ],
      );
      // Opening the tab IS the read: the cubit emits the rows, then marks them
      // read and re-emits ALL of them as read. So the mark is held open here —
      // otherwise the only frame that has an unread row has already gone by,
      // and a dot test that pumps past it would pass on an empty screen.
      final Completer<void> marking = Completer<void>();
      when(() => repo.markAllRead()).thenAnswer((_) => marking.future);

      await pump(tester);

      expect(find.text('Naye device se login'), findsOneWidget);
      expect(_unreadDots(), findsOneWidget);

      // …and once the mark lands the dot clears, on this visit, without the
      // rows leaving the screen.
      marking.complete();
      await tester.pump();
      await tester.pump();

      expect(_unreadDots(), findsNothing);
      expect(find.text('Naye device se login'), findsOneWidget);
    },
  );

  testWidgets('at 768 the alert card column stops instead of stretching', (
    WidgetTester tester,
  ) async {
    await pump(tester, size: const Size(768, 1024));

    expect(
      widthOf(tester, find.byType(BbListRow).first),
      lessThanOrEqualTo(600),
    );
  });

  testWidgets('every control clears the 48dp touch floor', (
    WidgetTester tester,
  ) async {
    await pump(tester, size: const Size(360, 640));

    await expectKitTapTargets(tester);
  });

  group('matrix', () {
    kitMatrixTest(
      'alerts list',
      () => const NotificationsScreen(),
      // The ROW, not the header title: 'Alerts' sits in fixed chrome that is
      // in the tree at every size whether or not the list below it rendered,
      // so pinning it would only have re-asserted "nothing threw".
      primary: () => find.text('Resume taiyaar hai'),
    );
  });

  group('matrix — empty', () {
    setUp(() {
      when(() => repo.list()).thenAnswer((_) async => <AppNotification>[]);
    });

    kitMatrixTest(
      'alerts empty',
      () => const NotificationsScreen(),
      primary: () => find.text('Abhi koi alert nahi'),
    );
  });
}
