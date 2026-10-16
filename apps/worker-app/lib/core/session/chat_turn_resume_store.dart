import 'package:shared_preferences/shared_preferences.dart';

/// What the chat should draw again after a cold start, beyond its text.
///
/// [options] is the last served turn's chips as `option_key` + label pairs;
/// [freeChat] is the ADR-0051 mode the worker was in.
///
/// [askedQuestionKey] is the question the last turn ASKED (e.g. a location
/// question the worker had not answered when the app closed). The transcript
/// redraw carries no question key and a resume serves no opening, so without
/// this the pending question is lost and the worker sees its bubble with no way
/// to answer.
class ChatTurnResumeState {
  const ChatTurnResumeState({
    required this.sessionId,
    required this.options,
    required this.freeChat,
    this.askedQuestionKey,
    this.pendingQuestionKey,
    this.profilingEditJson,
  });

  final String sessionId;

  /// Server-served chips, in served order. Empty = the turn served none.
  final List<({String optionKey, String labelText})> options;
  final bool freeChat;

  /// The question key the last turn asked, or null when it asked none.
  final String? askedQuestionKey;

  /// The question the last turn asked that is currently HIDDEN behind the
  /// in-chat résumé prompt (`issue10.jpg`).
  ///
  /// While that prompt is on screen the server's real question is stashed in
  /// memory and [askedQuestionKey] is deliberately null, so the pickers stay
  /// hidden. The stash dies with the process: a worker who closed the app on
  /// the prompt, reopened it and then answered the prompt had its chips cleared
  /// and NOTHING put in their place — the state question's bubble was in the
  /// transcript with no picker, no "Location bharein" button and no live ask.
  /// Remembering it here is what lets the answer put the question back.
  final String? pendingQuestionKey;

  /// ADR-0057 R10 (#2314) — the last turn's pending change/delete
  /// confirmation, as its wire JSON, so a reopened chat draws the tile again
  /// over the redrawn Haan / Nahi chips. Null when the turn had none.
  final String? profilingEditJson;
}

/// The last served chat turn's CHIPS and mode, remembered across a cold start
/// (#2030 ask 3).
///
/// WHY THE CLIENT HAS TO REMEMBER IT: the transcript redraw
/// (`GET` session messages) returns `direction` / `body_text` / `created_at` /
/// `tts_text` and NO options, and `POST /chat/session` serves an opening bubble
/// only on a fresh open — `_openingFrom` returns null on a resume. So after a
/// >5min background re-lock a returning worker saw the greeting's TEXT with its
/// "Haan, shuru karein" / "Baad mein" chips gone. They could still type "haan",
/// which is why ADR-0051 rates this polish and not a dead end.
///
/// SCOPED BY SESSION ID, so chips from a session the worker has since left can
/// never be drawn onto a new one. A restore is also only ever applied when the
/// live state has no options of its own — a served turn always wins.
///
/// Best-effort, exactly like [KnownWorkerFactsStore]: every method swallows a
/// plugin error, because a storage miss only costs the worker the chips they
/// had before this existed. Cleared on logout (`_clearSessionScopedCaches`) so
/// the next worker on a shared phone starts clean.
abstract interface class ChatTurnResumeStore {
  /// The remembered turn, or null when there is none to apply. NEVER throws.
  Future<ChatTurnResumeState?> read();

  /// Remembers [state] as the latest served turn. NEVER throws.
  Future<void> write(ChatTurnResumeState state);

  /// Forgets everything. NEVER throws.
  Future<void> clearAll();
}

/// [ChatTurnResumeStore] over `shared_preferences`.
///
/// Resolves [SharedPreferences] LAZILY per call, so registering it never
/// touches the platform channel.
class SharedPrefsChatTurnResumeStore implements ChatTurnResumeStore {
  const SharedPrefsChatTurnResumeStore({
    Future<SharedPreferences> Function() prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final Future<SharedPreferences> Function() _prefs;

  /// `bb_`-prefixed to match the existing key convention.
  static const String kSessionKey = 'bb_chat_turn_session';
  static const String kOptionsKey = 'bb_chat_turn_options';
  static const String kFreeChatKey = 'bb_chat_turn_free_chat';
  static const String kQuestionKey = 'bb_chat_turn_question';
  static const String kPendingQuestionKey = 'bb_chat_turn_pending_question';
  static const String kProfilingEditKey = 'bb_chat_turn_profiling_edit';

  /// Splits an entry into key and label. A unit separator, because a label is
  /// server copy that may hold any punctuation a comma-joined list would break
  /// on ("Resume banayein", a model follow-up question, …).
  static const String _sep = '\u0001';

  @override
  Future<ChatTurnResumeState?> read() async {
    try {
      final SharedPreferences prefs = await _prefs();
      final String? sessionId = prefs.getString(kSessionKey);
      if (sessionId == null || sessionId.isEmpty) return null;
      final List<String> raw =
          prefs.getStringList(kOptionsKey) ?? const <String>[];
      final List<({String optionKey, String labelText})> options =
          <({String optionKey, String labelText})>[];
      for (final String entry in raw) {
        final int at = entry.indexOf(_sep);
        // A malformed row is DROPPED, never rendered: a chip with no key could
        // not be routed, and one with no label would draw blank.
        if (at <= 0 || at == entry.length - 1) continue;
        options.add((
          optionKey: entry.substring(0, at),
          labelText: entry.substring(at + 1),
        ));
      }
      return ChatTurnResumeState(
        sessionId: sessionId,
        options: options,
        freeChat: prefs.getBool(kFreeChatKey) ?? false,
        askedQuestionKey: prefs.getString(kQuestionKey),
        pendingQuestionKey: prefs.getString(kPendingQuestionKey),
        profilingEditJson: prefs.getString(kProfilingEditKey),
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(ChatTurnResumeState state) async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.setString(kSessionKey, state.sessionId);
      await prefs.setStringList(kOptionsKey, <String>[
        for (final ({String optionKey, String labelText}) o in state.options)
          '${o.optionKey}$_sep${o.labelText}',
      ]);
      await prefs.setBool(kFreeChatKey, state.freeChat);
      // Null-safe: a write of "no pending question" must CLEAR any previous one,
      // never leave a stale key that would resurface a finished question.
      final String? questionKey = state.askedQuestionKey;
      if (questionKey == null || questionKey.isEmpty) {
        await prefs.remove(kQuestionKey);
      } else {
        await prefs.setString(kQuestionKey, questionKey);
      }
      // Same null-safety: a turn with nothing hidden behind the résumé prompt
      // must clear a previous pending key, or a finished question comes back.
      final String? pending = state.pendingQuestionKey;
      if (pending == null || pending.isEmpty) {
        await prefs.remove(kPendingQuestionKey);
      } else {
        await prefs.setString(kPendingQuestionKey, pending);
      }
      // Same null-safety: a turn with no edit tile clears the previous one.
      final String? edit = state.profilingEditJson;
      if (edit == null || edit.isEmpty) {
        await prefs.remove(kProfilingEditKey);
      } else {
        await prefs.setString(kProfilingEditKey, edit);
      }
    } catch (_) {
      // Best-effort: an unremembered turn just loses its chips on a cold start.
    }
  }

  @override
  Future<void> clearAll() async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.remove(kSessionKey);
      await prefs.remove(kOptionsKey);
      await prefs.remove(kFreeChatKey);
      await prefs.remove(kQuestionKey);
      await prefs.remove(kPendingQuestionKey);
      await prefs.remove(kProfilingEditKey);
    } catch (_) {
      // Best-effort: a teardown failure must never block sign-out.
    }
  }
}

/// In-memory [ChatTurnResumeStore]: the seam unit tests inject, and the default
/// wherever persistence is not wired (chips are then lost on a cold start,
/// exactly as before #2030).
class InMemoryChatTurnResumeStore implements ChatTurnResumeStore {
  InMemoryChatTurnResumeStore([this._state]);

  ChatTurnResumeState? _state;

  @override
  Future<ChatTurnResumeState?> read() async => _state;

  @override
  Future<void> write(ChatTurnResumeState state) async => _state = state;

  @override
  Future<void> clearAll() async => _state = null;
}
