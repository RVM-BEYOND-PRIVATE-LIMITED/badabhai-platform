import 'package:shared_preferences/shared_preferences.dart';

/// What the chat should draw again after a cold start, beyond its text.
///
/// [options] is the last served turn's chips as `option_key` + label pairs;
/// [freeChat] is the ADR-0051 mode the worker was in.
class ChatTurnResumeState {
  const ChatTurnResumeState({
    required this.sessionId,
    required this.options,
    required this.freeChat,
  });

  final String sessionId;

  /// Server-served chips, in served order. Empty = the turn served none.
  final List<({String optionKey, String labelText})> options;
  final bool freeChat;
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
