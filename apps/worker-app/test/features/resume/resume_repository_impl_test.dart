import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/resume/data/resume_repository_impl.dart';

SessionRepository _session({String? token = 'tok', String? resumeId = 'r1'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  if (resumeId != null) s.setResume(resumeId);
  return s;
}

ResumeRepositoryImpl _repo(
  MockClient client, {
  String? token = 'tok',
  String? resumeId = 'r1',
}) =>
    ResumeRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token, resumeId: resumeId),
    );

void main() {
  group('resumeDownloadUrl', () {
    test('success returns the signed url with the bearer attached', () async {
      late http.Request captured;
      final ResumeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
        captured = req;
        return http.Response(
          jsonEncode(<String, dynamic>{'url': 'https://signed/pdf', 'expires_in': 300}),
          200,
        );
      }));

      expect(await repo.resumeDownloadUrl(), 'https://signed/pdf');
      expect(captured.method, 'GET');
      expect(captured.url.path, '/resume/r1/download');
      expect(captured.headers['authorization'], 'Bearer tok');
    });

    test('409 -> ResumeNotReadyFailure (honest "PDF taiyaar ho rahi hai", NOT a generic ServerFailure)',
        () {
      final ResumeRepositoryImpl repo = _repo(MockClient((http.Request req) async =>
          http.Response(
            jsonEncode(<String, dynamic>{'message': 'Resume PDF is still being rendered'}),
            409,
          )));
      expect(repo.resumeDownloadUrl(), throwsA(isA<ResumeNotReadyFailure>()));
    });

    test('500 -> ServerFailure (the 409 special-case does not swallow real errors)', () {
      final ResumeRepositoryImpl repo = _repo(MockClient(
          (http.Request req) async => http.Response('{}', 500)));
      expect(repo.resumeDownloadUrl(), throwsA(isA<ServerFailure>()));
    });

    test('401 -> UnauthorizedFailure', () {
      final ResumeRepositoryImpl repo = _repo(MockClient(
          (http.Request req) async => http.Response('{}', 401)));
      expect(repo.resumeDownloadUrl(), throwsA(isA<UnauthorizedFailure>()));
    });

    test('no resumeId / token fails closed with UnauthorizedFailure', () {
      final ResumeRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => http.Response('{}', 200)),
        token: null,
      );
      expect(repo.resumeDownloadUrl(), throwsA(isA<UnauthorizedFailure>()));
    });
  });

  // F2/F3 — the reuse short-circuit used to live INSIDE `if (profileId == null)`,
  // and that block set profileId itself. So it fired at most once per session and
  // every later Resume-tab open POSTed /resume/generate. Server-side that is
  // createInitial(overwrite: true): it resets render_status to 'pending' and
  // pdf_storage_key to null, so the app destroyed its own rendered PDF on every
  // open (self-inflicted 409 on the next download) and burned the 5/day generate
  // cap doing it (429).
  group('generateResume reuse vs force (F2/F3)', () {
    /// A server holding a profile AND an already-generated resume.
    MockClient serverWithResume(List<String> hits, {String name = 'OLD NAME'}) {
      return MockClient((http.Request req) async {
        hits.add('${req.method} ${req.url.path}');
        if (req.url.path == '/workers/w1/profile') {
          return http.Response(
            jsonEncode(<String, dynamic>{
              'profile': <String, dynamic>{'id': 'p1'},
              'resume': <String, dynamic>{'id': 'r1', 'resume_text': name},
            }),
            200,
          );
        }
        if (req.url.path == '/resume/generate') {
          return http.Response(
            jsonEncode(<String, dynamic>{
              'resume_id': 'r2',
              'resume_text': 'NEW NAME',
            }),
            200,
          );
        }
        return http.Response('{}', 404);
      });
    }

    test('repeated opens REUSE the resume and never re-POST generate', () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: serverWithResume(hits)),
        _session(resumeId: null),
      );

      // Three Resume-tab opens in the SAME session (profileId gets cached on the
      // first) — the exact shape that used to start re-POSTing generate.
      expect(await repo.generateResume(), 'OLD NAME');
      expect(await repo.generateResume(), 'OLD NAME');
      expect(await repo.generateResume(), 'OLD NAME');

      expect(
        hits.where((String h) => h.contains('/resume/generate')),
        isEmpty,
        reason: 'a generate here overwrites the row and bins the rendered PDF',
      );
      expect(hits.every((String h) => h == 'GET /workers/w1/profile'), isTrue);
    });

    test('force: true DOES regenerate even when a resume already exists',
        () async {
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: serverWithResume(hits)),
        _session(resumeId: null),
      );

      final String text = await repo.generateResume(force: true);

      expect(text, 'NEW NAME', reason: 'the edited name must be baked in');
      expect(hits, contains('POST /resume/generate'));
    });

    test('force on a COLD start does not return the stale cached text (F3)',
        () async {
      // Fresh login/restart: no profileId in memory. force must resolve the
      // profile WITHOUT taking the reuse branch, or the old name is returned and
      // the regenerate silently skipped.
      final List<String> hits = <String>[];
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: serverWithResume(hits)),
        _session(resumeId: null),
      );

      final String text = await repo.generateResume(force: true);

      expect(text, 'NEW NAME');
      expect(text, isNot('OLD NAME'));
      expect(hits, contains('POST /resume/generate'));
    });

    test('generates when there genuinely is NO resume yet', () async {
      final List<String> hits = <String>[];
      final MockClient client = MockClient((http.Request req) async {
        hits.add('${req.method} ${req.url.path}');
        if (req.url.path == '/workers/w1/profile') {
          // Profile confirmed, but no resume row.
          return http.Response(
            jsonEncode(<String, dynamic>{
              'profile': <String, dynamic>{'id': 'p1'},
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'resume_id': 'r9',
            'resume_text': 'FIRST RESUME',
          }),
          200,
        );
      });
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: client),
        _session(resumeId: null),
      );

      expect(await repo.generateResume(), 'FIRST RESUME');
      expect(hits, contains('POST /resume/generate'));
    });

    test('no profile at all → ProfileIncompleteFailure, no generate', () async {
      final List<String> hits = <String>[];
      final MockClient client = MockClient((http.Request req) async {
        hits.add('${req.method} ${req.url.path}');
        return http.Response(jsonEncode(<String, dynamic>{}), 200);
      });
      final ResumeRepositoryImpl repo = ResumeRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: client),
        _session(resumeId: null),
      );

      await expectLater(
        repo.generateResume(),
        throwsA(isA<ProfileIncompleteFailure>()),
      );
      expect(hits.where((String h) => h.contains('generate')), isEmpty);
    });
  });
}
