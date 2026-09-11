import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/storage/signed_object_put.dart';
import 'package:badabhai_worker_app/features/resume_import/data/resume_importer_impl.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';

const String _kSignedUrl = 'https://storage.test/signed?token=SECRET';

PickedResumeDocument _doc([int bytes = 2048]) => PickedResumeDocument(
      kind: ResumeDocumentKind.pdf,
      bytes: Uint8List(bytes),
    );

SessionRepository _session() =>
    SessionRepository()..setSessionToken('tok');

/// Builds an importer whose API + PUT both run through ONE MockClient, so the
/// test can assert the exact ORDER of the four legs — which is the part of this
/// pipeline that carries the security argument (nothing is registered before it
/// is uploaded, nothing is uploaded before the mint says the door is open).
({ResumeImporterImpl importer, List<String> calls, List<Object> reported})
    _build({
  required Future<http.Response> Function(http.Request req, List<String> calls)
      handler,
  Duration pollInterval = const Duration(milliseconds: 1),
  Duration pollBudget = const Duration(milliseconds: 40),
}) {
  final List<String> calls = <String>[];
  final List<Object> reported = <Object>[];
  final MockClient client =
      MockClient((http.Request req) => handler(req, calls));
  final ApiClient api = ApiClient(baseUrl: 'http://test', client: client);
  return (
    importer: ResumeImporterImpl(
      api: api,
      session: _session(),
      put: SignedObjectPut(client: client),
      pollInterval: pollInterval,
      pollBudget: pollBudget,
      reportNonFatal: (Object e, StackTrace s, {required String reason}) =>
          reported.add(reason),
    ),
    calls: calls,
    reported: reported,
  );
}

String _label(http.Request req) {
  if (req.url.toString() == _kSignedUrl) return 'PUT_BYTES';
  return '${req.method} ${req.url.path}';
}

void main() {
  group('the dormant bucket — the state on every box today', () {
    test('a 503 from the mint is Unavailable, and NO bytes leave the device',
        () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          return http.Response('{"message":"not enabled"}', 503);
        },
      );

      final ResumeImportOutcome outcome =
          await h.importer.importResume(_doc());

      expect(outcome, isA<ResumeImportUnavailable>());
      // The WHOLE point: the mint is the only thing that ran. A worker on EDGE
      // spends one small request, not a résumé's worth of uplink, to discover
      // the door is shut.
      expect(h.calls, <String>['POST /profiling/resume-import/upload-url']);
      // Not an error — a switched-off feature is not a crash report.
      expect(h.reported, isEmpty);
    });
  });

  group('the happy paths', () {
    test('mint → PUT → confirm → poll, in that order, ending at the form',
        () async {
      int polls = 0;
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          if (req.method == 'POST') {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'import_id': 'imp-1',
                'status': 'uploaded',
                'route': null,
              }),
              201,
            );
          }
          polls++;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': polls < 2 ? 'parsing' : 'parsed',
              'route': polls < 2 ? null : 'form',
              'form_kind': polls < 2 ? null : 'cnc_turner',
            }),
            200,
          );
        },
      );

      final ResumeImportOutcome outcome =
          await h.importer.importResume(_doc());

      expect(outcome, isA<ResumeImportRoutedToForm>());
      expect((outcome as ResumeImportRoutedToForm).formKind, 'cnc_turner');
      expect(h.calls.take(3).toList(), <String>[
        'POST /profiling/resume-import/upload-url',
        'PUT_BYTES',
        'POST /profiling/resume-import',
      ]);
      // It kept polling while the server said `parsing`, and stopped the
      // moment it did not.
      expect(h.calls.where((String c) => c.startsWith('GET')).length, 2);
    });

    test('route == chat is an ORDINARY success, not a failure', () async {
      // Only 9 of 21 trades have a form at all, so this is the common outcome
      // and it must be visibly distinct from ResumeImportFailed.
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': 'parsed',
              'route': 'chat',
            }),
            req.method == 'POST' ? 201 : 200,
          );
        },
      );

      final ResumeImportOutcome outcome =
          await h.importer.importResume(_doc());

      expect(outcome, isA<ResumeImportRoutedToChat>());
      // The confirm already came back terminal, so there was nothing to poll.
      expect(h.calls.where((String c) => c.startsWith('GET')), isEmpty);
      expect(h.reported, isEmpty);
    });

    test('`parsed` with a NULL route goes to the chat, never guessed as form',
        () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': 'parsed',
              'route': null,
            }),
            req.method == 'POST' ? 201 : 200,
          );
        },
      );

      expect(await h.importer.importResume(_doc()),
          isA<ResumeImportRoutedToChat>());
    });
  });

  group('every other ending is a continue, never a dead end (ruling D9)', () {
    test('a failed parse is Failed, and its reason never reaches the caller',
        () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': 'failed',
              'failure_reason': 'no_text_layer',
            }),
            req.method == 'POST' ? 201 : 200,
          );
        },
      );

      final ResumeImportOutcome outcome =
          await h.importer.importResume(_doc());

      expect(outcome, isA<ResumeImportFailed>());
      // ResumeImportFailed carries no field at all, by construction: there is
      // nowhere for `no_text_layer` to ride to a screen.
    });

    test('a 404 on the poll stops immediately — it can never become a 200',
        () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          if (req.method == 'POST') {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'import_id': 'imp-1',
                'status': 'uploaded',
              }),
              201,
            );
          }
          return http.Response('{"message":"not found"}', 404);
        },
        pollInterval: const Duration(milliseconds: 1),
        pollBudget: const Duration(seconds: 5),
      );

      final ResumeImportOutcome outcome =
          await h.importer.importResume(_doc());

      expect(outcome, isA<ResumeImportFailed>());
      // ONE poll, not a budget's worth: the route answers 404 for both
      // not-found and not-yours, so retrying it burns the budget for nothing.
      expect(h.calls.where((String c) => c.startsWith('GET')).length, 1);
    });

    test('a transient 5xx mid-poll keeps waiting rather than giving up',
        () async {
      int polls = 0;
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          if (req.method == 'POST') {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'import_id': 'imp-1',
                'status': 'uploaded',
              }),
              201,
            );
          }
          polls++;
          if (polls == 1) return http.Response('{"message":"oops"}', 502);
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': 'parsed',
              'route': 'chat',
            }),
            200,
          );
        },
        pollInterval: const Duration(milliseconds: 1),
        pollBudget: const Duration(seconds: 5),
      );

      expect(await h.importer.importResume(_doc()),
          isA<ResumeImportRoutedToChat>());
      expect(h.calls.where((String c) => c.startsWith('GET')).length, 2);
    });

    test('running out of patience is Failed, not a hang', () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          // Never leaves `parsing` — the parse worker is wedged, or Redis is
          // down and nothing ever picked the job up.
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': req.method == 'POST' ? 'uploaded' : 'parsing',
            }),
            req.method == 'POST' ? 201 : 200,
          );
        },
      );

      expect(await h.importer.importResume(_doc()), isA<ResumeImportFailed>());
    });

    test('a failed PUT is Failed and IS reported, with a PII-free reason',
        () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          return http.Response('storage said no', 500);
        },
      );

      expect(await h.importer.importResume(_doc()), isA<ResumeImportFailed>());
      // Nothing was registered — the confirm was never reached.
      expect(h.calls, <String>[
        'POST /profiling/resume-import/upload-url',
        'PUT_BYTES',
      ]);
      // Reported, not swallowed. A STATIC key: no filename, no storage key,
      // no signed url.
      expect(h.reported, <Object>['resume_import_failed']);
    });

    test('a 503 from the CONFIRM is Unavailable too — dormancy at every door',
        () async {
      final ({
        ResumeImporterImpl importer,
        List<String> calls,
        List<Object> reported
      }) h = _build(
        handler: (http.Request req, List<String> calls) async {
          calls.add(_label(req));
          if (req.url.path.endsWith('/upload-url')) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'storage_path': 'resume-uploads/w1/abc.pdf',
                'upload_url': _kSignedUrl,
                'expires_in': 600,
              }),
              201,
            );
          }
          if (req.url.toString() == _kSignedUrl) {
            return http.Response('', 200);
          }
          return http.Response('{"message":"not enabled"}', 503);
        },
      );

      // The bucket can be un-set between the mint and the confirm; the server
      // checks it at BOTH doors, so the client must read both the same way.
      expect(
        await h.importer.importResume(_doc()),
        isA<ResumeImportUnavailable>(),
      );
    });

    test('no session is Failed, and reaches no network at all', () async {
      final List<String> calls = <String>[];
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls.add(_label(req));
          return http.Response('{}', 200);
        }),
      );
      final ResumeImporterImpl importer = ResumeImporterImpl(
        api: api,
        // No token — fail CLOSED. There is no anonymous upload.
        session: SessionRepository(),
      );

      expect(await importer.importResume(_doc()), isA<ResumeImportFailed>());
      expect(calls, isEmpty);
    });

    test('an over-sized document is refused before the mint', () async {
      final List<String> calls = <String>[];
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls.add(_label(req));
          return http.Response('{}', 200);
        }),
      );
      final ResumeImporterImpl importer =
          ResumeImporterImpl(api: api, session: _session());

      expect(
        await importer.importResume(_doc(kResumeUploadMaxBytes + 1)),
        isA<ResumeImportFailed>(),
      );
      expect(calls, isEmpty);
    });
  });
}
