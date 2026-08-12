import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/voice_correction_outcome.dart';
import '../domain/voice_form_gateway.dart';
import '../domain/voice_form_models.dart';
import '../domain/voice_review_row.dart';

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

  @override
  String? get sessionId => _sessionId;


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
  Future<VoiceFormStep> submit(VoiceAnswer answer, {required String? questionKey}) async {
    final Map<String, dynamic> body = <String, dynamic>{
      'session_id': _sessionId,
      // FROM THE CALLER, NOT FROM A CURSOR THIS CLASS KEEPS. `question_key` is the
      // stale-answer guard: it asserts "this is the question I am answering". Only the
      // cubit knows what is on the worker's screen, so only the cubit can assert it.
      //
      // It used to be a field this class set as a SIDE EFFECT of parsing a step — which
      // desynced the moment the cubit discarded a step it had asked for. An interruption
      // during `submit` (a multi-second window: the server transcribes and runs the turn
      // before replying) makes the cubit drop the response and re-arm Q(n) on resume, while
      // this cursor had already moved to Q(n+1). The worker's second answer to Q(n) then
      // carried `question_key: Q(n+1)`, the server's equality guard PASSED, and the answer
      // was captured against the wrong question — the exact substitution the field exists to
      // prevent, performed by the client.
      'question_key': questionKey,
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
      //
      // WRAPPED IN ReattachedTo, not returned bare (#727). The server REJECTED this
      // answer as stale; a bare NextQuestion would be indistinguishable from success
      // and the cubit would bank the stale answer (and emit `profiling_answer_spoken`)
      // against a question it was not an answer to. The variant carries that fact.
      if (e.statusCode == 409) {
        final Map<String, dynamic> json =
            await _api.profilingStart(authToken: _token);
        _sessionId = json['session_id'] as String? ?? _sessionId;
        return ReattachedTo(_parseStep(json['step']));
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
        // 200 WITH `committed: false` — the re-drive ran and did not commit. Real, and
        // rarer than the 409 below; retryable from the review screen either way.
        throw const VoiceUnavailableFailure();
      }
    } on ApiException catch (e) {
      // 409 — "the engine decides when an interview closes". THE OTHER retryable outcome,
      // and the frequent one. This comment used to claim it "surfaces as committed:false";
      // it does not. `ProfilingSessionService.finalize` throws `ConflictException`, which
      // arrives here as an `ApiException` — not a `Failure`, so it fell through to
      // `mapError`, which has no 409 arm and returns the generic `ServerFailure(409)`
      // "Something went wrong". The review screen then dead-ended on opaque copy for the
      // one condition the worker could actually have retried out of.
      if (e.statusCode == 409) throw const VoiceUnavailableFailure();
      throw mapError(e);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) async {
    final String? id = _sessionId;
    if (id == null) throw const UnauthorizedFailure();
    final Map<String, dynamic> body = <String, dynamic>{
      'session_id': id,
      'question_key': questionKey,
      'answer': _answerJson(answer),
    };
    try {
      final Map<String, dynamic> json =
          await _api.profilingCorrect(authToken: _token, body: body);
      return _parseCorrection(json);
    } on Failure {
      rethrow;
    } catch (error) {
      // 409 (still on screen), 422 (parsed to no value), the correction cap —
      // all fail closed to worker-safe copy; nothing is banked on the client.
      throw mapError(error);
    }
  }

  @override
  Future<List<VoiceReviewRow>> reviewRows() async {
    final String? id = _sessionId;
    if (id == null) throw const UnauthorizedFailure();
    try {
      final Map<String, dynamic> json =
          await _api.profilingSession(authToken: _token, sessionId: id);
      return _parseRows(json['rows']);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error); // fail-closed
    }
  }

  @override
  Future<Set<String>> answeredQuestionKeys() async {
    final String? id = _sessionId;
    if (id == null) return const <String>{};
    try {
      final Map<String, dynamic> json =
          await _api.profilingSession(authToken: _token, sessionId: id);
      final Object? rows = json['rows'];
      if (rows is! List) return const <String>{};
      return rows
          .whereType<Map<dynamic, dynamic>>()
          .map((Map<dynamic, dynamic> r) => r['question_key'] as String? ?? '')
          .where((String k) => k.isNotEmpty)
          .toSet();
    } catch (_) {
      // Fail-soft (#775): a failed confirmation read leaves the spoken signal
      // uncounted rather than throwing into the re-attach flow. The caller treats
      // an empty set as "not confirmed", which is the safe (under-count) direction.
      return const <String>{};
    }
  }

  // ---- wire → domain --------------------------------------------------------

  /// `GET /profiling/session/:id` `rows` → review rows. Defensive like
  /// `_parseStep`/`_parseQuestion`: a non-list is empty, and a row that is not a
  /// map or carries no addressable `question_key` is DROPPED — one bad row must
  /// never throw the whole review out from under a worker who can still submit.
  List<VoiceReviewRow> _parseRows(Object? raw) {
    if (raw is! List) return const <VoiceReviewRow>[];
    return raw
        .whereType<Map<dynamic, dynamic>>()
        .map(_parseRow)
        .whereType<VoiceReviewRow>()
        .toList();
  }

  VoiceReviewRow? _parseRow(Map<dynamic, dynamic> raw) {
    final Map<String, dynamic> row = raw.cast<String, dynamic>();
    final String questionId = row['question_key'] as String? ?? '';
    if (questionId.isEmpty) return null; // unaddressable — a correction has no target
    final String? answerType = row['answer_type'] as String?;
    final VoiceQuestionKind kind = _kind(answerType);
    final List<VoiceChoice> options = _options(row['options']);
    return VoiceReviewRow(
      questionId: questionId,
      fieldLabel: row['field_label'] as String? ?? '',
      displayValue: row['display_value'] as String? ?? '',
      declined: row['status'] == 'declined',
      // answer_type=='number' is the numeric heuristic — line the digits up.
      numeric: answerType == 'number',
      kind: kind,
      options: options,
      hasChoices: options.isNotEmpty || kind == VoiceQuestionKind.boolean,
      // Server truth has no local device path; only a locally-recorded clip does.
      clipPath: null,
    );
  }

  /// `POST /profiling/correct` response → the redrawn row + rebuild signal.
  VoiceCorrectionOutcome _parseCorrection(Map<String, dynamic> json) {
    final Map<String, dynamic> row =
        (json['row'] as Map).cast<String, dynamic>();
    return VoiceCorrectionOutcome(
      questionId: (json['question_key'] as String?) ??
          (row['question_key'] as String? ?? ''),
      displayValue: row['display_value'] as String?,
      declined: row['status'] == 'declined',
      correctionCount: json['correction_count'] as int? ?? 0,
      profileRebuildRequired: json['profile_rebuild_required'] == true,
    );
  }

  /// Answer → the discriminated-union body. Sends option KEYS, never labels, and for a
  /// spoken answer the REGISTERED `voice_note_id` — never bytes, never a device path.
  ///
  /// ALL FOUR MEMBERS, since #717. This threw `UnsupportedError` on `spoken` with the note
  /// that it "has no wire shape yet"; that was false on the commit it shipped in.
  /// `ProfilingAnswerSchema` has carried `{kind: 'spoken', voice_note_id}` since #702 and
  /// `ProfilingSessionService.answer` dispatches it into transcribe-then-turn. Since every
  /// `text`/`number`/`city`/`salary`/`duration` question renders as `open` — no chips, mic
  /// only — and the universal pack OPENS with four of them, that throw made the first
  /// question of every interview unanswerable.
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
        return <String, dynamic>{
          'kind': 'spoken',
          'voice_note_id': answer.voiceNoteId,
        };
    }
  }

  VoiceFormStep _parseStep(Object? raw) {
    final Map<String, dynamic> step = (raw as Map).cast<String, dynamic>();
    switch (step['kind']) {
      case 'question':
        final Map<String, dynamic> q =
            (step['question'] as Map).cast<String, dynamic>();
        return NextQuestion(
          _parseQuestion(q),
          index: step['index'] as int? ?? 0,
          total: step['total'] as int? ?? 0,
          lookahead: _parseLookahead(step['lookahead']),
        );
      case 'done':
        return const VoiceFormDone();
      case 'unavailable':
        // A STEP, NOT A FAILURE (#717). Nothing was written and the worker may send that
        // again — which is the whole reason this variant exists rather than a 5xx. Throwing
        // it made the cubit emit `VoiceFormError`, whose only action on screen is `onExit`:
        // the server said "say that again" and the client ended the interview.
        return RetryCurrentQuestion(
            step['reply'] as String? ?? const VoiceUnavailableFailure().message);
      default:
        // An UNKNOWN kind is different, and stays a failure. The union is closed on the
        // server, so a value this client has never seen means the two have diverged —
        // guessing "probably retryable" would re-arm the mic against a question that may no
        // longer be on screen. Fail closed.
        throw const VoiceUnavailableFailure();
    }
  }

  /// Advisory next-step predictions keyed by `option_key` / `'__declined'`
  /// (#761). Parsed DEFENSIVELY: a non-map, a non-string key, or a garbage entry
  /// is dropped — never a throw, so a bad prediction can never take down the step
  /// (a bad prediction just falls back to today's blocking submit for that tap).
  /// Absent ⇒ empty map.
  Map<String, PredictedNext> _parseLookahead(Object? raw) {
    if (raw is! Map) return const <String, PredictedNext>{};
    final Map<String, PredictedNext> out = <String, PredictedNext>{};
    raw.forEach((Object? key, Object? value) {
      if (key is! String || value is! Map) return;
      final PredictedNext? predicted =
          _parsePredictedNext(value.cast<String, dynamic>());
      if (predicted != null) out[key] = predicted;
    });
    return out;
  }

  /// One lookahead entry → a [PredictedNext]. The entry carries the predicted
  /// question INLINE (same `question_key`/`prompt_text`/`answer_type`/`options`/
  /// `why_text` shape [_parseQuestion] reads) plus its dot-rail position, taken
  /// from an explicit `index`/`total` or a nested `progress {answered,total}`.
  ///
  /// A `close`/`done` marker ⇒ a predicted DONE ([question] null); an entry with
  /// no usable prompt ⇒ no prediction (null).
  PredictedNext? _parsePredictedNext(Map<String, dynamic> entry) {
    final Map<String, dynamic>? progress = entry['progress'] is Map
        ? (entry['progress'] as Map).cast<String, dynamic>()
        : null;
    final int index =
        (entry['index'] as int?) ?? (progress?['answered'] as int?) ?? 0;
    final int total =
        (entry['total'] as int?) ?? (progress?['total'] as int?) ?? 0;
    final bool done =
        entry['question_kind'] == 'close' || entry['kind'] == 'done';
    if (done) {
      return PredictedNext(question: null, index: index, total: total);
    }
    final Object? prompt = entry['prompt_text'];
    if (prompt is! String || prompt.trim().isEmpty) return null;
    return PredictedNext(
      question: _parseQuestion(entry),
      index: index,
      total: total,
    );
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
