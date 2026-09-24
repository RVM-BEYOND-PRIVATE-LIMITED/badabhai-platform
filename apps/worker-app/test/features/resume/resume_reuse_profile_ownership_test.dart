import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/resume/data/resume_repository_impl.dart';

/// #1690 — a RETURNING worker who confirms a NEW profile must never be shown
/// the PREVIOUS profile's resume.
///
/// `GET /workers/me/profile` hands back whatever resume the worker has, with no
/// statement about which profile it belongs to, and `generateResume(force:
/// false)` reused it on sight. The history rows carry `profile_id`, so the
/// question now has a real answer.
///
/// The OTHER half of this file is just as load-bearing: the reuse branch exists
/// because a `POST /resume/generate` is `createInitial(overwrite: true)`
/// server-side — it resets the row to `pending`, bins the rendered PDF (a
/// self-inflicted 409 on the next download) and spends one of the worker's five
/// daily generates. So every case where the app CANNOT prove the resume is
/// foreign must still reuse.
SessionRepository _session() {
  final SessionRepository s = SessionRepository();
  s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
  return s;
}

/// A server with one profile, one resume, and a history the test controls.
MockClient _server(
  List<String> hits, {
  required String profileId,
  String? resumeId = 'r-old',
  String resumeText = 'OLD PROFILE RESUME',
  List<Map<String, dynamic>>? history,
  Map<String, dynamic>? pendingUpdate,
  int historyStatus = 200,
}) {
  return MockClient((http.Request req) async {
    hits.add('${req.method} ${req.url.path}');
    switch (req.url.path) {
      case '/workers/me/profile':
        return http.Response(
          jsonEncode(<String, dynamic>{
            'profile': <String, dynamic>{'id': profileId},
            if (resumeId != null)
              'resume': <String, dynamic>{
                'id': resumeId,
                'resume_text': resumeText,
              },
          }),
          200,
        );
      case '/resume/history':
        if (historyStatus != 200) {
          return http.Response('{}', historyStatus);
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'items': history ?? <Map<String, dynamic>>[],
            'pending_update': pendingUpdate,
          }),
          200,
        );
      case '/resume/generate':
        return http.Response(
          jsonEncode(<String, dynamic>{
            'resume_id': 'r-new',
            'resume_text': 'NEW PROFILE RESUME',
          }),
          200,
        );
    }
    return http.Response('{}', 404);
  });
}

Map<String, dynamic> _row(String resumeId, String? profileId) =>
    <String, dynamic>{
      'resume_id': resumeId,
      'profile_id': profileId,
      'source': 'chat',
      'trigger': 'profile_confirmed',
      'generated_at': '2026-09-12T10:00:00.000Z',
      'render_status': 'rendered',
      'rendered_at': '2026-09-12T10:01:00.000Z',
      'is_current': true,
    };

int _generates(List<String> hits) =>
    hits.where((String h) => h.endsWith('/resume/generate')).length;

void main() {
  group('a history card acts on ITS OWN resume (#1687)', () {
    test('resumeDownloadUrlFor mints the url for the id it was given, not '
        'whatever the session last touched', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hits.add(req.url.path);
            return http.Response(
              jsonEncode(<String, dynamic>{
                'url': 'https://signed/${req.url.pathSegments[1]}',
                'expires_in': 300,
              }),
              200,
            );
          }),
        ),
        _session()..setResume('r-current'),
      );

      expect(
        await repo.resumeDownloadUrlFor('r-older'),
        'https://signed/r-older',
      );
      expect(hits.single, '/resume/r-older/download');
    });

    test('reportSharedFor reports against that same id', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hits.add(req.url.path);
            return http.Response('{}', 200);
          }),
        ),
        _session()..setResume('r-current'),
      );

      await repo.reportSharedFor('r-older', 'whatsapp');
      expect(hits.single, '/resume/r-older/share');
    });

    test('a still-rendering entry answers 409 as the honest "not ready yet", '
        'not a failure', () async {
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient(
            (http.Request req) async => http.Response('{}', 409),
          ),
        ),
        _session(),
      );

      await expectLater(
        repo.resumeDownloadUrlFor('r-older'),
        throwsA(isA<ResumeNotReadyFailure>()),
      );
    });
  });

  group('generateResume(force: false) — whose resume is it? (#1690)', () {
    test('IDS MATCH: the resume belongs to the confirmed profile, so it is '
        'reused and nothing is generated', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: _server(
            hits,
            profileId: 'p1',
            history: <Map<String, dynamic>>[_row('r-old', 'p1')],
          ),
        ),
        _session(),
      );

      expect(await repo.generateResume(), 'OLD PROFILE RESUME');
      expect(_generates(hits), 0);
    });

    test('IDS DIFFER: the resume is the PREVIOUS profile\'s, so it is NOT '
        'reused — the new profile gets its own', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: _server(
            hits,
            // The worker just confirmed p2; the resume on the profile bundle
            // is still p1's.
            profileId: 'p2',
            history: <Map<String, dynamic>>[_row('r-old', 'p1')],
          ),
        ),
        _session(),
      );

      expect(await repo.generateResume(), 'NEW PROFILE RESUME');
      expect(_generates(hits), 1);
    });

    test(
      'NO HISTORY ROUTE (404): today\'s behaviour, byte for byte — reuse',
      () async {
        final List<String> hits = <String>[];
        final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
          ApiClient(
            baseUrl: 'http://test',
            client: _server(hits, profileId: 'p2', historyStatus: 404),
          ),
          _session(),
        );

        expect(await repo.generateResume(), 'OLD PROFILE RESUME');
        expect(_generates(hits), 0);
      },
    );

    test('the history does not MENTION this resume: reuse — the app may not '
        'bin a rendered PDF on an absence of evidence', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: _server(
            hits,
            profileId: 'p2',
            history: <Map<String, dynamic>>[_row('some-other-resume', 'p9')],
          ),
        ),
        _session(),
      );

      expect(await repo.generateResume(), 'OLD PROFILE RESUME');
      expect(_generates(hits), 0);
    });

    test('a LEGACY row with no profile_id cannot disagree: reuse', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: _server(
            hits,
            profileId: 'p2',
            history: <Map<String, dynamic>>[_row('r-old', null)],
          ),
        ),
        _session(),
      );

      expect(await repo.generateResume(), 'OLD PROFILE RESUME');
      expect(_generates(hits), 0);
    });

    test(
      'an ACCEPTED CHAT UPDATE is in flight: the ids legitimately differ '
      'and the app must NOT generate — the server already is (#1689)',
      () async {
        final List<String> hits = <String>[];
        final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
          ApiClient(
            baseUrl: 'http://test',
            client: _server(
              hits,
              profileId: 'p2',
              history: <Map<String, dynamic>>[_row('r-old', 'p1')],
              pendingUpdate: <String, dynamic>{
                'requested_at': '2026-09-24T10:00:00.000Z',
                'status': 'in_progress',
              },
            ),
          ),
          _session(),
        );

        expect(await repo.generateResume(), 'OLD PROFILE RESUME');
        expect(
          _generates(hits),
          0,
          reason: 'a client generate here mints a duplicate history entry',
        );
      },
    );

    test(
      'a FIRST-TIME worker (no resume at all) still generates exactly once',
      () async {
        final List<String> hits = <String>[];
        final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
          ApiClient(
            baseUrl: 'http://test',
            client: _server(hits, profileId: 'p1', resumeId: null),
          ),
          _session(),
        );

        expect(await repo.generateResume(), 'NEW PROFILE RESUME');
        expect(_generates(hits), 1);
        expect(
          hits.where((String h) => h.endsWith('/resume/history')),
          isEmpty,
          reason: 'there is no resume to check the ownership of',
        );
      },
    );
  });
}
