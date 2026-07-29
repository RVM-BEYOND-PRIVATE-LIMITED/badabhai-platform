import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/photo_repository.dart';

/// REAL photo byte-PUT: uploads the resized JPEG directly to the signed slot
/// (`Content-Type: image/jpeg`, bounded timeout). Mirrors
/// RealVoiceStorageUploader's discipline: the signed url is never logged and no
/// thrown message carries the url/token/body.
class RealPhotoUploader implements PhotoUploader {
  RealPhotoUploader({http.Client? client, Duration putTimeout = defaultPutTimeout})
      : _client = client ?? http.Client(),
        _putTimeout = putTimeout;

  /// A 1024px JPEG is a few hundred KB; 30s covers a 2G/EDGE uplink without
  /// parking the worker on a spinner forever (the voice-leg rationale).
  static const Duration defaultPutTimeout = Duration(seconds: 30);

  final http.Client _client;
  final Duration _putTimeout;

  @override
  Future<void> put({required String uploadUrl, required Uint8List bytes}) async {
    final http.Response res = await _client
        .put(
          Uri.parse(uploadUrl),
          headers: const <String, String>{'content-type': 'image/jpeg'},
          body: bytes,
        )
        .timeout(
          _putTimeout,
          onTimeout: () => throw ApiException(408, 'photo upload timed out'),
        );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Generic on purpose: the signed url embeds a token and the storage body
      // could echo it — neither may reach a log or the UI.
      throw ApiException(res.statusCode, 'photo upload failed');
    }
  }
}

/// MOCK photo byte-PUT: no network, no bytes stored — mock mode's guarantee.
class MockPhotoUploader implements PhotoUploader {
  const MockPhotoUploader();

  @override
  Future<void> put({required String uploadUrl, required Uint8List bytes}) async {
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }
}

/// Real photo source (ADR-0032): ApiClient for mint/confirm/read/delete, the
/// [PhotoUploader] seam for the byte PUT. Fail-closed on a missing session;
/// every error maps to a typed [Failure]; a 503 (feature dormant server-side)
/// reads as the honest [PhotoUnavailableFailure], and a 404 on the read is
/// "no photo" (null), never an error.
///
/// CACHE: holds the last-fetched signed URL in memory so the three consumers
/// (resume tab header, edit screen thumbnail, profile tab avatar) do not each
/// issue a redundant GET /workers/me/photo-url every time the widget remounts
/// or the tab is re-focused. The signed URL is a bearer credential — it is held
/// in memory only, never persisted. The cache is invalidated on every
/// [uploadPhoto] and [removePhoto], so the next [photoUrl] call fetches a fresh
/// URL that reflects the new state.
class PhotoRepositoryImpl implements PhotoRepository {
  PhotoRepositoryImpl(this._api, this._session, this._uploader);

  final ApiClient _api;
  final SessionRepository _session;
  final PhotoUploader _uploader;

  /// In-memory cache of the last-fetched signed URL. Null means either no photo
  /// or not yet fetched. [uploadPhoto] and [removePhoto] clear this so the
  /// subsequent [photoUrl] call fetches a fresh URL.
  String? _cachedUrl;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<String?> photoUrl() async {
    // Return cached URL immediately — avoids a redundant network round-trip
    // every time a widget remounts or a tab is re-focused. The cache lives in
    // memory only (the URL is a bearer credential) and is invalidated on
    // upload/remove so a fresh URL is fetched after any mutation.
    if (_cachedUrl != null) return _cachedUrl;

    final String token = _requireToken();
    try {
      final String url = await _api.getMyPhotoUrl(authToken: token);
      _cachedUrl = url.isEmpty ? null : url;
      return _cachedUrl;
    } on ApiException catch (e) {
      if (e.statusCode == 404) {
        _cachedUrl = null;
        return null; // no photo yet — not an error
      }
      if (e.statusCode == 503) throw const PhotoUnavailableFailure();
      throw mapError(e);
    } catch (error) {
      // Don't cache an error result — a transient failure should not poison the
      // cache and leave the user staring at a blank placeholder until the app is
      // killed.
      throw mapError(error);
    }
  }

  @override
  Future<void> uploadPhoto(Uint8List bytes) async {
    final String token = _requireToken();
    try {
      final PhotoUploadTicket ticket;
      try {
        ticket = await _api.requestPhotoUploadUrl(authToken: token);
      } on ApiException catch (e) {
        if (e.statusCode == 503) throw const PhotoUnavailableFailure();
        rethrow;
      }
      await _uploader.put(uploadUrl: ticket.uploadUrl, bytes: bytes);
      await _api.confirmPhoto(storagePath: ticket.storagePath, authToken: token);
      // Invalidate cache: the next photoUrl() call will fetch a fresh signed URL
      // for the newly uploaded photo.
      _cachedUrl = null;
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> removePhoto() async {
    final String token = _requireToken();
    try {
      await _api.deleteMyPhoto(authToken: token);
      // Photo no longer exists — clear the cache so photoUrl() returns null.
      _cachedUrl = null;
    } catch (error) {
      throw mapError(error);
    }
  }
}
