import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The server's REAL error envelope (`AllExceptionsFilter`, every response
/// app-wide) is `{statusCode, error: {message, issues?}, requestId, path,
/// timestamp}` — `message` sits under `error`, never at the top level. A
/// client that only ever checked the top level fell through to returning
/// the WHOLE raw JSON body as `ApiException.message`, which a caller
/// showing that message directly on screen (e.g. a form's inline submit
/// error) then rendered as a wall of JSON to the worker.
void main() {
  Future<ApiException> failWith(Map<String, dynamic> body) async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        return http.Response(jsonEncode(body), 400);
      }),
    );
    try {
      await api.attributeReferral(authToken: 'tok', code: 'abcdef012345');
    } on ApiException catch (e) {
      return e;
    }
    fail('expected an ApiException');
  }

  test('a Zod validation 400 surfaces the first issue\'s own message', () async {
    final ApiException e = await failWith(<String, dynamic>{
      'statusCode': 400,
      'error': <String, dynamic>{
        'message': 'Validation failed',
        'issues': <Map<String, dynamic>>[
          <String, dynamic>{
            'path': 'preferred_cities',
            'message': 'unrecognised city: Kota',
          },
        ],
      },
      'requestId': 'r-1',
      'path': '/workers/me/work-preferences',
      'timestamp': '2026-09-03T07:11:23.102Z',
    });

    expect(e.message, 'unrecognised city: Kota');
    // The whole point: never the raw envelope.
    expect(e.message, isNot(contains('statusCode')));
    expect(e.message, isNot(contains('requestId')));
  });

  test('a 400 with no issues falls back to error.message', () async {
    final ApiException e = await failWith(<String, dynamic>{
      'statusCode': 400,
      'error': <String, dynamic>{'message': 'profile is not confirmed'},
      'requestId': 'r-2',
      'path': '/resume/generate',
      'timestamp': '2026-09-03T07:11:23.102Z',
    });

    expect(e.message, 'profile is not confirmed');
  });

  test('a legacy top-level message shape still works', () async {
    final ApiException e = await failWith(<String, dynamic>{'message': 'old shape'});
    expect(e.message, 'old shape');
  });

  test('an unparseable body degrades to a safe generic line, never the raw body',
      () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient(
        (http.Request req) async => http.Response('not json at all', 400),
      ),
    );
    try {
      await api.attributeReferral(authToken: 'tok', code: 'abcdef012345');
      fail('expected an ApiException');
    } on ApiException catch (e) {
      expect(e.message, 'Kuch gadbad ho gayi. Dobara koshish karein.');
      expect(e.message, isNot(contains('not json')));
    }
  });
}
