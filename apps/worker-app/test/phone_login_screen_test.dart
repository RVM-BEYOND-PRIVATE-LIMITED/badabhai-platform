import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/auth/phone_login_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// Hosts the real [PhoneLoginScreen] with an injected [ApiClient] (fake
/// network), keeping the app routes reachable so a successful request can push
/// the OTP screen.
Widget _harness(ApiClient api) {
  return MaterialApp(
    theme: AppTheme.light(),
    onGenerateRoute: (RouteSettings settings) {
      if (settings.name == '/') {
        return MaterialPageRoute<void>(
          builder: (_) => PhoneLoginScreen(api: api),
          settings: settings,
        );
      }
      final WidgetBuilder? builder = appRoutes[settings.name];
      if (builder != null) {
        return MaterialPageRoute<void>(builder: builder, settings: settings);
      }
      return null;
    },
  );
}

void main() {
  testWidgets('send failure shows ONE neutral message and does NOT advance', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        // Rate-limit / cap / breaker: a non-2xx the UI must neutralize.
        return http.Response(
          jsonEncode(<String, dynamic>{'message': 'too many requests'}),
          429,
        );
      }),
    );

    await tester.pumpWidget(_harness(api));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), '+919876543210');
    await tester.tap(find.widgetWithText(FilledButton, 'Send OTP'));
    await tester.pump(); // request
    await tester.pump(const Duration(milliseconds: 750)); // snackbar entrance

    expect(
      find.text("Couldn't send a code right now — please try again shortly."),
      findsOneWidget,
    );
    // No oracle leak.
    expect(find.textContaining('too many'), findsNothing);
    // Stayed on the login screen — never advanced to the code screen.
    expect(find.text('Enter your phone number'), findsOneWidget);
    expect(find.text('Enter the code'), findsNothing);
  });

  testWidgets('request success carries the server cooldown to the OTP screen', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'success': true,
            'channel': 'sms',
            'resend_in_seconds': 9,
            // dev_otp present on the console provider — must never surface.
            'dev_otp': '654321',
          }),
          200,
        );
      }),
    );

    await tester.pumpWidget(_harness(api));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), '+919876543210');
    await tester.tap(find.widgetWithText(FilledButton, 'Send OTP'));
    await tester.pumpAndSettle();

    // Landed on the OTP screen with the server's 9s cooldown active.
    expect(find.text('Enter the code'), findsOneWidget);
    expect(find.text('Resend code in 9s'), findsOneWidget);
    // The dev code never surfaces on the OTP screen either.
    expect(find.textContaining('654321'), findsNothing);
  });
}
