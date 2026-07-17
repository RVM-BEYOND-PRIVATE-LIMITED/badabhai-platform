import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/resume/data/resume_edit_repository_impl.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

ResumeEditRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    ResumeEditRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

/// Routes GET /workers/me/resume-fields to [fieldsJson] and every PATCH to
/// `{ok:true}`, recording each request for assertions.
MockClient _client(
  List<http.Request> captured, {
  required Map<String, dynamic> fieldsJson,
}) {
  return MockClient((http.Request req) async {
    captured.add(req);
    if (req.method == 'GET' && req.url.path == '/workers/me/resume-fields') {
      return http.Response(jsonEncode(fieldsJson), 200);
    }
    return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
  });
}

void main() {
  group('load', () {
    test('GETs /workers/me/resume-fields with the bearer; maps the DTO',
        () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo = _repo(_client(
        reqs,
        fieldsJson: <String, dynamic>{
          'full_name': 'Ramesh Kumar',
          'show_photo': true,
          'night_shift_ready': true,
        },
      ));

      final ResumeSafeFields f = await repo.load();

      expect(reqs.single.method, 'GET');
      expect(reqs.single.url.path, '/workers/me/resume-fields');
      expect(reqs.single.headers['authorization'], 'Bearer tok');
      expect(f.displayName, 'Ramesh Kumar');
      expect(f.showPhoto, true);
      expect(f.nightShiftReady, true);
    });

    test('null full_name -> empty displayName (no fabricated placeholder)',
        () async {
      final ResumeEditRepositoryImpl repo = _repo(_client(
        <http.Request>[],
        fieldsJson: <String, dynamic>{
          'full_name': null,
          'show_photo': false,
          'night_shift_ready': false,
        },
      ));

      final ResumeSafeFields f = await repo.load();
      expect(f.displayName, '');
      expect(f.showPhoto, false);
    });

    test('no session token fails closed with UnauthorizedFailure', () {
      final ResumeEditRepositoryImpl repo = _repo(
        _client(<http.Request>[], fieldsJson: <String, dynamic>{}),
        token: null,
      );
      expect(repo.load(), throwsA(isA<UnauthorizedFailure>()));
    });

    test('a transport drop maps to a Failure (not a raw exception)', () {
      final ResumeEditRepositoryImpl repo = _repo(MockClient(
          (http.Request req) async => throw Exception('no network')));
      expect(repo.load(), throwsA(isA<Failure>()));
    });
  });

  group('save', () {
    test('non-empty name -> PATCHes /me/name AND /me/resume-prefs with bearer',
        () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo =
          _repo(_client(reqs, fieldsJson: <String, dynamic>{}));

      await repo.save(const ResumeSafeFields(
        displayName: '  Suresh  ', // trimmed before send
        showPhoto: false,
        nightShiftReady: true,
      ));

      final http.Request name =
          reqs.firstWhere((http.Request r) => r.url.path == '/workers/me/name');
      final http.Request prefs = reqs.firstWhere(
          (http.Request r) => r.url.path == '/workers/me/resume-prefs');

      expect(name.method, 'PATCH');
      expect(name.headers['authorization'], 'Bearer tok');
      expect(jsonDecode(name.body), <String, dynamic>{'full_name': 'Suresh'});

      expect(prefs.method, 'PATCH');
      expect(jsonDecode(prefs.body), <String, dynamic>{
        'show_photo': false,
        'night_shift_ready': true,
      });
    });

    test('empty name -> skips /me/name, still PATCHes /me/resume-prefs',
        () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo =
          _repo(_client(reqs, fieldsJson: <String, dynamic>{}));

      await repo.save(const ResumeSafeFields(
        displayName: '   ',
        showPhoto: true,
        nightShiftReady: false,
      ));

      expect(
        reqs.any((http.Request r) => r.url.path == '/workers/me/name'),
        isFalse,
      );
      expect(
        reqs.map((http.Request r) => r.url.path),
        contains('/workers/me/resume-prefs'),
      );
    });

    test('no session token fails closed with UnauthorizedFailure', () {
      final ResumeEditRepositoryImpl repo = _repo(
        _client(<http.Request>[], fieldsJson: <String, dynamic>{}),
        token: null,
      );
      expect(
        repo.save(const ResumeSafeFields(
          displayName: 'X',
          showPhoto: true,
          nightShiftReady: false,
        )),
        throwsA(isA<UnauthorizedFailure>()),
      );
    });

    test('after load, a prefs-only save (UNCHANGED name) skips /me/name', () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo = _repo(_client(
        reqs,
        fieldsJson: <String, dynamic>{
          'full_name': 'Ramesh Kumar',
          'show_photo': true,
          'night_shift_ready': false,
        },
      ));

      final ResumeSafeFields loaded = await repo.load();
      reqs.clear();
      // Flip only a toggle; the name is untouched.
      await repo.save(loaded.copyWith(nightShiftReady: true));

      expect(
        reqs.any((http.Request r) => r.url.path == '/workers/me/name'),
        isFalse, // unchanged name must NOT re-emit worker.name_recorded
      );
      expect(
        reqs.map((http.Request r) => r.url.path),
        contains('/workers/me/resume-prefs'),
      );
    });

    test('after load, a CHANGED name PATCHes /me/name once', () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo = _repo(_client(
        reqs,
        fieldsJson: <String, dynamic>{
          'full_name': 'Ramesh Kumar',
          'show_photo': true,
          'night_shift_ready': false,
        },
      ));

      final ResumeSafeFields loaded = await repo.load();
      reqs.clear();
      await repo.save(loaded.copyWith(displayName: 'Ramesh Kumaar'));

      final Iterable<http.Request> nameReqs =
          reqs.where((http.Request r) => r.url.path == '/workers/me/name');
      expect(nameReqs.length, 1);
      expect(jsonDecode(nameReqs.first.body),
          <String, dynamic>{'full_name': 'Ramesh Kumaar'});
    });
  });

  // F1 — save() REPORTS whether the name changed, so the preview knows to
  // regenerate (the name is baked in at generation time) without diffing again.
  group('save reports whether the name changed (F1)', () {
    test('a changed name returns true', () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo = _repo(_client(
        reqs,
        fieldsJson: <String, dynamic>{
          'full_name': 'Ramesh Kumar',
          'show_photo': true,
          'night_shift_ready': false,
        },
      ));

      final ResumeSafeFields loaded = await repo.load();
      final bool changed =
          await repo.save(loaded.copyWith(displayName: 'Ramesh Kumaar'));

      expect(changed, isTrue);
      expect(reqs.map((http.Request r) => r.url.path),
          contains('/workers/me/name'));
    });

    test('a prefs-only save returns false — no wasted regenerate', () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo = _repo(_client(
        reqs,
        fieldsJson: <String, dynamic>{
          'full_name': 'Ramesh Kumar',
          'show_photo': true,
          'night_shift_ready': false,
        },
      ));

      final ResumeSafeFields loaded = await repo.load();
      final bool changed =
          await repo.save(loaded.copyWith(nightShiftReady: true));

      expect(changed, isFalse,
          reason: 'regenerating here would burn one of the 5 daily generates');
    });

    test('re-saving the SAME new name returns false the second time', () async {
      final List<http.Request> reqs = <http.Request>[];
      final ResumeEditRepositoryImpl repo = _repo(_client(
        reqs,
        fieldsJson: <String, dynamic>{
          'full_name': 'Ramesh Kumar',
          'show_photo': true,
          'night_shift_ready': false,
        },
      ));

      final ResumeSafeFields loaded = await repo.load();
      final ResumeSafeFields renamed =
          loaded.copyWith(displayName: 'Ramesh Kumaar');

      expect(await repo.save(renamed), isTrue);
      // save() updates its loaded-name baseline, so an immediate re-save is a
      // no-op and must not trigger a second regenerate.
      expect(await repo.save(renamed), isFalse);
    });
  });
}
