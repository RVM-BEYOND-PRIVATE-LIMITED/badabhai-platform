// The upload leg for a feedback image: mint a signed slot on the API, PUT the
// JPEG bytes to it, return the server-owned storage_path. A per-image failure
// throws HERE and the SCREEN swallows it (the text feedback must always send).
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/feedback/data/feedback_attachment_uploader_impl.dart';

const String _mintedPath =
    'feedback-attachments/w1/9f8e7d6c-2222-4222-8222-000000000002.jpg';
const String _signedUpload = 'http://storage.test/signed-upload?token=SECRET';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

/// Routes the mint endpoint; [mintStatus] != 201 answers an error body.
MockClient _mintClient(List<http.Request> captured, {int mintStatus = 201}) {
  return MockClient((http.Request req) async {
    captured.add(req);
    if (req.method == 'POST' &&
        req.url.path == '/workers/me/feedback/attachment/upload-url') {
      if (mintStatus != 201) {
        return http.Response('{"message":"off"}', mintStatus);
      }
      return http.Response(
        jsonEncode(<String, dynamic>{
          'storage_path': _mintedPath,
          'upload_url': _signedUpload,
          'expires_in': 7200,
        }),
        201,
      );
    }
    return http.Response('{"message":"unexpected"}', 500);
  });
}

void main() {
  test('mint -> PUT bytes to the SIGNED url -> returns the MINTED path',
      () async {
    final List<http.Request> mintReqs = <http.Request>[];
    http.Request? put;
    final RealFeedbackAttachmentUploader uploader = RealFeedbackAttachmentUploader(
      api: ApiClient(baseUrl: 'http://test', client: _mintClient(mintReqs)),
      session: _session(),
      client: MockClient((http.Request req) async {
        put = req;
        return http.Response('', 200);
      }),
    );
    final Uint8List bytes = Uint8List.fromList(<int>[0xFF, 0xD8, 0xFF]);

    final String path = await uploader.upload(bytes);

    expect(path, _mintedPath);
    // 1) mint — empty body (server chooses the key), bearer attached
    expect(mintReqs.single.method, 'POST');
    expect(mintReqs.single.url.path,
        '/workers/me/feedback/attachment/upload-url');
    expect(jsonDecode(mintReqs.single.body), <String, dynamic>{});
    expect(mintReqs.single.headers['authorization'], 'Bearer tok');
    // 2) the bytes go to the SIGNED url as image/jpeg — never through the API
    expect(put!.method, 'PUT');
    expect(put!.url.toString(), _signedUpload);
    expect(put!.headers['content-type'], startsWith('image/jpeg'));
    expect(put!.bodyBytes, bytes);
  });

  test('a PUT non-2xx throws — and never leaks the signed token', () async {
    final RealFeedbackAttachmentUploader uploader = RealFeedbackAttachmentUploader(
      api: ApiClient(baseUrl: 'http://test', client: _mintClient(<http.Request>[])),
      session: _session(),
      client: MockClient(
          (http.Request req) async => http.Response('token-echo SECRET', 403)),
    );
    await expectLater(
      uploader.upload(Uint8List.fromList(<int>[1])),
      throwsA(
        isA<ApiException>().having(
          (ApiException e) => e.message,
          'message',
          isNot(contains('SECRET')),
        ),
      ),
    );
  });

  test(
      'mint 404 (endpoint not deployed) surfaces a failure BEFORE any bytes move '
      '— the screen swallows it so the text still sends', () async {
    final List<http.Request> putReqs = <http.Request>[];
    final RealFeedbackAttachmentUploader uploader = RealFeedbackAttachmentUploader(
      api: ApiClient(
          baseUrl: 'http://test',
          client: _mintClient(<http.Request>[], mintStatus: 404)),
      session: _session(),
      client: MockClient((http.Request req) async {
        putReqs.add(req);
        return http.Response('', 200);
      }),
    );
    await expectLater(
      uploader.upload(Uint8List.fromList(<int>[1])),
      throwsA(isA<ApiException>()
          .having((ApiException e) => e.statusCode, 'statusCode', 404)),
    );
    expect(putReqs, isEmpty);
  });

  test('mint 503 (bucket dormant) surfaces a failure', () async {
    final RealFeedbackAttachmentUploader uploader = RealFeedbackAttachmentUploader(
      api: ApiClient(
          baseUrl: 'http://test',
          client: _mintClient(<http.Request>[], mintStatus: 503)),
      session: _session(),
      client: MockClient((http.Request req) async => http.Response('', 200)),
    );
    await expectLater(
      uploader.upload(Uint8List.fromList(<int>[1])),
      throwsA(isA<ApiException>()
          .having((ApiException e) => e.statusCode, 'statusCode', 503)),
    );
  });

  test('fail-closed: no session token -> UnauthorizedFailure, no mint',
      () async {
    final List<http.Request> mintReqs = <http.Request>[];
    final RealFeedbackAttachmentUploader uploader = RealFeedbackAttachmentUploader(
      api: ApiClient(baseUrl: 'http://test', client: _mintClient(mintReqs)),
      session: _session(token: null),
      client: MockClient((http.Request req) async => http.Response('', 200)),
    );
    await expectLater(
      uploader.upload(Uint8List.fromList(<int>[1])),
      throwsA(isA<UnauthorizedFailure>()),
    );
    expect(mintReqs, isEmpty);
  });

  test('MockFeedbackAttachmentUploader returns a canned path, no network',
      () async {
    final String path = await const MockFeedbackAttachmentUploader()
        .upload(Uint8List.fromList(<int>[1]));
    expect(path, startsWith('feedback-attachments/'));
  });
}
