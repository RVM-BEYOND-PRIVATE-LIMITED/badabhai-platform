import 'package:equatable/equatable.dart';

/// Delivery state of a WORKER message (#343).
///
/// Bada bhai's own messages are always [sent] — they exist because the server
/// already answered. Only the worker's bubbles can fail, and a failed one must
/// SAY so and offer a retry: silently rendering an undelivered message as if it
/// landed is what let a whole profiling session be discarded unnoticed.
enum ChatSendStatus {
  /// Delivered to the server (or a bada-bhai message, which is always this).
  sent,

  /// The send threw. The bubble stays in the transcript, marked, tap-to-retry.
  failed,
}

/// One message in the "bada bhai" profiling chat. UI state (an ordered,
/// append-only transcript) — not an API shape, so it lives in the domain.
class ChatMessage extends Equatable {
  const ChatMessage({
    required this.text,
    required this.fromWorker,
    this.status = ChatSendStatus.sent,
    this.submissionId,
    this.ttsText,
    this.canReadAloud = true,
  });

  final String text;
  final bool fromWorker;

  /// Delivery state — meaningful only when [fromWorker]. Defaults to [sent] so
  /// bada-bhai bubbles and the optimistic worker bubble read as normal.
  final ChatSendStatus status;

  /// The per-submission id (#870) minted ONCE when this worker bubble was
  /// created and carried on the bubble so a retry re-sends the SAME id. Lets the
  /// server tell a retried POST of one answer from a worker genuinely repeating
  /// the same words. Null on bada-bhai bubbles and any non-submission bubble; it
  /// is never sent for them.
  final String? submissionId;

  /// The Devanagari read-aloud rendering of [text] (`tts_text`, #896), carried
  /// on a BOT bubble so the on-device hi-IN voice pronounces the Hindi correctly
  /// (romanized [text] reads as gibberish to every TTS voice). Null on a worker
  /// bubble and on an older-API bot bubble — read-aloud then speaks [text]. Never
  /// displayed; the bubble always shows [text].
  final String? ttsText;

  /// Whether this bubble may be READ ALOUD at all (ADR-0046 O9, Phase 3).
  ///
  /// False on a MODEL-WRITTEN turn, which the server marks with
  /// `read_aloud: false`. Such a turn has no reviewed Devanagari twin, and
  /// [ttsText] is therefore null — so the shipped `ttsText ?? text` fallback
  /// would hand the hi-IN voice the model's raw romanized Hinglish and read it
  /// as gibberish. The contract is explicit that the app must NOT fall back to
  /// speaking `reply`, so a bubble with this false is offered no speaker button
  /// and is never auto-read.
  ///
  /// Defaults to TRUE, which is every bubble the app has ever shown: fixed copy
  /// and interview questions carry a reviewed twin and are read aloud exactly as
  /// before. Only a turn that explicitly says `read_aloud: false` opts out.
  final bool canReadAloud;

  ChatMessage copyWith({ChatSendStatus? status}) => ChatMessage(
        text: text,
        fromWorker: fromWorker,
        status: status ?? this.status,
        // Preserved, never regenerated: a retry (which flips status) must keep
        // the ORIGINAL id so the re-POST is recognisable as the same submission.
        submissionId: submissionId,
        // Preserved: flipping status must not drop the read-aloud script (#896).
        ttsText: ttsText,
        // Preserved for the same reason: a status flip must not silently make a
        // model-written bubble speakable again.
        canReadAloud: canReadAloud,
      );

  @override
  List<Object?> get props =>
      <Object?>[text, fromWorker, status, submissionId, ttsText, canReadAloud];
}
