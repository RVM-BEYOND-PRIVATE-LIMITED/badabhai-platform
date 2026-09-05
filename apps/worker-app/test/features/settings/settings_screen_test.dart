import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
    // scrollUntilVisible — the footer is far enough down the ListView that
    // it isn't built into the element tree until something scrolls near it.
    await tester.scrollUntilVisible(
        find.textContaining('Made in India'), 200,
        scrollable: find.byType(Scrollable));
    expect(find.textContaining('Made in India'), findsOneWidget);
  });

  // #966 — a tester must be able to read WHICH build their device runs (to tell
  // a real bug from a stale APK) and copy it into a bug report. The footer shows
  // the build id inline; a long-press copies it.
  testWidgets('shows the build id in the footer and long-press copies it',
      (WidgetTester tester) async {
    final List<String> copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform, (MethodCall call) async {
      if (call.method == 'Clipboard.setData') {
        copied.add((call.arguments as Map<Object?, Object?>)['text'] as String);
      }
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    // Readable inline — 'dev' with no --dart-define=APP_BUILD (a test binary).
    // scrollUntilVisible, not ensureVisible — the footer is far enough down
    // the ListView that it isn't built into the element tree at all until
    // something scrolls near it (ensureVisible needs the element to already
    // exist to find it).
    await tester.scrollUntilVisible(
        find.textContaining('build dev'), 200,
        scrollable: find.byType(Scrollable));
    expect(find.textContaining('build dev'), findsOneWidget);

    await tester.longPress(find.textContaining('build dev'));
    await tester.pump(); // surface the confirmation snackbar

    expect(copied, <String>['dev']);
    expect(find.text('Build id copy ho gaya'), findsOneWidget);
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

  // #1429 — the state->city PREVIEW row is gone, and must stay gone. It stood
  // in for a backend dataset that has since shipped: the real state-then-city
  // cascade now lives on the preferences marker's cities page, driven by the
  // options response's own `states` list. A Settings row pointing at a
  // hardcoded 15-state map would now be a second, WRONG answer to the same
  // question.
  testWidgets('no Sheher/State demo row — the real cascade superseded it',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const SettingsScreen()),
    );

    expect(find.text('Sheher/State demo'), findsNothing);
  });
}