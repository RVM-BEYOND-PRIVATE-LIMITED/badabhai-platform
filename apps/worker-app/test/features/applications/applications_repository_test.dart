import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/applications/data/applications_repository_impl.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

ApplicationsRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    ApplicationsRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

Map<String, dynamic> _row({
  required String jobId,
  required String action,
  String? area = 'Pimpri',
  String? reason,
  Object? rank = 1,
}) =>
    <String, dynamic>{
      'job_id': jobId,
      'trade_key': 'cnc_operator',
      'title': 'CNC Operator',
      'city': 'Pune',
      'area': area,
      'action': action,
      'reason': reason,
      'source_surface': 'feed',
      'rank': rank,
      'created_at': '2026-06-01T10:00:00.000Z',
      'updated_at': '2026-06-01T10:00:00.000Z',
    };

void main() {
  test(
      'GETs /workers/me/applications with the bearer; drops skips; keeps nullables',
      () async {
    late http.Request captured;
    final ApplicationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'worker_id': 'w1',
          'applications': <Map<String, dynamic>>[
            _row(jobId: 'a1', action: 'applied'),
            _row(jobId: 's1', action: 'skipped', reason: 'too_far'), // dropped
            _row(
                jobId: 'a2',
                action: 'applied',
                area: null,
                reason: null,
                rank: null), // nullables
          ],
        }),
        200,
      );
    }));

    final List<dynamic> result = await repo.appliedJobs();

    // Worker-scoped GET, token-derived (no workerId param), bearer attached.
    expect(captured.method, 'GET');
    expect(captured.url.path, '/workers/me/applications');
    expect(captured.url.queryParameters, isEmpty); // no filter params
    expect(captured.headers['authorization'], 'Bearer tok');

    // The mixed list filters to apply-only, preserving API (oldest-first) order.
    expect(result.map((dynamic a) => a.jobId).toList(), <String>['a1', 'a2']);
    // First row has area/reason... ; second exercises the nullables.
    expect(result.first.area, 'Pimpri');
    expect(result[1].area, isNull);
    expect(result[1].reason, isNull);
    expect(result[1].rank, isNull);
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final ApplicationsRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.appliedJobs(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final ApplicationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      throw Exception('no network');
    }));
    expect(repo.appliedJobs(), throwsA(isA<Failure>()));
  });

  test('missing applications array -> empty list', () async {
    final ApplicationsRepositoryImpl repo = _repo(MockClient(
        (http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{'worker_id': 'w1'}), 200)));
    expect(await repo.appliedJobs(), isEmpty);
  });
}
