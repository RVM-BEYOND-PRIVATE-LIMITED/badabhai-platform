import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

SwipeRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) {
  return SwipeRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: client),
    _session(token: token),
  );
}

Map<String, dynamic> _feedJob(String id) => <String, dynamic>{
      'job_id': id,
      'trade_key': 'cnc_operator',
      'title': 'CNC Operator',
      'city': 'Pune',
      'area': null,
      'rank': 1,
    };

Map<String, dynamic> _decision(String jobId, String action) =>
    <String, dynamic>{
      'job_id': jobId,
      'trade_key': 'cnc_operator',
      'title': 'CNC Operator',
      'city': 'Pune',
      'area': null,
      'action': action,
      'reason': action == 'skipped' ? 'not_interested' : null,
      'source_surface': 'feed',
      'rank': 1,
      'created_at': '2026-06-01T10:00:00.000Z',
      'updated_at': '2026-06-01T10:00:00.000Z',
    };

/// Routes the two GETs [getFeed] now makes (WA-1): `/feed` and the worker's own
/// decisions at `/workers/me/applications`.
MockClient _feedClient({
  required List<Map<String, dynamic>> jobs,
  List<Map<String, dynamic>> decisions = const <Map<String, dynamic>>[],
  void Function(http.Request)? onRequest,
}) {
  return MockClient((http.Request req) async {
    onRequest?.call(req);
    if (req.url.path == '/workers/me/applications') {
      return http.Response(
        jsonEncode(
            <String, dynamic>{'worker_id': 'w1', 'applications': decisions}),
        200,
      );
    }
    return http.Response(jsonEncode(<String, dynamic>{'jobs': jobs}), 200);
  });
}

void main() {
  test('getFeed sends the bearer token on BOTH reads and returns items',
      () async {
    final Map<String, http.Request> byPath = <String, http.Request>{};
    final SwipeRepositoryImpl repo = _repo(_feedClient(
      jobs: <Map<String, dynamic>>[_feedJob('j1')],
      onRequest: (http.Request req) => byPath[req.url.path] = req,
    ));

    final result = await repo.getFeed();
    expect(byPath['/feed']?.headers['authorization'], 'Bearer tok');
    // WA-1: the worker's own decisions ride along to exclude decided jobs.
    expect(byPath['/workers/me/applications']?.headers['authorization'],
        'Bearer tok');
    expect(result, hasLength(1));
    expect(result.first.jobId, 'j1');
  });

  test(
      'WA-1: getFeed EXCLUDES already-decided jobs (applied AND skipped) so a '
      're-swipe can never overwrite an applied row', () async {
    final SwipeRepositoryImpl repo = _repo(_feedClient(
      jobs: <Map<String, dynamic>>[
        _feedJob('applied-1'),
        _feedJob('skipped-1'),
        _feedJob('fresh-1'),
      ],
      decisions: <Map<String, dynamic>>[
        _decision('applied-1', 'applied'),
        _decision('skipped-1', 'skipped'),
      ],
    ));

    final result = await repo.getFeed();
    expect(result.map((j) => j.jobId).toList(), <String>['fresh-1']);
  });

  test('a worker with no decisions sees the whole feed', () async {
    final SwipeRepositoryImpl repo = _repo(_feedClient(
      jobs: <Map<String, dynamic>>[_feedJob('j1'), _feedJob('j2')],
    ));
    expect(await repo.getFeed(), hasLength(2));
  });

  test(
      'FAIL-CLOSED: a failing decisions read fails the whole feed load '
      '(never silently serves a deck that can destroy applied state)', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      if (req.url.path == '/workers/me/applications') {
        return http.Response('oops', 500);
      }
      return http.Response(
        jsonEncode(<String, dynamic>{
          'jobs': <Map<String, dynamic>>[_feedJob('j1')],
        }),
        200,
      );
    }));
    expect(repo.getFeed(), throwsA(isA<Failure>()));
  });

  test('a 403 maps to ConsentRequiredFailure', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'message': 'consent required'}),
        403,
      );
    }));
    expect(repo.getFeed(), throwsA(isA<ConsentRequiredFailure>()));
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      throw Exception('no network');
    }));
    expect(repo.getFeed(), throwsA(isA<Failure>()));
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final SwipeRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.getFeed(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('applyToJob posts to the apply endpoint with the bearer token', () async {
    late http.Request captured;
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'application_id': 'a1',
          'action': 'applied',
        }),
        200,
      );
    }));

    await repo.applyToJob('j1', rank: 3);
    expect(captured.url.path, '/applications/j1/apply');
    expect(captured.headers['authorization'], 'Bearer tok');
  });
}
