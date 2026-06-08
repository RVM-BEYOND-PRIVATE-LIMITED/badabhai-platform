/// API client — PLACEHOLDER for Phase 1.
///
/// Intentionally has NO HTTP dependency yet (so `flutter pub get` stays light).
/// Methods return mock data to let the screens flow end-to-end. Wire to the
/// NestJS API (see apps/api) later with `http`/`dio` and proper models.
///
/// Base URL is supplied at build time:
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3001
class ApiClient {
  ApiClient({String? baseUrl})
      : baseUrl = baseUrl ??
            const String.fromEnvironment(
              'API_BASE_URL',
              defaultValue: 'http://localhost:3001',
            );

  final String baseUrl;

  Future<void> requestOtp(String phoneE164) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/auth/otp/request { phone }
  }

  Future<String> verifyOtp(String phoneE164, String otp) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/auth/otp/verify -> { worker_id }
    return _mockId('worker');
  }

  Future<void> acceptConsent({
    required String workerId,
    required List<String> purposes,
  }) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/consent/accept
  }

  Future<String> startSession(String workerId) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/chat/session -> { session_id }
    return _mockId('session');
  }

  Future<String> sendMessage({
    required String sessionId,
    required String workerId,
    required String text,
  }) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/chat/message -> { reply }
    return 'Bada Bhai (mock): tell me which machines you run and your experience.';
  }

  Future<String> extractProfile({
    required String workerId,
    String? sessionId,
  }) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/profile/extract -> { profile_id }
    return _mockId('profile');
  }

  Future<void> confirmProfile({
    required String workerId,
    required String profileId,
  }) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/profile/confirm
  }

  Future<String> generateResume({
    required String workerId,
    required String profileId,
  }) async {
    await _fakeLatency();
    // TODO: POST $baseUrl/resume/generate -> { resume_text }
    return 'WORKER PROFILE (DRAFT)\nRole: VMC Operator\nExperience: 5 years';
  }

  Future<void> _fakeLatency() => Future<void>.delayed(const Duration(milliseconds: 300));

  String _mockId(String prefix) =>
      '$prefix-${DateTime.now().millisecondsSinceEpoch}';
}
