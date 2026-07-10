import '../auth/payer_http.dart';
import 'models.dart';
import 'mock_payer_api_client.dart';
import 'payer_api_client.dart';

/// REAL HTTP-backed [PayerApiClient].
///
/// Strategy (PASS C, intentionally tight): bind the cleanly-mappable `/payer/*`
/// endpoints; COMPOSE a [MockPayerApiClient] and DELEGATE to it for the surfaces
/// whose backend is missing (design-only) or whose screen rework is deferred
/// (per-job applicants, relay reveal, masked résumé). Every delegated method is
/// marked `// TODO(bind)` so the follow-up is greppable.
///
/// SECURITY: never sends a body `payer_id` (the server derives it from the bearer
/// via [PayerHttp]); never logs a token.
class HttpPayerApiClient implements PayerApiClient {
  HttpPayerApiClient(this._http, {MockPayerApiClient? fallback})
      : _mock = fallback ?? MockPayerApiClient();

  final PayerHttp _http;

  /// Composed mock used as the fallback for deferred / design-only surfaces.
  final MockPayerApiClient _mock;

  // ---------------------------------------------------------------------------
  // BOUND — real endpoints
  // ---------------------------------------------------------------------------

  @override
  Future<int> fetchCredits() async {
    final PayerResponse res = await _http.send(PayerMethod.get, '/payer/credits');
    return (res.body['balance'] as num?)?.toInt() ?? 0;
  }

  @override
  Future<int> buyCredits(int count) async {
    // The Buy-credits screen passes a pack's unlock COUNT; the real endpoint
    // wants a `pack_code`. Map the catalogue counts (50/200/1000) → pack codes.
    final String packCode = _packCodeForCount(count);
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/credits',
      body: <String, dynamic>{'pack_code': packCode},
    );
    return (res.body['balance'] as num?)?.toInt() ?? await fetchCredits();
  }

  @override
  Future<List<LedgerEntry>> fetchLedger() async {
    final PayerResponse res = await _http.send(PayerMethod.get, '/payer/unlocks');
    // A non-2xx must not decode to a fabricated empty ledger shown as success.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['unlocks'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(_ledgerFromUnlock)
        .toList(growable: false);
  }

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    final String path = status == null || status.isEmpty
        ? '/payer/job-postings'
        : '/payer/job-postings?status=$status';
    final PayerResponse res = await _http.send(PayerMethod.get, path);
    // A real server error (5xx/429/400) must not decode to an empty list shown
    // as a "ready" no-jobs state — surface it so JobsCubit shows error/retry.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    // The list endpoint returns rows under a wrapping key when the transport can
    // surface them; a top-level bare array is not decodable through [PayerHttp]
    // (which yields a Map body) — see the note on [_asList].
    final List<dynamic> rows = res.body['items'] is List<dynamic>
        ? res.body['items'] as List<dynamic>
        : _asList(res.body['data']) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(_jobFromRow)
        .toList(growable: false);
  }

  // --- Company job postings — CRUD + lifecycle -------------------------------

  @override
  Future<JobPosting> createCompanyJob({
    required String orgLabel,
    required String roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
  }) async {
    // EXACTLY ONE of vacancy_band | vacancies (server rejects both/neither).
    if ((vacancyBand == null) == (vacancies == null)) {
      throw ArgumentError(
        'createCompanyJob needs exactly one of vacancyBand or vacancies',
      );
    }
    final Map<String, dynamic> body = <String, dynamic>{
      'org_label': orgLabel,
      'role_title': roleTitle,
      if (locationLabel != null && locationLabel.isNotEmpty)
        'location_label': locationLabel,
      if (description != null && description.isNotEmpty)
        'description': description,
      if (vacancyBand != null) 'vacancy_band': vacancyBand,
      if (vacancies != null) 'vacancies': vacancies,
    };
    final PayerResponse res =
        await _http.send(PayerMethod.post, '/payer/job-postings', body: body);
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return _jobFromRow(res.body);
  }

  @override
  Future<JobPosting?> getJob(String id) async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/job-postings/$id');
    // Neutral 404 (unknown OR foreign) → null, never an oracle/exception.
    if (res.statusCode == 404) return null;
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return _jobFromRow(res.body);
  }

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
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{
      if (orgLabel != null) 'org_label': orgLabel,
      if (roleTitle != null) 'role_title': roleTitle,
      if (locationLabel != null) 'location_label': locationLabel,
      if (description != null) 'description': description,
      if (vacancyBand != null) 'vacancy_band': vacancyBand,
      if (vacancies != null) 'vacancies': vacancies,
      if (status != null) 'status': status,
    };
    if (body.isEmpty) {
      throw ArgumentError('updateJob needs at least one field');
    }
    final PayerResponse res = await _http
        .send(PayerMethod.patch, '/payer/job-postings/$id', body: body);
    // 400 no-op / 409 closed or illegal transition surface as a typed error.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return _jobFromRow(res.body);
  }

  @override
  Future<JobPosting> closeJob(String id) => _lifecycle(id, 'close');

  @override
  Future<JobPosting> pauseJob(String id) => _lifecycle(id, 'pause');

  @override
  Future<JobPosting> resumeJob(String id) => _lifecycle(id, 'resume');

  /// Shared close/pause/resume POST — a 200 row on success, a 409 (illegal
  /// transition) → [PayerApiException] the cubit turns into an honest message.
  Future<JobPosting> _lifecycle(String id, String action) async {
    final PayerResponse res =
        await _http.send(PayerMethod.post, '/payer/job-postings/$id/$action');
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return _jobFromRow(res.body);
  }

  @override
  Future<PlanPurchase> buyPlan(
    String id, {
    required String tier,
    String? coupon,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-postings/$id/plan',
      body: <String, dynamic>{
        'tier': tier,
        if (coupon != null && coupon.isNotEmpty) 'coupon': coupon,
      },
    );
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return _planFromResponse(res.body);
  }

  @override
  Future<BoostPurchase> buyBoost(
    String id, {
    String tier = 'all_candidates',
    String? coupon,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-postings/$id/boost',
      body: <String, dynamic>{
        'tier': tier,
        if (coupon != null && coupon.isNotEmpty) 'coupon': coupon,
      },
    );
    // 409 when an active boost already exists.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final Map<String, dynamic> boost =
        (res.body['boost'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final Map<String, dynamic> quote =
        (res.body['quote'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    return BoostPurchase(
      status: boost['status'] as String?,
      finalInr: (quote['finalInr'] as num?)?.toInt(),
    );
  }

  @override
  Future<PlanPurchase> quotaTopup(
    String id, {
    required String tier,
    String? coupon,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-postings/$id/quota-topup',
      body: <String, dynamic>{
        'tier': tier,
        if (coupon != null && coupon.isNotEmpty) 'coupon': coupon,
      },
    );
    // 409 when there is no active plan to top up.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return _planFromResponse(res.body);
  }

  // --- Credits — balance + ledger + pack purchase ----------------------------

  @override
  Future<int> fetchCreditBalance() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/credits');
    // A non-2xx must not decode to a fabricated 0 balance shown as success.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return (res.body['balance'] as num?)?.toInt() ?? 0;
  }

  @override
  Future<int> buyCreditPack({required String packCode}) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/credits',
      body: <String, dynamic>{'pack_code': packCode},
    );
    // Unknown pack → a real 404 (surfaced as a typed error, not a false buy).
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return (res.body['balance'] as num?)?.toInt() ?? await fetchCreditBalance();
  }

  @override
  Future<List<LedgerEntry>> fetchCreditLedger({int limit = 20}) async {
    final PayerResponse res = await _http
        .send(PayerMethod.get, '/payer/credits/ledger?limit=$limit');
    // A non-2xx must not decode to a fabricated empty ledger shown as success.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['ledger'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(_ledgerFromCreditRow)
        .toList(growable: false);
  }

  @override
  Future<List<Applicant>> fetchApplicants(String jobId) async {
    // Faceless, relevance-ranked applicants for an OWNED job. The response is an
    // object ({jobId, applicants:[...]}) so it decodes cleanly. An unknown OR
    // foreign job is a neutral 404 → empty feed (no-oracle).
    final PayerResponse res = await _http.send(
      PayerMethod.get,
      '/payer/reach/jobs/$jobId/applicants',
    );
    // Neutral 404 (unknown OR foreign job) → empty feed (no-oracle). But a
    // 429 (per-payer hourly cap) or 5xx must NOT masquerade as "no applicants"
    // — surface it so FindCubit shows an error/retry, not a false empty.
    if (res.statusCode == 404) return const <Applicant>[];
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['applicants'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(_applicantFromRow)
        .toList(growable: false);
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async {
    // The opaque worker UUID from the feed is sent as `worker_id` (NEVER a mock
    // int, NEVER a body `payer_id` — the server derives the payer from the
    // bearer). `job_id` is optional scoping.
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/unlocks',
      body: <String, dynamic>{
        'worker_id': workerId,
        if (jobId != null) 'job_id': jobId,
      },
    );
    // Money denials come back as HTTP 200 {status:"unavailable"} — never trust
    // the status/HTTP code alone: a grant MUST carry a real unlock_id.
    final String? unlockId = res.body['unlock_id'] as String?;
    if (unlockId == null || unlockId.isEmpty) {
      return const UnlockResult.unavailable();
    }
    return UnlockResult.granted(
      unlockId: unlockId,
      expiresAt: res.body['expires_at'] as String?,
    );
  }

  @override
  Future<RevealResult> reveal(String unlockId) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/unlocks/$unlockId/reveal',
    );
    // A relay is real only when a relay_handle is present; {status:"unavailable"}
    // (or a missing handle) is the neutral deny.
    final String? handle = res.body['relay_handle'] as String?;
    if (handle == null || handle.isEmpty) {
      return const RevealResult.unavailable();
    }
    return RevealResult.relay(
      relayHandle: handle,
      channel: res.body['channel'] as String? ?? 'in_app_relay',
      expiresAt: res.body['expires_at'] as String?,
    );
  }

  @override
  Future<DisclosureResult> disclose({
    required String workerId,
    String? jobPostingId,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/resume-disclosures',
      body: <String, dynamic>{
        'worker_id': workerId,
        if (jobPostingId != null) 'job_posting_id': jobPostingId,
      },
    );
    // Disclosed only when a signed resume_url is present; else neutral deny.
    final String? url = res.body['resume_url'] as String?;
    if (url == null || url.isEmpty) {
      return const DisclosureResult.unavailable();
    }
    return DisclosureResult.disclosed(
      disclosureId: res.body['disclosure_id'] as String? ?? '',
      resumeUrl: url,
      expiresAt: res.body['expires_at'] as String?,
    );
  }

  @override
  Future<int> unlockCandidate(int candidateId) async {
    // LEGACY / MOCK path — keyed by the in-memory candidate int id. The REAL
    // unlock flow uses [unlock] with the opaque worker UUID from
    // [fetchApplicants]; nothing in REAL mode reaches this int→string path.
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/unlocks',
      body: <String, dynamic>{'worker_id': '$candidateId'},
    );
    // Money/disclosure denials come back as HTTP 200 {status:"unavailable"} —
    // the NEUTRAL deny. Never trust the status code: treat it as "no change".
    final String? status = res.body['status'] as String?;
    if (status == 'unavailable') {
      return fetchCredits();
    }
    // Success {ok, unlock_id, status:"granted", expires_at} carries no balance,
    // so re-read server-truth credits.
    return fetchCredits();
  }

  @override
  Future<ReferralLink> referralLink({String? campaign}) async {
    // Faceless: the only optional input is a non-PII campaign tag — never a
    // worker id/phone/name (there is no such field on this route).
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/agency/invites',
      body: <String, dynamic>{
        if (campaign != null && campaign.isNotEmpty) 'campaign': campaign,
      },
    );
    final String code = res.body['code'] as String? ?? '';
    final String link = res.body['link'] as String? ?? '';
    return ReferralLink(code: code, url: link);
  }

  // --- Agency demand — jobs CRUD + lifecycle + referrals summary -------------

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
    // snake_case body — trade_key/pay_min/etc. NEVER a body payer_id (the server
    // derives the tenant from the bearer).
    final Map<String, dynamic> body = <String, dynamic>{
      'trade_key': tradeKey,
      'title': title,
      'city': city,
      if (area != null && area.isNotEmpty) 'area': area,
      if (payMin != null) 'pay_min': payMin,
      if (payMax != null) 'pay_max': payMax,
      if (minExperienceYears != null) 'min_experience_years': minExperienceYears,
      if (maxExperienceYears != null) 'max_experience_years': maxExperienceYears,
      if (neededBy != null) 'needed_by': neededBy,
    };
    final PayerResponse res =
        await _http.send(PayerMethod.post, '/payer/agency/jobs', body: body);
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return AgencyJobView.fromJson(res.body);
  }

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async {
    // The list route returns a BARE JSON array — PayerHttp._decode wraps it
    // under `items`.
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/agency/jobs');
    // A non-2xx (5xx/429/403) must not decode to a fabricated empty list shown
    // as a "no jobs" ready state — surface it so AgencyJobsCubit shows error.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows = res.body['items'] is List<dynamic>
        ? res.body['items'] as List<dynamic>
        : const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(AgencyJobView.fromJson)
        .toList(growable: false);
  }

  @override
  Future<AgencyJobView?> getAgencyJob(String id) async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/agency/jobs/$id');
    // Neutral 404 (unknown OR not-owned) → null (no-oracle).
    if (res.statusCode == 404) return null;
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return AgencyJobView.fromJson(res.body);
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
    final Map<String, dynamic> body = <String, dynamic>{
      if (tradeKey != null) 'trade_key': tradeKey,
      if (title != null) 'title': title,
      if (city != null) 'city': city,
      if (area != null) 'area': area,
      if (payMin != null) 'pay_min': payMin,
      if (payMax != null) 'pay_max': payMax,
      if (minExperienceYears != null) 'min_experience_years': minExperienceYears,
      if (maxExperienceYears != null) 'max_experience_years': maxExperienceYears,
      if (neededBy != null) 'needed_by': neededBy,
    };
    if (body.isEmpty) {
      throw ArgumentError('updateAgencyJob needs at least one field');
    }
    final PayerResponse res =
        await _http.send(PayerMethod.patch, '/payer/agency/jobs/$id', body: body);
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return AgencyJobView.fromJson(res.body);
  }

  @override
  Future<AgencyJobView> closeAgencyJob(String id) => _agencyLifecycle(id, 'close');

  @override
  Future<AgencyJobView> pauseAgencyJob(String id) => _agencyLifecycle(id, 'pause');

  /// Shared close/pause POST. A pause returns `status:'closed'` (Phase-1 has no
  /// `paused` state) — the caller surfaces that honestly.
  Future<AgencyJobView> _agencyLifecycle(String id, String action) async {
    final PayerResponse res =
        await _http.send(PayerMethod.post, '/payer/agency/jobs/$id/$action');
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return AgencyJobView.fromJson(res.body);
  }

  @override
  Future<ReferralsSummary> fetchReferralsSummary() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/agency/referrals/summary');
    // A non-2xx must not decode to a fabricated all-zero summary shown as real.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return ReferralsSummary.fromJson(res.body);
  }

  // --- Org / team members (ADR-0027) — masked, owner-gated -------------------

  @override
  Future<List<OrgMemberView>> fetchOrgMembers() async {
    // The list route returns a BARE JSON array — PayerHttp._decode wraps it
    // under `items`. Any org member may read; every row is masked.
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/org/members');
    // A non-2xx (5xx/429/403) must not decode to a fabricated empty roster shown
    // as a "no team" ready state — surface it so OrgCubit shows error/retry.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows = res.body['items'] is List<dynamic>
        ? res.body['items'] as List<dynamic>
        : const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(OrgMemberView.fromJson)
        .toList(growable: false);
  }

  @override
  Future<OrgMemberView> inviteOrgMember({
    required String email,
    String orgRole = 'recruiter',
  }) async {
    // [email] is the ONE transient raw value — sent straight to the POST, never
    // stored/logged. `org_role` is 'recruiter' only (server rejects others).
    // NEVER a body payer_id/org_id (the server derives them from the session).
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/org/members',
      body: <String, dynamic>{'email': email, 'org_role': orgRole},
    );
    // 409 already-member/seat-cap · 503 mailer · 403 not-owner → typed error.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return OrgMemberView.fromJson(res.body);
  }

  @override
  Future<void> removeOrgMember(String memberId) async {
    final PayerResponse res =
        await _http.send(PayerMethod.delete, '/payer/org/members/$memberId');
    // 200 {member_id,status:'removed'} on success; 409 if the target is the
    // owner, 403 if the caller is not the owner, neutral 404 if unknown.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
  }

  @override
  Future<OrgMemberView> acceptOrgInvite({required String token}) async {
    // Body carries ONLY the single-use token — no org/member id (the server
    // resolves both and binds the accept to the caller's verified email).
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/org/invites/accept',
      body: <String, dynamic>{'token': token},
    );
    // 404 bad/expired token · 403 email mismatch → the UI states the reason.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return OrgMemberView.fromJson(res.body);
  }

  // --- Hiring capacity (ADR-0016) — allowance vs used ------------------------

  @override
  Future<CapacityView> fetchCapacity() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/capacity');
    // A non-2xx must not decode to a fabricated all-zero capacity shown as real.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return CapacityView.fromJson(res.body);
  }

  @override
  Future<CapacityPurchase> buyCapacity({
    required String tier,
    String? coupon,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/capacity',
      body: <String, dynamic>{
        'tier': tier,
        if (coupon != null && coupon.isNotEmpty) 'coupon': coupon,
      },
    );
    // MIXED casing: top-level snake_case + a nested camelCase quote (finalInr).
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return CapacityPurchase.fromJson(res.body);
  }

  // ---------------------------------------------------------------------------
  // DELEGATED to the mock — deferred screen rework / design-only (no backend)
  // ---------------------------------------------------------------------------

  @override
  // The rich global candidate list is a MOCK-only shape (the REAL feed is the
  // faceless per-job [fetchApplicants]). Kept delegating so MOCK stays walkable.
  Future<List<Candidate>> fetchCandidates() => _mock.fetchCandidates();

  @override
  // TODO(bind): home demand metrics have no single endpoint — synthesize later.
  Future<HomeMetrics> fetchHomeMetrics() => _mock.fetchHomeMetrics();

  @override
  // TODO(bind): recent-activity has no endpoint — synthesize from events later.
  Future<List<ActivityItem>> fetchRecentActivity() => _mock.fetchRecentActivity();

  @override
  // TODO(bind): agency earn summary aggregate — GET /payer/agency/referrals/summary
  // gives funnel counts, not ₹ earned. Deferred.
  Future<EarnSummary> fetchEarnSummary() => _mock.fetchEarnSummary();

  @override
  // The credit-pack catalogue is config-only (no endpoint) — design data.
  Future<List<CreditPack>> fetchCreditPacks() => _mock.fetchCreditPacks();

  @override
  // DESIGN-ONLY — no backend endpoint (ADR-0022 parked Phase 2).
  Future<List<ReferredWorker>> fetchReferredWorkers() =>
      _mock.fetchReferredWorkers();

  @override
  // DESIGN-ONLY — no backend endpoint (ADR-0022 parked Phase 2).
  Future<PayoutSummary> fetchPayoutSummary() => _mock.fetchPayoutSummary();

  @override
  // DESIGN-ONLY — no backend endpoint (ADR-0022 parked Phase 2).
  Future<List<PayoutEntry>> fetchPayouts() => _mock.fetchPayouts();

  @override
  // DESIGN-ONLY — no backend endpoint (ADR-0022 parked Phase 2).
  Future<KycStatus> kycStatus() => _mock.kycStatus();

  @override
  // DESIGN-ONLY — no backend endpoint (ADR-0022 parked Phase 2).
  Future<KycStatus> submitKyc(KycSubmission submission) =>
      _mock.submitKyc(submission);

  // ---------------------------------------------------------------------------
  // Row mappers
  // ---------------------------------------------------------------------------

  JobPosting _jobFromRow(Map<String, dynamic> row) {
    return JobPosting(
      id: row['id'] as String?,
      title: row['roleTitle'] as String? ?? row['role_title'] as String? ?? '',
      band: row['vacancyBand'] as String? ?? row['vacancy_band'] as String? ?? '',
      locationLabel:
          row['locationLabel'] as String? ?? row['location_label'] as String?,
      createdAt: row['createdAt'] as String? ?? row['created_at'] as String?,
      status: _jobStatusFromWire(row['status'] as String?),
      // The RAW lifecycle string drives the REAL My-jobs pill + legal actions
      // (the 3-value [JobStatus] enum can't distinguish draft/paused/closed).
      wireStatus: row['status'] as String?,
      // Server row has NO quota/applicants/unlocks/verified/boost (MISSING per
      // the API map). Keep the model defaults — do NOT fake them.
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      verified: false,
      boosted: false,
    );
  }

  /// Wire status `draft|open|closed` → the app's [JobStatus]. The model has no
  /// `draft` member; map draft → review (its "not live yet" slot).
  JobStatus _jobStatusFromWire(String? wire) => switch (wire) {
        'open' => JobStatus.live,
        'closed' => JobStatus.filled,
        _ => JobStatus.review,
      };

  /// One faceless camelCase applicant row → [Applicant]. NO name/phone/skill
  /// field exists on the wire by construction; only opaque id + coarse facets.
  Applicant _applicantFromRow(Map<String, dynamic> row) {
    final List<dynamic> components =
        (row['components'] as List<dynamic>?) ?? const <dynamic>[];
    return Applicant(
      workerId: row['workerId'] as String? ?? '',
      rank: (row['rank'] as num?)?.toInt() ?? 0,
      score: (row['score'] as num?)?.toDouble() ?? 0,
      hot: row['hot'] as bool? ?? false,
      pushEligible: row['pushEligible'] as bool? ?? false,
      components: components
          .whereType<Map<String, dynamic>>()
          .map(_signalFromRow)
          .toList(growable: false),
      experienceBand: row['experienceBand'] as String?,
      tradeLabel: row['tradeLabel'] as String?,
      cityLabel: row['cityLabel'] as String?,
    );
  }

  ApplicantSignal _signalFromRow(Map<String, dynamic> row) => ApplicantSignal(
        signal: row['signal'] as String? ?? '',
        raw: (row['raw'] as num?)?.toDouble() ?? 0,
        weight: (row['weight'] as num?)?.toDouble() ?? 0,
        reason: row['reason'] as String? ?? '',
      );

  /// Flattens the plan/quota-topup response (`{plan{applicantVisibilityQuota,
  /// status}, quote{finalInr}, paused, wouldPause}`) → [PlanPurchase].
  PlanPurchase _planFromResponse(Map<String, dynamic> body) {
    final Map<String, dynamic> plan =
        (body['plan'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final Map<String, dynamic> quote =
        (body['quote'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    return PlanPurchase(
      applicantVisibilityQuota:
          (plan['applicantVisibilityQuota'] as num?)?.toInt(),
      status: plan['status'] as String?,
      finalInr: (quote['finalInr'] as num?)?.toInt(),
      paused: body['paused'] as bool? ?? false,
      wouldPause: body['wouldPause'] as bool? ?? false,
    );
  }

  /// One credit-ledger row (`{delta, reason, pack_code, ...}`) → [LedgerEntry].
  /// The sign of `delta` drives credit/debit; the label is derived from the
  /// coarse `reason` (never PII).
  LedgerEntry _ledgerFromCreditRow(Map<String, dynamic> row) {
    final int delta = (row['delta'] as num?)?.toInt() ?? 0;
    final String reason = row['reason'] as String? ?? '';
    final String? packCode = row['pack_code'] as String?;
    final bool isCredit = delta >= 0;
    final String label = switch (reason) {
      'pack_purchase' =>
        packCode == null ? 'Pack purchase' : 'Pack purchase · $packCode',
      'unlock_debit' => 'Unlock',
      'refund' => 'Refund',
      'grant' => 'Bonus credits',
      _ => reason.isEmpty ? 'Adjustment' : reason,
    };
    return LedgerEntry(
      label: label,
      amount: '${isCredit ? '+' : '−'}${delta.abs()}',
      direction: isCredit ? LedgerDirection.credit : LedgerDirection.debit,
    );
  }

  LedgerEntry _ledgerFromUnlock(Map<String, dynamic> row) {
    final String workerId = row['worker_id'] as String? ?? '';
    final String tail = workerId.length >= 4
        ? workerId.substring(workerId.length - 4)
        : workerId;
    return LedgerEntry(
      label: 'Unlock ••• $tail',
      amount: '−1',
      direction: LedgerDirection.debit,
    );
  }

  static List<dynamic>? _asList(Object? v) => v is List<dynamic> ? v : null;

  /// Maps a catalogue unlock count to the server pack code. Falls back to the
  /// count itself if it is an unknown bespoke value.
  String _packCodeForCount(int count) => switch (count) {
        50 => 'pack_50',
        200 => 'pack_200',
        1000 => 'pack_1000',
        _ => 'pack_$count',
      };
}
