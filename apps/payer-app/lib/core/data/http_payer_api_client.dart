import '../auth/payer_http.dart';
import 'candidate_search_models.dart';
import 'job_posting_chat_models.dart';
import 'models.dart';
import 'payer_api_client.dart';

/// What a refused job write says (see `_jobWriteRejection`): a typed [code],
/// the first issue as a labelled sentence, and every issue by its field.
typedef _JobWriteRejection = ({
  String? code,
  String? validationMessage,
  Map<String, String> fieldErrors,
});

/// REAL HTTP-backed [PayerApiClient]. EVERY method here talks to a live
/// `/payer/*` route — this class holds no canned data and composes no mock.
///
/// It used to compose a [MockPayerApiClient] and delegate ~10 methods to it with
/// no `kUseMocks` gate, which meant a genuine release build served invented
/// figures (home metrics, recent activity, payouts, KYC, referred workers,
/// credit packs) through the "real" client. Those surfaces had no backend route,
/// so they were REMOVED from the app rather than faked; the two remaining
/// MOCK-only demo methods ([fetchCandidates] / [unlockCandidate]) now throw
/// [UnsupportedError] here instead of silently returning seed data.
///
/// SECURITY: never sends a body `payer_id` (the server derives it from the bearer
/// via [PayerHttp]); never logs a token.
class HttpPayerApiClient implements PayerApiClient {
  HttpPayerApiClient(this._http);

  final PayerHttp _http;

  // ---------------------------------------------------------------------------
  // BOUND — real endpoints
  // ---------------------------------------------------------------------------

  @override
  Future<int> fetchCredits() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/credits');
    // A non-2xx must NOT decode to a fabricated 0 balance rendered as a real
    // "0 credits" — surface the failure so the UI shows an honest error/retry.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return (res.body['balance'] as num?)?.toInt() ?? 0;
  }

  @override
  Future<List<LedgerEntry>> fetchLedger() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/unlocks');
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
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? shift,
    String? neededBy,
    String? roleKind,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
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
      // Match V1 (additive) — only sent when supplied.
      if (matchSkillIds != null) 'match_skill_ids': matchSkillIds,
      if (untickedRelatedIds != null)
        'unticked_related_ids': untickedRelatedIds,
      // The worker-visible content half (#1653 made the create accept all of
      // it). Blank/empty values are OMITTED: `area` is `min(1)` so a blank
      // would 400, and an empty chip list on a CREATE says nothing the absent
      // key does not (there is nothing stored to clear).
      if (city != null) 'city': city,
      if (area != null && area.isNotEmpty) 'area': area,
      if (payMin != null) 'pay_min': payMin,
      if (payMax != null) 'pay_max': payMax,
      if (payType != null) 'pay_type': payType,
      if (minExperienceYears != null)
        'min_experience_years': minExperienceYears,
      if (maxExperienceYears != null)
        'max_experience_years': maxExperienceYears,
      if (shift != null) 'shift': shift,
      if (neededBy != null) 'needed_by': neededBy,
      // Migration 0131 — the display role that picks the worker card's art.
      if (roleKind != null) 'role_kind': roleKind,
      if (benefits != null && benefits.isNotEmpty) 'benefits': benefits,
      if (requirements != null && requirements.isNotEmpty)
        'requirements': requirements,
      if (roleKind != null && roleKind.isNotEmpty) 'role_kind': roleKind,
      if (tradeLevel != null && tradeLevel.isNotEmpty)
        'trade_level': tradeLevel,
      if (tradeAnswers != null) 'trade_answers': tradeAnswers,
    };
    final PayerResponse res =
        await _http.send(PayerMethod.post, '/payer/job-postings', body: body);
    // #2595 — a refused create names its fields the way an edit's 400 does, so
    // the Post form can show each reason AT its box.
    if (!res.isSuccess) throw _jobWriteFailure(res);
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
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? shift,
    String? neededBy,
    String? roleKind,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<JobPostingClearField>? clear,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{
      if (orgLabel != null) 'org_label': orgLabel,
      if (roleTitle != null) 'role_title': roleTitle,
      if (locationLabel != null) 'location_label': locationLabel,
      if (description != null) 'description': description,
      if (vacancyBand != null) 'vacancy_band': vacancyBand,
      if (vacancies != null) 'vacancies': vacancies,
      if (status != null) 'status': status,
      // Match V1 (additive) — only sent when supplied.
      if (matchSkillIds != null) 'match_skill_ids': matchSkillIds,
      if (untickedRelatedIds != null)
        'unticked_related_ids': untickedRelatedIds,
      if (city != null) 'city': city,
      if (area != null) 'area': area,
      if (payMin != null) 'pay_min': payMin,
      if (payMax != null) 'pay_max': payMax,
      if (payType != null) 'pay_type': payType,
      if (minExperienceYears != null)
        'min_experience_years': minExperienceYears,
      if (maxExperienceYears != null)
        'max_experience_years': maxExperienceYears,
      if (shift != null) 'shift': shift,
      if (neededBy != null) 'needed_by': neededBy,
      if (roleKind != null) 'role_kind': roleKind,
      // LIST SEMANTICS (deliberate asymmetry with the create): a list the caller
      // PASSES rides the PATCH even when EMPTY, because `[]` is how the chips
      // get CLEARED server-side; only a null list is omitted.
      if (benefits != null) 'benefits': benefits,
      if (requirements != null) 'requirements': requirements,
      if (roleKind != null) 'role_kind': roleKind,
      if (tradeLevel != null) 'trade_level': tradeLevel,
      if (tradeAnswers != null) 'trade_answers': tradeAnswers,
    };
    // #1652 — the fields to UNSET, after the values so a contradiction is caught.
    _addClear(body, clear?.map((JobPostingClearField f) => f.wire));
    if (body.isEmpty) {
      throw ArgumentError('updateJob needs at least one field');
    }
    final PayerResponse res = await _http
        .send(PayerMethod.patch, '/payer/job-postings/$id', body: body);
    // 400 no-op / 409 closed or illegal transition surface as a typed error.
    if (!res.isSuccess) throw _jobWriteFailure(res);
    return _jobFromRow(res.body);
  }

  /// #1652 — fold a `clear` list ([names], the fields' wire names) into a job
  /// edit PATCH [body].
  ///
  /// Added only when non-empty: the route's `clear` is `.min(1)`, so an empty
  /// list would 400 for asking nothing. FAILS CLOSED on a name the body also
  /// SETS — the server rejects that contradiction with a 400, so it is refused
  /// here with the same typed code instead of spending a round-trip on a request
  /// that cannot succeed.
  static void _addClear(Map<String, dynamic> body, Iterable<String>? names) {
    if (names == null) return;
    final List<String> clear = names.toSet().toList(growable: false);
    if (clear.isEmpty) return;
    if (clear.any(body.containsKey)) {
      throw const PayerApiException(400, code: kJobEditSetAndClearedCode);
    }
    body['clear'] = clear;
  }

  /// The typed failure of a job WRITE — a create or an edit, on either
  /// contract — from its non-2xx response ([_jobWriteRejection] reads a 400).
  static PayerApiException _jobWriteFailure(PayerResponse res) {
    final _JobWriteRejection rejection = _jobWriteRejection(res);
    return PayerApiException(
      res.statusCode,
      code: rejection.code,
      validationMessage: rejection.validationMessage,
      fieldErrors: rejection.fieldErrors,
    );
  }

  /// The typed code + field-level messages for a failed job write.
  ///
  /// [kJobEditSetAndClearedCode] when the 400 is the server's `clear` rejection
  /// — a validation issue on the `clear` path, inside the global
  /// `{ error: { issues: [{ path, message }] } }` envelope. The server sends no
  /// code for it, and the path is the only structural signal; the app's typed
  /// [JobPostingClearField]/[AgencyJobClearField] names, the non-empty rule and
  /// the pre-send check in [_addClear] leave "set and cleared" as the only
  /// `clear` refusal it can meet.
  ///
  /// The two other 400s a job edit can legitimately return are stamped too, so a
  /// caller never has to guess from the bare status:
  ///  - [kJobEditNoChangesCode] — `no effective changes to apply` (the save was a
  ///    no-op; the old client-reported "already closed" was wrong),
  ///  - [kJobEditClosedCode] — `Job is closed and cannot be edited` (terminal).
  ///
  /// #2635 — [kPostingTradeRequiredCode] is the one refusal the server NAMES:
  /// its `error.reason` is read, never its message. It is pinned to `role_kind`
  /// with [kPostingTradeRequiredMessage], so a form shows it at its trade
  /// picker and any other caller says the app's words, not the server's.
  ///
  /// EVERY OTHER validation 400 carries its first issue as a human-readable
  /// [PayerApiException.validationMessage] naming the field, so the edit screen
  /// can say WHICH box is wrong instead of "check the details" — and (#2595)
  /// all of its issues as [PayerApiException.fieldErrors], so a form can show
  /// each AT its box. A CREATE's 400 is only ever that last kind: the four
  /// codes above are edit-only refusals.
  static _JobWriteRejection _jobWriteRejection(PayerResponse res) {
    const Map<String, String> noFields = <String, String>{};
    if (res.statusCode != 400) {
      return (code: null, validationMessage: null, fieldErrors: noFields);
    }
    final Object? error = res.body['error'];
    final Object? reason = error is Map ? error['reason'] : res.body['reason'];
    if (reason == kPostingTradeRequiredCode) {
      return (
        code: kPostingTradeRequiredCode,
        validationMessage: kPostingTradeRequiredMessage,
        fieldErrors: const <String, String>{
          'role_kind': kPostingTradeRequiredMessage,
        },
      );
    }
    final Object? issues = error is Map ? error['issues'] : null;
    if (issues is List) {
      for (final Object? issue in issues) {
        if (issue is Map && issue['path'] == 'clear') {
          return (
            code: kJobEditSetAndClearedCode,
            validationMessage: null,
            fieldErrors: noFields,
          );
        }
      }
      final String? fieldMessage = _firstValidationMessage(issues);
      if (fieldMessage != null) {
        return (
          code: null,
          validationMessage: fieldMessage,
          fieldErrors: _fieldErrors(issues),
        );
      }
    }
    final Object? message =
        error is Map ? error['message'] : res.body['message'];
    if (message is String) {
      if (message == 'no effective changes to apply') {
        return (
          code: kJobEditNoChangesCode,
          validationMessage: null,
          fieldErrors: noFields,
        );
      }
      if (message == 'Job is closed and cannot be edited') {
        return (
          code: kJobEditClosedCode,
          validationMessage: null,
          fieldErrors: noFields,
        );
      }
      final String? fromMessage = _messageToFieldText(message);
      if (fromMessage != null) {
        return (
          code: null,
          validationMessage: fromMessage,
          fieldErrors: noFields,
        );
      }
    }
    return (code: null, validationMessage: null, fieldErrors: noFields);
  }

  /// A service-thrown 400 (cross-field order, skill cap, skill vocabulary, …) has
  /// no `issues` list — only a message. Name its field when the message starts
  /// with one, and otherwise show the sentence itself. Null for the two shapes we
  /// already handle above and for the bare validation envelope.
  static String? _messageToFieldText(String message) {
    final String text = message.trim();
    if (text.isEmpty || text == 'Validation failed' || text == 'Bad Request') {
      return null;
    }
    final String lower = text.toLowerCase();
    for (final MapEntry<String, String> field in _fieldLabels.entries) {
      if (lower.startsWith('${field.key} ')) {
        final String rest = text.substring(field.key.length + 1).trim();
        if (rest.isEmpty) continue;
        return '${field.value}: ${_sentence(rest)}';
      }
    }
    return _sentence(text);
  }

  /// Upper-case the first letter and close the sentence, without touching an
  /// already-finished one.
  static String _sentence(String text) {
    final String trimmed = text.trim();
    if (trimmed.isEmpty) return trimmed;
    final String capitalised = trimmed[0].toUpperCase() + trimmed.substring(1);
    return capitalised.endsWith('.') ? capitalised : '$capitalised.';
  }

  /// The friendly label for each editable job wire field, so a server issue on
  /// `pay_max` reads as `Maximum pay: ...` rather than a bare field name.
  static const Map<String, String> _fieldLabels = <String, String>{
    'trade_key': 'Trade',
    'title': 'Job title',
    'city': 'City',
    'area': 'Area',
    'pay_min': 'Minimum pay',
    'pay_max': 'Maximum pay',
    'min_experience_years': 'Minimum experience',
    'max_experience_years': 'Maximum experience',
    'needed_by': 'Needed by',
    'pay_type': 'Pay type',
    'role_kind': 'Role',
    'description': 'Description',
    'shift': 'Shift',
    'benefits': 'Benefits',
    'requirements': 'Requirements',
    'match_skill_ids': 'Skills',
  };

  /// Turn the server's first validation issue into a field-named sentence. The
  /// server NEVER echoes the value, only the field and a safe reason, so this is
  /// safe to render. Returns null when there is no usable issue.
  static String? _firstValidationMessage(List<dynamic> issues) {
    for (final Object? issue in issues) {
      if (issue is! Map) continue;
      final Object? rawMessage = issue['message'];
      if (rawMessage is! String) continue;
      final Object? rawPath = issue['path'];
      final String path = rawPath is String ? rawPath : '';
      final String? text =
          _issueReason(rawMessage, subject: path.split('.').last);
      if (text == null) continue;
      final String? label = _fieldLabels[path];
      return label == null ? text : '$label: $text.';
    }
    return null;
  }

  /// #2595 — EVERY validation issue, keyed by the wire field at the head of its
  /// path (`benefits.2` → `benefits`), the first per field winning — the same
  /// routing payer-web's `mapPostingIssues` does. Each reason is phrased to sit
  /// AT its field: no label, and the field's own leading name dropped
  /// ("description must not contain links" → "Must not contain links.").
  static Map<String, String> _fieldErrors(List<dynamic> issues) {
    final Map<String, String> errors = <String, String>{};
    for (final Object? issue in issues) {
      if (issue is! Map) continue;
      final Object? rawMessage = issue['message'];
      final Object? rawPath = issue['path'];
      if (rawMessage is! String || rawPath is! String) continue;
      final String field = rawPath.split('.').first;
      if (field.isEmpty || errors.containsKey(field)) continue;
      final String? reason = _issueReason(rawMessage, subject: field);
      if (reason != null) errors[field] = _sentence(reason);
    }
    return errors;
  }

  /// One validation issue's reason, readable — or null when nothing is left.
  /// The server's field-screen messages open with the field's own [subject]
  /// ("title must not contain a company name"); that is dropped so a label is
  /// not doubled. Zod's ceilings get a plain phrase instead of raw Zod. The
  /// first letter is capitalised; no stop is added.
  static String? _issueReason(String rawMessage, {required String subject}) {
    String text = rawMessage.trim();
    if (subject.isNotEmpty && text.toLowerCase().startsWith('$subject ')) {
      text = text.substring(subject.length + 1).trim();
    }
    if (text.startsWith(_zodNumberMax)) {
      text = 'must be ${text.substring(_zodNumberMax.length).trim()} or less';
    } else if (text.startsWith(_zodNumberMin)) {
      text = 'must be ${text.substring(_zodNumberMin.length).trim()} or more';
    } else if (_zodTextMax.firstMatch(text) case final RegExpMatch cap) {
      // The text boxes carry no length cap of their own, so this one is real.
      text = 'must be ${cap.group(1)} characters or fewer';
    }
    if (text.isEmpty) return null;
    return text[0].toUpperCase() + text.substring(1);
  }

  static const String _zodNumberMax = 'Too big: expected number to be <=';
  static const String _zodNumberMin = 'Too small: expected number to be >=';

  /// Zod's text length ceiling: "Too big: expected string to have <=200
  /// characters".
  static final RegExp _zodTextMax =
      RegExp(r'^Too big: expected string to have <=(\d+) characters$');

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

  // --- Match V1 — demand skill picker + reach preview ------------------------

  @override
  Future<List<MatchSkill>> fetchMatchSkills() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/match/skills');
    // A non-2xx must not decode to a fabricated empty picker shown as ready.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['skills'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(MatchSkill.fromJson)
        .toList(growable: false);
  }

  @override
  Future<List<PostingTradeForm>> fetchPostingTrades() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/posting-trades');
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows = res.body['trades'] is List<dynamic>
        ? res.body['trades'] as List<dynamic>
        : const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(PostingTradeForm.fromJson)
        .toList(growable: false);
  }

  @override
  Future<ReachPreview> reachPreview({
    required List<String> matchSkillIds,
    List<String> untickedRelatedIds = const <String>[],
    String? roleKind,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/match/reach-preview',
      body: <String, dynamic>{
        'match_skill_ids': matchSkillIds,
        'unticked_related_ids': untickedRelatedIds,
        // #2635 — the job's trade, so the preview scopes the posted ids to it
        // exactly as publish will. Optional and additive: omitted when unset.
        if (roleKind != null && roleKind.isNotEmpty) 'role_kind': roleKind,
      },
    );
    // A non-2xx must not decode to a fabricated zero-reach preview shown as real.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return ReachPreview.fromJson(res.body);
  }

  // --- AI job-posting chat (ADR-0035) ----------------------------------------
  // Five routes behind PayerAuthGuard. NEVER a body `payer_id` (the server
  // derives it from the bearer) and NEVER an org/company name on the wire — the
  // draft has no such field by construction (see [JobPostingDraft]).

  @override
  Future<JobPostingChatTurn> startJobPostingChatSession() async {
    // EMPTY body — no payer id (XB-A) and no org name (rule A) to send.
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-posting-chat/session',
      body: <String, dynamic>{},
    );
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final JobPostingChatTurn turn = JobPostingChatTurn.fromJson(res.body);
    // A 2xx with no session id is CONTRACT BREAKAGE, not an open session: every
    // later call keys off this id, and an empty one would send the payer into a
    // chat whose every turn 404s. Fail here instead (mirrors the #370 rule that
    // a malformed 2xx must not decode to a confident-looking empty value).
    if (turn.sessionId.isEmpty) throw PayerApiException(res.statusCode);
    return turn;
  }

  @override
  Future<JobPostingChatTurn> sendJobPostingChatMessage({
    required String sessionId,
    required String text,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-posting-chat/message',
      // EXACTLY {session_id, text} — the frozen contract.
      body: <String, dynamic>{'session_id': sessionId, 'text': text},
    );
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return JobPostingChatTurn.fromJson(res.body);
  }

  @override
  Future<List<JobPostingChatSessionSummary>>
      fetchJobPostingChatSessions() async {
    final PayerResponse res = await _http.send(
      PayerMethod.get,
      '/payer/job-posting-chat/sessions',
    );
    // A non-2xx must NOT decode to an empty list rendered as "no chat in
    // progress" — that is exactly the cross-device promise this endpoint makes,
    // so a 5xx here has to surface as an error, never as "you have nothing".
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<JobPostingChatSessionSummary> rows = _rows(res.body, 'sessions')
        .map(JobPostingChatSessionSummary.fromJson)
        .where((JobPostingChatSessionSummary s) => s.id.isNotEmpty)
        .toList();
    // Newest activity first — the same ordering the web client applies, so both
    // devices offer the same conversation back.
    rows.sort(
        (JobPostingChatSessionSummary a, JobPostingChatSessionSummary b) =>
            b.activityKey.compareTo(a.activityKey));
    return List<JobPostingChatSessionSummary>.unmodifiable(rows);
  }

  @override
  Future<JobPostingChatTranscript?> fetchJobPostingChatTranscript(
    String sessionId,
  ) async {
    final PayerResponse res = await _http.send(
      PayerMethod.get,
      '/payer/job-posting-chat/sessions/$sessionId/messages',
    );
    // Neutral 404 (unknown OR not-owned — the no-oracle IDOR defence the worker
    // transcript route already uses) → null, never an exception and never a
    // distinguishable error the caller could probe with.
    if (res.statusCode == 404) return null;
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return JobPostingChatTranscript.fromJson(res.body);
  }

  @override
  Future<PublishJobResult> publishJobPostingChatSession(
    String sessionId, {
    String? roleKind,
    String? area,
  }) async {
    // The draft already lives server-side on the session row, the payer IS the
    // session (XB-A), and the org name is auto-filled there. The only body keys
    // are the optional publish-step picks (#2490 role, #2493 area) — omitted
    // when unpicked.
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-posting-chat/sessions/$sessionId/publish',
      body: <String, dynamic>{
        if (roleKind != null && roleKind.isNotEmpty) 'role_kind': roleKind,
        if (area != null && area.isNotEmpty) 'area': area,
      },
    );
    // 400 draft incomplete · 409 already published / not ready · 404 unknown.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final Object? id = res.body['job_posting_id'] ?? res.body['jobPostingId'];
    // A 2xx without the created id is contract breakage — do NOT report a
    // success the caller cannot route to.
    if (id is! String || id.isEmpty) throw PayerApiException(res.statusCode);
    // Fields the server could not fold onto the structured posting (additive,
    // default []). Accepts snake_case + camelCase; ignores non-string entries.
    final List<String> unmapped = ((res.body['unmapped_fields'] ??
                res.body['unmappedFields']) as List<dynamic>? ??
            const <dynamic>[])
        .whereType<String>()
        .toList(growable: false);
    // #1727 — the worker-card columns the created posting holds NULL. Parsed on
    // the same tolerant terms: a key this build does not know about must never
    // throw here, because the posting has ALREADY been created server-side.
    final List<String> unsetCard = ((res.body['unset_card_fields'] ??
                res.body['unsetCardFields']) as List<dynamic>? ??
            const <dynamic>[])
        .whereType<String>()
        .toList(growable: false);
    return PublishJobResult(
      jobPostingId: id,
      unmappedFields: unmapped,
      unsetCardFields: unsetCard,
    );
  }

  /// Rows from `{<key>: [...]}`, falling back to the `items` envelope
  /// [PayerHttp] wraps a bare top-level array in (both list conventions ship
  /// in-repo, so both are accepted).
  static List<Map<String, dynamic>> _rows(
    Map<String, dynamic> body,
    String key,
  ) {
    final Object? raw = body[key] ?? body['items'];
    if (raw is! List<dynamic>) return const <Map<String, dynamic>>[];
    return raw.whereType<Map<String, dynamic>>().toList(growable: false);
  }

  // --- Credits — balance + ledger (read-only; no purchase surface) -----------

  @override
  Future<int> fetchCreditBalance() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/credits');
    // A non-2xx must not decode to a fabricated 0 balance shown as success.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    // #370 — nor may a 2xx with the WRONG BODY. PayerHttp._decode turns any
    // unparseable/non-object body into `{}`, so captive-portal HTML, a proxy
    // interception or contract drift all sailed past the guard above and then
    // `?? 0` minted a confident "0 credits" — telling the payer their balance was
    // wiped. A missing/non-numeric `balance` is a CONTRACT ERROR, not a zero:
    // throw so CreditsCubit keeps the last-known value and shows '—' + error.
    final Object? balance = res.body['balance'];
    if (balance is! num) throw PayerApiException(res.statusCode);
    return balance.toInt();
  }

  @override
  Future<List<LedgerEntry>> fetchCreditLedger({int limit = 20}) async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/credits/ledger?limit=$limit');
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

  // --- All-candidates search (ADR-0040 E2) -----------------------------------

  @override
  Future<CandidateSearchPage> searchCandidates(
    CandidateSearchQuery query,
  ) async {
    // POST, though it writes nothing (the filter set is a list — the
    // reach-preview precedent). PayerHttp never auto-retries a POST, so each
    // call is exactly one unit of the payer's hourly search cap.
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/candidates/search',
      body: query.toJson(),
    );
    // 429 = the hourly cap, 400 = a refused body or cursor, 5xx = an outage.
    // The status rides the exception so the screen can say which — none may
    // decode to an empty page, which would read as "nobody on the portal".
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final CandidateSearchPage? page = CandidateSearchPage.tryFromJson(res.body);
    // #370 — a 2xx that is not the contract (captive-portal HTML decodes to
    // `{}`) is an error, never a zero-candidate pool.
    if (page == null) throw PayerApiException(res.statusCode);
    return page;
  }

  @override
  Future<CandidateFilters> fetchCandidateFilters() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/candidates/filters');
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final CandidateFilters? filters = CandidateFilters.tryFromJson(res.body);
    if (filters == null) throw PayerApiException(res.statusCode);
    return filters;
  }

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/unlocks');
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final Object? rows = res.body['unlocks'];
    // Same #370 rule: a 2xx without the list is a contract error, not "you
    // have unlocked nobody".
    if (rows is! List<dynamic>) throw PayerApiException(res.statusCode);
    return rows
        .map(PayerUnlock.tryFromJson)
        .whereType<PayerUnlock>()
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
    // #346 — a transport/server failure is NOT a neutral deny. Without this
    // guard a 500/503/429 (whose Nest error envelope carries no `unlock_id`)
    // fell through to UnlockResult.unavailable() and the payer was told the
    // candidate "is not available to unlock right now" — permanent-sounding, so
    // they move on — when the API was simply down or they hit the rate cap.
    // Same rule disclose() already states: a non-2xx must NOT decode to the
    // neutral-deny copy.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
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
    // #346 — worse here than on unlock: the payer has ALREADY SPENT the credit.
    // A 5xx on reveal used to render the neutral "unavailable" deny, so they were
    // told the contact does not exist instead of being offered a retry for
    // something they paid for. A non-2xx is an outage, not a deny.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
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
    // The backend's NEUTRAL deny is HTTP 200 {status:'unavailable'} — so any
    // non-2xx here is genuinely transport/server failure and must NOT decode to
    // the neutral-deny copy (mirrors the listDisclosures guard below).
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
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
  Future<List<PayerDisclosure>> listDisclosures() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/resume-disclosures');
    // A non-2xx (401/5xx) must NOT decode to an empty list shown as "no
    // disclosures" — surface it so the caller shows the real error state.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['disclosures'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(PayerDisclosure.fromJson)
        .toList();
  }

  @override
  Future<void> recordInviteClick(String code) async {
    // AGENT-only, no body; the server returns 200 {ok:true} ALWAYS (neutral
    // no-op on an unknown code — no oracle). This is a best-effort funnel
    // signal: we do not gate on the status, and the caller fires-and-forgets so
    // a transport failure never blocks the share action.
    await _http.send(PayerMethod.post, '/payer/agency/invites/$code/click');
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
    // A non-2xx (e.g. the fail-closed per-payer invite-mint 429, or a 5xx) must
    // NOT decode to an empty ReferralLink('', '') shown as success. Throwing here
    // both surfaces the real error to ReferralCubit AND prevents the empty link
    // from being written into the process-level _sessionLink cache (the assign
    // never completes), so a later open retries the mint instead of re-serving a
    // broken code/QR for the rest of the session.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final String code = res.body['code'] as String? ?? '';
    final String link = res.body['link'] as String? ?? '';
    return ReferralLink(code: code, url: link);
  }

  @override
  Future<List<AgencyWorker>> fetchReferredWorkers() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/agency/workers');
    // A 403 (company session — agent-only route) and a 429 (rate cap) must
    // surface as a typed error so the UI can show agent-only / try-again, NOT a
    // fabricated empty funnel. Any other non-2xx surfaces too.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['workers'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(AgencyWorker.fromJson)
        .toList(growable: false);
  }

  @override
  Future<List<MintedInvite>> createInviteBatch({
    required int count,
    String? campaign,
  }) async {
    // Faceless: count + an optional non-PII campaign tag only. NEVER a body
    // payer_id (the server derives the agency from the bearer).
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/agency/invites/batch',
      body: <String, dynamic>{
        'count': count,
        if (campaign != null) 'campaign': campaign,
      },
    );
    // 403 company session · 429 mint cap · 5xx → typed error (never an empty
    // batch shown as success).
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    final List<dynamic> rows =
        (res.body['invites'] as List<dynamic>?) ?? const <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(MintedInvite.fromJson)
        .toList(growable: false);
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
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
    String? roleKind,
    String? description,
    String? shift,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<String>? matchSkillIds,
  }) async {
    // snake_case body — trade_key/pay_min/etc. NEVER a body payer_id (the server
    // derives the tenant from the bearer).
    //
    // The worker-visible content keys (description/shift/benefits/requirements)
    // are omitted when blank/empty: the server's `description` is `min(1)`, so a
    // blank string would be a 400, and an empty list on a CREATE carries no
    // information the absent key does not (there is nothing stored to clear).
    final Map<String, dynamic> body = <String, dynamic>{
      'trade_key': tradeKey,
      'title': title,
      'city': city,
      if (area != null && area.isNotEmpty) 'area': area,
      if (payMin != null) 'pay_min': payMin,
      if (payMax != null) 'pay_max': payMax,
      // #1648 — what the band MEANS. Never defaulted: omitted stores NULL.
      if (payType != null) 'pay_type': payType,
      if (minExperienceYears != null)
        'min_experience_years': minExperienceYears,
      if (maxExperienceYears != null)
        'max_experience_years': maxExperienceYears,
      if (neededBy != null) 'needed_by': neededBy,
      if (roleKind != null) 'role_kind': roleKind,
      if (description != null && description.trim().isNotEmpty)
        'description': description.trim(),
      if (shift != null) 'shift': shift,
      if (benefits != null && benefits.isNotEmpty) 'benefits': benefits,
      if (requirements != null && requirements.isNotEmpty)
        'requirements': requirements,
      if (roleKind != null && roleKind.isNotEmpty) 'role_kind': roleKind,
      // Migration 0141 — the trade-specific form. Empty answers still carry the
      // role's base match skill, so an empty map is sent when the form used it.
      if (tradeLevel != null && tradeLevel.isNotEmpty)
        'trade_level': tradeLevel,
      if (tradeAnswers != null) 'trade_answers': tradeAnswers,
      // ADR-0050 - demand skills. On CREATE an empty pick carries no information
      // the absent key does not (there is nothing stored to clear), so it is
      // omitted. The route strips it until the API field lands (#1960/#1957).
      if (matchSkillIds != null && matchSkillIds.isNotEmpty)
        'match_skill_ids': matchSkillIds,
    };
    final PayerResponse res =
        await _http.send(PayerMethod.post, '/payer/agency/jobs', body: body);
    // #2595 — field-named, like the company create.
    if (!res.isSuccess) throw _jobWriteFailure(res);
    return AgencyJobView.fromJson(res.body);
  }

  @override
  Future<JobDescriptionDraft> draftJobDescription({
    required String spokenText,
    String? tradeLabel,
    String? roleLabel,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{
      'spoken_text': spokenText,
      // `.optional()` on the route, not `.nullable()`: omit, never send null.
      if (tradeLabel != null && tradeLabel.isNotEmpty) 'trade_label': tradeLabel,
      if (roleLabel != null && roleLabel.isNotEmpty) 'role_label': roleLabel,
    };
    final PayerResponse res = await _http.send(
      PayerMethod.post,
      '/payer/job-postings/description/draft',
      body: body,
    );
    if (!res.isSuccess) throw _jobWriteFailure(res);
    return JobDescriptionDraft.fromJson(res.body);
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
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
    String? roleKind,
    String? description,
    String? shift,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<String>? matchSkillIds,
    List<AgencyJobClearField>? clear,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{
      if (tradeKey != null) 'trade_key': tradeKey,
      if (title != null) 'title': title,
      if (city != null) 'city': city,
      if (area != null) 'area': area,
      if (payMin != null) 'pay_min': payMin,
      if (payMax != null) 'pay_max': payMax,
      if (payType != null) 'pay_type': payType,
      if (minExperienceYears != null)
        'min_experience_years': minExperienceYears,
      if (maxExperienceYears != null)
        'max_experience_years': maxExperienceYears,
      if (neededBy != null) 'needed_by': neededBy,
      if (roleKind != null) 'role_kind': roleKind,
      if (description != null && description.trim().isNotEmpty)
        'description': description.trim(),
      if (shift != null) 'shift': shift,
      // LIST SEMANTICS (deliberate asymmetry with the create): a list the caller
      // PASSES is sent even when EMPTY, because `[]` is how the chips get
      // CLEARED server-side; only a null list is omitted.
      if (benefits != null) 'benefits': benefits,
      if (requirements != null) 'requirements': requirements,
      if (roleKind != null) 'role_kind': roleKind,
      if (tradeLevel != null) 'trade_level': tradeLevel,
      if (tradeAnswers != null) 'trade_answers': tradeAnswers,
      // ADR-0050 - same list semantics: a passed `match_skill_ids` (even `[]`)
      // is sent to clear; a null is omitted. Stripped by the route until the API
      // field lands (#1960/#1957).
      if (matchSkillIds != null) 'match_skill_ids': matchSkillIds,
    };
    // #1652 — the fields to UNSET, after the values so a contradiction is caught.
    _addClear(body, clear?.map((AgencyJobClearField f) => f.wire));
    if (body.isEmpty) {
      throw ArgumentError('updateAgencyJob needs at least one field');
    }
    final PayerResponse res = await _http
        .send(PayerMethod.patch, '/payer/agency/jobs/$id', body: body);
    if (!res.isSuccess) throw _jobWriteFailure(res);
    return AgencyJobView.fromJson(res.body);
  }

  @override
  Future<AgencyJobView> closeAgencyJob(String id) =>
      _agencyLifecycle(id, 'close');

  @override
  Future<AgencyJobView> pauseAgencyJob(String id) =>
      _agencyLifecycle(id, 'pause');

  @override
  Future<AgencyJobView> resumeAgencyJob(String id) =>
      _agencyLifecycle(id, 'resume');

  /// Shared close/pause/resume POST (`/payer/agency/jobs/:id/<action>`, #1202).
  /// pause → `paused`, resume → `open`, close → `closed`; each returns the
  /// updated [AgencyJobView]. A 404 (unknown/not-owned) / 400 (illegal
  /// transition) surfaces as [PayerApiException].
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
    // #2193 — and ONE 409 is told apart from the already-used/expired 409: the
    // membership-invariant refusal, where the account (not the link) is what
    // cannot accept. Matched on a distinctive phrase of the server's neutral
    // message, because it deliberately carries no reason code; a miss just
    // leaves the generic conflict line, which is still safe copy.
    if (!res.isSuccess) {
      throw PayerApiException(
        res.statusCode,
        code: _inviteRefusalCode(res),
      );
    }
    return OrgMemberView.fromJson(res.body);
  }

  /// [kOrgInviteNotAcceptableCode] when a 409 is the server's membership-invariant
  /// refusal (`This invite can't be accepted with this account`), else null.
  ///
  /// Normalised to letters and digits and matched on the phrase, so neither the
  /// contraction, an apostrophe nor a trailing full stop can silently drop the
  /// branch. No other refusal on this route reads anything like it.
  static String? _inviteRefusalCode(PayerResponse res) {
    if (res.statusCode != 409) return null;
    final Object? error = res.body['error'];
    final Object? message =
        error is Map ? error['message'] : res.body['message'];
    if (message is! String) return null;
    final String flat =
        message.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), ' ').trim();
    return flat.contains('accepted with this account')
        ? kOrgInviteNotAcceptableCode
        : null;
  }

  // --- Hiring capacity (ADR-0016) — allowance vs used (read-only) ------------

  @override
  Future<CapacityView> fetchCapacity() async {
    final PayerResponse res =
        await _http.send(PayerMethod.get, '/payer/capacity');
    // A non-2xx must not decode to a fabricated all-zero capacity shown as real.
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return CapacityView.fromJson(res.body);
  }

  // ---------------------------------------------------------------------------
  // MOCK-ONLY demo surfaces — unreachable on the real seam
  // ---------------------------------------------------------------------------
  // The rich global candidate list (and its int-keyed unlock) is a MOCK-only
  // shape: the REAL feed is the faceless per-job [fetchApplicants] + [unlock]
  // keyed by the opaque worker UUID. [FindCubit] only takes the mock branch when
  // `kUseMocks` is true (or a test injects the mock client), so these are never
  // reached in a real build. They FAIL LOUDLY rather than return seed data, so a
  // future caller cannot quietly resurrect fabricated candidates in production.

  // `async` (not an arrow `=> throw`) so the failure arrives as a REJECTED
  // FUTURE like every other method on this seam, rather than throwing
  // synchronously out of the call expression — a caller that stores the future
  // or chains .catchError would otherwise miss it.

  @override
  Future<List<Candidate>> fetchCandidates() async => throw UnsupportedError(
        'fetchCandidates is MOCK-only: the real feed is fetchApplicants(jobId).',
      );

  @override
  Future<int> unlockCandidate(int candidateId) async => throw UnsupportedError(
        'unlockCandidate(int) is MOCK-only: the real unlock is '
        'unlock(workerId:) with the opaque worker UUID from the feed.',
      );

  // ---------------------------------------------------------------------------
  // Row mappers
  // ---------------------------------------------------------------------------

  JobPosting _jobFromRow(Map<String, dynamic> row) {
    return JobPosting(
      id: row['id'] as String?,
      title: row['roleTitle'] as String? ?? row['role_title'] as String? ?? '',
      band:
          row['vacancyBand'] as String? ?? row['vacancy_band'] as String? ?? '',
      locationLabel:
          row['locationLabel'] as String? ?? row['location_label'] as String?,
      createdAt: row['createdAt'] as String? ?? row['created_at'] as String?,
      status: _jobStatusFromWire(row['status'] as String?),
      // The RAW lifecycle string drives the REAL My-jobs pill + legal actions
      // (the 3-value [JobStatus] enum can't distinguish draft/paused/closed).
      wireStatus: row['status'] as String?,
      // REAL, backend-sourced stats (`GET /payer/job-postings` now joins the
      // active plan + boost): the applicant-visibility quota (base + top-ups),
      // how many applicant views are used, and whether a boost is active. A
      // draft / plan-less posting carries null → 0 (honest "no plan yet"), never
      // a fabricated number.
      filled: (row['applicants_viewed_count'] as num?)?.toInt() ?? 0,
      quota: (row['applicant_visibility_quota'] as num?)?.toInt() ?? 0,
      boosted: row['boosted'] as bool? ?? false,
      // Ops trust review → the worker-visible "Verified job" badge
      // (`verified` = verification_status === 'verified').
      verified: row['verified'] as bool? ?? false,
      // Truthful per-posting engagement: résumés the payer downloaded for it.
      disclosuresCount: (row['disclosures_count'] as num?)?.toInt() ?? 0,
      // The worker-visible display half of the row (`JobPostingApi` returns all
      // of these on the payer list/get/patch). Parsed so the edit form prefills
      // what is REALLY stored, and so the post flow can tell which keys the
      // create route persisted vs silently stripped. Absent key → null, never a
      // fabricated value.
      description: row['description'] as String?,
      city: row['city'] as String?,
      area: row['area'] as String?,
      payMin:
          (row['pay_min'] as num?)?.toInt() ?? (row['payMin'] as num?)?.toInt(),
      payMax:
          (row['pay_max'] as num?)?.toInt() ?? (row['payMax'] as num?)?.toInt(),
      payType: row['pay_type'] as String? ?? row['payType'] as String?,
      minExperienceYears: (row['min_experience_years'] as num?)?.toInt() ??
          (row['minExperienceYears'] as num?)?.toInt(),
      maxExperienceYears: (row['max_experience_years'] as num?)?.toInt() ??
          (row['maxExperienceYears'] as num?)?.toInt(),
      // jsonb with NO default: the server preserves NULL rather than flattening
      // it to `[]`, so we keep the two apart too — "nothing stated" is not "an
      // empty list", and the edit form needs the difference.
      benefits: _optionalStringList(row['benefits']),
      requirements: _optionalStringList(row['requirements']),
      shift: row['shift'] as String?,
      neededBy: row['needed_by'] as String? ?? row['neededBy'] as String?,
      roleKind: row['role_kind'] as String? ?? row['roleKind'] as String?,
      matchSkillIds: _stringList(row['match_skill_ids']),
      tradeLevel: row['trade_level'] as String? ?? row['tradeLevel'] as String?,
      tradeAnswers: _optionalStringMapList(
        row['trade_answers'] ?? row['tradeAnswers'],
      ),
      // Still NO per-posting source (applications + unlocks attach to `jobs`, not
      // `job_postings`) — kept at the model defaults rather than faked.
      applicants: 0,
      unlocks: 0,
    );
  }

  /// Wire status `draft|open|closed` → the app's [JobStatus]. The model has no
  /// `draft` member; map draft → review (its "not live yet" slot).
  JobStatus _jobStatusFromWire(String? wire) => switch (wire) {
        'open' => JobStatus.live,
        'closed' => JobStatus.filled,
        _ => JobStatus.review,
      };

  /// One faceless applicant row → [Applicant]. NO name/phone/skill field exists
  /// on the wire by construction; only an opaque id + coarse facets.
  ///
  /// The route serves TWO SHAPES behind `MATCH_V1_ENABLED` (#1823/#1913), and
  /// the mapper branches on shape so flipping the flag — and rolling it back —
  /// is invisible here (parity with payer-web's `toMatchCandidate` /
  /// `toWeightedApplicant`):
  ///
  ///  - a COMPANY POSTING row (Matching V1): camelCase keys + an
  ///    `applicationId`. It carries NO `score`, `hot`, `pushEligible` or
  ///    `components` — V1 has no weights and no model output; the order is the
  ///    server's frozen rank key. [Applicant.score]/[Applicant.hot] are
  ///    therefore STRUCTURAL placeholders (0/false), never a meaningful number,
  ///    and no signal list is invented from nothing.
  ///  - an AGENCY weighted-pool row: a real `score`/`components` and the
  ///    snake_case match facets.
  Applicant _applicantFromRow(Map<String, dynamic> row) {
    final Object? applicationId = row['applicationId'];
    if (applicationId is String && applicationId.isNotEmpty) {
      return Applicant(
        workerId: row['workerId'] as String? ?? '',
        rank: (row['rank'] as num?)?.toInt() ?? 0,
        // V1: no score/hot/components on the wire. Structural placeholders,
        // pinned so nothing reads a fabricated 0 as a real ranking value.
        score: 0,
        hot: false,
        pushEligible: false,
        // camelCase, straight off the posting-applicant wire.
        matchTier: (row['matchTier'] as num?)?.toInt(),
        effectiveTier: (row['effectiveTier'] as num?)?.toInt(),
        skillMonths: (row['skillMonths'] as num?)?.toInt(),
        industryMonths: (row['industryMonths'] as num?)?.toInt(),
        matchedSkillLabel: row['matchedSkillLabel'] as String?,
        lastWorkedAt: row['lastWorkedAt'] as String?,
        // #2548 — display-only level fit; absent or null = no level sort.
        levelFit: row['levelFit'] as String?,
        // #2137 — the saved board stage; absent while the server flag is off.
        stage: row['stage'] as String?,
      );
    }
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
      // Match V1 facets (additive, nullable) — parsed from the snake_case keys
      // the deterministic matcher emits; absent on legacy rows → null.
      matchTier: (row['match_tier'] as num?)?.toInt(),
      effectiveTier: (row['effective_tier'] as num?)?.toInt(),
      skillMonths: (row['skill_months'] as num?)?.toInt(),
      industryMonths: (row['industry_months'] as num?)?.toInt(),
      matchedSkillLabel: row['matched_skill_label'] as String?,
      lastWorkedAt: row['last_worked_at'] as String?,
      levelFit: row['levelFit'] as String?,
      // #2137 — the saved board stage; absent while the server flag is off.
      stage: row['stage'] as String?,
    );
  }

  @override
  Future<bool> setApplicantStage({
    required String jobId,
    required String workerId,
    required String stage,
  }) async {
    final PayerResponse res = await _http.send(
      PayerMethod.put,
      '/payer/reach/jobs/$jobId/applicants/$workerId/stage',
      body: <String, dynamic>{'stage': stage},
    );
    // Neutral 404: flag off / not this payer's posting / no longer on the feed.
    if (res.statusCode == 404) return false;
    if (!res.isSuccess) throw PayerApiException(res.statusCode);
    return true;
  }

  ApplicantSignal _signalFromRow(Map<String, dynamic> row) => ApplicantSignal(
        signal: row['signal'] as String? ?? '',
        raw: (row['raw'] as num?)?.toDouble() ?? 0,
        weight: (row['weight'] as num?)?.toDouble() ?? 0,
        reason: row['reason'] as String? ?? '',
      );

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

  /// A wire array of strings → an immutable `List<String>`; anything else (an
  /// absent key, a null, a non-list) → empty. Never a fabricated entry.
  static List<String> _stringList(Object? v) => v is List<dynamic>
      ? List<String>.unmodifiable(v.whereType<String>())
      : const <String>[];

  /// Same, for a jsonb array the server may legitimately return as NULL: an
  /// absent/null value stays NULL instead of collapsing to `[]`, which is the
  /// only way "nothing stated" and "stored empty" stay tellable apart.
  static List<String>? _optionalStringList(Object? v) => v is List<dynamic>
      ? List<String>.unmodifiable(v.whereType<String>())
      : null;

  static Map<String, List<String>>? _optionalStringMapList(Object? v) {
    if (v is! Map) return null;
    final out = <String, List<String>>{};
    for (final entry in v.entries) {
      if (entry.key is String && entry.value is List) {
        out[entry.key as String] = List<String>.unmodifiable(
            (entry.value as List).whereType<String>());
      }
    }
    return Map<String, List<String>>.unmodifiable(out);
  }
}
