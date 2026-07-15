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
  static const ReferralLink _referralLink = ReferralLink(
    code: 'APEX-7K2',
    url: 'badabhai.in/r/APEX-7K2',
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

  // --- Agency demand — jobs CRUD + lifecycle + referrals summary (canned) ----
  // An in-memory list so the agency My-jobs + Post-a-job flow is walkable in
  // MOCK: create prepends a fresh `open` row; close/pause flip it to `closed`
  // (Phase-1 has no `paused` state). PII-free — only coarse demand attributes.

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
  Future<AgencyJobView> closeAgencyJob(String id) => _closeAgency(id);

  @override
  // A pause returns `status:'closed'` on the wire — mirror that here.
  Future<AgencyJobView> pauseAgencyJob(String id) => _closeAgency(id);

  Future<AgencyJobView> _closeAgency(String id) => _mutate(
        id,
        (AgencyJobView j) => AgencyJobView(
          id: j.id,
          status: 'closed',
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
