import 'package:equatable/equatable.dart';

import 'chat_news_link.dart';

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
/// How a worker bubble's answer was composed — the location-write gate
/// (identity intake D7, `POST /chat/message` `answer_source`).
///
/// `dialog`: pressed through the location card's own pickers (state dropdown,
/// city list incl. its custom entry, GPS fill) via Theek hai. `typed`:
/// everything else — composer text, chips, voice transcripts. Only the
/// intake's `state`/`city` steps read it; every other question is source-blind.
enum ChatAnswerSource {
  typed,
  dialog;

  /// The wire value (`answer_source`).
  String get wire => switch (this) {
        ChatAnswerSource.typed => 'typed',
        ChatAnswerSource.dialog => 'dialog',
      };
}

class ChatMessage extends Equatable {
  const ChatMessage({
    required this.text,
    required this.fromWorker,
    this.status = ChatSendStatus.sent,
    this.submissionId,
    this.answerSource,
    this.ttsText,
    this.canReadAloud = true,
    this.newsLinks = const <ChatNewsLink>[],
    this.bulleted = false,
    this.closesSession = false,
    this.extractionReady = false,
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

  /// How this worker bubble was composed (null = typed/legacy). Rides the
  /// bubble beside [submissionId] so a retry re-sends the SAME source: a
  /// retried dialog answer must not be demoted to a re-ask server-side.
  /// Null on bada-bhai bubbles; never rendered, only sent.
  final ChatAnswerSource? answerSource;

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

  /// ADR-0054 §3.4 (#2148) — the "read more" tiles drawn under THIS bubble.
  /// Empty on a worker bubble and on every bot turn that served none, so the
  /// transcript needs no second list to know which bubble owns which tiles.
  final List<ChatNewsLink> newsLinks;

  /// Render the `\n`-separated lines as a lead line + bullet list instead of
  /// one paragraph. Set ONLY on companion turns whose lines are
  /// server-composed reviewed copy (the companion server-composes every such
  /// reply from per-fact lines and joins them with `\n`), so splitting
  /// recovers the server's own structure — never a re-parse of prose. A
  /// model-written turn (`read_aloud: false`, no reviewed twin) and every
  /// interview turn keep `false`, so model prose is never reformatted by the
  /// client.
  final bool bulleted;

  /// #2258 — this redrawn bubble is the one that CLOSED its session.
  ///
  /// Set only by the transcript redraw (`ChatRepositoryImpl.loadHistory`), on
  /// the last KEPT bubble at or before the server's `session_ended_at`, so a
  /// cold reopen of a finished interview can draw the "End of conversation"
  /// marker where the live close drew it. Every live bubble keeps `false`; the
  /// live close sets its marker from the turn itself.
  final bool closesSession;

  /// #2331 — the session that closed on THIS bubble finished with the
  /// build-profile CTA lit (the server's `extraction_ready`), so a COLD REOPEN
  /// must draw the "Ho gaya — meri profile banaiye" button under the divider
  /// without the worker sending anything.
  ///
  /// Set only by the transcript redraw (`ChatRepositoryImpl.loadHistory`), on
  /// the SAME closing bubble as [closesSession] — one marker, one gate. Every
  /// live bubble keeps `false`; the live close lights the bloc's flag from the
  /// turn itself. It reads false on an abandoned session, a form handover and an
  /// older API build, so those correctly show no CTA.
  final bool extractionReady;

  ChatMessage copyWith({ChatSendStatus? status}) => ChatMessage(
    text: text,
    fromWorker: fromWorker,
    status: status ?? this.status,
    // Preserved, never regenerated: a retry (which flips status) must keep
    // the ORIGINAL id so the re-POST is recognisable as the same submission.
    submissionId: submissionId,
    // Preserved for the same reason: a retried dialog answer must keep its
    // source so the intake does not demote it to a re-ask.
    answerSource: answerSource,
    // Preserved: flipping status must not drop the read-aloud script (#896).
    ttsText: ttsText,
    // Preserved for the same reason: a status flip must not silently make a
    // model-written bubble speakable again.
    canReadAloud: canReadAloud,
    // Preserved: a status flip must not silently un-bullet a recap.
    bulleted: bulleted,
    // Preserved: a status flip must not move the "End of conversation" marker.
    closesSession: closesSession,
    // Preserved: a status flip must not drop the #2331 done-CTA gate.
    extractionReady: extractionReady,
  );

  @override
  List<Object?> get props => <Object?>[
    text,
    fromWorker,
    status,
    submissionId,
    answerSource,
    ttsText,
    canReadAloud,
    bulleted,
    closesSession,
    extractionReady,
  ];
}
