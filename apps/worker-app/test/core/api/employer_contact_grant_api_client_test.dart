import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';

/// The wire contract for `POST /consent/employer-contact/grant` (2026-11-04):
/// WorkerAuthGuard, body `{consent_version}` ONLY — the server derives the
/// purposes — and `{ok, consent_id, granted}` back.
void main() {
  group('ApiClient.grantEmployerContact', () {
    test('POSTs the grant with the bearer and ONLY the notice version',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'ok': true,
              'consent_id': 'c2',
              'granted': <String>['employer_sharing', 'employer_messaging'],
            }),
            200,
          );
        }),
      );

      final EmployerContactGrantDto dto =
          await api.grantEmployerContact(authToken: 'tok');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/consent/employer-contact/grant');
      expect(captured.headers['authorization'], 'Bearer tok');
      // No purpose list, no worker id: the version of the notice just shown.
      expect(
        jsonDecode(captured.body),
        <String, dynamic>{'consent_version': '2026-11-04'},
      );
      expect(
        dto,
        const EmployerContactGrantDto(
          ok: true,
          consentId: 'c2',
          granted: <String>['employer_sharing', 'employer_messaging'],
        ),
      );
    });

    test('the idempotent no-op parses as a success with nothing granted',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'ok': true,
                'consent_id': null,
                'granted': <String>[],
              }),
              200,
            )),
      );

      final EmployerContactGrantDto dto =
          await api.grantEmployerContact(authToken: 'tok');
      expect(dto.ok, isTrue);
      expect(dto.consentId, isNull);
      expect(dto.granted, isEmpty);
    });

    for (final int status in <int>[400, 404]) {
      test('a $status surfaces as an ApiException (honest failure)', () {
        final ApiClient api = ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{'message': 'no'}), status)),
        );

        expect(
          () => api.grantEmployerContact(authToken: 'tok'),
          throwsA(isA<ApiException>()
              .having((ApiException e) => e.statusCode, 'statusCode', status)),
        );
      });
    }
  });

  test('MockApiClient: grant turns the canned switch back ON', () async {
    final MockApiClient api = MockApiClient();
    await api.withdrawEmployerContact(authToken: 'mock');
    expect((await api.getConsentState(authToken: 'mock')).purposes,
        isNot(contains('employer_sharing')));

    final EmployerContactGrantDto dto =
        await api.grantEmployerContact(authToken: 'mock');

    expect(dto.granted, <String>['employer_sharing', 'employer_messaging']);
    expect(
      (await api.getConsentState(authToken: 'mock')).purposes,
      containsAll(<String>['employer_sharing', 'employer_messaging']),
    );
    // Already on: the idempotent no-op.
    expect((await api.grantEmployerContact(authToken: 'mock')).granted, isEmpty);
  });
}
