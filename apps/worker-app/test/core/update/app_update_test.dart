import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/update/app_update.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/notifications/data/notification_read_store.dart';

import '../auth/fakes.dart';

Future<void> _pump(WidgetTester tester, {int frames = 10}) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

http.Response _config({
  required int min,
  required int latest,
  String? storeUrl = 'https://example.test/worker-app',
}) => http.Response(
  jsonEncode(<String, Object?>{
    'app': 'worker',
    'platform': 'android',
    'min_supported_build': min,
    'latest_build': latest,
    'store_url': storeUrl,
    'message_key': 'update_default',
  }),
  200,
);

Future<void> _loadPolicy(http.Client client, {int build = 10}) async {
  final AppUpdateController update = AppUpdateController.instance;
  await update.init(
    client: client,
    platform: 'android',
    buildNumber: build,
    prefs: SharedPreferences.getInstance,
    now: () => DateTime(2026, 11, 26, 10),
  );
  await update.refresh();
}

void main() {
  late AuthSessionManager auth;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient(), secureStore: FakeSecureStore());
    await initAuthLocator(
      localeStore: LocaleStore(FakePrefs()),
      authApi: MockAuthApi(locator<SecureTokenStore>()),
      readStore: const SessionOnlyNotificationReadStore(),
      persistentAuthEnabled: true,
    );
    auth = locator<AuthSessionManager>();
    await auth.bootstrap();
    AppUpdateController.instance.resetForTest();
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  tearDown(() async {
    AppUpdateController.instance.resetForTest();
    await locator.reset();
  });

  testWidgets('a minimum above this build shows the update page', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _loadPolicy(MockClient((_) async => _config(min: 11, latest: 12)));
    expect(AppUpdateController.instance.blocking, isTrue);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pump(tester);

    expect(find.text('Update required'), findsOneWidget);
    expect(find.text('Update app'), findsOneWidget);
  });

  testWidgets('an unreachable config opens normally', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _loadPolicy(MockClient((_) async => throw Exception('offline')));
    expect(AppUpdateController.instance.blocking, isFalse);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pump(tester);

    expect(find.text('Update required'), findsNothing);
  });

  test('a build below the latest shows one notice a day', () async {
    await _loadPolicy(MockClient((_) async => _config(min: 5, latest: 20)));
    final AppUpdateController update = AppUpdateController.instance;
    expect(update.blocking, isFalse);
    expect(update.notice, isTrue);

    update.dismissNotice();
    expect(update.notice, isFalse);

    update.resetForTest();
    await _loadPolicy(MockClient((_) async => _config(min: 5, latest: 20)));
    expect(update.notice, isFalse, reason: 'dismissed today');

    update.resetForTest();
    final AppUpdateController next = AppUpdateController.instance;
    await next.init(
      client: MockClient((_) async => _config(min: 5, latest: 20)),
      platform: 'android',
      buildNumber: 10,
      prefs: SharedPreferences.getInstance,
      now: () => DateTime(2026, 11, 27, 10),
    );
    await next.refresh();
    expect(next.notice, isTrue, reason: 'a new day shows it again');
  });
  test('a 426 body is the update refusal and carries the config', () {
    final Map<String, dynamic> body = <String, dynamic>{
      'statusCode': 426,
      'error': <String, dynamic>{
        'code': 'APP_UPDATE_REQUIRED',
        'message': 'This app version is no longer supported.',
        'config': <String, dynamic>{
          'min_supported_build': 50,
          'latest_build': 52,
          'store_url': 'https://example.test/app',
          'message_key': 'update_default',
        },
      },
    };
    expect(isAppUpdateRequiredResponse(426, body), isTrue);
    expect(isAppUpdateRequiredResponse(500, body), isFalse);
    expect(appUpdateConfigFromBody(body)?.minSupportedBuild, 50);
  });
  test('every request names the app, platform and build', () async {
    await AppUpdateController.instance.init(
      client: MockClient((_) async => http.Response('{}', 200)),
      platform: 'android',
      buildNumber: 42,
      prefs: SharedPreferences.getInstance,
    );
    expect(AppRequestIdentity.headers(), <String, String>{
      'x-app-name': 'worker',
      'x-app-platform': 'android',
      'x-app-build-number': '42',
    });
  });

}
