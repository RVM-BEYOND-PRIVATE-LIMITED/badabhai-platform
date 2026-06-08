import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_models.dart';

// Re-export the response models so screens that import this file get them too.
export 'api_models.dart';

/// Current DPDP consent version. Mirrors `CURRENT_CONSENT_VERSION` in
/// packages/types — keep these in sync when the consent copy changes.
const String kConsentVersion = '2026-06-01';

/// HTTP client for the NestJS API (see apps/api).
///
/// Base URL is supplied at build time:
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3001
/// (10.0.2.2 is the Android emulator's alias for the host machine.)
///
/// PRIVACY: the worker's raw answers are sent to the API, which stores PII only
/// in the `workers` table and pseudonymizes before any LLM call. This client
/// never talks to an LLM directly.
class ApiClient {
  ApiClient({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ??
            const String.fromEnvironment(
              'API_BASE_URL',
              defaultValue: 'http://localhost:3001',
            ),
        _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  Future<void> requestOtp(String phoneE164) async {
    await _post('/auth/otp/request', <String, dynamic>{'phone': phoneE164});
  }

  Future<VerifyOtpResult> verifyOtp(String phoneE164, String otp) async {
    final Map<String, dynamic> json = await _post(
      '/auth/otp/verify',
      <String, dynamic>{'phone': phoneE164, 'otp': otp},
    );
    return VerifyOtpResult.fromJson(json);
  }

  Future<void> acceptConsent({
    required String workerId,
    required List<String> purposes,
    String consentVersion = kConsentVersion,
  }) async {
    await _post('/consent/accept', <String, dynamic>{
      'worker_id': workerId,
      'consent_version': consentVersion,
      'purposes': purposes,
    });
  }

  Future<String> startSession(String workerId) async {
    final Map<String, dynamic> json =
        await _post('/chat/session', <String, dynamic>{'worker_id': workerId});
    return json['session_id'] as String;
  }

  Future<ChatReply> sendMessage({
    required String sessionId,
    required String workerId,
    required String text,
  }) async {
    final Map<String, dynamic> json = await _post('/chat/message', <String, dynamic>{
      'session_id': sessionId,
      'worker_id': workerId,
      'text': text,
    });
    return ChatReply.fromJson(json);
  }

  Future<ExtractResult> extractProfile({
    required String workerId,
    String? sessionId,
  }) async {
    final Map<String, dynamic> json = await _post('/profile/extract', <String, dynamic>{
      'worker_id': workerId,
      if (sessionId != null) 'session_id': sessionId,
    });
    return ExtractResult.fromJson(json);
  }

  Future<void> confirmProfile({
    required String workerId,
    required String profileId,
  }) async {
    await _post('/profile/confirm', <String, dynamic>{
      'worker_id': workerId,
      'profile_id': profileId,
    });
  }

  Future<ResumeResult> generateResume({
    required String workerId,
    required String profileId,
  }) async {
    final Map<String, dynamic> json = await _post('/resume/generate', <String, dynamic>{
      'worker_id': workerId,
      'profile_id': profileId,
    });
    return ResumeResult.fromJson(json);
  }

  /// Closes the underlying HTTP client. Call when the client is no longer used.
  void dispose() => _client.close();

  /// POST JSON and return the decoded object. Throws [ApiException] on non-2xx.
  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final http.Response res = await _client.post(
      uri,
      headers: const <String, String>{'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _messageFrom(res.body));
    }
    if (res.body.isEmpty) return <String, dynamic>{};
    final dynamic decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  String _messageFrom(String body) {
    try {
      final dynamic decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic> && decoded['message'] != null) {
        return decoded['message'].toString();
      }
    } catch (_) {
      // fall through to raw body
    }
    return body.isEmpty ? 'request failed' : body;
  }
}
