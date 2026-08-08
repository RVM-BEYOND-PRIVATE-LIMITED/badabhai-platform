import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/voice_form_gateway.dart';
import '../domain/voice_form_models.dart';

/// The real HTTP implementation of [VoiceFormGateway] (#699), against the frozen
/// deterministic-interview routes (backend #697/#698).
///
/// All four routes are worker-authed (bearer) + consent-gated, exactly like
/// `/chat/*`; the worker id is never in a body. A session that is missing or not
/// yours is a 404. PRIVACY: an answer clip crosses only as a signed-upload
/// reference the caller mints — never bytes through here, and never a path in a
/// log; this class logs nothing.
class HttpVoiceFormGateway implements VoiceFormGateway {
  HttpVoiceFormGateway(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  /// Server session id, learned on [start] and echoed on every later call.
  String? _sessionId;

  /// The question_key the client believes is on screen — the stale-answer guard
  /// sent with [submit]. Null on the disambiguation turn (the server allows it).
  String? _currentQuestionKey;

  String get _token {
    final String? t = _session.sessionToken;
    if (t == null) throw const UnauthorizedFailure();
    return t;
  }

  @override
  Future<VoiceFormStep> start() async {
    try {
      final Map<String, dynamic> json =
          await _api.profilingStart(authToken: _token);
      _sessionId = json['session_id'] as String?;
      return _parseStep(json['step']);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error); // fail-closed
    }
  }

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer) async {
    final Map<String, dynamic> body = <String, dynamic>{
      'session_id': _sessionId,
      'question_key': _currentQuestionKey,
      'answer': _answerJson(answer),
    };
    try {
      final Map<String, dynamic> json =
          await _api.profilingAnswer(authToken: _token, body: body);
      return _parseStep(json['step']);
    } on ApiException catch (e) {
      // 409 — the engine already moved on (the routine 2G retry-after-timeout
      // case). Do NOT re-POST the same body; re-attach to read the CURRENT step
      // and redraw. Any other status fails closed.
      if (e.statusCode == 409) {
        final Map<String, dynamic> json =
            await _api.profilingStart(authToken: _token);
        _sessionId = json['session_id'] as String? ?? _sessionId;
        return _parseStep(json['step']);
      }
      throw mapError(e);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> finalize() async {
    final String? id = _sessionId;
    if (id == null) throw const UnauthorizedFailure();
    try {
      final Map<String, dynamic> json =
          await _api.profilingFinalize(authToken: _token, sessionId: id);
      final bool committed = json['committed'] == true;
      if (!committed) {
        // The flush failed (or the engine has not closed the interview yet, a
        // 409 that surfaces as committed:false) — retryable, the worker may
        // submit again from the review screen.
        throw const VoiceUnavailableFailure();
      }
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  // ---- wire → domain --------------------------------------------------------

  /// Answer → the discriminated-union body. Sends option KEYS, never labels.
  /// A `spoken` answer has no wire shape yet (the follow-up backend PR), so it is
  /// rejected loudly rather than sent as something the server cannot store.
  Map<String, dynamic> _answerJson(VoiceAnswer answer) {
    switch (answer.kind) {
      case VoiceAnswerKind.text:
        return <String, dynamic>{'kind': 'text', 'text': answer.text};
      case VoiceAnswerKind.chips:
        return <String, dynamic>{
          'kind': 'chips',
          'option_keys': answer.optionKeys,
        };
      case VoiceAnswerKind.boolean:
        return <String, dynamic>{'kind': 'boolean', 'value': answer.boolValue};
      case VoiceAnswerKind.spoken:
        throw UnsupportedError(
            'spoken answers have no wire shape yet (#699 follow-up)');
    }
  }

  VoiceFormStep _parseStep(Object? raw) {
    final Map<String, dynamic> step = (raw as Map).cast<String, dynamic>();
    switch (step['kind']) {
      case 'question':
        final Map<String, dynamic> q =
            (step['question'] as Map).cast<String, dynamic>();
        _currentQuestionKey = q['question_key'] as String?;
        return NextQuestion(
          _parseQuestion(q),
          index: step['index'] as int? ?? 0,
          total: step['total'] as int? ?? 0,
        );
      case 'done':
        return const VoiceFormDone();
      case 'unavailable':
        // NOT an error in the engine's sense (nothing was written), but the
        // client surfaces it as a retryable failure carrying the server's reply
        // — the worker sends again, and it is never dead-lettered in the offline
        // queue (that path is only for spoken clips, which do not reach here).
        throw VoiceUnavailableFailure(
            step['reply'] as String? ?? const VoiceUnavailableFailure().message);
      default:
        throw const VoiceUnavailableFailure();
    }
  }

  VoiceQuestion _parseQuestion(Map<String, dynamic> q) {
    return VoiceQuestion(
      id: q['question_key'] as String? ?? '',
      prompt: q['prompt_text'] as String? ?? '',
      kind: _kind(q['answer_type'] as String?),
      options: _options(q['options']),
      whyText: q['why_text'] as String?,
      // tts_clip_id = sha256(normalize(prompt))[:16] → resolve a bundled asset by
      // that name; a missing asset is the designed text fallback (#631).
      ttsAssetKey: q['tts_clip_id'] as String?,
    );
  }

  /// answer_type decides the input — NOT options.length (all 236 boolean pack
  /// items carry zero options).
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
            ))
        .where((VoiceChoice c) => c.key.isNotEmpty)
        .toList();
  }
}
