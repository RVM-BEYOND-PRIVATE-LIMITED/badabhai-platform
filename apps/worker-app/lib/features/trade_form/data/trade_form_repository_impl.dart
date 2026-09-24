import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/known_worker_facts_store.dart';
import '../../../core/session/session_repository.dart';
import '../../voice_form/domain/voice_form_models.dart'
    show VoiceChoice, VoiceQuestion, VoiceQuestionKind;
import '../domain/form_fact_registry.dart';
import '../domain/trade_form_models.dart';
import '../domain/profiling_tier.dart';
import '../domain/trade_form_repository.dart';

/// Real trade-form repository (#1341) — HTTP + parsing, mirroring
/// `HttpVoiceFormGateway`'s pattern: [ApiClient] returns raw JSON (the tree
/// is this feature's own shape, not core's) and this class owns turning it
/// into [TradeForm]/[TradeFormStep]. Follows `FinishingRepositoryImpl`'s ctor
/// + bearer-token shape for the two marker-screen writes.
/// Reports a caught, NON-FATAL error to the app's observability sink.
///
/// The same seam `ChatRepositoryImpl` uses, and for the same reason: it makes
/// "this failure was REPORTED, not swallowed" unit-testable without a live
/// Firebase (which makes `recordNonFatal` a no-op in tests).
typedef NonFatalReporter = void Function(
  Object error,
  StackTrace stack, {
  required String reason,
});

/// Default [NonFatalReporter]. [reason] is a short, STATIC, PII-free key.
void _recordNonFatal(Object error, StackTrace stack, {required String reason}) =>
    CrashReporter.recordNonFatal(error, stack, reason: reason);

class TradeFormRepositoryImpl implements TradeFormRepository {
  TradeFormRepositoryImpl(
    this._api,
    this._session, {
    NonFatalReporter reportNonFatal = _recordNonFatal,
    KnownWorkerFactsStore? knownFacts,
  })  : _report = reportNonFatal,
        _knownFacts = knownFacts;

  final ApiClient _api;
  final SessionRepository _session;
  final NonFatalReporter _report;

  /// What the worker already gave before this form (/name's city, chat
  /// answers) — [dedupeTradeForm] skips those questions. Null asks everything
  /// the form carries.
  final KnownWorkerFactsStore? _knownFacts;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<TradeForm?> loadForm({bool upgradeView = false}) async {
    final String token = _requireToken();
    try {
      final Map<String, dynamic> json = await _api.getTradeForm(
        authToken: token,
        // #1698 — the parameter is OMITTED on an ordinary load rather than
        // sent as `view=full`, so a server built before tiers sees exactly the
        // request it has always seen.
        view: upgradeView ? 'upgrade' : null,
      );
      // ONE FACT, ASKED ONCE: every caller (the first load AND the
      // schema_stale resync) gets the de-duplicated form, so the walk and the
      // progress totals derived from `questionSteps` agree. See
      // `form_fact_registry.dart` for why the server's form repeats itself.
      final TradeForm form = _parseForm(json);
      final Set<WorkerFact> known =
          await _knownFacts?.knownFacts() ?? const <WorkerFact>{};
      return dedupeTradeForm(form, knownFacts: known);
    } on ApiException catch (error) {
      // 404 — this worker was never handed a form. A DIFFERENT thing from an
      // empty form (#1341): the caller renders an honest "nothing to fill
      // here" state rather than a blank one, so this is null, not a Failure.
      if (error.statusCode == 404) return null;
      throw mapError(error);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<TierState> loadTierState() async {
    final String? token = _session.sessionToken;
    // No session at all: there is nothing to ask about, and a tier screen must
    // never be the reason a signed-out worker sees an error.
    if (token == null) return TierState.disabled;
    try {
      return TierState.fromJson(await _api.getProfilingTiers(authToken: token));
    } catch (_) {
      // EVERY failure is the same answer: a 404 (no form handed over), a 401,
      // a 5xx, a timeout, a body this build cannot parse. All of them mean
      // "do what the app did before tiers existed". Deliberately not reported
      // either — an optional gate that quietly stays shut is not an incident.
      return TierState.disabled;
    }
  }

  @override
  Future<TierChoice?> chooseTier(ProfilingTier tier) async {
    final String token = _requireToken();
    try {
      return TierChoice.fromJson(
        await _api.chooseProfilingTier(
          authToken: token,
          tier: profilingTierWire(tier),
        ),
      );
    } on ApiException catch (error) {
      // Same posture as every deliberate write on this repository: a 400 (or a
      // 409 refusing a downgrade this app should never have offered) carries
      // the server's own sentence, and the worker is shown it rather than
      // "kuch takneeki dikkat hai".
      if ((error.statusCode == 400 || error.statusCode == 409) &&
          error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      throw mapError(error);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<TradeFormAnswerResult> submitAnswer({
    required String questionKey,
    required TradeFormAnswer answer,
  }) async {
    final String token = _requireToken();
    try {
      final Map<String, dynamic> json = await _api.submitTradeFormAnswer(
        authToken: token,
        body: <String, dynamic>{
          'question_key': questionKey,
          'answer': answer.toJson(),
        },
      );
      return _parseAnswerResult(json);
    } on ApiException catch (error, stack) {
      // 400 naming an unknown option_key means client/pack-version disagree
      // (#1341) — surfaced with the server's own message, the same pattern
      // `FinishingRepositoryImpl.saveWorkPreferences` uses for a bad city.
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      // #1480 — ANYTHING ELSE IS A DEAD END FOR THE WORKER, SO IT MUST NOT BE ONE FOR US.
      //
      // Above this line the server told the worker something he can act on. Below it he gets
      // "kuch takneeki dikkat hai" and stops, and on 2026-09-10 that happened on EVERY
      // question of the CNC turner form with nothing recorded anywhere — the investigation
      // needed SSH to the box because the app kept no trace of what it saw.
      //
      // A 400 is deliberately NOT reported: it is the server's considered answer about this
      // request, the worker is told what to change, and reporting it would bury the real
      // faults under pack-version skew. Everything else — 5xx, 401, 403, a timeout — is a
      // failure the worker cannot fix and we would otherwise never learn about.
      //
      // REASON IS STATIC AND PII-FREE. The status rides on the mapped `ServerFailure` and the
      // question key is deliberately absent: it is pack vocabulary, not a worker's words, but
      // a per-question key would fragment the Crashlytics issue into eighteen.
      _report(mapError(error), stack, reason: 'trade_form_answer_failed');
      throw mapError(error);
    } on Failure {
      rethrow;
    } catch (error, stack) {
      _report(mapError(error), stack, reason: 'trade_form_answer_failed');
      throw mapError(error);
    }
  }

  @override
  Future<WorkPrefOptionsDto> loadPreferenceOptions() async {
    final String token = _requireToken();
    try {
      return await _api.getWorkPreferenceOptions(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<TradeFormPreferences?> loadSavedPreferences() async {
    final String token = _requireToken();
    final WorkPreferencesDto dto;
    try {
      dto = await _api.getWorkPreferences(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
    // EVERY FIELD NULL MEANS NO STORED ROW, which the caller must be able to
    // tell apart from a stored "none of these" (an empty list). Coalescing the
    // two is the erase this whole read exists to prevent.
    if (dto.languages == null &&
        dto.documentsReady == null &&
        dto.preferredCities == null &&
        dto.jobType == null &&
        dto.shift == null &&
        dto.willingToRelocate == null &&
        dto.accommodationNeeded == null &&
        dto.salaryExpectedMax == null) {
      return null;
    }
    // `touched` IS DELIBERATELY LEFT EMPTY. Prefilling is not touching: a page
    // the worker passes through must send none of these keys, so the stored
    // values stay exactly as they are. It also honours the read's `partial`
    // contract — a key whose stored value was withheld must not be re-sent
    // unless the worker edits it, and editing is the only thing that marks it
    // touched.
    return TradeFormPreferences(
      languages: dto.languages?.toSet() ?? const <String>{},
      documentsReady: dto.documentsReady?.toSet() ?? const <String>{},
      preferredCities: dto.preferredCities ?? const <String>[],
      jobType: dto.jobType,
      shift: dto.shift,
      willingToRelocate: dto.willingToRelocate ?? false,
      accommodationNeeded: dto.accommodationNeeded ?? false,
      salaryExpectedMax: dto.salaryExpectedMax,
    );
  }

  @override
  Future<void> savePreferences(TradeFormPreferences prefs) async {
    final String token = _requireToken();
    try {
      await _api.updateWorkPreferences(fields: prefs.toJson(), authToken: token);
    } on ApiException catch (error) {
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<TradeFormStoredEmployment> loadSavedEmployment() async {
    final String token = _requireToken();
    final MyEmploymentDto dto;
    try {
      dto = await _api.getMyEmployment(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
    return TradeFormStoredEmployment(
      entries: dto.employments.map(_entryFromView).toList(growable: false),
      expectedExistingCount: dto.expectedExistingCount,
    );
  }

  /// One stored employment → the flat card the page draws (#1710).
  ///
  /// THE SERVER'S OWN PROJECTION RULE, in reverse. An employment the server
  /// would project to the single-role shorthand (exactly one stint whose dates
  /// equal the employment's) becomes a plain flat entry, and the save sends
  /// the shorthand back — byte-for-byte the shape this page has always sent.
  ///
  /// ANYTHING ELSE KEEPS ITS `roles[]`. A second stint cannot be drawn by a
  /// page with one role field, and flattening it would delete it on the next
  /// save, so the stints ride along on
  /// [TradeFormEmploymentEntry.storedRoles] and the card edits the first.
  static TradeFormEmploymentEntry _entryFromView(EmploymentViewDto view) {
    final EmploymentRoleViewDto? only =
        view.roles.length == 1 ? view.roles.first : null;
    final bool shorthand =
        only != null && only.startYm == view.startYm && only.endYm == view.endYm;
    final EmploymentRoleViewDto? primary =
        view.roles.isEmpty ? null : view.roles.first;
    return TradeFormEmploymentEntry(
      employerName: view.employerName,
      roleLabel: primary?.roleLabel ?? '',
      employerCity: view.employerCity,
      employerState: view.employerState,
      startYm: view.startYm,
      endYm: view.endYm,
      workDone: primary?.workDone,
      workDoneVoiceNoteId: primary?.workDoneVoiceNoteId,
      // A stored row with no end date IS the worker's current job — the same
      // reading `TradeFormEmploymentEntry.stillWorking` documents. Never
      // "missing": the switch must come back ON so the résumé keeps printing
      // "Present" rather than demanding an end date the worker never gave.
      stillWorking: view.endYm == null,
      storedRoles: shorthand
          ? const <Map<String, dynamic>>[]
          : view.roles
              .map((EmploymentRoleViewDto r) => <String, dynamic>{
                    'role_label': r.roleLabel,
                    'start_ym': r.startYm,
                    'end_ym': r.endYm,
                    'work_done': r.workDone,
                    'work_done_voice_note_id': r.workDoneVoiceNoteId,
                  })
              .toList(growable: false),
    );
  }

  @override
  Future<void> saveEmployment(
    List<TradeFormEmploymentEntry> employments, {
    int? expectedExistingCount,
  }) async {
    final String token = _requireToken();
    try {
      await _api.updateEmployment(
        employments:
            employments.map((TradeFormEmploymentEntry e) => e.toJson()).toList(),
        authToken: token,
        expectedExistingCount: expectedExistingCount,
      );
    } on ApiException catch (error) {
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<QualificationOptionsDto> loadQualificationOptions() async {
    final String token = _requireToken();
    try {
      return await _api.getQualificationOptions(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<TradeFormQualifications?> loadSavedQualifications() async {
    final String token = _requireToken();
    final MyQualificationsDto dto;
    try {
      dto = await _api.getMyQualifications(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
    // `trainings` is read but not mapped: this page has no trainings section
    // to draw one in, and the PUT leaves an absent key alone, so a stored
    // training survives every save from here untouched.
    if (dto.certificates.isEmpty && dto.educations.isEmpty) return null;
    // BOTH `*Touched` FLAGS STAY FALSE — see the interface doc. A prefilled
    // page the worker passes through sends neither key, and the stored rows
    // are left exactly as they are.
    return TradeFormQualifications(
      certificates: dto.certificates
          .map((CertificateEntryDto c) => TradeFormCertificateEntry(
                name: c.name,
                issuer: c.issuer,
                year: c.year,
              ))
          .toList(growable: false),
      educations: dto.educations
          .map((EducationEntryDto e) => TradeFormEducationEntry(
                credential: e.credential,
                field: e.field,
                council: e.council,
                year: e.year,
                institute: e.institute,
              ))
          .toList(growable: false),
    );
  }

  @override
  Future<void> saveQualifications(
    TradeFormQualifications qualifications,
  ) async {
    final String token = _requireToken();
    try {
      await _api.updateQualifications(
        fields: qualifications.toJson(),
        authToken: token,
      );
    } on ApiException catch (error) {
      // A 400 here is most often the phone/email-shape screen naming the
      // offending field ("remove contact details from the issuer") — surface
      // the server's own message honestly, same convention as every other
      // write on this repository.
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  // ---- wire → domain, mirrors HttpVoiceFormGateway's defensive parsing:
  // a malformed section/screen/question is DROPPED rather than thrown, so one
  // bad row never takes the whole form down for a worker who can still fill
  // the rest. ---------------------------------------------------------------

  TradeForm _parseForm(Map<String, dynamic> json) {
    final List<dynamic> rawSections =
        json['sections'] as List<dynamic>? ?? const <dynamic>[];
    return TradeForm(
      kind: json['kind'] as String? ?? '',
      packId: json['pack_id'] as String? ?? '',
      packVersion: (json['pack_version'] as num?)?.toInt() ?? 0,
      // #1472 — re-read from EVERY schema response, never cached: the form is
      // resumable across a cold start, and a stale id files a spoken work
      // description under the wrong conversation.
      sessionId: json['session_id'] as String?,
      sections: rawSections
          .whereType<Map<dynamic, dynamic>>()
          .map((Map<dynamic, dynamic> s) => _parseSection(s.cast<String, dynamic>()))
          .toList(),
    );
  }

  TradeFormSection _parseSection(Map<String, dynamic> json) {
    final List<dynamic> rawScreens =
        json['screens'] as List<dynamic>? ?? const <dynamic>[];
    return TradeFormSection(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      screens: rawScreens
          .whereType<Map<dynamic, dynamic>>()
          .map((Map<dynamic, dynamic> s) => _parseStep(s.cast<String, dynamic>()))
          .whereType<TradeFormStep>()
          .toList(),
    );
  }

  /// One `screens[]` entry → the matching [TradeFormStep], or null for a
  /// `type` this client build does not know (fail SOFT here — an unknown
  /// screen kind is dropped, not fatal to the rest of the form).
  TradeFormStep? _parseStep(Map<String, dynamic> json) {
    switch (json['type']) {
      case 'question':
        final Object? q = json['question'];
        if (q is! Map) return null;
        return TradeFormQuestionStep(
          question: _parseQuestion(q.cast<String, dynamic>()),
          searchable: (json['ui'] is Map)
              ? (json['ui'] as Map)['searchable'] == true
              : false,
          answer: _parseSavedAnswer(json['answer']),
          suggestion: _parseSuggestion(json['suggestion']),
        );
      case 'preferences':
        return TradeFormPreferencesStep(tierScope: _tierScope(json));
      case 'employment':
        return TradeFormEmploymentStep(tierScope: _tierScope(json));
      case 'qualifications':
        return TradeFormQualificationsStep(
          suggestedCertificates: (json['suggested_certificates'] as List<dynamic>?)
                  ?.whereType<String>()
                  .toList() ??
              const <String>[],
          tierScope: _tierScope(json),
        );
      default:
        return null;
    }
  }

  /// `tier_scope` on a marker screen (#1698/#1710), or [unscoped] when the
  /// server did not send one — a tier-less server, tiers switched off, or a
  /// body this build cannot read. Degrading to "ask everything" is the
  /// fail-open direction on purpose: hiding a field the worker still owes an
  /// answer to is the harm, not asking one twice.
  TradeFormTierScope _tierScope(Map<String, dynamic> json) =>
      TradeFormTierScope.fromJson(json['tier_scope']) ??
      TradeFormTierScope.unscoped;

  VoiceQuestion _parseQuestion(Map<String, dynamic> q) {
    return VoiceQuestion(
      id: q['question_key'] as String? ?? '',
      prompt: q['prompt_text'] as String? ?? '',
      kind: _kind(q['answer_type'] as String?),
      options: _options(q['options']),
      whyText: q['why_text'] as String?,
    );
  }

  /// `answer_type` decides the input, NOT `options.length` — mirrors
  /// `HttpVoiceFormGateway._kind` exactly (the two DTOs share the same
  /// `answer_type` vocabulary by design, see `trade_form_models.dart`).
  VoiceQuestionKind _kind(String? answerType) {
    switch (answerType) {
      case 'boolean':
        return VoiceQuestionKind.boolean;
      case 'single_select':
        return VoiceQuestionKind.singleSelect;
      case 'multi_select':
        return VoiceQuestionKind.multiSelect;
      case 'text':
      case 'number':
      default:
        return VoiceQuestionKind.open;
    }
  }

  List<VoiceChoice> _options(Object? raw) {
    if (raw is! List) return const <VoiceChoice>[];
    return raw
        .whereType<Map<dynamic, dynamic>>()
        .map((Map<dynamic, dynamic> o) => VoiceChoice(
              key: o['option_key'] as String? ?? '',
              label: o['label_text'] as String? ?? '',
              // #1382 — carried onto the domain model so a multi-select
              // renderer can keep this option mutually exclusive with every
              // other one; previously parsed away entirely.
              isNoneOfAbove: o['is_none_of_above'] as bool? ?? false,
            ))
        .where((VoiceChoice c) => c.key.isNotEmpty)
        .toList();
  }

  /// `answer: null` ⇒ genuinely unanswered — returned as null, NEVER
  /// coerced into a declined/empty [TradeFormSavedAnswer] (#1341: an empty
  /// `option_keys` on an ANSWERED row is real too, and the two must stay
  /// distinguishable by [TradeFormAnswerStatus] alone).
  TradeFormSavedAnswer? _parseSavedAnswer(Object? raw) {
    if (raw is! Map) return null;
    final Map<String, dynamic> a = raw.cast<String, dynamic>();
    final String? status = a['status'] as String?;
    if (status != 'answered' && status != 'declined') return null;
    return TradeFormSavedAnswer(
      status: status == 'declined'
          ? TradeFormAnswerStatus.declined
          : TradeFormAnswerStatus.answered,
      optionKeys: (a['option_keys'] as List<dynamic>?)
              ?.whereType<String>()
              .toList() ??
          const <String>[],
      text: a['text'] as String?,
      number: (a['number'] as num?)?.toDouble(),
      boolValue: a['bool'] as bool?,
    );
  }

  /// `suggestion: null` — which is what the server sends until a résumé has
  /// been parsed — reads as null here, and so does a malformed object. NEVER
  /// coerced into a [TradeFormSavedAnswer]: a suggestion has no status, and
  /// manufacturing one would put a résumé's guesses on a worker's profile as
  /// his own claims (ruling D2, #1499).
  ///
  /// A missing `confidence` reads as 0 rather than dropping the suggestion: the
  /// number is observability, not a gate, so its absence must not lose the one
  /// thing the worker can actually use.
  TradeFormSuggestion? _parseSuggestion(Object? raw) {
    if (raw is! Map) return null;
    final Map<String, dynamic> s = raw.cast<String, dynamic>();
    final Object? rawValues = s['values'];
    if (rawValues is! Map) return null;
    final Map<String, dynamic> v = rawValues.cast<String, dynamic>();
    final TradeFormSuggestion suggestion = TradeFormSuggestion(
      optionKeys: (v['option_keys'] as List<dynamic>?)
              ?.whereType<String>()
              .toList() ??
          const <String>[],
      text: v['text'] as String?,
      number: (v['number'] as num?)?.toDouble(),
      boolValue: v['bool'] as bool?,
      confidence: (s['confidence'] as num?)?.toDouble() ?? 0,
    );
    // Nothing to say is the same as saying nothing — one null for the renderer
    // to branch on instead of two.
    return suggestion.isEmpty ? null : suggestion;
  }

  TradeFormAnswerResult _parseAnswerResult(Map<String, dynamic> json) {
    return TradeFormAnswerResult(
      questionKey: json['question_key'] as String? ?? '',
      status: json['status'] == 'declined'
          ? TradeFormAnswerStatus.declined
          : TradeFormAnswerStatus.answered,
      answered: (json['answered'] as num?)?.toInt() ?? 0,
      total: (json['total'] as num?)?.toInt() ?? 0,
      // #1382 — absent on the wire today (backend work in progress);
      // missing/null reads as false, the current, correct behaviour.
      schemaStale: json['schema_stale'] as bool? ?? false,
    );
  }
}
