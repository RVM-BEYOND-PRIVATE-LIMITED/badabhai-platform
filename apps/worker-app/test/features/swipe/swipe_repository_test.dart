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
  test('getFeed sends the bearer token and returns items',
      () async {
    final Map<String, http.Request> byPath = <String, http.Request>{};
    final SwipeRepositoryImpl repo = _repo(_feedClient(
      jobs: <Map<String, dynamic>>[_feedJob('j1')],
      onRequest: (http.Request req) => byPath[req.url.path] = req,
    ));

    final FeedPage result = await repo.getFeed();
    expect(byPath['/feed']?.headers['authorization'], 'Bearer tok');


    expect(result.jobs, hasLength(1));
    expect(result.jobs.first.jobId, 'j1');
  });

  test('a worker with no decisions sees the whole feed', () async {
    final SwipeRepositoryImpl repo = _repo(_feedClient(
      jobs: <Map<String, dynamic>>[_feedJob('j1'), _feedJob('j2')],
    ));
    expect((await repo.getFeed()).jobs, hasLength(2));
  });

  // ── #2068 / ADR-0052 — paging ───────────────────────────────────────────────

  test('the cursor rides GET /feed untouched and next_cursor comes back',
      () async {
    const String cursor = 'eyJ2IjoxLCJtIjoidjEiLCJvIjo1MH0';
    late http.Request captured;
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'jobs': <Map<String, dynamic>>[_feedJob('j51')],
          'next_cursor': 'CURSOR-3',
        }),
        200,
      );
    }));

    final FeedPage page = await repo.getFeed(cursor: cursor);

    expect(captured.url.queryParameters['cursor'], cursor);
    expect(page.jobs.single.jobId, 'j51');
    expect(page.nextCursor, 'CURSOR-3');
  });

  // The two cursor 400s (malformed / wrong feed order) are the ONLY 400s the
  // deck answers by restarting instead of surfacing, so they get their own
  // type. The path is what identifies them — never the message.
  test('a 400 naming the cursor maps to FeedCursorRejectedFailure', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{
          'statusCode': 400,
          'error': <String, dynamic>{
            'message': 'Validation failed',
            'issues': <Map<String, dynamic>>[
              <String, dynamic>{
                'path': 'cursor',
                'message':
                    'cursor was issued for a different feed order; refetch '
                    'without a cursor',
              },
            ],
          },
        }),
        400,
      );
    }));
    expect(
      repo.getFeed(cursor: 'stale'),
      throwsA(isA<FeedCursorRejectedFailure>()),
    );
  });

  // The server nests the validation payload under `error`; #2068 quotes it
  // bare. Both shapes must be read, or a rejected cursor would surface as an
  // error screen on one of them.
  test('a 400 naming the cursor is recognised in the UNNESTED body too', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{
          'message': 'Validation failed',
          'issues': <Map<String, dynamic>>[
            <String, dynamic>{'path': 'cursor', 'message': 'cursor is malformed'},
          ],
        }),
        400,
      );
    }));
    expect(
      repo.getFeed(cursor: 'bad'),
      throwsA(isA<FeedCursorRejectedFailure>()),
    );
  });

  test('a 400 about ANY OTHER field stays an InvalidRequestFailure', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{
          'statusCode': 400,
          'error': <String, dynamic>{
            'message': 'Validation failed',
            'issues': <Map<String, dynamic>>[
              <String, dynamic>{'path': 'pay_min', 'message': 'too big'},
            ],
          },
        }),
        400,
      );
    }));
    expect(repo.getFeed(), throwsA(isA<InvalidRequestFailure>()));
  });

  test('a 400 with no parsable body stays an InvalidRequestFailure', () {
    final SwipeRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('nonsense', 400)),
    );
    expect(repo.getFeed(cursor: 'c'), throwsA(isA<InvalidRequestFailure>()));
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

  // #1906 — a search-initiated apply must carry source_surface:'search', and the
  // feed default stays 'feed'.
  test('applyToJob forwards source_surface (default feed, search explicit)', () async {
    final List<Map<String, dynamic>> bodies = <Map<String, dynamic>>[];
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      bodies.add(jsonDecode(req.body) as Map<String, dynamic>);
      return http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'application_id': 'a1',
          'action': 'applied',
        }),
        200,
      );
    }));

    await repo.applyToJob('j1', rank: 1);
    await repo.applyToJob('j2', rank: 2, sourceSurface: 'search');

    expect(bodies[0]['source_surface'], 'feed');
    expect(bodies[1]['source_surface'], 'search');
  });
}
