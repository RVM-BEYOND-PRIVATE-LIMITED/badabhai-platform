import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';
import 'package:badabhai_worker_app/features/notifications/domain/notifications_repository.dart';
import 'package:badabhai_worker_app/features/notifications/presentation/cubit/notifications_cubit.dart';
import 'package:badabhai_worker_app/features/notifications/presentation/notifications_screen.dart';

class MockNotificationsRepository extends Mock
    implements NotificationsRepository {}

AppNotification _n(String id, NotificationKind kind, String title, String sub) =>
    AppNotification(
        id: id, kind: kind, title: title, subtitle: sub, time: 'Abhi');

Future<void> _pump(WidgetTester tester, List<AppNotification> items) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockNotificationsRepository repo = MockNotificationsRepository();
  when(() => repo.list()).thenAnswer((_) async => items);
  locator.registerFactory<NotificationsCubit>(() => NotificationsCubit(repo));

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light(), home: const NotificationsScreen()),
  );
  await tester.pump(); // loading
  await tester.pump(); // load() resolves → ready/empty
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets('renders real API notification rows (faceless copy)', (
    WidgetTester tester,
  ) async {
    await _pump(tester, <AppNotification>[
      _n('e1', NotificationKind.resumeReady, 'Resume taiyaar hai',
          'Aapka naya resume ban gaya — dekhein aur download karein.'),
      _n('e2', NotificationKind.security, 'Naye device se login',
          'Aapke account mein ek naye device se login hua.'),
    ]);

    expect(find.text('Alerts'), findsOneWidget);
    expect(find.text('Resume taiyaar hai'), findsOneWidget);
    expect(find.text('Naye device se login'), findsOneWidget);
  });

  testWidgets('the Alerts tab shows NO employer/company name, ₹/pay, or phone text',
      (WidgetTester tester) async {
    await _pump(tester, <AppNotification>[
      _n('e1', NotificationKind.resumeReady, 'Resume taiyaar hai',
          'Aapka naya resume ban gaya.'),
      _n('e2', NotificationKind.profileReady, 'Profile taiyaar hai',
          'Aapki profile confirm ho gayi.'),
      _n('e3', NotificationKind.voiceProcessed, 'Voice note taiyaar',
          'Aapka voice note process ho gaya.'),
    ]);

    // Sweep every rendered Text widget for unsafe employer/pay/phone content.
    final Iterable<Text> texts = tester.widgetList<Text>(find.byType(Text));
    for (final Text t in texts) {
      final String s = (t.data ?? '').toLowerCase();
      expect(s.contains('₹'), isFalse, reason: 'no pay symbol');
      expect(s.contains('employer'), isFalse, reason: 'no employer word');
      expect(s.contains('company'), isFalse, reason: 'no company word');
      expect(RegExp(r'\d{4,}').hasMatch(s), isFalse,
          reason: 'no phone/pay digit run');
    }
    // And the known old mock employer/pay strings are gone.
    expect(find.textContaining('Sharma Precision'), findsNothing);
    expect(find.textContaining('Deccan Auto'), findsNothing);
    expect(find.textContaining('₹'), findsNothing);
  });

  testWidgets(
      'an application_sent row renders the SERVER copy verbatim with the sent '
      'icon and the green (applied-confirmation) tone', (
    WidgetTester tester,
  ) async {
    await _pump(tester, <AppNotification>[
      _n('e1', NotificationKind.applicationSent, 'Application bhej di',
          'Aapki application aage pahunch gayi.'),
    ]);

    // Server-rendered copy, not app-composed.
    expect(find.text('Application bhej di'), findsOneWidget);
    expect(
        find.text('Aapki application aage pahunch gayi.'), findsOneWidget);

    // Right icon…
    expect(find.byIcon(Icons.send_rounded), findsOneWidget);

    // …and the green tone (BbNotiTone.green paints success on successTint).
    final Icon icon = tester.widget<Icon>(find.byIcon(Icons.send_rounded));
    expect(icon.color, AppColors.success);
    final Container tile = tester.widget<Container>(
      find
          .ancestor(of: find.byIcon(Icons.send_rounded), matching: find.byType(Container))
          .first,
    );
    expect((tile.decoration! as BoxDecoration).color, AppColors.successTint);

    // No employer IDENTITY (ADR-0024): no company name, pay or phone shape.
    expect(find.textContaining('Pvt'), findsNothing);
    expect(find.textContaining('Ltd'), findsNothing);
    expect(find.textContaining('₹'), findsNothing);
  });

  testWidgets('empty feed shows the Hinglish empty state', (
    WidgetTester tester,
  ) async {
    await _pump(tester, <AppNotification>[]);
    expect(find.text('Abhi koi alert nahi'), findsOneWidget);
  });
}
