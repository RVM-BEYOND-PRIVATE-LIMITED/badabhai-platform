import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/settings/presentation/settings_screen.dart';
import 'package:badabhai_worker_app/router.dart';

import '../../core/auth/fakes.dart';

class _MockApiClient extends Mock implements ApiClient {}

void main() {
  late _MockApiClient api;
  late FakeSecureStore secureBacking;

  setUp(() async {
    api = _MockApiClient();
    secureBacking = FakeSecureStore();
    await locator.reset();
    setupLocator(apiClient: api, secureStore: secureBacking);
  });

  tearDown(() => locator.reset());

  testWidgets('renders the rows + legal footer (account delete hidden)', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('WhatsApp alerts'), findsOneWidget);
    expect(find.text('Account delete karein'), findsNothing);
    expect(find.textContaining('Made in India'), findsOneWidget);
  });

  // 'Bhasha' stays hidden until real localization ships (it set X-Locale with
  // no translated strings behind it). The screen/route still exists — only the
  // entry point is gone, so assert the row to catch an accidental re-add.
  testWidgets('hides the Bhasha row', (WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('Bhasha'), findsNothing);
  });

  // #464 — 'Aapke devices' is the worker's ONLY in-app way to revoke a session
  // on a lost or stolen phone. It was removed to sidestep a DevicesCubit
  // emit-after-close crash (FI-001), which left DevicesScreen and Routes.devices
  // built but UNREACHABLE — a thief kept a live session and the worker's only
  // recourse was "contact support". This pins BOTH halves of reachability: the
  // row renders, and tapping it pushes the real Routes.devices constant.
  testWidgets('the Aapke devices row navigates to Routes.devices',
      (WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/',
      routes: <RouteBase>[
        GoRoute(path: '/', builder: (_, __) => const SettingsScreen()),
        // The production router registers this same constant nested under
        // /profile/settings (router.dart). A stand-in destination keeps the real
        // DevicesScreen's auth-locator graph out of a Settings test while still
        // proving the exact route this row pushes.
        GoRoute(
          path: Routes.devices,
          builder: (_, __) => const Scaffold(body: Text('DEVICES SCREEN')),
        ),
      ],
    );
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));

    expect(find.text('Aapke devices'), findsOneWidget);
    expect(find.text('Logged-in devices dekhein · hatayein'), findsOneWidget);

    await tester.tap(find.text('Aapke devices'));
    await tester.pumpAndSettle();

    expect(find.text('DEVICES SCREEN'), findsOneWidget);
    expect(router.state.uri.toString(), Routes.devices);
  });
}