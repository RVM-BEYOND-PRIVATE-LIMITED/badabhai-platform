import 'api_client.dart';

/// A no-network [ApiClient] for UI development.
///
/// Selected by `createApiClient` when `--dart-define=USE_MOCKS=true`
/// (see lib/core/config/app_config.dart). It extends [ApiClient] with a
/// `mock://local` base URL and OVERRIDES EVERY public network method to return
/// canned data after a short delay (so loading states still render). It NEVER
/// calls `super` and NEVER touches HTTP — no request can leave the device.
///
/// PII-FREE BY CONTRACT (CLAUDE.md §2, invariant 2): every id is an obviously
/// fake `mock-*` sentinel and every job/resume string is generic — no real
/// phone, name, employer, or address ever reaches app state or logs.
///
/// MAINTENANCE: any NEW public network method added to [ApiClient] MUST get a
/// matching override here — otherwise mock mode would silently fall through to
/// the real implementation and hit the network.
class MockApiClient extends ApiClient {
  MockApiClient() : super(baseUrl: 'mock://local');

  /// Canned latency so the real loading states still show in mock mode.
  static const Duration _latency = Duration(milliseconds: 300);

  /// Rotates the canned assistant turns so chat feels live across messages.
  int _chatTurn = 0;

  Future<void> _delay() => Future<void>.delayed(_latency);

  @override
  Future<RequestOtpResult> requestOtp(String phoneE164) async {
    await _delay();
    // Canned cooldown only — NO code is ever returned to the UI (the mock never
    // echoes `dev_otp`). Mirrors the default OTP_RESEND_COOLDOWN_SECONDS so the
    // resend countdown still renders in mock mode.
    return RequestOtpResult(success: true, channel: 'sms', resendInSeconds: 30);
  }

  @override
  Future<VerifyOtpResult> verifyOtp(String phoneE164, String otp) async {
    await _delay();
    return VerifyOtpResult(
      workerId: 'mock-worker-0001',
      accessToken: 'mock-token',
      isNewWorker: true,
      status: 'active',
    );
  }

  @override
  Future<void> acceptConsent({
    required String workerId,
    required List<String> purposes,
    String consentVersion = kConsentVersion,
  }) async {
    await _delay();
  }

  @override
  Future<String> startSession({required String authToken}) async {
    await _delay();
    return 'mock-session-0001';
  }

  @override
  Future<ChatReply> sendMessage({
    required String sessionId,
    required String authToken,
    required String text,
  }) async {
    await _delay();
    final _CannedTurn turn = _cannedTurns[_chatTurn % _cannedTurns.length];
    _chatTurn++;
    return ChatReply(
      reply: turn.reply,
      blocked: false,
      isMock: true,
      suggestedFollowups: turn.followups,
    );
  }

  @override
  Future<String> extractProfile({
    required String authToken,
    String? sessionId,
  }) async {
    await _delay();
    return 'mock-profile-0001';
  }

  @override
  Future<EnqueueResult> enqueueProfileExtraction({
    required String authToken,
    String? sessionId,
  }) async {
    await _delay();
    return EnqueueResult(aiJobId: 'mock-job-0001', status: 'queued');
  }

  @override
  Future<AiJob> getAiJob(String aiJobId) async {
    await _delay();
    return AiJob(
      id: 'mock-job-0001',
      jobType: 'profile_extraction',
      status: 'completed',
      profileId: 'mock-profile-0001',
      errorMessage: null,
    );
  }

  @override
  Future<String> awaitProfileId(
    String aiJobId, {
    int maxAttempts = 40,
    Duration pollInterval = const Duration(milliseconds: 350),
  }) async {
    await _delay();
    return 'mock-profile-0001';
  }

  @override
  Future<void> confirmProfile({
    required String authToken,
    required String profileId,
  }) async {
    await _delay();
  }

  @override
  Future<ResumeResult> generateResume({
    required String workerId,
    required String profileId,
  }) async {
    await _delay();
    return ResumeResult(
      resumeId: 'mock-resume-0001',
      version: 1,
      resumeText: _cannedResume,
      isMock: true,
    );
  }

  @override
  Future<List<FeedItem>> getFeed({
    required String authToken,
    int limit = 20,
  }) async {
    await _delay();
    return _cannedFeed.take(limit).toList();
  }

  @override
  Future<ApplyResult> applyToJob(
    String jobId, {
    required String authToken,
    int? rank,
    String sourceSurface = 'feed',
  }) async {
    await _delay();
    return ApplyResult(
      ok: true,
      applicationId: 'mock-app-0001',
      action: 'applied',
    );
  }

  @override
  Future<SkipResult> skipJob(
    String jobId, {
    required String authToken,
    String reason = 'other',
  }) async {
    await _delay();
    return SkipResult(
      ok: true,
      applicationId: 'mock-app-0001',
      action: 'skipped',
    );
  }
}

/// One canned assistant turn (reply + suggested follow-up chips).
class _CannedTurn {
  const _CannedTurn(this.reply, this.followups);
  final String reply;
  final List<String> followups;
}

/// A few PII-free assistant turns cycled by [MockApiClient.sendMessage].
const List<_CannedTurn> _cannedTurns = <_CannedTurn>[
  _CannedTurn(
    'Got it. Which machines have you operated — CNC, VMC, or both?',
    <String>['CNC', 'VMC', 'Both'],
  ),
  _CannedTurn(
    'Nice. How many years of experience do you have on those machines?',
    <String>['1–2 years', '3–5 years', '5+ years'],
  ),
  _CannedTurn(
    'Which controls are you comfortable with?',
    <String>['Fanuc', 'Siemens', 'Both'],
  ),
  _CannedTurn(
    'Thanks — that is enough to build your profile. Tap continue when ready.',
    <String>['Continue'],
  ),
];

/// A generic, PII-free resume body for mock mode — no real worker information.
const String _cannedResume = '''CNC / VMC OPERATOR — CANDIDATE PROFILE (MOCK)

Trade: CNC / VMC Operator
Experience: 4 years on 3-axis and 4-axis machining centres
Skills: Fanuc & Siemens controls, GD&T, micrometer & vernier gauges,
        tool offsets, first-article inspection
Availability: Immediate
Location: Pune (open to relocate)

This is mock data for UI development — it contains no real worker information.''';

/// PII-free seed feed for mock mode: coarse trade / title / city / area only —
/// no employer, no pay (mirrors the real `/feed` contract). Item 3 leaves
/// [FeedItem.area] null to exercise the nullable path.
final List<FeedItem> _cannedFeed = <FeedItem>[
  FeedItem(
    jobId: 'mock-job-0001',
    tradeKey: 'cnc_operator',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Chakan',
    rank: 1,
  ),
  FeedItem(
    jobId: 'mock-job-0002',
    tradeKey: 'vmc_setter',
    title: 'VMC Setter',
    city: 'Pune',
    area: 'Hinjewadi',
    rank: 2,
  ),
  FeedItem(
    jobId: 'mock-job-0003',
    tradeKey: 'welder',
    title: 'Welder',
    city: 'Nashik',
    area: null,
    rank: 3,
  ),
  FeedItem(
    jobId: 'mock-job-0004',
    tradeKey: 'fitter',
    title: 'Fitter',
    city: 'Aurangabad',
    area: 'Waluj',
    rank: 4,
  ),
];
