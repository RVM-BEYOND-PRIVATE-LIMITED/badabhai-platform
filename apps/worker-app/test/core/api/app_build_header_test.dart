import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/config/build_info.dart';

/// #966 — the worker app must stamp WHICH build every request came from, so the
/// server can attribute a bug report to a specific build from its logs (a client
/// fix can be green on `main` while a tester's device runs a days-old APK).
void main() {
  test('every request carries the x-app-build header', () async {
    late http.Request captured;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        captured = req;
        return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
      }),
    );

    // Any authed call — the header is built at the single [_headers] choke-point,
    // so it rides EVERY request, not just this one.
    await api.attributeReferral(authToken: 'tok', code: 'abcdef012345');

    // Present, and equal to the compile-time build id. A test binary carries no
    // --dart-define=APP_BUILD, so it is the 'dev' default — never absent.
    expect(captured.headers['x-app-build'], isNotNull);
    expect(captured.headers['x-app-build'], kAppBuild);
    expect(kAppBuild, 'dev');
  });
}
