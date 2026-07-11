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
  Future<void> requestOtp(String phoneE164) async {
    await _delay();
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
  Future<void> updateName({
    required String fullName,
    required String authToken,
  }) async {
    // No-op: never stores, echoes, or logs the name (PII-free by construction).
    await _delay();
  }

  @override
  Future<WorkerProfileBundle> getWorkerProfile({
    required String workerId,
    required String authToken,
  }) async {
    await _delay();
    // Mock worker always has a profile (+ a ready resume) so the Resume tab works
    // straight from login, mirroring a returning worker on the real backend.
    return WorkerProfileBundle(
      profileId: 'mock-profile-0001',
      resumeId: 'mock-resume-0001',
      resumeText: _cannedResume,
    );
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
  Future<ResumeDownload> downloadResume({
    required String resumeId,
    required String authToken,
  }) async {
    await _delay();
    return const ResumeDownload(
      url: 'https://mock.local/resume/mock-resume-0001.pdf',
      expiresInSeconds: 900,
    );
  }

  @override
  Future<InterviewKitDownload> downloadInterviewKit(String tradeKey) async {
    await _delay();
    return const InterviewKitDownload(
      url: 'https://mock.local/interview-kit/mock-kit-0001.pdf',
      expiresInSeconds: 900,
    );
  }

  @override
  Future<void> logout({required String authToken}) async {
    // No-op: nothing to revoke in mock mode. The caller still clears the
    // in-memory session locally.
    await _delay();
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

  @override
  Future<List<AppliedJob>> getMyApplications({required String authToken}) async {
    await _delay();
    // Canned, PII-FREE rows: several action:'applied' (kept) and a couple
    // action:'skipped' (filtered out by the repository) so the applied-only
    // filter is exercised; varied created_at, with some area/reason/rank null to
    // exercise the nullables. Oldest-first, matching the real API ordering.
    // Values MATCH the API's ApplicationAction enum ('applied'|'skipped').
    final DateTime now = DateTime.now();
    return <AppliedJob>[
      AppliedJob(
        jobId: 'mock-job-0001',
        tradeKey: 'cnc_operator',
        title: 'CNC Operator',
        city: 'Pune',
        area: 'Chakan',
        action: 'applied',
        reason: null,
        sourceSurface: 'feed',
        rank: 3,
        createdAt: now.subtract(const Duration(days: 4)),
        updatedAt: now.subtract(const Duration(days: 4)),
      ),
      AppliedJob(
        jobId: 'mock-job-0002',
        tradeKey: 'fitter',
        title: 'Fitter',
        city: 'Nashik',
        area: null, // null area -> subtitle falls back to city only
        action: 'skipped', // filtered out
        reason: 'too_far',
        sourceSurface: 'feed',
        rank: 7,
        createdAt: now.subtract(const Duration(days: 2)),
        updatedAt: now.subtract(const Duration(days: 2)),
      ),
      AppliedJob(
        jobId: 'mock-job-0003',
        tradeKey: 'vmc_operator',
        title: 'VMC Operator',
        city: 'Pune',
        area: null, // null area
        action: 'applied',
        reason: null,
        sourceSurface: 'search',
        rank: null, // null rank
        createdAt: now.subtract(const Duration(hours: 6)),
        updatedAt: now.subtract(const Duration(hours: 6)),
      ),
      AppliedJob(
        jobId: 'mock-job-0004',
        tradeKey: 'welder',
        title: 'Welder',
        city: 'Aurangabad',
        area: 'Waluj',
        action: 'skipped', // filtered out
        reason: 'low_pay',
        sourceSurface: 'feed',
        rank: null,
        createdAt: now.subtract(const Duration(hours: 2)),
        updatedAt: now.subtract(const Duration(hours: 2)),
      ),
      AppliedJob(
        jobId: 'mock-job-0005',
        tradeKey: 'cnc_operator',
        title: 'CNC Setter',
        city: 'Pune',
        area: 'Hinjewadi',
        action: 'applied',
        reason: null,
        sourceSurface: 'feed',
        rank: 1,
        createdAt: now.subtract(const Duration(minutes: 25)),
        updatedAt: now.subtract(const Duration(minutes: 25)),
      ),
    ];
  }

  // --- A2 voice note --------------------------------------------------------

  @override
  Future<VoiceUploadTicket> requestVoiceUploadUrl({
    required String authToken,
  }) async {
    await _delay();
    // Mirrors the real shape (`voice-notes/<workerId>/<uuid>.m4a`) with
    // obviously-fake sentinels. The upload_url is never PUT to in mock mode —
    // the mock-mode pipeline uses MockVoiceStorageUploader, which skips it.
    return const VoiceUploadTicket(
      storagePath: 'voice-notes/mock-worker-0001/mock-clip-0001.m4a',
      uploadUrl: 'https://mock.local/upload/mock-clip-0001',
      expiresInSeconds: 7200,
    );
  }

  @override
  Future<VoiceNoteDetail> fetchVoiceNote({
    required String authToken,
    required String voiceNoteId,
  }) async {
    await _delay();
    // Canned, PII-FREE transcript — KEEP IN SYNC with the string returned by
    // MockVoiceTranscriptResolver (features/voice/data/voice_pipeline_impl.dart);
    // a parity test asserts they match.
    return const VoiceNoteDetail(
      voiceNoteId: 'mock-voice-0001',
      durationSeconds: 12,
      transcriptText:
          'Main CNC machine par 4 saal se kaam kar raha hoon, Fanuc control aata hai.',
      transcriptEnglish:
          'I have worked on CNC machines for 4 years and know Fanuc controls.',
      transcriptConfidence: 0.92,
    );
  }

  @override
  Future<VoiceUploadResult> uploadVoiceNote({
    required String authToken,
    required String sessionId,
    required String storagePath,
    required int durationSeconds,
  }) async {
    await _delay();
    return VoiceUploadResult(
      voiceNoteId: 'mock-voice-0001',
      durationSeconds: durationSeconds,
    );
  }

  @override
  Future<TranscribeResult> transcribeVoiceNote({
    required String authToken,
    required String voiceNoteId,
  }) async {
    await _delay();
    return const TranscribeResult(aiJobId: 'mock-voice-job-0001', status: 'queued');
  }

  @override
  Future<AiJob> awaitAiJob(
    String aiJobId, {
    int maxAttempts = 40,
    Duration pollInterval = const Duration(milliseconds: 350),
  }) async {
    await _delay();
    // Canned COMPLETED transcription job — terminal on the first poll, no network.
    return const AiJob(
      id: 'mock-voice-job-0001',
      jobType: 'transcription',
      status: 'completed',
      profileId: null,
      errorMessage: null,
      voiceNoteId: 'mock-voice-0001',
    );
  }

  // --- A3 referral invite ---------------------------------------------------

  @override
  Future<InviteResult> createInvite({
    required String authToken,
    String? campaign,
  }) async {
    await _delay();
    // 12-hex code, obviously-fake sentinel. Link mirrors the real `/i/<code>`.
    return const InviteResult(
      inviteId: 'mock-invite-0001',
      code: 'abcdef012345',
      link: '/i/abcdef012345',
    );
  }

  // --- A4 DPDP account delete ----------------------------------------------

  @override
  Future<AccountDeleteRequestResult> requestAccountDelete({
    required String authToken,
  }) async {
    await _delay();
    return const AccountDeleteRequestResult(success: true, resendInSeconds: 30);
  }

  @override
  Future<void> confirmAccountDelete({
    required String authToken,
    required String otp,
  }) async {
    await _delay();
    // No-op success (204) in mock mode; the caller clears local session/tokens.
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
