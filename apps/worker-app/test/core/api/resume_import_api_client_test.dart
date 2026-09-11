import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The résumé-import wire contract (#1499 / ADR-0041 RI-1..RI-4), pinned
/// against the shapes `resume-import.controller.ts` actually serves.
void main() {
  group('createResumeUploadUrl', () {
    test('POSTs the mint with the declared mime and nothing else', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'storage_path': 'resume-uploads/w1/abc.pdf',
              'upload_url': 'https://storage.test/signed?token=SECRET',
              'expires_in': 600,
            }),
            201,
          );
        }),
      );

      final SignedUploadTicket ticket = await api.createResumeUploadUrl(
        mime: 'application/pdf',
        authToken: 'tok',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/profiling/resume-import/upload-url');
      expect(captured.headers['authorization'], 'Bearer tok');
      // `.strict()` server-side: an extra field is a 400, so the client must
      // send EXACTLY this one key.
      expect(
        jsonDecode(captured.body),
        <String, dynamic>{'mime': 'application/pdf'},
      );
      expect(ticket.storagePath, 'resume-uploads/w1/abc.pdf');
      expect(ticket.uploadUrl, 'https://storage.test/signed?token=SECRET');
      expect(ticket.expiresInSeconds, 600);
    });

    test('a 503 (bucket unset) surfaces as an ApiException the caller can read',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response('{"message":"résumé uploads not enabled"}', 503)),
      );

      // This is the state on EVERY box today, so it is the branch that has to
      // be reachable and identifiable rather than the exotic one.
      await expectLater(
        api.createResumeUploadUrl(mime: 'image/jpeg', authToken: 'tok'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 503)),
      );
    });
  });

  group('confirmResumeImport', () {
    test('POSTs only the storage_path and parses the import row', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': 'uploaded',
              'route': null,
              'form_kind': null,
              'failure_reason': null,
            }),
            201,
          );
        }),
      );

      final ResumeImportDto dto = await api.confirmResumeImport(
        storagePath: 'resume-uploads/w1/abc.pdf',
        authToken: 'tok',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/profiling/resume-import');
      // Deliberately NO mime and NO byte_size: the server measures the object
      // itself, because a client that states its own size can defeat the cap.
      expect(
        jsonDecode(captured.body),
        <String, dynamic>{'storage_path': 'resume-uploads/w1/abc.pdf'},
      );
      expect(dto.importId, 'imp-1');
      expect(dto.status, ResumeImportStatus.uploaded);
      // NULL until parsing finishes — never defaulted to one of the two routes.
      expect(dto.route, isNull);
      expect(dto.isTerminal, isFalse);
    });
  });

  group('getResumeImport', () {
    test('GETs the import by id', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'import_id': 'imp-1',
              'status': 'parsed',
              'route': 'form',
              'form_kind': 'cnc_turner',
              'failure_reason': null,
            }),
            200,
          );
        }),
      );

      final ResumeImportDto dto =
          await api.getResumeImport(importId: 'imp-1', authToken: 'tok');

      expect(captured.method, 'GET');
      expect(captured.url.path, '/profiling/resume-import/imp-1');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(dto.status, ResumeImportStatus.parsed);
      expect(dto.route, ResumeImportRoute.form);
      expect(dto.formKind, 'cnc_turner');
      expect(dto.isTerminal, isTrue);
      expect(dto.hasFailed, isFalse);
    });

    test('parses the failed terminal state and keeps the reason UNRENDERED',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'import_id': 'imp-1',
                'status': 'failed',
                'route': null,
                'form_kind': null,
                'failure_reason': 'ocr_below_floor',
              }),
              200,
            )),
      );

      final ResumeImportDto dto =
          await api.getResumeImport(importId: 'imp-1', authToken: 'tok');

      expect(dto.status, ResumeImportStatus.failed);
      expect(dto.hasFailed, isTrue);
      expect(dto.isTerminal, isTrue);
      // Carried so a caller can tell "failed" from "still going" — and mapped
      // to one honest line by the screen, never shown as-is (ruling D9).
      expect(dto.failureReason, 'ocr_below_floor');
    });

    test('an UNKNOWN status is not a crash and is not terminal', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'import_id': 'imp-1',
                'status': 'some_future_state',
                'route': 'form',
              }),
              200,
            )),
      );

      final ResumeImportDto dto =
          await api.getResumeImport(importId: 'imp-1', authToken: 'tok');

      // A status this build has never heard of must not crash a worker
      // mid-onboarding, and must not be read as a decision either.
      expect(dto.status, ResumeImportStatus.unknown);
      expect(dto.isTerminal, isFalse);
      expect(dto.hasFailed, isFalse);
    });

    test('an unknown ROUTE reads as null, never guessed', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'import_id': 'imp-1',
                'status': 'parsed',
                'route': 'somewhere_else',
              }),
              200,
            )),
      );

      final ResumeImportDto dto =
          await api.getResumeImport(importId: 'imp-1', authToken: 'tok');

      expect(dto.route, isNull);
    });
  });
}
