import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/resume/data/photo_repository_impl.dart';
import 'package:badabhai_worker_app/features/resume/domain/photo_repository.dart';

const String _mintedPath = 'photos/w1/9f8e7d6c-2222-4222-8222-000000000002.jpg';
const String _signedUpload = 'http://storage.test/signed-upload?token=SECRET';
const String _signedRead = 'http://storage.test/signed-read?token=SECRET';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

/// Records every API request; routes the photo endpoints per [photoStatus].
MockClient _apiClient(
  List<http.Request> captured, {
  int photoUrlStatus = 200,
  int mintStatus = 201,
}) {
  return MockClient((http.Request req) async {
    captured.add(req);
    final String p = req.url.path;
    if (req.method == 'POST' && p == '/workers/me/photo/upload-url') {
      if (mintStatus != 201) return http.Response('{"message":"off"}', mintStatus);
      return http.Response(
        jsonEncode(<String, dynamic>{
          'storage_path': _mintedPath,
          'upload_url': _signedUpload,
          'expires_in': 7200,
        }),
        201,
      );
    }
    if (req.method == 'POST' && p == '/workers/me/photo') {
      return http.Response(
          jsonEncode(<String, dynamic>{'worker_id': 'w1', 'has_photo': true}), 200);
    }
    if (req.method == 'GET' && p == '/workers/me/photo-url') {
      if (photoUrlStatus != 200) {
        return http.Response('{"message":"nope"}', photoUrlStatus);
      }
      return http.Response(
          jsonEncode(<String, dynamic>{'url': _signedRead, 'expires_in': 900}), 200);
    }
    if (req.method == 'DELETE' && p == '/workers/me/photo') {
      return http.Response(
          jsonEncode(<String, dynamic>{'worker_id': 'w1', 'has_photo': false}), 200);
    }
    return http.Response('{"message":"unexpected"}', 500);
  });
}

/// A PUT recorder standing in for the signed-url uploader leg.
class _RecordingUploader implements PhotoUploader {
  String? url;
  Uint8List? bytes;
  Object? throwOnPut;

  @override
  Future<void> put({required String uploadUrl, required Uint8List bytes}) async {
    if (throwOnPut != null) throw throwOnPut!;
    url = uploadUrl;
    this.bytes = bytes;
  }
}

void main() {
  group('photoUrl', () {
    test('GETs /workers/me/photo-url with the bearer and returns the signed url',
        () async {
      final List<http.Request> reqs = <http.Request>[];
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: _apiClient(reqs)),
        _session(),
        _RecordingUploader(),
      );
      final String? url = await repo.photoUrl();
      expect(url, _signedRead);
      expect(reqs.single.headers['authorization'], 'Bearer tok');
    });

    test('404 means NO PHOTO (null) — never an error', () async {
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(
            baseUrl: 'http://test',
            client: _apiClient(<http.Request>[], photoUrlStatus: 404)),
        _session(),
        _RecordingUploader(),
      );
      expect(await repo.photoUrl(), isNull);
    });

    test('503 (feature dormant) maps to the honest PhotoUnavailableFailure',
        () async {
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(
            baseUrl: 'http://test',
            client: _apiClient(<http.Request>[], photoUrlStatus: 503)),
        _session(),
        _RecordingUploader(),
      );
      expect(repo.photoUrl(), throwsA(isA<PhotoUnavailableFailure>()));
    });

    test('fail-closed: no session token -> UnauthorizedFailure, no request',
        () async {
      final List<http.Request> reqs = <http.Request>[];
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: _apiClient(reqs)),
        _session(token: null),
        _RecordingUploader(),
      );
      expect(repo.photoUrl(), throwsA(isA<UnauthorizedFailure>()));
      expect(reqs, isEmpty);
    });
  });

  group('uploadPhoto', () {
    test('mint -> PUT bytes to the SIGNED url -> confirm with the MINTED path',
        () async {
      final List<http.Request> reqs = <http.Request>[];
      final _RecordingUploader up = _RecordingUploader();
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: _apiClient(reqs)),
        _session(),
        up,
      );
      final Uint8List bytes = Uint8List.fromList(<int>[0xFF, 0xD8, 0xFF]);

      await repo.uploadPhoto(bytes);

      // 1) mint (empty body — the server chooses the key)
      expect(reqs[0].method, 'POST');
      expect(reqs[0].url.path, '/workers/me/photo/upload-url');
      expect(jsonDecode(reqs[0].body), <String, dynamic>{});
      // 2) bytes PUT to the signed url, never through the API
      expect(up.url, _signedUpload);
      expect(up.bytes, bytes);
      // 3) confirm registers EXACTLY the minted path
      expect(reqs[1].method, 'POST');
      expect(reqs[1].url.path, '/workers/me/photo');
      expect(jsonDecode(reqs[1].body),
          <String, dynamic>{'storage_path': _mintedPath});
    });

    test('503 on mint -> PhotoUnavailableFailure BEFORE any bytes move',
        () async {
      final _RecordingUploader up = _RecordingUploader();
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(
            baseUrl: 'http://test',
            client: _apiClient(<http.Request>[], mintStatus: 503)),
        _session(),
        up,
      );
      await expectLater(
        repo.uploadPhoto(Uint8List.fromList(<int>[1])),
        throwsA(isA<PhotoUnavailableFailure>()),
      );
      expect(up.url, isNull); // the uploader was never invoked
    });

    test('a PUT transport failure maps to a typed Failure (never crashes raw)',
        () async {
      final _RecordingUploader up = _RecordingUploader()
        ..throwOnPut = ApiException(500, 'photo upload failed');
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: _apiClient(<http.Request>[])),
        _session(),
        up,
      );
      expect(
        repo.uploadPhoto(Uint8List.fromList(<int>[1])),
        throwsA(isA<ServerFailure>()),
      );
    });
  });

  group('removePhoto', () {
    test('DELETEs /workers/me/photo with the bearer', () async {
      final List<http.Request> reqs = <http.Request>[];
      final PhotoRepositoryImpl repo = PhotoRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: _apiClient(reqs)),
        _session(),
        _RecordingUploader(),
      );
      await repo.removePhoto();
      expect(reqs.single.method, 'DELETE');
      expect(reqs.single.url.path, '/workers/me/photo');
      expect(reqs.single.headers['authorization'], 'Bearer tok');
    });
  });

  group('RealPhotoUploader', () {
    test('PUTs the bytes with content-type image/jpeg; non-2xx throws generic',
        () async {
      http.Request? seen;
      final MockClient storage = MockClient((http.Request req) async {
        seen = req;
        return http.Response('', 200);
      });
      await RealPhotoUploader(client: storage)
          .put(uploadUrl: _signedUpload, bytes: Uint8List.fromList(<int>[7]));
      expect(seen!.method, 'PUT');
      expect(seen!.headers['content-type'], startsWith('image/jpeg'));

      final MockClient failing = MockClient(
          (http.Request req) async => http.Response('token-echo SECRET', 403));
      await expectLater(
        RealPhotoUploader(client: failing)
            .put(uploadUrl: _signedUpload, bytes: Uint8List.fromList(<int>[7])),
        throwsA(
          isA<ApiException>().having(
            // The signed url/token must never leak into the thrown message.
            (ApiException e) => e.message,
            'message',
            isNot(contains('SECRET')),
          ),
        ),
      );
    });
  });
}
