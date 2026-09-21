import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/storage/signed_object_put.dart';

/// The one signed-slot byte PUT (#1499), extracted from the three byte-for-byte
/// copies that lived in `RealVoiceStorageUploader`, `RealPhotoUploader` and
/// `RealFeedbackAttachmentUploader`.
///
/// Their own tests still pin their behaviour end-to-end; this pins the shared
/// leg directly, including the two properties that are easy to lose in a
/// refactor — the exact content type, and the fact that no thrown message
/// carries the signed url.
void main() {
  const String signed = 'https://storage.test/o/key?token=SUPER_SECRET_TOKEN';

  test('PUTs the bytes with exactly the given content type', () async {
    late http.Request captured;
    final SignedObjectPut put = SignedObjectPut(
      client: MockClient((http.Request req) async {
        captured = req;
        return http.Response('', 200);
      }),
    );

    await put.send(
      uploadUrl: signed,
      bytes: Uint8List.fromList(<int>[1, 2, 3]),
      contentType: 'application/pdf',
      what: 'résumé',
    );

    expect(captured.method, 'PUT');
    expect(captured.url.toString(), signed);
    expect(captured.headers['content-type'], 'application/pdf');
    expect(captured.bodyBytes, <int>[1, 2, 3]);
  });

  test('a non-2xx throws the storage status with a generic message', () async {
    final SignedObjectPut put = SignedObjectPut(
      client: MockClient((http.Request req) async =>
          // A storage error body can echo the signed url back at us.
          http.Response('<Error><Url>$signed</Url></Error>', 403)),
    );

    await expectLater(
      put.send(
        uploadUrl: signed,
        bytes: Uint8List(4),
        contentType: 'image/jpeg',
        what: 'photo',
      ),
      throwsA(
        isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 403)
            .having((ApiException e) => e.message, 'message', 'photo upload failed')
            // THE privacy property: the signed url is a bearer credential and
            // a thrown message reaches logs, crash reports and screenshots.
            .having(
              (ApiException e) => e.message.contains('SUPER_SECRET_TOKEN'),
              'leaks the signing token',
              isFalse,
            ),
      ),
    );
  });

  test('a stalled socket becomes a 408 rather than hanging forever', () async {
    final SignedObjectPut put = SignedObjectPut(
      timeout: const Duration(milliseconds: 10),
      client: MockClient((http.Request req) async {
        await Future<void>.delayed(const Duration(seconds: 5));
        return http.Response('', 200);
      }),
    );

    await expectLater(
      put.send(
        uploadUrl: signed,
        bytes: Uint8List(4),
        contentType: 'audio/mp4',
        what: 'voice clip',
      ),
      throwsA(isA<ApiException>()
          .having((ApiException e) => e.statusCode, 'statusCode', 408)
          .having((ApiException e) => e.message, 'message',
              'voice clip upload timed out')),
    );
  });

  test('the default timeout is the 30s the three uploaders each chose', () {
    // Our workers are often on 2G/EDGE, so this is deliberately far above the
    // app's usual ~8s — but bounded, so a stalled socket does not park a
    // worker on a spinner forever.
    expect(SignedObjectPut.defaultTimeout, const Duration(seconds: 30));
  });
}
