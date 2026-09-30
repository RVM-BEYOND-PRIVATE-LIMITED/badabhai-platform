import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart' show ChatOption;

/// The ONE opening turn `POST /chat/session` can hand the client, packaged for
/// the bloc to apply to bubble 0.
///
/// Two shapes ride this, and they are the same wire field (`opening_text`):
///
///   * the ordinary one-shot composite opener (CHAT_ONE_SHOT_OPENER_ENABLED),
///     with its Devanagari read-aloud twin ([ttsText]) and no chips; and
///   * the résumé-confirm opening (ADR-0042 D8, #1523) — the server composes a
///     "Resume se ye mila: … Sahi hai?" bubble and serves its Haan/Nahi chips as
///     [options], flagged [resumePending]. The worker answers by tapping a chip,
///     which submits its label exactly like a later-turn suggested option.
///
/// [text] is the SERVER's copy, never a parsed résumé value: the client renders
/// only what the server sent, so there is no local résumé parsing to drift.
class ChatSessionOpening extends Equatable {
  const ChatSessionOpening({
    required this.text,
    this.ttsText,
    this.resumePending = false,
    this.options = const <ChatOption>[],
    this.questionKey,
    this.answerType,
  });

  /// The server-composed bubble 0 text.
  final String text;

  /// The Devanagari read-aloud twin (`opening_tts_text`), or null when the
  /// server served no twin — read-aloud then speaks [text]. Never displayed.
  final String? ttsText;

  /// True when this opening is a résumé-confirm first turn (`resume_pending`):
  /// the canned `kChatOpeningText` opener is suppressed and [text] is the confirm.
  final bool resumePending;

  /// The opening turn's tap-to-answer chips (`opening_options`); the same
  /// [ChatOption] objects a later turn serves, so a tap carries the stable
  /// `option_key` for lookahead while the label is the submitted answer.
  final List<ChatOption> options;

  /// ADR-0048 — `opening_question_key`: the identity question bubble 0 IS, when
  /// the chat opens on the identity intake (`worker_first_name`,
  /// `worker_last_name`, `worker_state`, `worker_city`).
  ///
  /// Null on every other open, which is what makes it safe to read: the intake
  /// asks only what the worker's record is missing, so a worker who already has
  /// a name, state and city never sees one.
  ///
  /// IT IS ALSO THE SIGNAL THAT THIS OPEN IS NOT AN EMPTY IMPORT. The #1660
  /// "Resume dekh liya, lekin poori jaankari nahi ban paayi" line infers a
  /// failed import from `resume_pending` being absent — which is now wrong on
  /// every intake open, where the absence means "we are asking your name", not
  /// "your résumé gave us nothing".
  final String? questionKey;

  /// ADR-0048 — `opening_answer_type` (`text` for every intake question today).
  /// Null when the server sent none, and the composer then behaves as it always
  /// has.
  final String? answerType;

  @override
  List<Object?> get props =>
      <Object?>[text, ttsText, resumePending, options, questionKey, answerType];
}
