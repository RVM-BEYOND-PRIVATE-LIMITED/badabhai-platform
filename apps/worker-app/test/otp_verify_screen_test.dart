import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/auth/otp_verify_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// The dev-only OTP echoed by the console SMS provider in dev/test. The screen
/// must NEVER render this in any state — the worker reads the code from real
/// SMS. Tests assert this string is absent from the widget tree.
const String _devOtp = '424242';

/// Builds the OTP screen as the initial route with [OtpVerifyArgs], backed by an
/// injected [ApiClient]. Uses `onGenerateRoute` so the consent route (pushed on
/// a successful verify) stays reachable without a `home`+`routes` clash.
Widget _harness(
  ApiClient api, {
  String phone = '+919876543210',
  int resendInSeconds = 30,
}) {
  return MaterialApp(
    theme: AppTheme.light(),
    onGenerateRoute: (RouteSettings settings) {
      if (settings.name == '/') {
        return MaterialPageRoute<void>(
          builder: (_) => OtpVerifyScreen(api: api),
          settings: RouteSettings(
            name: '/',
            arguments: OtpVerifyArgs(
              phone: phone,
              resendInSeconds: resendInSeconds,
            ),
          ),
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

/// A request-OTP response body in the API's JSON shape. Includes `dev_otp` to
/// prove the screen never surfaces it.
String _requestBody({int resendInSeconds = 30}) => jsonEncode(<String, dynamic>{
      'success': true,
      'channel': 'sms',
      'resend_in_seconds': resendInSeconds,
      'dev_otp': _devOtp,
    });

void main() {
  testWidgets('never displays or pre-fills the OTP code (no dev_otp leak)', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        // Resend would echo dev_otp on the console provider — include it.
        return http.Response(_requestBody(), 200);
      }),
    );

    await tester.pumpWidget(_harness(api));
    await tester.pumpAndSettle();

    // The code field starts empty — nothing auto-filled.
    final TextField field = tester.widget<TextField>(
      find.byKey(const Key('otpCodeField')),
    );
    expect(field.controller!.text, isEmpty);

    // The dev code never appears anywhere in the tree, in any state.
    expect(find.text(_devOtp), findsNothing);
    expect(find.textContaining(_devOtp), findsNothing);
    // No "mock" oracle copy.
    expect(find.textContaining('mock'), findsNothing);
    expect(find.textContaining('any 4-6 digits'), findsNothing);
  });

  testWidgets('resend is disabled during the server cooldown, re-enables at 0', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        return http.Response(_requestBody(resendInSeconds: 3), 200);
      }),
    );

    // Seed a 3s cooldown via route args.
    await tester.pumpWidget(_harness(api, resendInSeconds: 3));
    await tester.pump();

    final Finder resend = find.byKey(const Key('otpResendButton'));
    TextButton button = tester.widget<TextButton>(resend);
    expect(button.onPressed, isNull); // disabled while counting down
    expect(find.textContaining('Resend code in'), findsOneWidget);

    // Advance past the cooldown.
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));

    button = tester.widget<TextButton>(resend);
    expect(button.onPressed, isNotNull); // re-enabled at 0
    expect(find.text('Resend code'), findsOneWidget);
  });

  testWidgets('resend uses the SERVER cooldown, not a hard-coded value', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        // Server hands back a distinctive 7s window on resend.
        return http.Response(_requestBody(resendInSeconds: 7), 200);
      }),
    );

    // Start with an already-elapsed cooldown so resend is tappable.
    await tester.pumpWidget(_harness(api, resendInSeconds: 0));
    await tester.pump();

    await tester.tap(find.byKey(const Key('otpResendButton')));
    await tester.pump(); // fire request
    await tester.pump(); // apply server cooldown

    // The countdown reflects the server's 7s, proving it is server-sourced.
    expect(find.text('Resend code in 7s'), findsOneWidget);
    // dev_otp still never surfaces after a resend.
    expect(find.textContaining(_devOtp), findsNothing);
  });

  testWidgets('a wrong/expired code shows ONE neutral message (no oracle)', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/auth/otp/verify') {
          // The server returns 401 with a message; the UI must NOT echo it.
          return http.Response(
            jsonEncode(<String, dynamic>{'message': 'otp attempt 4 of 5'}),
            401,
          );
        }
        return http.Response(_requestBody(), 200);
      }),
    );

    await tester.pumpWidget(_harness(api, resendInSeconds: 0));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('otpCodeField')), '000000');
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    expect(
      find.text('That code is incorrect or expired. Please try again.'),
      findsOneWidget,
    );
    // The server's leaky attempt-count message is never shown.
    expect(find.textContaining('attempt'), findsNothing);
    expect(find.textContaining('of 5'), findsNothing);
  });

  testWidgets('a failed resend shows ONE neutral message (no limit oracle)', (
    WidgetTester tester,
  ) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        // Rate-limit / cap / breaker all surface as a non-2xx with a message
        // the UI must neutralize.
        return http.Response(
          jsonEncode(<String, dynamic>{'message': 'too many requests'}),
          429,
        );
      }),
    );

    await tester.pumpWidget(_harness(api, resendInSeconds: 0));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('otpResendButton')));
    await tester.pumpAndSettle();

    expect(
      find.text("Couldn't send a code right now — please try again shortly."),
      findsOneWidget,
    );
    // The 429 / "too many requests" oracle is never shown.
    expect(find.textContaining('too many'), findsNothing);
    expect(find.textContaining('429'), findsNothing);
  });
}
