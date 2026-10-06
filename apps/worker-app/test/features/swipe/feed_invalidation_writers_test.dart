import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/job_feed_invalidation.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/match_skills/data/match_skills_repository_impl.dart';
import 'package:badabhai_worker_app/features/profile_edit/data/profile_edit_repository_impl.dart';

/// The match-input writers mark the Jobs feed stale ONLY after the server
/// confirms the write — a failed edit changed nothing the feed depends on.

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

ApiClient _api(int status, Object body) => ApiClient(
      baseUrl: 'http://test',
      client: MockClient(
        (http.Request _) async => http.Response(jsonEncode(body), status),
      ),
    );

class _Counter {
  _Counter(JobFeedInvalidation signal) {
    signal.addListener(() => count++);
  }
  int count = 0;
}

void main() {
  late JobFeedInvalidation signal;
  late _Counter fired;
  setUp(() {
    signal = JobFeedInvalidation();
    fired = _Counter(signal);
  });

  group('match-skill toggles', () {
    MatchSkillsRepositoryImpl repo(int status, Object body) =>
        MatchSkillsRepositoryImpl(
          _api(status, body),
          _session(),
          feedInvalidation: signal,
        );

    test('a confirmed wants toggle invalidates the feed', () async {
      await repo(200, <String, dynamic>{'skill_id': 's1', 'wants': false})
          .setWants('s1', wants: false);
      expect(fired.count, 1);
    });

    test('a failed wants toggle does not', () async {
      await expectLater(
        repo(404, <String, dynamic>{'message': 'nope'})
            .setWants('s1', wants: false),
        throwsA(isA<Failure>()),
      );
      expect(fired.count, 0);
    });

    test('a confirmed clear-all invalidates the feed', () async {
      await repo(200, <String, dynamic>{'cleared': 3}).clearAll();
      expect(fired.count, 1);
    });
  });

  group('occupation edit', () {
    ProfileEditRepositoryImpl repo(int status, Object body) =>
        ProfileEditRepositoryImpl(
          _api(status, body),
          _session(),
          feedInvalidation: signal,
        );

    test('a confirmed occupations save invalidates the feed', () async {
      await repo(200, <String, dynamic>{'occupations': <Object>[]})
          .saveOccupations(<String>['role_1']);
      expect(fired.count, 1);
    });

    test('a rejected occupations save does not', () async {
      await expectLater(
        repo(500, <String, dynamic>{'message': 'boom'})
            .saveOccupations(<String>['role_1']),
        throwsA(anything),
      );
      expect(fired.count, 0);
    });
  });
}
