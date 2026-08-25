import 'job_posting_chat_models.dart';
import 'models.dart';
import 'payer_api_client.dart';

/// In-memory [PayerApiClient] seeded with sample data from the Payer App kit's
/// `.dc.html` script block (6 candidates, 3 jobs, credits=200, ledger rows).
/// PII-free and swappable: every method mirrors the real API's shape.
///
/// SCOPE: this client is reachable ONLY from a demo build
/// (`--dart-define=USE_MOCKS=true`, which also paints the corner MOCK banner) or
/// a widget test that injects it. A real release build never constructs it — the
/// HTTP client no longer composes or delegates to it.
///
/// An unlock mutates the in-memory balance and the unlocked set, exactly as the
/// mockup's reducer does (`confirmUnlock`).
class MockPayerApiClient implements PayerApiClient {
  MockPayerApiClient();

  int _credits = 200;
  final Set<int> _unlocked = <int>{};

  static const List<Candidate> _candidates = <Candidate>[
    Candidate(
      id: 1,
      name: 'Ramesh Kumar',
      trade: 'CNC Setter',
      skill: 'Fanuc, VMC programming',
      exp: '6 yrs',
      loc: 'Pimpri, Pune',
      avail: 'Available now',
      hot: true,
      fit: FitLabel.strong,
      phone: '+91 98765 43210',
    ),
    Candidate(
      id: 2,
      name: 'Suresh Patil',
      trade: 'VMC Setter',
      skill: 'Siemens, fixture setting',
      exp: '4 yrs',
      loc: 'Chakan, Pune',
      avail: 'Available now',
      hot: false,
      fit: FitLabel.good,
      phone: '+91 98701 22890',
    ),
    Candidate(
      id: 3,
      name: 'Imran Shaikh',
      trade: 'CNC Operator',
      skill: 'Fanuc, GD&T reading',
      exp: '8 yrs',
      loc: 'Bhosari, Pune',
      avail: '2 weeks notice',
      hot: true,
      fit: FitLabel.strong,
      phone: '+91 99204 55178',
    ),
    Candidate(
      id: 4,
      name: 'Vikas More',
      trade: 'Quality Inspector',
      skill: 'CMM, GD&T',
      exp: '3 yrs',
      loc: 'Hadapsar, Pune',
      avail: 'Available now',
      hot: false,
      fit: FitLabel.good,
      phone: '+91 97653 09921',
    ),
    Candidate(
      id: 5,
      name: 'Ganesh Jadhav',
      trade: 'CNC Operator',
      skill: 'Mazak, turning',
      exp: '2 yrs',
      loc: 'Wagholi, Pune',
      avail: 'Immediate',
      hot: false,
      fit: FitLabel.none,
      phone: '+91 98810 76340',
    ),
    Candidate(
      id: 6,
      name: 'Sanjay Pawar',
      trade: 'Welder / Fabricator',
      skill: 'MIG, TIG, ARC',
      exp: '5 yrs',
      loc: 'Ranjangaon, Pune',
      avail: 'Available now',
      hot: false,
      fit: FitLabel.good,
      phone: '+91 90110 28845',
    ),
  ];

  static const List<JobPosting> _jobs = <JobPosting>[
    JobPosting(
      title: 'CNC Setter',
      band: '5–10 vacancies',
      filled: 7,
      quota: 10,
      applicants: 23,
      unlocks: 12,
      status: JobStatus.live,
      verified: true,
      boosted: true,
    ),
    JobPosting(
      title: 'VMC Setter',
      band: '1 vacancy',
      filled: 1,
      quota: 1,
      applicants: 9,
      unlocks: 3,
      status: JobStatus.filled,
      verified: true,
      boosted: false,
    ),
    JobPosting(
      title: 'Quality Inspector',
      band: '2–4 vacancies',
      filled: 0,
      quota: 4,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.review,
      verified: false,
      boosted: false,
    ),
  ];

  /// Canned credit ledger (the credit-account ledger, distinct from the unlock
  /// ledger). Newest-first; mirrors `GET /payer/credits/ledger` reasons.
  static const List<LedgerEntry> _creditLedger = <LedgerEntry>[
    LedgerEntry(
      label: 'Pack purchase · pack_200',
      amount: '+200',
      direction: LedgerDirection.credit,
    ),
    LedgerEntry(
      label: 'Unlock',
      amount: '−1',
      direction: LedgerDirection.debit,
    ),
    LedgerEntry(
      label: 'Bonus credits',
      amount: '+10',
      direction: LedgerDirection.credit,
    ),
  ];

  static const List<LedgerEntry> _ledger = <LedgerEntry>[
    LedgerEntry(
      label: '200-pack purchase',
      amount: '+200',
      direction: LedgerDirection.credit,
    ),
    LedgerEntry(
      label: 'Unlocked Ramesh K.',
      amount: '−1',
      direction: LedgerDirection.debit,
    ),
    LedgerEntry(
      label: 'Unlocked Imran S.',
      amount: '−1',
      direction: LedgerDirection.debit,
    ),
  ];

  // --- Agency · Supply sample data (kit `.dc.html` script block) -------------

  /// The agency's referral link. Mirrors `POST /payer/agency/invites` →
  /// `{code, link:"/i/<code>"}`.
  ///
  /// PATH-ONLY, exactly as the real endpoint returns it. It used to read
  /// `badabhai.in/r/APEX-7K2` — scheme-less, and on the `/r/` resolver path
  /// rather than the `/i/` space the doc comment above, the batch mock, and the
  /// worker app's App Link intent-filter all use. A mock that disagrees with the
  /// wire hides exactly the normalisation bug it should surface, so this now
  /// exercises `absoluteInviteUrl`'s path-only branch the way production does.
  static const ReferralLink _referralLink = ReferralLink(
    code: 'APEX-7K2',
    url: '/i/APEX-7K2',
  );

  @override
  Future<List<Candidate>> fetchCandidates() async => _candidates
      .map((Candidate c) => c.copyWith(unlocked: _unlocked.contains(c.id)))
      .toList(growable: false);

  @override
  Future<List<Applicant>> fetchApplicants(String jobId) async =>
      _applicantsFrom(_candidates);

  @override
  // `status` is a no-op on the mock (canned list is already the "open" feed).
  Future<List<JobPosting>> fetchJobs({String? status}) async => _jobs;

  // --- Company job postings — CRUD + lifecycle (canned) ----------------------
  // MOCK keeps the rich canned list ([_jobs]) so My-jobs stays walkable; create
  // returns a fresh draft row (id set → the screen renders the REAL-style card),
  // lifecycle returns a row reflecting the transition. No list mutation.

  int _jobSeq = 100;

  JobPosting _cannedJob(String? id, {required String wireStatus}) => JobPosting(
        id: id,
        title: 'CNC Setter',
        band: '2-5',
        locationLabel: 'Pimpri, Pune',
        createdAt: '2026-07-08T00:00:00Z',
        status: JobStatus.review,
        filled: 0,
        quota: 0,
        applicants: 0,
        unlocks: 0,
        verified: false,
        boosted: false,
        wireStatus: wireStatus,
      );

  @override
  Future<JobPosting> createCompanyJob({
    required String orgLabel,
    required String roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
    String? city,
    int? payMin,
    int? payMax,
    String? shift,
    String? neededBy,
  }) async {
    if ((vacancyBand == null) == (vacancies == null)) {
      throw ArgumentError(
        'createCompanyJob needs exactly one of vacancyBand or vacancies',
      );
    }
    _jobSeq += 1;
    return JobPosting(
      id: 'mock-job-$_jobSeq',
      title: roleTitle,
      band: vacancyBand ?? '$vacancies',
      locationLabel: locationLabel,
      createdAt: '2026-07-08T00:00:00Z',
      status: JobStatus.review,
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      verified: false,
      boosted: false,
      wireStatus: 'draft',
    );
  }

  @override
  Future<JobPosting?> getJob(String id) async =>
      _cannedJob(id, wireStatus: 'open');

  @override
  Future<JobPosting> updateJob(
    String id, {
    String? orgLabel,
    String? roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? status,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
    String? city,
    int? payMin,
    int? payMax,
    String? shift,
    String? neededBy,
  }) async =>
      _cannedJob(id, wireStatus: status ?? 'draft');

  @override
  Future<JobPosting> closeJob(String id) async =>
      _cannedJob(id, wireStatus: 'closed');

  @override
  Future<JobPosting> pauseJob(String id) async =>
      _cannedJob(id, wireStatus: 'paused');

  @override
  Future<JobPosting> resumeJob(String id) async =>
      _cannedJob(id, wireStatus: 'open');

  @override
  Future<PlanPurchase> buyPlan(
    String id, {
    required String tier,
    String? coupon,
  }) async =>
      PlanPurchase(
        applicantVisibilityQuota: tier == 'pro' ? 100 : 50,
        status: 'active',
        finalInr: tier == 'pro' ? 7999 : 4999,
      );

  @override
  Future<BoostPurchase> buyBoost(
    String id, {
    String tier = 'all_candidates',
    String? coupon,
  }) async =>
      const BoostPurchase(status: 'active', finalInr: 999);

  @override
  Future<PlanPurchase> quotaTopup(
    String id, {
    required String tier,
    String? coupon,
  }) async =>
      const PlanPurchase(
        applicantVisibilityQuota: 25,
        status: 'active',
        finalInr: 1999,
      );

  @override
  Future<List<LedgerEntry>> fetchLedger() async => _ledger;

  @override
  Future<ReferralLink> referralLink({String? campaign}) async => _referralLink;

  // --- Match V1 — demand skill picker + reach preview (canned) ---------------
  // A tiny deterministic taxonomy + reach maths so the post-a-job skill picker
  // and reach meter are walkable in MOCK with no backend. PII-free (skill ids +
  // integer counts only).

  static const List<MatchSkill> _matchSkills = <MatchSkill>[
    MatchSkill(
      skillId: 'cnc_operation',
      label: 'CNC Operation',
      industryId: 'manufacturing',
      relatedSkillIds: <String>['vmc_operation', 'cnc_programming'],
    ),
    MatchSkill(
      skillId: 'vmc_operation',
      label: 'VMC Operation',
      industryId: 'manufacturing',
      relatedSkillIds: <String>['cnc_operation'],
    ),
    MatchSkill(
      skillId: 'cnc_programming',
      label: 'CNC Programming',
      industryId: 'manufacturing',
      relatedSkillIds: <String>['cnc_operation'],
    ),
    MatchSkill(
      skillId: 'quality_inspection',
      label: 'Quality Inspection',
      industryId: 'manufacturing',
      relatedSkillIds: <String>[],
    ),
    MatchSkill(
      skillId: 'welding',
      label: 'Welding',
      industryId: 'manufacturing',
      relatedSkillIds: <String>['fabrication'],
    ),
  ];

  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => _matchSkills;

  @override
  Future<ReachPreview> reachPreview({
    required List<String> matchSkillIds,
    List<String> untickedRelatedIds = const <String>[],
  }) async {
    // Deterministic canned maths: each picked skill reaches a fixed base, each
    // still-ticked related skill adds a smaller slice. Mirrors the shape the
    // real deterministic matcher returns (never generative).
    const Map<String, int> baseReach = <String, int>{
      'cnc_operation': 42,
      'vmc_operation': 28,
      'cnc_programming': 15,
      'quality_inspection': 12,
      'welding': 20,
      'fabrication': 9,
    };
    final Set<String> unticked = untickedRelatedIds.toSet();
    final List<ReachSkill> skills = <ReachSkill>[];
    final Set<String> reachIds = <String>{};
    int total = 0;
    int tier1 = 0;
    for (final String id in matchSkillIds) {
      final List<String> relatedIds = _matchSkills
          .where((MatchSkill s) => s.skillId == id)
          .expand((MatchSkill s) => s.relatedSkillIds)
          .toList(growable: false);
      final int direct = baseReach[id] ?? 0;
      total += direct;
      tier1 += direct;
      reachIds.add(id);
      final List<RelatedPreview> related = <RelatedPreview>[];
      for (final String relId in relatedIds) {
        final bool ticked = !unticked.contains(relId);
        final int relReach = ((baseReach[relId] ?? 0) / 2).round();
        if (ticked) {
          total += relReach;
          reachIds.add(relId);
        }
        related.add(RelatedPreview(
          skillId: relId,
          label: _matchSkillLabel(relId),
          ticked: ticked,
          reachCount: relReach,
        ));
      }
      skills.add(ReachSkill(
        skillId: id,
        label: _matchSkillLabel(id),
        reachCount: direct,
        related: related,
      ));
    }
    return ReachPreview(
      skills: skills,
      reachSkillIds: reachIds.toList(growable: false),
      reachTotal: total,
      reachTier1: tier1,
      zeroReach: total == 0,
      appliedUntickedIds: unticked.toList(growable: false),
      maxSkillsPerPosting: 5,
    );
  }

  static String _matchSkillLabel(String id) => _matchSkills
      .where((MatchSkill s) => s.skillId == id)
      .map((MatchSkill s) => s.label)
      .followedBy(<String>[id])
      .first;

  // --- Agency — referred workers + batch invites (canned) --------------------

  static const List<AgencyWorker> _referredWorkers = <AgencyWorker>[
    AgencyWorker(
      ref: 'W-3F9A',
      profileComplete: true,
      appliedCount: 4,
      unlockedCount: 2,
      lastActiveOn: '2026-07-27T00:00:00Z',
    ),
    AgencyWorker(
      ref: 'W-8C21',
      profileComplete: false,
      appliedCount: 1,
      unlockedCount: 0,
      lastActiveOn: '2026-07-20T00:00:00Z',
    ),
    AgencyWorker(
      ref: 'W-5D7B',
      profileComplete: true,
      appliedCount: 0,
      unlockedCount: 0,
    ),
  ];

  @override
  Future<List<AgencyWorker>> fetchReferredWorkers() async => _referredWorkers;

  int _inviteSeq = 700;

  @override
  Future<List<MintedInvite>> createInviteBatch({
    required int count,
    String? campaign,
  }) async {
    final List<MintedInvite> minted = <MintedInvite>[];
    for (int i = 0; i < count; i++) {
      _inviteSeq += 1;
      final String code = 'APEX-$_inviteSeq';
      minted.add(MintedInvite(
        agencyInviteId: 'mock-invite-$_inviteSeq',
        code: code,
        link: 'badabhai.in/i/$code',
      ));
    }
    return minted;
  }

  // --- AI job-posting chat (ADR-0035) — canned DETERMINISTIC interview -------
  // A tiny in-memory stand-in for the server-side interview engine so the whole
  // chat → draft → publish loop is walkable with `USE_MOCKS=true` and in widget
  // tests, with no backend and no LLM.
  //
  // It mirrors the two properties of the real engine that matter to the client:
  //   1. DETERMINISTIC topic order (invariant #4 — the engine decides the next
  //      question and readiness; nothing here is generative or random), and
  //   2. NO org/company question anywhere in the bank (ADR-0035 §Decision 3 —
  //      the payer's own name is auto-filled server-side at publish and never
  //      travels through the conversation). A test asserts that hole stays shut.
  //
  // Vacancy is banded ([kVacancyBands], ADR-0012): the mock maps a headcount
  // answer to a band exactly as `bandForCount()` does server-side, so the client
  // can never learn to expect a raw integer here.

  int _chatSeq = 0;
  final Map<String, _MockChatSession> _chatSessions = <String, _MockChatSession>{};

  @override
  Future<JobPostingChatTurn> startJobPostingChatSession() async {
    _chatSeq += 1;
    final String id = 'mock-chat-$_chatSeq';
    final _MockChatSession session = _MockChatSession(id);
    _chatSessions[id] = session;
    session.messages.add(
      JobPostingChatMessageRow(
        fromPayer: false,
        messageType: 'text',
        bodyText: _kMockChatOpening,
        createdAt: _mockNow,
      ),
    );
    return JobPostingChatTurn(
      sessionId: id,
      reply: _kMockChatOpening,
      draft: session.draft,
      suggestedReplies: _kMockChatTopics.first.chips,
    );
  }

  @override
  Future<JobPostingChatTurn> sendJobPostingChatMessage({
    required String sessionId,
    required String text,
  }) async {
    final _MockChatSession? session = _chatSessions[sessionId];
    // Neutral unknown/not-owned — same shape the real route's no-oracle 404 has.
    if (session == null) throw const PayerApiException(404);
    return session.answer(text);
  }

  @override
  Future<List<JobPostingChatSessionSummary>>
      fetchJobPostingChatSessions() async =>
          _chatSessions.values
              .map((_MockChatSession s) => s.summary)
              .toList(growable: false)
              .reversed
              .toList(growable: false);

  @override
  Future<JobPostingChatTranscript?> fetchJobPostingChatTranscript(
    String sessionId,
  ) async {
    // Neutral 404 → null (never an oracle), matching the real client.
    final _MockChatSession? session = _chatSessions[sessionId];
    if (session == null) return null;
    return JobPostingChatTranscript(
      sessionId: session.id,
      status: session.status,
      draft: session.draft,
      draftReady: session.draftReady,
      suggestedReplies: session.currentChips,
      messages: session.messages.toList(growable: false),
    );
  }

  @override
  Future<PublishJobResult> publishJobPostingChatSession(
    String sessionId,
  ) async {
    final _MockChatSession? session = _chatSessions[sessionId];
    if (session == null) throw const PayerApiException(404);
    if (session.published) throw const PayerApiException(409);
    // The server validates the stored draft against PayerCreateJobPostingSchema
    // and rejects an incomplete one — mirror that so the UI's publish-failure
    // path is exercised in MOCK too.
    if (!session.draft.hasRequiredFields) throw const PayerApiException(400);
    session.published = true;
    _chatSeq += 1;
    // Canned clean publish — nothing left unmapped.
    return PublishJobResult(
      jobPostingId: 'mock-posting-$_chatSeq',
      unmappedFields: const <String>[],
    );
  }

  // --- Agency demand — jobs CRUD + lifecycle + referrals summary (canned) ----
  // An in-memory list so the agency My-jobs + Post-a-job flow is walkable in
  // MOCK: create prepends a fresh `open` row; close → `closed` (terminal),
  // pause → `paused` and resume → `open` (#1202, reversible). PII-free — only
  // coarse demand attributes.

  int _agencySeq = 200;

  final List<AgencyJobView> _agencyJobs = <AgencyJobView>[
    const AgencyJobView(
      id: 'mock-agency-1',
      status: 'open',
      tradeKey: 'cnc_operator',
      title: 'CNC Operator — Day shift',
      city: 'Pune',
      area: 'Chakan',
      payMin: 22000,
      payMax: 28000,
      minExperienceYears: 2,
      maxExperienceYears: 6,
      neededBy: 'immediate',
      applicantsReceived: 7,
      createdAt: '2026-07-06T00:00:00Z',
      updatedAt: '2026-07-06T00:00:00Z',
    ),
    const AgencyJobView(
      id: 'mock-agency-2',
      status: 'paused',
      tradeKey: 'quality_inspector',
      title: 'Quality Inspector — Night shift',
      city: 'Pune',
      area: 'Ranjangaon',
      payMin: 24000,
      payMax: 30000,
      minExperienceYears: 3,
      applicantsReceived: 4,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-05T00:00:00Z',
    ),
    const AgencyJobView(
      id: 'mock-agency-3',
      status: 'closed',
      tradeKey: 'cnc_vmc_setter',
      title: 'CNC / VMC Setter',
      city: 'Pune',
      area: 'Bhosari',
      applicantsReceived: 12,
      createdAt: '2026-06-28T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
    ),
  ];

  @override
  Future<AgencyJobView> createAgencyJob({
    required String tradeKey,
    required String title,
    required String city,
    String? area,
    int? payMin,
    int? payMax,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
  }) async {
    _agencySeq += 1;
    final AgencyJobView job = AgencyJobView(
      id: 'mock-agency-$_agencySeq',
      status: 'open',
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
      minExperienceYears: minExperienceYears,
      maxExperienceYears: maxExperienceYears,
      neededBy: neededBy,
      applicantsReceived: 0,
      createdAt: '2026-07-08T00:00:00Z',
      updatedAt: '2026-07-08T00:00:00Z',
    );
    _agencyJobs.insert(0, job);
    return job;
  }

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async =>
      List<AgencyJobView>.unmodifiable(_agencyJobs);

  @override
  Future<AgencyJobView?> getAgencyJob(String id) async {
    for (final AgencyJobView job in _agencyJobs) {
      if (job.id == id) return job;
    }
    return null;
  }

  @override
  Future<AgencyJobView> updateAgencyJob(
    String id, {
    String? tradeKey,
    String? title,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
  }) async {
    if (tradeKey == null &&
        title == null &&
        city == null &&
        area == null &&
        payMin == null &&
        payMax == null &&
        minExperienceYears == null &&
        maxExperienceYears == null &&
        neededBy == null) {
      throw ArgumentError('updateAgencyJob needs at least one field');
    }
    return _mutate(
      id,
      (AgencyJobView j) => AgencyJobView(
        id: j.id,
        status: j.status,
        tradeKey: tradeKey ?? j.tradeKey,
        title: title ?? j.title,
        city: city ?? j.city,
        area: area ?? j.area,
        payMin: payMin ?? j.payMin,
        payMax: payMax ?? j.payMax,
        minExperienceYears: minExperienceYears ?? j.minExperienceYears,
        maxExperienceYears: maxExperienceYears ?? j.maxExperienceYears,
        neededBy: neededBy ?? j.neededBy,
        applicantsReceived: j.applicantsReceived,
        createdAt: j.createdAt,
        updatedAt: '2026-07-08T00:00:00Z',
      ),
    );
  }

  @override
  Future<AgencyJobView> closeAgencyJob(String id) => _setAgencyStatus(id, 'closed');

  @override
  // A pause is reversible (#1202) — the row comes back `paused`, resumable.
  Future<AgencyJobView> pauseAgencyJob(String id) => _setAgencyStatus(id, 'paused');

  @override
  // Resume flips a `paused` row back to `open` (#1202).
  Future<AgencyJobView> resumeAgencyJob(String id) => _setAgencyStatus(id, 'open');

  Future<AgencyJobView> _setAgencyStatus(String id, String status) => _mutate(
        id,
        (AgencyJobView j) => AgencyJobView(
          id: j.id,
          status: status,
          tradeKey: j.tradeKey,
          title: j.title,
          city: j.city,
          area: j.area,
          payMin: j.payMin,
          payMax: j.payMax,
          minExperienceYears: j.minExperienceYears,
          maxExperienceYears: j.maxExperienceYears,
          neededBy: j.neededBy,
          applicantsReceived: j.applicantsReceived,
          createdAt: j.createdAt,
          updatedAt: '2026-07-08T00:00:00Z',
        ),
      );

  /// Applies [update] to the row with [id] in-place; a neutral unknown id is a
  /// no-op-safe [PayerApiException(404)] (mirrors the real not-owned/unknown).
  Future<AgencyJobView> _mutate(
    String id,
    AgencyJobView Function(AgencyJobView) update,
  ) async {
    final int i = _agencyJobs.indexWhere((AgencyJobView j) => j.id == id);
    if (i < 0) throw const PayerApiException(404);
    final AgencyJobView next = update(_agencyJobs[i]);
    _agencyJobs[i] = next;
    return next;
  }

  @override
  Future<ReferralsSummary> fetchReferralsSummary() async =>
      const ReferralsSummary(
        created: 24,
        clicked: 11,
        accepted: 6,
        minBucket: 5,
      );

  @override
  Future<int> fetchCredits() async => _credits;

  @override
  Future<int> fetchCreditBalance() async => _credits;

  @override
  Future<List<LedgerEntry>> fetchCreditLedger({int limit = 20}) async =>
      _creditLedger.take(limit).toList(growable: false);

  @override
  Future<int> unlockCandidate(int candidateId) async {
    if (!_unlocked.contains(candidateId) && _credits > 0) {
      _unlocked.add(candidateId);
      _credits -= 1;
    }
    return _credits;
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async {
    // Canned grant — decrement the shared balance so the credits stat still
    // moves. A real backend is server-truth; here we just mint an unlock id.
    if (_credits > 0) _credits -= 1;
    final String tail = workerId.length >= 4
        ? workerId.substring(workerId.length - 4)
        : workerId;
    return UnlockResult.granted(
      unlockId: 'mock-unlock-$tail',
      expiresAt: '2026-12-31T00:00:00Z',
    );
  }

  @override
  Future<RevealResult> reveal(String unlockId) async => const RevealResult.relay(
        relayHandle: 'relay-7Q2X',
        channel: 'in_app_relay',
        expiresAt: '2026-12-31T00:00:00Z',
      );

  @override
  Future<DisclosureResult> disclose({
    required String workerId,
    String? jobPostingId,
  }) async =>
      const DisclosureResult.disclosed(
        disclosureId: 'mock-disclosure',
        resumeUrl: 'https://mock.badabhai.in/resume/masked.pdf',
        expiresAt: '2026-12-31T00:00:00Z',
      );

  @override
  Future<List<PayerDisclosure>> listDisclosures() async =>
      const <PayerDisclosure>[
        PayerDisclosure(
          disclosureId: 'mock-disc-1',
          workerId: 'mock-worker-uuid-1',
          jobPostingId: 'mock-job-1',
          status: 'disclosed',
          resumeRef: 'mock/resume/masked-1.pdf',
          disclosedAt: '2026-07-01T10:00:00Z',
          expiresAt: '2026-12-31T00:00:00Z',
          createdAt: '2026-07-01T10:00:00Z',
        ),
      ];

  @override
  Future<void> recordInviteClick(String code) async {
    // Neutral no-op mock — mirrors the server's always-200 funnel signal.
  }

  // --- Org / team members (ADR-0027) — canned, owner-gated (PASS P4b) --------
  // The self row is the OWNER so the owner-only invite/remove actions are
  // walkable in MOCK. Emails are ALWAYS masked (never a raw address at rest).

  int _orgSeq = 300;

  final List<OrgMemberView> _orgMembers = <OrgMemberView>[
    const OrgMemberView(
      memberId: 'mock-owner',
      orgRole: 'owner',
      status: 'active',
      emailMasked: 'o•••@kalyani.in',
      invitedAt: '2026-05-01T00:00:00Z',
      isSelf: true,
    ),
    const OrgMemberView(
      memberId: 'mock-recruiter-1',
      orgRole: 'recruiter',
      status: 'active',
      emailMasked: 'p•••@kalyani.in',
      invitedAt: '2026-06-10T00:00:00Z',
    ),
    const OrgMemberView(
      memberId: 'mock-recruiter-2',
      orgRole: 'recruiter',
      status: 'invited',
      emailMasked: 'n•••@kalyani.in',
      invitedAt: '2026-07-05T00:00:00Z',
    ),
  ];

  @override
  Future<List<OrgMemberView>> fetchOrgMembers() async =>
      List<OrgMemberView>.unmodifiable(_orgMembers);

  @override
  Future<OrgMemberView> inviteOrgMember({
    required String email,
    String orgRole = 'recruiter',
  }) async {
    _orgSeq += 1;
    // The raw email is masked IMMEDIATELY and only the mask is kept — the mock
    // never stores/logs the raw address (mirrors the server's discipline).
    final OrgMemberView member = OrgMemberView(
      memberId: 'mock-member-$_orgSeq',
      orgRole: 'recruiter',
      status: 'invited',
      emailMasked: _maskEmail(email),
      invitedAt: '2026-07-08T00:00:00Z',
    );
    _orgMembers.add(member);
    return member;
  }

  @override
  Future<void> removeOrgMember(String memberId) async {
    final int i =
        _orgMembers.indexWhere((OrgMemberView m) => m.memberId == memberId);
    if (i < 0) throw const PayerApiException(404); // neutral unknown/not-owned
    if (_orgMembers[i].isOwner) throw const PayerApiException(409); // can't remove owner
    _orgMembers.removeAt(i);
  }

  @override
  Future<OrgMemberView> acceptOrgInvite({required String token}) async =>
      // Canned accept → an active membership row for the accepting session.
      const OrgMemberView(
        memberId: 'mock-accepted',
        orgRole: 'recruiter',
        status: 'active',
        emailMasked: 'y•••@kalyani.in',
        invitedAt: '2026-07-08T00:00:00Z',
        isSelf: true,
      );

  /// Masks a raw email to first char + domain — NEVER keeps the local part.
  /// "ravi.k@acme.in" → "r•••@acme.in".
  static String _maskEmail(String email) {
    final int at = email.indexOf('@');
    if (at <= 0) return '•••';
    final String head = email.substring(0, 1);
    final String domain = email.substring(at);
    return '$head•••$domain';
  }

  // --- Hiring capacity (ADR-0016) — canned allowance (PASS P4b) --------------

  static const CapacityView _capacity = CapacityView(
    maxActiveVacancies: 5,
    activePlanCount: 3,
    sourceTier: 'cap_5',
    expiresAt: '2026-08-07T00:00:00Z',
  );

  @override
  Future<CapacityView> fetchCapacity() async => _capacity;

  // --- Agency supply-money — KYC · earnings · payouts (canned, walkable) ------
  // A stateful in-memory mock so the whole earnings → request → history flow is
  // walkable in MOCK mode. The launch flag is treated as ON here (a demo build);
  // the real flag-OFF 404 degrade is exercised against the HTTP client, not this
  // mock. Money is fake — a request just moves ₹ from requestable → in-request
  // and prepends a history row. Masked by construction (last-4 only), PII-free.
  // Config economics mirror the server defaults (25% × ₹40 / 90d / ₹500 min).
  static const int _kPayoutThresholdInr = 500;
  static const int _kPayoutBasisInr = 40;
  static const int _kPayoutRateBps = 2500;
  static const int _kPayoutWindowDays = 90;

  // ₹ accrued per qualifying unlock (basis × rate) = 40 × 2500 / 10000 = ₹10.
  int get _accrualAmountInr => (_kPayoutBasisInr * _kPayoutRateBps) ~/ 10000;

  // Seeded VERIFIED so the request flow is immediately walkable in a demo.
  AgencyKycView _kyc = const AgencyKycView(
    status: 'verified',
    panLast4: '234F',
    bankLast4: '9012',
    updatedAt: '2026-07-10T00:00:00Z',
  );

  int _requestableInr = 850; // 85 accruals available to request
  int _inRequestInr = 0;
  final int _paidInr = 500; // one prior settled payout (the history seed row)
  final int _totalAccrualCount = 135; // 85 requestable + 50 already paid

  int _payoutSeq = 1;
  final List<AgencyPayout> _payouts = <AgencyPayout>[
    const AgencyPayout(
      id: 'mock-payout-1',
      amountInr: 500,
      accrualCount: 50,
      status: 'paid',
      createdAt: '2026-06-20T00:00:00Z',
    ),
  ];

  @override
  Future<AgencyKycView> submitAgencyKyc({
    required String pan,
    required String bankAccount,
    required String ifsc,
    required String accountHolderName,
  }) async {
    // A fresh submission is PENDING until an ops ack (the app has no verify path
    // in mock) — the honest state. Only the last-4 ever leaves the boundary.
    String last4(String v) => v.length <= 4 ? v : v.substring(v.length - 4);
    _kyc = AgencyKycView(
      status: 'pending',
      panLast4: last4(pan),
      bankLast4: last4(bankAccount),
      updatedAt: '2026-07-12T00:00:00Z',
    );
    return _kyc;
  }

  @override
  Future<AgencyKycView> fetchAgencyKyc() async => _kyc;

  @override
  Future<AgencyEarnings> fetchAgencyEarnings() async {
    String? blocked;
    if (!_kyc.isVerified) {
      blocked = 'kyc_not_verified';
    } else if (_requestableInr < _kPayoutThresholdInr) {
      blocked = 'below_threshold';
    }
    return AgencyEarnings(
      totalAccruedInr: _requestableInr + _inRequestInr + _paidInr,
      requestableInr: _requestableInr,
      inRequestInr: _inRequestInr,
      paidInr: _paidInr,
      accrualCount: _totalAccrualCount,
      kycStatus: _kyc.status,
      thresholdInr: _kPayoutThresholdInr,
      basisInr: _kPayoutBasisInr,
      rateBps: _kPayoutRateBps,
      windowDays: _kPayoutWindowDays,
      payoutsEnabled: true,
      canRequest: blocked == null,
      blockedReason: blocked,
    );
  }

  @override
  Future<PayoutRequestResult> requestAgencyPayout() async {
    // Mirror the server gate: KYC verified AND ≥ threshold. A refusal changes
    // nothing (HTTP 200 with ok:false server-side).
    if (!_kyc.isVerified) {
      return const PayoutRequestResult(ok: false, blockedReason: 'kyc_not_verified');
    }
    if (_requestableInr < _kPayoutThresholdInr) {
      return const PayoutRequestResult(ok: false, blockedReason: 'below_threshold');
    }
    final int amount = _requestableInr;
    final int count = amount ~/ _accrualAmountInr;
    _payoutSeq += 1;
    final AgencyPayout row = AgencyPayout(
      id: 'mock-payout-$_payoutSeq',
      amountInr: amount,
      accrualCount: count,
      status: 'requested',
      createdAt: '2026-07-14T00:00:00Z',
    );
    _payouts.insert(0, row);
    _inRequestInr += amount;
    _requestableInr = 0;
    return PayoutRequestResult(
      ok: true,
      requestId: row.id,
      amountInr: amount,
      accrualCount: count,
    );
  }

  @override
  Future<List<AgencyPayout>> fetchAgencyPayouts() async =>
      List<AgencyPayout>.unmodifiable(_payouts);

  /// Faceless [Applicant] rows synthesized from the canned candidates — opaque
  /// UUID-style ids + coarse facets + a couple of soft reasons. No name/phone.
  List<Applicant> _applicantsFrom(List<Candidate> source) {
    int rank = 0;
    return source.map((Candidate c) {
      rank += 1;
      final String workerId =
          '00000000-0000-4000-8000-${c.id.toString().padLeft(12, '0')}';
      return Applicant(
        workerId: workerId,
        rank: rank,
        score: 1 - (rank * 0.05),
        hot: c.hot,
        pushEligible: c.hot,
        components: <ApplicantSignal>[
          ApplicantSignal(
            signal: 'trade',
            raw: 1,
            weight: 0.5,
            reason: 'Trade matches ${c.trade}',
          ),
          const ApplicantSignal(
            signal: 'availability',
            raw: 1,
            weight: 0.3,
            reason: 'Available in your area',
          ),
        ],
        experienceBand: c.exp,
        tradeLabel: c.trade,
        cityLabel: c.loc,
      );
    }).toList(growable: false);
  }
}

// ===========================================================================
// MOCK job-posting interview engine (ADR-0035)
// ===========================================================================

/// Fixed timestamp so canned rows are stable across runs/tests.
const String _mockNow = '2026-07-27T00:00:00Z';

/// The opener. Deliberately does NOT greet the payer by company name and does
/// NOT ask for one (ADR-0035 §Decision 3) — the org name is auto-filled
/// server-side at publish time and never enters the conversation.
const String _kMockChatOpening =
    'Namaste! Main aapki job posting banane mein madad karunga. '
    'Shuru karte hain — aapko kis kaam ke liye log chahiye?';

/// One deterministic interview topic: the question asked, the chips offered, and
/// how the payer's free-text answer folds into the draft.
class _MockChatTopic {
  const _MockChatTopic({
    required this.key,
    required this.question,
    required this.chips,
    required this.apply,
  });

  /// Field KEY (never a value) — this is what `missing_fields` carries.
  final String key;
  final String question;
  final List<String> chips;
  final JobPostingDraft Function(JobPostingDraft draft, String answer) apply;
}

/// The MOCK topic bank. Ordered, finite, and — critically — carrying NO
/// company/org question. The real engine's bank lives in
/// `apps/ai-service/app/job_posting_chat/question_bank.py`; this exists only so
/// the client is walkable without it.
final List<_MockChatTopic> _kMockChatTopics = <_MockChatTopic>[
  _MockChatTopic(
    key: 'role_title',
    question: 'Aapko kis kaam ke liye log chahiye?',
    chips: <String>['CNC Setter', 'CNC Operator', 'Welder', 'Fitter'],
    apply: (JobPostingDraft d, String a) => _copyDraft(d, roleTitle: a),
  ),
  _MockChatTopic(
    key: 'location_label',
    question: 'Kaam kahan hai — city aur area?',
    chips: <String>['Pune', 'Chakan', 'Pimpri'],
    apply: (JobPostingDraft d, String a) => _copyDraft(d, locationLabel: a),
  ),
  _MockChatTopic(
    key: 'vacancy_band',
    question: 'Kitne log chahiye?',
    // The chips ARE the band enum labels — a tapped chip can never record a
    // headcount the payer did not give (ADR-0012).
    chips: <String>['1', '2-5', '6-10', '11-25', '25+'],
    apply: (JobPostingDraft d, String a) =>
        _copyDraft(d, vacancyBand: _mockBandFor(a)),
  ),
  _MockChatTopic(
    key: 'pay',
    question: 'Salary range kya rahegi (per month)?',
    chips: <String>['18000-24000', '24000-30000', '30000-40000'],
    apply: (JobPostingDraft d, String a) {
      final List<int> nums = RegExp(r'\d+')
          .allMatches(a)
          .map((RegExpMatch m) => int.parse(m.group(0)!))
          .where((int n) => n >= 1000)
          .toList();
      if (nums.isEmpty) return d;
      nums.sort();
      return _copyDraft(d, payMin: nums.first, payMax: nums.last);
    },
  ),
  _MockChatTopic(
    key: 'shift',
    question: 'Shift kaunsi hai?',
    chips: <String>['Day', 'Night', 'Rotational'],
    apply: (JobPostingDraft d, String a) => _copyDraft(d, shift: a),
  ),
  _MockChatTopic(
    key: 'requirements',
    question: 'Kaam ke liye kya zaroori hai — experience ya koi skill?',
    chips: <String>['2+ years', 'Fanuc', 'Drawing reading'],
    apply: (JobPostingDraft d, String a) =>
        _copyDraft(d, requirements: <String>[...d.requirements, a]),
  ),
];

/// Maps a vacancy answer to the `vacancy_band` enum — the MOCK mirror of the
/// shared `bandForCount()` validator (ADR-0012). An answer that is already a
/// band is passed through; a headcount is bucketed; anything else falls back to
/// the smallest band rather than inventing a bigger one.
String _mockBandFor(String answer) {
  final String trimmed = answer.trim();
  if (kVacancyBands.contains(trimmed)) return trimmed;
  final RegExpMatch? m = RegExp(r'\d+').firstMatch(trimmed);
  final int n = m == null ? 1 : int.parse(m.group(0)!);
  if (n <= 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 10) return '6-10';
  if (n <= 25) return '11-25';
  return '25+';
}

/// `copyWith` for the immutable [JobPostingDraft] (kept here, not on the model,
/// so the wire DTO stays a plain parsed value with no mock-only surface).
JobPostingDraft _copyDraft(
  JobPostingDraft d, {
  String? roleTitle,
  String? locationLabel,
  String? vacancyBand,
  int? payMin,
  int? payMax,
  String? shift,
  List<String>? requirements,
  List<String>? missingFields,
}) {
  return JobPostingDraft(
    roleTitle: roleTitle ?? d.roleTitle,
    tradeKey: d.tradeKey,
    skillPhrases: d.skillPhrases,
    locationLabel: locationLabel ?? d.locationLabel,
    vacancyBand: vacancyBand ?? d.vacancyBand,
    payMin: payMin ?? d.payMin,
    payMax: payMax ?? d.payMax,
    shift: shift ?? d.shift,
    benefits: d.benefits,
    requirements: requirements ?? d.requirements,
    description: d.description,
    confidence: d.confidence,
    missingFields: missingFields ?? d.missingFields,
    clarificationQuestions: d.clarificationQuestions,
  );
}

/// One in-memory MOCK conversation: transcript + draft + a cursor into the
/// topic bank. Stateless-engine semantics (the cursor is derived from what the
/// draft already has, not from a counter that can drift).
class _MockChatSession {
  _MockChatSession(this.id);

  final String id;
  final List<JobPostingChatMessageRow> messages = <JobPostingChatMessageRow>[];
  JobPostingDraft draft = const JobPostingDraft();
  bool published = false;
  int _asked = 0;

  bool get draftReady => _asked >= _kMockChatTopics.length;

  String get status => published
      ? 'published'
      : (draftReady ? 'draft_ready' : 'active');

  /// Chips for the question currently on screen (empty once the bank is done).
  List<String> get currentChips => _asked < _kMockChatTopics.length
      ? _kMockChatTopics[_asked].chips
      : const <String>[];

  JobPostingChatSessionSummary get summary => JobPostingChatSessionSummary(
        id: id,
        status: status,
        startedAt: _mockNow,
        lastMessageAt: _mockNow,
        draftReady: draftReady,
        roleTitle: draft.roleTitle,
      );

  /// Applies the payer's [text] to the CURRENT topic and asks the next one.
  JobPostingChatTurn answer(String text) {
    messages.add(
      JobPostingChatMessageRow(
        fromPayer: true,
        messageType: 'text',
        bodyText: text,
        createdAt: _mockNow,
      ),
    );

    if (_asked < _kMockChatTopics.length) {
      draft = _kMockChatTopics[_asked].apply(draft, text.trim());
      _asked += 1;
    }

    final _MockChatTopic? next =
        _asked < _kMockChatTopics.length ? _kMockChatTopics[_asked] : null;
    final String reply = next == null
        ? 'Bas ho gaya — neeche draft dekh lijiye aur publish kar dijiye.'
        : next.question;

    draft = _copyDraft(
      draft,
      missingFields: _kMockChatTopics
          .skip(_asked)
          .map((_MockChatTopic t) => t.key)
          .toList(growable: false),
    );

    messages.add(
      JobPostingChatMessageRow(
        fromPayer: false,
        messageType: 'text',
        bodyText: reply,
        createdAt: _mockNow,
      ),
    );

    return JobPostingChatTurn(
      sessionId: id,
      reply: reply,
      status: status,
      draft: draft,
      draftReady: draftReady,
      suggestedReplies: next?.chips ?? const <String>[],
    );
  }
}
