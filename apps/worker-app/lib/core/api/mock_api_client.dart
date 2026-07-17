import '../../features/swipe/domain/job_detail.dart';
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
  Future<ResumeFieldsDto> getResumeFields({required String authToken}) async {
    await _delay();
    // Canned safe fields so the edit screen renders in mock mode. has_photo
    // reflects the session-local mock photo state (ADR-0032).
    return ResumeFieldsDto(
      fullName: 'Ramesh Kumar',
      showPhoto: true,
      nightShiftReady: false,
      hasPhoto: _mockHasPhoto,
    );
  }

  @override
  Future<void> updateResumePrefs({
    required bool showPhoto,
    required bool nightShiftReady,
    required String authToken,
  }) async {
    // No-op: nothing is persisted in mock mode.
    await _delay();
  }

  /// ADR-0032 mock photo state — session-local, no network, no bytes stored.
  bool _mockHasPhoto = false;

  @override
  Future<PhotoUploadTicket> requestPhotoUploadUrl({
    required String authToken,
  }) async {
    await _delay();
    return const PhotoUploadTicket(
      storagePath: 'photos/mock-worker/mock-photo-0001.jpg',
      uploadUrl: 'https://mock.local/signed-upload/mock-photo-0001.jpg',
      expiresInSeconds: 7200,
    );
  }

  @override
  Future<void> confirmPhoto({
    required String storagePath,
    required String authToken,
  }) async {
    await _delay();
    _mockHasPhoto = true;
  }

  @override
  Future<String> getMyPhotoUrl({required String authToken}) async {
    await _delay();
    if (!_mockHasPhoto) {
      throw ApiException(404, 'no photo');
    }
    // A non-network scheme on purpose (mock:// never resolves DNS): Image.network's
    // errorBuilder shows the placeholder, proving the degrade path with ZERO network
    // in mock mode (the same sentinel idiom as the mock PDF url).
    return 'mock://local/photo/mock-photo-0001.jpg';
  }

  @override
  Future<void> deleteMyPhoto({required String authToken}) async {
    await _delay();
    _mockHasPhoto = false;
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
    required String authToken,
  }) async {
    await _delay();
    return ResumeResult(
      resumeId: 'mock-resume-0001',
      version: 1,
      resumeText: _cannedResume,
      isMock: true,
    );
  }

  // The `mock://` SCHEME is the downloader's mock sentinel: `downloadSignedPdf`
  // sees it, skips the (impossible) network fetch, and saves a small placeholder
  // PDF instead — so the download flow stays walkable offline. Keep the scheme
  // if these urls ever change.
  @override
  Future<ResumeDownload> downloadResume({
    required String resumeId,
    required String authToken,
  }) async {
    await _delay();
    return const ResumeDownload(
      url: 'mock://downloads/resume/mock-resume-0001.pdf',
      expiresInSeconds: 900,
    );
  }

  @override
  Future<InterviewKitDownload> downloadInterviewKit(String tradeKey) async {
    await _delay();
    return const InterviewKitDownload(
      url: 'mock://downloads/interview-kit/mock-kit-0001.pdf',
      expiresInSeconds: 900,
    );
  }

  @override
  Future<List<InterviewKitListItem>> getInterviewKits() async {
    await _delay();
    // A few real trade_keys (a subset of the 15 wired kits), PII-free.
    return const <InterviewKitListItem>[
      InterviewKitListItem(tradeKey: 'cnc_operator', displayName: 'CNC Operator'),
      InterviewKitListItem(tradeKey: 'vmc_operator', displayName: 'VMC Operator'),
      InterviewKitListItem(tradeKey: 'fitter', displayName: 'Fitter'),
    ];
  }

  @override
  Future<InterviewKitContentDto> getInterviewKit(String tradeKey) async {
    await _delay();
    // Canned PREP PACK (mirrors the real content shape: question LISTS, NO
    // answers). Echoes the requested tradeKey. PII-free.
    return InterviewKitContentDto(
      tradeKey: tradeKey,
      displayName: 'CNC Operator',
      overview:
          'Yeh interview aapki machine chalane, drawing padhne aur safety ki '
          'samajh check karta hai. Neeche ke sawaal aur checklist se taiyari karein.',
      commonQuestions: const <String>[
        'Aapne kaun kaun si CNC machine chalayi hai?',
        'Tool offset kaise set karte hain aur first piece kaise check karte hain?',
        'G-code aur M-code mein kya farq hai?',
      ],
      practicalQuestions: const <String>[
        'Saved program se job kaise start karte hain?',
        'Cycle start dabane se pehle kya check karte hain?',
      ],
      safetyQuestions: const <String>[
        'Shop floor par kaun sa PPE pehnte hain?',
        'Machine se ajeeb awaaz aaye to kya karte hain?',
      ],
      drawingMeasurementQuestions: const <String>[
        'Drawing par tolerance kaise padhte hain?',
        'Outer diameter kaise measure karte hain?',
      ],
      skillChecklist: const <String>[
        'Fanuc / Siemens control',
        'GD&T reading',
        'Micrometer aur vernier',
      ],
      reviseBefore: const <String>[
        'Tool offset aur work offset',
        'Basic G/M codes',
      ],
      documentsToCarry: const <String>[
        'Aadhaar card (original + photocopy)',
        'ITI / Diploma certificate',
        'BadaBhai resume printout',
      ],
      commonMistakes: const <String>[
        'Bina drawing padhe job start karna',
        'First piece inspection skip karna',
      ],
      hinglishNote:
          'Aaram se, saaf jawaab dein. Jo aata hai wahi bolein — bluff mat karein.',
    );
  }

  @override
  Future<ProfileSummaryDto> getProfileSummary({required String authToken}) async {
    await _delay();
    // Mirrors the real (NAMELESS) contract: no name field, canonical taxonomy ids
    // + a display name, `strength` as a signal COUNT. Obviously-generic, PII-free.
    return const ProfileSummaryDto(
      profileStatus: 'confirmed',
      confirmedAt: '2026-06-01T00:00:00.000Z',
      tradeDisplayName: 'CNC Operator',
      canonicalTradeId: 'dom_cnc_machining',
      canonicalRoleId: 'role_cnc_turner_operator',
      city: 'Pune',
      strength: 8,
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
  Future<JobDetail> jobDetail(String jobId, {required String authToken}) async {
    await _delay();
    final JobDetail? detail = _cannedJobDetails[jobId];
    // Mirror the real contract's neutral 404 for unknown/closed jobs so mock
    // mode exercises the same failure path as the live API.
    if (detail == null) throw ApiException(404, 'Job not found');
    return detail;
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
    //
    // Job ids are DISJOINT from [_cannedFeed] on purpose (mock-job-01xx vs
    // mock-job-000x): SwipeRepositoryImpl.getFeed excludes already-APPLIED jobs
    // from the deck (WA-1; skips re-serve — the mind-change path), so applied
    // rows that overlapped the canned feed would honestly (and confusingly)
    // shrink the mock deck. These rows model past decisions on jobs that are
    // no longer open.
    final DateTime now = DateTime.now();
    return <AppliedJob>[
      AppliedJob(
        jobId: 'mock-job-0101',
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
        jobId: 'mock-job-0102',
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
        jobId: 'mock-job-0103',
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
        jobId: 'mock-job-0104',
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
        jobId: 'mock-job-0105',
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

  @override
  Future<List<WorkerNotification>> getMyNotifications({
    required String authToken,
  }) async {
    await _delay();
    // Canned, PII-FREE, FACELESS rows mirroring the real allowlist projection —
    // NO employer name, NO pay, NO phone/name. Newest first (API ordering).
    final DateTime now = DateTime.now();
    return <WorkerNotification>[
      WorkerNotification(
        id: 'mock-noti-0001',
        type: 'resume_ready',
        title: 'Resume taiyaar hai',
        body: 'Aapka naya resume ban gaya — dekhein aur download karein.',
        createdAt: now.subtract(const Duration(minutes: 5)),
      ),
      // The worker's OWN apply action. Faceless by design: no employer identity,
      // no job title, no pay — just the server-rendered copy (ADR-0024).
      WorkerNotification(
        id: 'mock-noti-0005',
        type: 'application_sent',
        title: 'Application bhej di',
        body: 'Aapki application aage pahunch gayi.',
        createdAt: now.subtract(const Duration(minutes: 45)),
      ),
      WorkerNotification(
        id: 'mock-noti-0002',
        type: 'profile_ready',
        title: 'Profile taiyaar hai',
        body: 'Aapki profile confirm ho gayi.',
        createdAt: now.subtract(const Duration(hours: 3)),
      ),
      WorkerNotification(
        id: 'mock-noti-0003',
        type: 'voice_processed',
        title: 'Voice note taiyaar',
        body: 'Aapka voice note process ho gaya.',
        createdAt: now.subtract(const Duration(hours: 20)),
      ),
      WorkerNotification(
        id: 'mock-noti-0004',
        type: 'security',
        title: 'Naye device se login',
        body: 'Aapke account mein ek naye device se login hua.',
        createdAt: now.subtract(const Duration(days: 1)),
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

  /// Pending mock deletion due time (ADR-0031 grace) — set by
  /// [confirmAccountDelete], cleared by [cancelAccountDelete], so the
  /// scheduled-banner → cancel round trip is walkable in mock mode.
  DateTime? _deletionScheduledFor;

  @override
  Future<AccountDeleteRequestResult> requestAccountDelete({
    required String authToken,
  }) async {
    await _delay();
    return const AccountDeleteRequestResult(success: true, resendInSeconds: 30);
  }

  @override
  Future<AccountDeleteConfirmResult> confirmAccountDelete({
    required String authToken,
    required String otp,
  }) async {
    await _delay();
    // Mirrors the real 200 {success, scheduled_for}: the delete is SCHEDULED
    // for now + 7 days — nothing is wiped, the mock session stays usable.
    _deletionScheduledFor = DateTime.now().add(const Duration(days: 7));
    return AccountDeleteConfirmResult(
      success: true,
      scheduledFor: _deletionScheduledFor,
    );
  }

  @override
  Future<void> cancelAccountDelete({required String authToken}) async {
    await _delay();
    // Idempotent, like the real route: cancelling with nothing pending is a
    // no-op success.
    _deletionScheduledFor = null;
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

/// PII-free seed feed for mock mode: coarse trade / title / city / area, the
/// job's experience window, and (ADR-0024 addendum, 2026-07-16) the additive
/// pay band + shift — still no employer of any shape (mirrors the real `/feed`
/// contract). Item 3 leaves [FeedItem.area] null to exercise the nullable path.
///
/// The experience windows are DELIBERATELY varied, and item 4 leaves them null:
/// the Jobs-tab filters match on trade/city/experience, so a canned feed with a
/// uniform (or absent) window would make the Experience filter look broken in
/// mock mode — every band would match everything. Mock data has to mirror the
/// contract closely enough that the controls behave the same as against the real
/// feed. The null window is the honest "no bound stated" case, which by contract
/// matches EVERY band (see `jobMatchesExperience`).
///
/// Pay/shift are likewise varied: item 3 carries a one-sided band (min only)
/// and item 4 states neither — the honest nulls whose card rows must HIDE.
/// KEEP IN PARITY with [_cannedJobDetails] (a test asserts the shared fields
/// match, like the real feed and detail routes reading the same jobs row).
final List<FeedItem> _cannedFeed = <FeedItem>[
  FeedItem(
    jobId: 'mock-job-0001',
    tradeKey: 'cnc_operator',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Chakan',
    minExperienceYears: 0,
    maxExperienceYears: 2,
    payMin: 16000,
    payMax: 26000,
    shift: 'day',
    rank: 1,
  ),
  FeedItem(
    jobId: 'mock-job-0002',
    tradeKey: 'vmc_setter',
    title: 'VMC Setter',
    city: 'Pune',
    area: 'Hinjewadi',
    minExperienceYears: 2,
    maxExperienceYears: 5,
    payMin: 22000,
    payMax: 32000,
    shift: 'rotational',
    rank: 2,
  ),
  FeedItem(
    jobId: 'mock-job-0003',
    tradeKey: 'welder',
    title: 'Welder',
    city: 'Nashik',
    area: null,
    minExperienceYears: 5,
    maxExperienceYears: null,
    payMin: 18000,
    payMax: null,
    shift: 'night',
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

/// Canned FULL job details for mock mode (`GET /jobs/:jobId`, ADR-0024
/// addendum 2026-07-16), keyed by the [_cannedFeed] job ids.
///
/// PII-FREE AND FACELESS BY CONTRACT: NO company/employer name of any shape
/// (no "Pvt Ltd"-style strings), no phone, no email — only the worker-visible
/// fields the real route serves. Descriptions are generic Hinglish; every
/// requirement/benefit is a trade fact, never an identity.
///
/// Coverage is deliberately varied so the detail screen's "null hides the
/// row" rule is exercised in mock mode: 0001 is fully populated, 0003 has a
/// one-sided pay band and no benefits, and 0004 states nothing beyond the
/// feed's own facts (every optional row hidden).
const Map<String, JobDetail> _cannedJobDetails = <String, JobDetail>{
  'mock-job-0001': JobDetail(
    jobId: 'mock-job-0001',
    tradeKey: 'cnc_operator',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Chakan',
    payMin: 16000,
    payMax: 26000,
    minExperienceYears: 0,
    maxExperienceYears: 2,
    neededBy: 'immediate',
    shift: 'day',
    description:
        'CNC lathe par production ka kaam. Drawing padh kar job set karna, '
        'tool offset lagana aur first piece check karna hoga. Naye log bhi '
        'apply kar sakte hain — training milegi.',
    requirements: <String>['Fanuc control', 'ITI / Diploma', 'Drawing reading'],
    benefits: <String>['PF + ESI', 'Overtime pay', 'Canteen'],
  ),
  'mock-job-0002': JobDetail(
    jobId: 'mock-job-0002',
    tradeKey: 'vmc_setter',
    title: 'VMC Setter',
    city: 'Pune',
    area: 'Hinjewadi',
    payMin: 22000,
    payMax: 32000,
    minExperienceYears: 2,
    maxExperienceYears: 5,
    neededBy: 'soon',
    shift: 'rotational',
    description:
        'VMC machine par setting aur programming ka kaam. Fixture lagana, '
        'program prove-out karna aur quality maintain karna hoga.',
    requirements: <String>['VMC setting', 'Siemens control', 'GD&T basics'],
    benefits: <String>['PF + ESI', 'Bus facility'],
  ),
  'mock-job-0003': JobDetail(
    jobId: 'mock-job-0003',
    tradeKey: 'welder',
    title: 'Welder',
    city: 'Nashik',
    payMin: 18000,
    minExperienceYears: 5,
    neededBy: 'flexible',
    shift: 'night',
    description:
        'MIG welding ka experience chahiye. Structure fabrication ka kaam '
        'hai — safety gear diya jayega.',
    requirements: <String>['MIG welding'],
    // benefits deliberately null — the detail screen must HIDE the row.
  ),
  // Deliberately minimal: the employer stated nothing beyond the feed's own
  // facts, so EVERY optional detail row stays hidden (never fabricated).
  'mock-job-0004': JobDetail(
    jobId: 'mock-job-0004',
    tradeKey: 'fitter',
    title: 'Fitter',
    city: 'Aurangabad',
    area: 'Waluj',
  ),
};
