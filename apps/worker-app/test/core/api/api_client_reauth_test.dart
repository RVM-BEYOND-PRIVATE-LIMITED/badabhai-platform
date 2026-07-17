import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// #351 — every worker-scoped product call (feed, chat, resume, profile, voice,
/// notifications, applications) rides the legacy ApiClient with
/// SessionRepository.sessionToken as its bearer, NOT AuthedClient's refresh
/// interceptor. A 401 was mapped straight to UnauthorizedFailure: nothing
/// refreshed with the perfectly good persisted refresh token, and nothing fired
/// ReauthSignal — so AuthSessionManager stayed `authenticated` and the router
/// bounced the worker away from /login. Every tab showed "Please log in again"
/// forever with no escape.
void main() {
  group('ApiClient 401 renew + retry (#351)', () {
    test('a 401 renews auth once and retries with the FRESH bearer', () async {
      final List<String?> bearers = <String?>[];
      int renewCalls = 0;
      String liveToken = 'stale-token';

      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        onUnauthorized: () async {
          renewCalls++;
          liveToken = 'fresh-token'; // what AuthSessionManager.refresh() bridges
          return true;
        },
        currentAuthToken: () => liveToken,
        client: MockClient((http.Request req) async {
          bearers.add(req.headers['authorization']);
          if (req.headers['authorization'] == 'Bearer fresh-token') {
            return http.Response(
                jsonEncode(<String, dynamic>{'session_id': 's1'}), 201);
          }
          return http.Response(jsonEncode(<String, dynamic>{}), 401);
        }),
      );

      final String id = await api.startSession(authToken: liveToken);

      expect(id, 's1');
      expect(renewCalls, 1, reason: 'renew exactly once');
      expect(bearers, <String>['Bearer stale-token', 'Bearer fresh-token'],
          reason: 'the retry must NOT resend the token that just 401ed');
    });

    test('an unrenewable 401 surfaces, and does not retry', () async {
      int attempts = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        // Refresh failed unrecoverably — AuthSessionManager has already wiped +
        // flipped to loggedOut, which is what frees the router.
        onUnauthorized: () async => false,
        currentAuthToken: () => 'whatever',
        client: MockClient((http.Request req) async {
          attempts++;
          return http.Response(jsonEncode(<String, dynamic>{}), 401);
        }),
      );

      await expectLater(
        api.startSession(authToken: 'dead'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 401)),
      );
      expect(attempts, 1, reason: 'no retry when auth could not be renewed');
    });

    test('a renewed retry that still 401s gives up (no loop)', () async {
      int attempts = 0;
      int renewCalls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        onUnauthorized: () async {
          renewCalls++;
          return true;
        },
        currentAuthToken: () => 'still-bad',
        client: MockClient((http.Request req) async {
          attempts++;
          return http.Response(jsonEncode(<String, dynamic>{}), 401);
        }),
      );

      await expectLater(
          api.startSession(authToken: 'bad'), throwsA(isA<ApiException>()));
      expect(attempts, 2, reason: 'original + exactly one retry');
      expect(renewCalls, 1, reason: 'renew is not re-entered on the retry');
    });

    test('an UNAUTHENTICATED 401 never triggers a renew', () async {
      int renewCalls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        onUnauthorized: () async {
          renewCalls++;
          return true;
        },
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{}), 401)),
      );

      // No bearer was sent: a 401 is a real answer, not a stale token.
      await expectLater(
          api.acceptConsent(workerId: 'w1', purposes: <String>['profiling']),
          throwsA(isA<ApiException>()));
      expect(renewCalls, 0);
    });

    test('a non-401 error is untouched by the reauth path', () async {
      int renewCalls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        onUnauthorized: () async {
          renewCalls++;
          return true;
        },
        currentAuthToken: () => 'tok',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{}), 500)),
      );

      await expectLater(
        api.startSession(authToken: 'tok'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 500)),
      );
      expect(renewCalls, 0);
    });

    test('with no hook wired the 401 behaves exactly as before', () async {
      int attempts = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          attempts++;
          return http.Response(jsonEncode(<String, dynamic>{}), 401);
        }),
      );

      await expectLater(
          api.startSession(authToken: 'tok'), throwsA(isA<ApiException>()));
      expect(attempts, 1);
    });
  });
}
