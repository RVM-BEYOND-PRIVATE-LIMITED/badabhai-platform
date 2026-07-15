import 'models.dart';

/// The data seam for the payer app. Two implementations bind to it:
/// [MockPayerApiClient] (canned, PII-free — demo builds behind `USE_MOCKS=true`
/// and widget tests) and `HttpPayerApiClient` (the live `/payer/*` routes).
///
/// EVERY method here has a real backend route, EXCEPT the two explicitly marked
/// MOCK-only ([fetchCandidates] / [unlockCandidate]) which the HTTP client
/// rejects with [UnsupportedError]. Surfaces that had no route (home metrics,
/// recent activity, earn/payout/KYC/referred rows, the credit-pack catalogue)
/// were REMOVED from the app rather than served as invented data.
///
/// Methods are async + return PII-free DTOs. The unlock flow is server-truth in
/// the real impl (credits decrement + ledger write happen there); the mock keeps
/// the same shape in memory.
abstract class PayerApiClient {
  /// Candidate feed — relevance-sorted, never by who paid. Each result carries
  /// its current [Candidate.unlocked] flag so the view masks/reveals correctly.
  ///
  /// MOCK-ONLY: the rich global candidate list. The REAL feed is per-job and
  /// faceless — see [fetchApplicants]. The HTTP client throws [UnsupportedError].
  Future<List<Candidate>> fetchCandidates();

  /// The REAL per-job feed — the faceless, relevance-ranked applicants for an
  /// owned [jobId] (`GET /payer/reach/jobs/:jobId/applicants`). PII-free:
  /// [Applicant] carries an opaque worker UUID + coarse facets, never a name.
  Future<List<Applicant>> fetchApplicants(String jobId);

  /// The signed-in payer's job postings; optional [status] filter
  /// (`?status=open` scopes the REAL feed to live postings).
  Future<List<JobPosting>> fetchJobs({String? status});

  // --- Company job postings — CRUD + lifecycle (PASS P3) --------------------
  // COMPANY (employer) surface: `POST/GET/PATCH /payer/job-postings` +
  // lifecycle/monetization sub-routes. snake_case IN, camelCase OUT. The AGENCY
  // create branch (`/payer/agency/jobs`) is a DIFFERENT contract (P4) — NOT here.

  /// Create a draft company posting (`POST /payer/job-postings` → 201 draft).
  /// Send [orgLabel] + [roleTitle] (+ optional [locationLabel]/[description]) and
  /// EXACTLY ONE of [vacancyBand] (`'1'|'2-5'|'6-10'|'11-25'|'25+'`) or
  /// [vacancies] (an int) — passing both/neither throws [ArgumentError].
  Future<JobPosting> createCompanyJob({
    required String orgLabel,
    required String roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
  });

  /// One owned posting (`GET /payer/job-postings/:id`). A neutral 404 (unknown or
  /// foreign) returns `null`, never an exception.
  Future<JobPosting?> getJob(String id);

  /// Patch an owned posting (`PATCH /payer/job-postings/:id`). Pass ≥1 field;
  /// [status] may only be `'open'` (publish a draft). 400 no-op / 409 closed or
  /// illegal transition surface as [PayerApiException].
  Future<JobPosting> updateJob(
    String id, {
    String? orgLabel,
    String? roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? status,
  });

  /// Close an owned posting (`POST /payer/job-postings/:id/close`). 409 when it
  /// is already closed/paused → [PayerApiException].
  Future<JobPosting> closeJob(String id);

  /// Pause an owned posting (`POST /payer/job-postings/:id/pause`). 409 unless it
  /// is currently open → [PayerApiException].
  Future<JobPosting> pauseJob(String id);

  /// Resume an owned posting (`POST /payer/job-postings/:id/resume`). 409 unless
  /// it is currently paused → [PayerApiException].
  Future<JobPosting> resumeJob(String id);

  /// Buy an applicant-visibility plan for a posting
  /// (`POST /payer/job-postings/:id/plan` → 201). [tier] is `'standard'|'pro'`.
  Future<PlanPurchase> buyPlan(String id, {required String tier, String? coupon});

  /// Boost a posting (`POST /payer/job-postings/:id/boost` → 201). 409 when an
  /// active boost already exists → [PayerApiException].
  Future<BoostPurchase> buyBoost(
    String id, {
    String tier = 'all_candidates',
    String? coupon,
  });

  /// Top up a posting's applicant-visibility quota
  /// (`POST /payer/job-postings/:id/quota-topup` → 201). 409 when there is no
  /// active plan → [PayerApiException].
  Future<PlanPurchase> quotaTopup(
    String id, {
    required String tier,
    String? coupon,
  });

  /// The unlock ledger (most-recent first).
  Future<List<LedgerEntry>> fetchLedger();

  // --- Credits — balance + ledger (PASS P3) ---------------------------------
  // READ-ONLY. The pack CATALOGUE had no endpoint (its prices were hardcoded
  // client-side and contradicted the server pricing catalog) and there is no
  // payment provider, so the purchase surface was REMOVED — only the real
  // balance + ledger remain.

  /// Current credit balance (`GET /payer/credits` → `{payer_id, balance}`).
  Future<int> fetchCreditBalance();

  /// The credit ledger (`GET /payer/credits/ledger?limit=` → `{ledger:[...]}`),
  /// most-recent first. Rows carry `delta`/`reason` (pack_purchase, unlock_debit,
  /// refund, grant) — mapped to display [LedgerEntry]s.
  Future<List<LedgerEntry>> fetchCreditLedger({int limit = 20});

  // --- Agency · Supply ------------------------------------------------------
  // The referral LINK + funnel summary are the supply surfaces with a real
  // backend (`POST /payer/agency/invites`, `GET /payer/agency/referrals/summary`
  // — both agent-only).

  /// The agency's referral link + code (`POST /payer/agency/invites`, agent-only).
  /// Faceless: the only optional input is a non-PII [campaign] tag — never a
  /// worker id/phone. Returns `{code, link:'/i/<code>'}`.
  Future<ReferralLink> referralLink({String? campaign});

  // --- Agency demand — jobs CRUD + lifecycle (PASS P4a) ---------------------
  // AGENT-only surface (`@PayerRoles('agent')` → 403 for a company session, so
  // these are called ONLY for an agency session). snake_case IN, camelCase OUT.
  // A pause returns `status:'closed'` (Phase-1 has no `paused` literal).

  /// Create an agency job (`POST /payer/agency/jobs` → 201 [AgencyJobView],
  /// starts `open`). Only [tradeKey]/[title]/[city] are required; the rest are
  /// optional coarse bands. A 400 (bad band ordering / invalid trade) surfaces
  /// as [PayerApiException].
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
  });

  /// The agency's own job postings (`GET /payer/agency/jobs` — a BARE array
  /// wrapped under `items` by the transport). Newest-first.
  Future<List<AgencyJobView>> fetchAgencyJobs();

  /// One owned agency job (`GET /payer/agency/jobs/:id`). A neutral 404 (unknown
  /// or not-owned) returns `null`, never an exception.
  Future<AgencyJobView?> getAgencyJob(String id);

  /// Patch an owned agency job (`PATCH /payer/agency/jobs/:id`). Pass ≥1 field
  /// (else [ArgumentError]). 400/404 surface as [PayerApiException].
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
  });

  /// Close an owned agency job (`POST /payer/agency/jobs/:id/close`). 404
  /// unknown / 400 already-closed → [PayerApiException].
  Future<AgencyJobView> closeAgencyJob(String id);

  /// Pause an owned agency job (`POST /payer/agency/jobs/:id/pause`). GOTCHA:
  /// the returned row's status is `closed` (Phase-1 has no `paused` state — the
  /// pause differs from close only in the emitted event). Surface honestly.
  Future<AgencyJobView> pauseAgencyJob(String id);

  /// The agency referral FUNNEL summary (`GET /payer/agency/referrals/summary`).
  /// AGGREGATE counts only (k-anon floor applied) — no per-worker rows.
  Future<ReferralsSummary> fetchReferralsSummary();

  /// Current credit balance.
  Future<int> fetchCredits();

  /// Spend 1 credit to unlock [candidateId]. Returns the new balance.
  ///
  /// MOCK-ONLY: keyed by the in-memory candidate int id. The REAL flow uses
  /// [unlock] with the opaque worker UUID from the feed; the HTTP client throws
  /// [UnsupportedError].
  Future<int> unlockCandidate(int candidateId);

  /// REAL unlock — spend a credit to unlock [workerId] (an opaque UUID from the
  /// per-job feed), optionally scoped to [jobId] (`POST /payer/unlocks`).
  /// Returns a typed [UnlockResult]; the neutral DENY (HTTP 200
  /// `{status:"unavailable"}`) comes back as `unavailable`, never an exception.
  Future<UnlockResult> unlock({required String workerId, String? jobId});

  /// REAL reveal — exchange a granted [unlockId] for an in-app relay handle
  /// (`POST /payer/unlocks/:unlockId/reveal`). Returns a relay handle + channel,
  /// or the neutral `unavailable`. Never a raw phone.
  Future<RevealResult> reveal(String unlockId);

  /// REAL masked-résumé disclosure — request a signed masked-PDF URL for
  /// [workerId] (`POST /payer/resume-disclosures`), optionally scoped to
  /// [jobPostingId]. Returns the URL, or the neutral `unavailable`.
  Future<DisclosureResult> disclose({
    required String workerId,
    String? jobPostingId,
  });

  /// The caller's OWN masked-resume disclosure history
  /// (`GET /payer/resume-disclosures` → `{disclosures:[...]}`, newest-first,
  /// ≤500). PII-free rows (opaque ids + timestamps). Session-scoped — the
  /// `payer_id` is derived from the bearer, never a body/param.
  Future<List<PayerDisclosure>> listDisclosures();

  /// Record an agency invite-link click/share
  /// (`POST /payer/agency/invites/:code/click`, AGENT-only, no body → HTTP 200
  /// `{ok:true}` always, a neutral no-op on an unknown code). Best-effort funnel
  /// signal; carries no PII. Callers treat it as fire-and-forget.
  Future<void> recordInviteClick(String code);

  // --- Org / team members (ADR-0027, PASS P4b) ------------------------------
  // The signed-in payer's org/team, behind PayerAuthGuard (+ PayerOrgRoleGuard
  // on the write routes). Emails are ALWAYS server-masked; the ONLY raw email is
  // the transient invite input handed straight to the POST. NO body payer_id /
  // org_id (the server derives both from the bearer + resolved org).

  /// The caller's own org members (`GET /payer/org/members`). Any member may
  /// read; each row is masked. Newest membership order is server-defined.
  Future<List<OrgMemberView>> fetchOrgMembers();

  /// Invite a teammate (`POST /payer/org/members`, OWNER-only → 201
  /// [OrgMemberView] `invited`). [orgRole] may only be `'recruiter'`. [email] is
  /// the transient raw invitee email — never stored/logged past the POST. A 409
  /// (already a member / seat cap), 503 (mailer down), or 403 (not the owner)
  /// surface as [PayerApiException].
  Future<OrgMemberView> inviteOrgMember({
    required String email,
    String orgRole,
  });

  /// Remove a teammate (`DELETE /payer/org/members/:id`, OWNER-only → 200). A
  /// 409 (the target is the org owner) or 403 (not the owner) surface as
  /// [PayerApiException]. A neutral 404 (unknown / not-owned) also throws.
  Future<void> removeOrgMember(String memberId);

  /// Accept a teammate invite (`POST /payer/org/invites/accept`,
  /// PayerAuthGuard-only → 200 active [OrgMemberView]). The body carries ONLY
  /// the single-use [token]. A 404 (bad/expired token) or 403 (invite email
  /// mismatch) surface as [PayerApiException].
  Future<OrgMemberView> acceptOrgInvite({required String token});

  // --- Hiring capacity (ADR-0016, PASS P4b) ---------------------------------
  // The payer's OWN concurrent-active-vacancy allowance. PII-free, READ-ONLY:
  // the upgrade/buy action was a MOCK payment (`real_call:false`) with no
  // payment provider behind it, so it was REMOVED — only the real allowance
  // read remains.

  /// The caller's own capacity allowance (`GET /payer/capacity`).
  Future<CapacityView> fetchCapacity();
}
