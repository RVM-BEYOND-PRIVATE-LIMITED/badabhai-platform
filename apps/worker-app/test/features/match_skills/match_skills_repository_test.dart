import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/match_skills/data/match_skills_repository_impl.dart';
import 'package:badabhai_worker_app/features/match_skills/domain/match_skill.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  return s;
}

MatchSkillsRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    MatchSkillsRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status);

/// The wire contract of the three E4 routes (#1828), pinned against the
/// backend's controller (`worker-match-skills.controller.ts`).
void main() {
  test('GET /workers/me/match-skills with the bearer; OFF rows are kept',
      () async {
    late http.Request seen;
    final MatchSkillsRepositoryImpl repo = _repo(MockClient((http.Request r) async {
      seen = r;
      return _json(<String, dynamic>{
        'skills': <Map<String, dynamic>>[
          <String, dynamic>{
            'skill_id': 'mskill_cnc_turner',
            'label': 'CNC Turner',
            'wants': true,
          },
          <String, dynamic>{
            'skill_id': 'mskill_vmc_operator',
            'label': 'VMC Operator',
            'wants': false,
          },
        ],
      });
    }));

    final List<MatchSkill> skills = await repo.list();

    expect(seen.method, 'GET');
    expect(seen.url.path, '/workers/me/match-skills');
    expect(seen.headers['authorization'], 'Bearer tok');
    expect(skills, const <MatchSkill>[
      MatchSkill(skillId: 'mskill_cnc_turner', label: 'CNC Turner', wants: true),
      MatchSkill(
        skillId: 'mskill_vmc_operator',
        label: 'VMC Operator',
        wants: false,
      ),
    ]);
  });

  test('a row whose label is missing or is the bare id never renders the id',
      () async {
    final MatchSkillsRepositoryImpl repo = _repo(MockClient(
      (_) async => _json(<String, dynamic>{
        'skills': <Map<String, dynamic>>[
          <String, dynamic>{'skill_id': 'mskill_cnc_turner', 'wants': true},
          <String, dynamic>{
            'skill_id': 'mskill_pipe_fitter',
            'label': 'mskill_pipe_fitter',
            'wants': true,
          },
          // No id → the app could never write it back; dropped.
          <String, dynamic>{'label': 'Ghost', 'wants': true},
        ],
      }),
    ));

    final List<String> labels =
        (await repo.list()).map((MatchSkill s) => s.label).toList();

    expect(labels, <String>['CNC Turner', 'Pipe Fitter']);
  });

  test('a body without a skills list is a failure, not an empty screen',
      () async {
    final MatchSkillsRepositoryImpl repo =
        _repo(MockClient((_) async => _json(<String, dynamic>{})));

    await expectLater(repo.list(), throwsA(isA<ServerFailure>()));
  });

  test('PUT sends the RESULTING state and returns what the server holds',
      () async {
    late http.Request seen;
    final MatchSkillsRepositoryImpl repo = _repo(MockClient((http.Request r) async {
      seen = r;
      return _json(<String, dynamic>{
        'ok': true,
        'skill_id': 'mskill_cnc_turner',
        'wants': false,
      });
    }));

    final bool held = await repo.setWants('mskill_cnc_turner', wants: false);

    expect(seen.method, 'PUT');
    expect(seen.url.path, '/workers/me/match-skills/mskill_cnc_turner/wants');
    expect(seen.headers['authorization'], 'Bearer tok');
    expect(jsonDecode(seen.body), <String, dynamic>{'wants': false});
    expect(held, isFalse);
  });

  test('PUT 400 / 404 surface as typed failures', () async {
    final MatchSkillsRepositoryImpl bad = _repo(MockClient(
      (_) async => _json(<String, dynamic>{'message': 'bad id'}, 400),
    ));
    final MatchSkillsRepositoryImpl notHeld = _repo(MockClient(
      (_) async => _json(<String, dynamic>{'message': 'not held'}, 404),
    ));

    await expectLater(
      bad.setWants('mskill_x', wants: false),
      throwsA(isA<InvalidRequestFailure>()),
    );
    await expectLater(
      notHeld.setWants('mskill_x', wants: false),
      throwsA(isA<ServerFailure>()
          .having((ServerFailure f) => f.statusCode, 'status', 404)),
    );
  });

  test('POST clear-all with the bearer; the server count is not surfaced',
      () async {
    late http.Request seen;
    final MatchSkillsRepositoryImpl repo = _repo(MockClient((http.Request r) async {
      seen = r;
      // What the real server answers: every row held, already-off included
      // (#1850) — which is why the repository returns nothing to show.
      return _json(<String, dynamic>{'ok': true, 'cleared': 8});
    }));

    await repo.clearAll();

    expect(seen.method, 'POST');
    expect(seen.url.path, '/workers/me/match-skills/clear-all');
    expect(seen.headers['authorization'], 'Bearer tok');
  });

  test('a clear-all 2xx without a numeric cleared fails closed', () async {
    final MatchSkillsRepositoryImpl repo = _repo(MockClient(
      (_) async => _json(<String, dynamic>{'ok': true, 'cleared': '3'}),
    ));

    await expectLater(
      repo.clearAll(),
      throwsA(isA<ServerFailure>()
          .having((ServerFailure f) => f.statusCode, 'status', 502)),
    );
  });

  test('a row whose wants is not a boolean is dropped, never drawn as OFF',
      () async {
    final MatchSkillsRepositoryImpl repo = _repo(MockClient(
      (_) async => _json(<String, dynamic>{
        'skills': <Map<String, dynamic>>[
          <String, dynamic>{
            'skill_id': 'mskill_cnc_turner',
            'label': 'CNC Turner',
            'wants': true,
          },
          <String, dynamic>{'skill_id': 'mskill_fitter', 'label': 'Fitter'},
          <String, dynamic>{
            'skill_id': 'mskill_welder',
            'label': 'Welder',
            'wants': 'false',
          },
        ],
      }),
    ));

    final List<String> ids =
        (await repo.list()).map((MatchSkill s) => s.skillId).toList();

    expect(ids, <String>['mskill_cnc_turner']);
  });

  test('no session → fails closed without calling the network', () async {
    int calls = 0;
    final MatchSkillsRepositoryImpl repo = _repo(
      MockClient((_) async {
        calls++;
        return _json(<String, dynamic>{});
      }),
      token: null,
    );

    await expectLater(repo.list(), throwsA(isA<UnauthorizedFailure>()));
    await expectLater(
      repo.setWants('mskill_x', wants: true),
      throwsA(isA<UnauthorizedFailure>()),
    );
    await expectLater(repo.clearAll(), throwsA(isA<UnauthorizedFailure>()));
    expect(calls, 0);
  });
}
