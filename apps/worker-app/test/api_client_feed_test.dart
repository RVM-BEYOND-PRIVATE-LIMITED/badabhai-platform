import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

void main() {
  group('ApiClient feed/apply/skip', () {
    test('getFeed sends bearer token + limit and parses items', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'jobs': <Map<String, dynamic>>[
                <String, dynamic>{
                  'job_id': 'j1',
                  'trade_key': 'cnc_operator',
                  'title': 'CNC Operator',
                  'city': 'Pune',
                  'area': null,
                  'rank': 1,
                },
              ],
            }),
            200,
          );
        }),
      );

      final FeedPage page = await api.getFeed(authToken: 'tok', limit: 5);

      expect(captured.method, 'GET');
      expect(captured.url.path, '/feed');
      expect(captured.url.queryParameters['limit'], '5');
      expect(captured.headers['authorization'], 'Bearer tok');
      // No cursor asked for ⇒ no cursor param: that request is byte-identical
      // to the pre-paging call (#2068, ADR-0052 §2.2).
      expect(captured.url.queryParameters.containsKey('cursor'), isFalse);
      expect(page.jobs, hasLength(1));
      expect(page.jobs.first.jobId, 'j1');
      expect(page.jobs.first.area, isNull);
      expect(page.jobs.first.rank, 1);
      // A response WITHOUT the key reads as "end of deck" — an older API build
      // or a rollback of PR #2067 must never look like "page 2 exists".
      expect(page.nextCursor, isNull);
    });

    // #2068 — the cursor is OPAQUE: whatever the server minted goes back out
    // verbatim, and whatever comes back is stored as-is. This test is the whole
    // round trip; [FeedPage] parsing has its own suite.
    test('getFeed sends the cursor it was given and returns the next one',
        () async {
      const String cursor =
          'eyJ2IjoxLCJtIjoiam9icyIsIm8iOjUwLCJqIjp7InQiOiIyMDk5LTAxLTA1VDAwOjAw'
          'OjAwLjEyMzQ1NloiLCJpZCI6ImQyOTBmMWVlLTZjNTQtNGIwMS05MGU2LWQ3MDE3NDhm'
          'MDg1MSJ9fQ';
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'jobs': <Map<String, dynamic>>[],
              'next_cursor': 'PAGE-3-CURSOR',
            }),
            200,
          );
        }),
      );

      final FeedPage page =
          await api.getFeed(authToken: 'tok', cursor: cursor);

      // Byte-for-byte on the wire, and the raw query string carries it
      // unescaped (base64url is all unreserved characters).
      expect(captured.url.queryParameters['cursor'], cursor);
      expect(captured.url.query, contains('cursor=$cursor'));
      expect(page.nextCursor, 'PAGE-3-CURSOR');
    });

    test('applyToJob posts rank + source_surface with bearer token', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'ok': true,
              'application_id': 'a1',
              'action': 'applied',
            }),
            200,
          );
        }),
      );

      final ApplyResult result =
          await api.applyToJob('j1', authToken: 'tok', rank: 3);

      expect(captured.method, 'POST');
      expect(captured.url.path, '/applications/j1/apply');
      expect(captured.headers['authorization'], 'Bearer tok');
      final Map<String, dynamic> body =
          jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['rank'], 3);
      expect(body['source_surface'], 'feed');
      expect(result.ok, isTrue);
      expect(result.action, 'applied');
      expect(result.applicationId, 'a1');
    });

    test('skipJob posts reason with bearer token', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'ok': true,
              'application_id': 'a2',
              'action': 'skipped',
            }),
            200,
          );
        }),
      );

      final SkipResult result =
          await api.skipJob('j1', authToken: 'tok', reason: 'too_far');

      expect(captured.url.path, '/applications/j1/skip');
      final Map<String, dynamic> body =
          jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['reason'], 'too_far');
      expect(result.action, 'skipped');
    });

    test('a non-2xx response throws ApiException with the server message',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          return http.Response(
            jsonEncode(<String, dynamic>{'message': 'worker has not accepted consent'}),
            403,
          );
        }),
      );

      expect(
        () => api.getFeed(authToken: 'tok'),
        throwsA(
          isA<ApiException>()
              .having((ApiException e) => e.statusCode, 'statusCode', 403),
        ),
      );
    });

    test('a fresh x-session-token response header fires the refresh callback',
        () async {
      String? refreshed;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        onSessionTokenRefreshed: (String t) => refreshed = t,
        client: MockClient((http.Request req) async {
          return http.Response(
            jsonEncode(<String, dynamic>{'jobs': <Map<String, dynamic>>[]}),
            200,
            headers: <String, String>{'x-session-token': 'fresh-token'},
          );
        }),
      );

      await api.getFeed(authToken: 'old-token');

      expect(refreshed, 'fresh-token');
    });
  });
}
