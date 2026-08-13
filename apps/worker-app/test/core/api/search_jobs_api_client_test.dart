import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/features/job_search/domain/job_search_item.dart';

/// `GET /jobs/search` builds its Uri the same way `getFeed` does: send each of
/// q/city/state ONLY when non-empty, always send limit + page, carry the bearer.
void main() {
  group('ApiClient.searchJobs', () {
    test('sends q/city/state/limit/page + bearer and parses the envelope',
        () async {
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
                  'title': 'CNC Operator',
                  'city': 'Kota',
                  'state': 'Rajasthan',
                  'pay_min': 20000,
                  'pay_max': 35000,
                  'shift': 'day',
                  'published_at': '2026-08-01T00:00:00Z',
                },
              ],
              'page': 1,
              'limit': 20,
              'has_more': true,
            }),
            200,
          );
        }),
      );

      final JobSearchPage page = await api.searchJobs(
        authToken: 'tok',
        q: 'CNC operator',
        city: 'Kota',
        state: 'Rajasthan',
        limit: 20,
        page: 1,
      );

      expect(captured.method, 'GET');
      expect(captured.url.path, '/jobs/search');
      expect(captured.url.queryParameters['q'], 'CNC operator');
      expect(captured.url.queryParameters['city'], 'Kota');
      expect(captured.url.queryParameters['state'], 'Rajasthan');
      expect(captured.url.queryParameters['limit'], '20');
      expect(captured.url.queryParameters['page'], '1');
      expect(captured.headers['authorization'], 'Bearer tok');

      expect(page.items, hasLength(1));
      expect(page.items.first.jobId, 'j1');
      expect(page.items.first.state, 'Rajasthan');
      expect(page.items.first.publishedAt, DateTime.utc(2026, 8, 1));
      expect(page.page, 1);
      expect(page.limit, 20);
      expect(page.hasMore, isTrue);
    });

    test('omits empty/null q/city/state but ALWAYS sends limit + page', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'jobs': <Map<String, dynamic>>[],
              'page': 3,
              'limit': 50,
              'has_more': false,
            }),
            200,
          );
        }),
      );

      await api.searchJobs(
        authToken: 'tok',
        q: 'welder',
        city: '', // empty -> omitted
        state: null, // null -> omitted
        limit: 50,
        page: 3,
      );

      expect(captured.url.queryParameters['q'], 'welder');
      expect(captured.url.queryParameters.containsKey('city'), isFalse);
      expect(captured.url.queryParameters.containsKey('state'), isFalse);
      expect(captured.url.queryParameters['limit'], '50');
      expect(captured.url.queryParameters['page'], '3');
    });

    test('defaults: limit=20, page=1 when the caller omits them', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{'jobs': <Map<String, dynamic>>[]}),
            200,
          );
        }),
      );

      await api.searchJobs(authToken: 'tok', q: 'fitter');

      expect(captured.url.queryParameters['limit'], '20');
      expect(captured.url.queryParameters['page'], '1');
      expect(captured.url.queryParameters['q'], 'fitter');
    });

    test('a 403 (consent) surfaces as an ApiException the mapper turns to '
        'ConsentRequiredFailure', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          return http.Response(
            jsonEncode(
                <String, dynamic>{'message': 'worker has not accepted consent'}),
            403,
          );
        }),
      );

      expect(
        () => api.searchJobs(authToken: 'tok', q: 'CNC'),
        throwsA(
          isA<ApiException>()
              .having((ApiException e) => e.statusCode, 'statusCode', 403),
        ),
      );
    });
  });
}
