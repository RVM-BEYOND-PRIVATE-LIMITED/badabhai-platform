import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../../voice_form/domain/voice_form_models.dart'
    show VoiceChoice, VoiceQuestion, VoiceQuestionKind;
import '../domain/trade_form_models.dart';
import '../domain/trade_form_repository.dart';

/// Real trade-form repository (#1341) — HTTP + parsing, mirroring
/// `HttpVoiceFormGateway`'s pattern: [ApiClient] returns raw JSON (the tree
/// is this feature's own shape, not core's) and this class owns turning it
/// into [TradeForm]/[TradeFormStep]. Follows `FinishingRepositoryImpl`'s ctor
/// + bearer-token shape for the two marker-screen writes.
class TradeFormRepositoryImpl implements TradeFormRepository {
  TradeFormRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<TradeForm?> loadForm() async {
    final String token = _requireToken();
    try {
      final Map<String, dynamic> json =
          await _api.getTradeForm(authToken: token);
      return _parseForm(json);
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
    } on ApiException catch (error) {
      // 400 naming an unknown option_key means client/pack-version disagree
      // (#1341) — surfaced with the server's own message, the same pattern
      // `FinishingRepositoryImpl.saveWorkPreferences` uses for a bad city.
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
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
  Future<WorkPrefOptionsDto> loadPreferenceOptions() async {
    final String token = _requireToken();
    try {
      return await _api.getWorkPreferenceOptions(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
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
  Future<void> saveEmployment(
    List<TradeFormEmploymentEntry> employments,
  ) async {
    final String token = _requireToken();
    try {
      await _api.updateEmployment(
        employments:
            employments.map((TradeFormEmploymentEntry e) => e.toJson()).toList(),
        authToken: token,
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
        );
      case 'preferences':
        return const TradeFormPreferencesStep();
      case 'employment':
        return const TradeFormEmploymentStep();
      case 'qualifications':
        return TradeFormQualificationsStep(
          suggestedCertificates: (json['suggested_certificates'] as List<dynamic>?)
                  ?.whereType<String>()
                  .toList() ??
              const <String>[],
        );
      default:
        return null;
    }
  }

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
