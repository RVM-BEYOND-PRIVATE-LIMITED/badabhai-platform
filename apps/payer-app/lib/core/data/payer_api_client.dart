import 'job_posting_chat_models.dart';
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
  ///
  /// Match V1 (additive, all optional): [matchSkillIds] (+ [untickedRelatedIds]
  /// excluded from reach), [city], [payMin]/[payMax], [shift], [neededBy] — each
  /// only added to the body when non-null (snake_case: `match_skill_ids`,
  /// `unticked_related_ids`, `city`, `pay_min`, `pay_max`, `shift`, `needed_by`).
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
  });

  /// One owned posting (`GET /payer/job-postings/:id`). A neutral 404 (unknown or
  /// foreign) returns `null`, never an exception.
  Future<JobPosting?> getJob(String id);

  /// Patch an owned posting (`PATCH /payer/job-postings/:id`). Pass ≥1 field;
  /// [status] may only be `'open'` (publish a draft). 400 no-op / 409 closed or
  /// illegal transition surface as [PayerApiException].
  ///
  /// Match V1 (additive, all optional): [matchSkillIds]/[untickedRelatedIds],
  /// [city], [payMin]/[payMax], [shift], [neededBy] — each only added to the
  /// PATCH body when non-null (same snake_case keys as [createCompanyJob]).
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

  // --- Match V1 — demand skill picker + reach preview -----------------------
  // The DEMAND-side skill taxonomy the payer picks from + the deterministic
  // reach preview. Both PII-free (coarse skill ids/labels + integer counts).

  /// The selectable demand skills (`GET /payer/match/skills` → `{skills:[...]}`).
  /// Each [MatchSkill] carries its related-skill ids the reach preview widens
  /// into. A non-2xx surfaces as [PayerApiException].
  Future<List<MatchSkill>> fetchMatchSkills();

  /// Deterministic reach preview for a picked skill set
  /// (`POST /payer/match/reach-preview`, body `{match_skill_ids,
  /// unticked_related_ids}`). Returns per-skill breakdowns + roll-up totals. A
  /// non-2xx surfaces as [PayerApiException].
  Future<ReachPreview> reachPreview({
    required List<String> matchSkillIds,
    List<String> untickedRelatedIds = const <String>[],
  });

  // --- AI job-posting chat (ADR-0035) ---------------------------------------
  // The conversational INPUT SURFACE in front of the unchanged job-posting
  // create path. Five endpoints, all behind the existing PayerAuthGuard; the
  // `payer_id` is ALWAYS derived from the bearer server-side and is NEVER put in
  // a body here. Publish reuses `JobPostingsService.createForPayer`, which
  // already emits `job_posting.created` — this client adds no new writer.
  //
  // The payer's own company/org name is NEVER asked for in the chat and NEVER
  // sent anywhere from this seam: it is auto-filled server-side from
  // `payers.orgNameEnc` at publish time (ADR-0035 §Decision 3), which is why
  // [JobPostingDraft] has no `org_label` field at all.

  /// Open a chat session for the signed-in payer
  /// (`POST /payer/job-posting-chat/session`). Body-less — the server derives
  /// the payer from the bearer, and there is no org name to send (rule A).
  ///
  /// Returns the SAME engine-turn shape a message does (the frozen contract's
  /// own choice), so the opener carries `reply_text`, the chips, and any draft.
  Future<JobPostingChatTurn> startJobPostingChatSession();

  /// Send one payer turn and get the engine's next turn back
  /// (`POST /payer/job-posting-chat/message`, body EXACTLY `{session_id, text}`).
  /// The returned [JobPostingChatTurn] carries the reply, the updated draft, and
  /// the engine's own `draft_ready` decision (deterministic, server-side — the
  /// client never decides readiness).
  Future<JobPostingChatTurn> sendJobPostingChatMessage({
    required String sessionId,
    required String text,
  });

  /// This payer's chat sessions, newest-activity first
  /// (`GET /payer/job-posting-chat/sessions`) — the CROSS-DEVICE
  /// "continue where you left off" entry point. Ownership is by `payer_id` from
  /// the bearer, so a conversation started on the web shows up here.
  Future<List<JobPostingChatSessionSummary>> fetchJobPostingChatSessions();

  /// Hydrate a session
  /// (`GET /payer/job-posting-chat/sessions/:id/messages`) — the transcript
  /// oldest-first PLUS the current draft, the engine's readiness decision and
  /// the live chips, which is what lets a resumed chat show the draft without
  /// sending another message.
  ///
  /// A neutral 404 (unknown OR not-owned — the no-oracle IDOR defence) returns
  /// `null`, never an exception, so a stale session id can never crash the
  /// screen or act as an existence oracle.
  Future<JobPostingChatTranscript?> fetchJobPostingChatTranscript(
    String sessionId,
  );

  /// Publish the session's draft as a real posting
  /// (`POST /payer/job-posting-chat/sessions/:id/publish`, EMPTY body — the
  /// draft already lives server-side and the org name is auto-filled there).
  /// The server validates the stored draft against the SAME
  /// `PayerCreateJobPostingSchema` the manual form uses and calls the SAME
  /// `createForPayer`. Returns a [PublishJobResult] carrying the created
  /// posting's id plus any `unmapped_fields` the draft could not fold onto the
  /// structured posting. A 400 (draft still incomplete) / 409 (already
  /// published) surfaces as [PayerApiException].
  Future<PublishJobResult> publishJobPostingChatSession(String sessionId);

  /// The unlock ledger (most-recent first).
  Future<List<LedgerEntry>> fetchLedger();

  // --- Credits — balance + ledger (READ-ONLY; no purchase surface) ----------
  // The mobile app deliberately has NO credit-purchase method: selling a digital
  // entitlement from inside a store-distributed app is exactly what App Store /
  // Play Store IAP policy covers, and the mobile-payments rule bars it outright.
  // Credit packs are bought on the payer WEB portal; the app only READS the
  // balance and spend and points the payer to the web for the purchase.

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

  /// The agency's referred workers (`GET /payer/agency/workers`, AGENT-only →
  /// `{workers:[...]}`). Faceless funnel rows (opaque ref + coarse counts). A
  /// company session's 403 — and a 429 rate cap — surface as [PayerApiException]
  /// so the UI can show the agent-only / try-again state.
  Future<List<AgencyWorker>> fetchReferredWorkers();

  /// Mint a BATCH of agency invites
  /// (`POST /payer/agency/invites/batch`, AGENT-only → `{invites:[...]}`). Sends
  /// [count] (+ optional non-PII [campaign] tag) and returns the minted
  /// [MintedInvite]s. A 403 (company session) / 429 (mint cap) surface as
  /// [PayerApiException].
  Future<List<MintedInvite>> createInviteBatch({
    required int count,
    String? campaign,
  });

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
