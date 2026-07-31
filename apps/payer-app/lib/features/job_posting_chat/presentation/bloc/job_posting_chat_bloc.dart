import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/job_posting_chat_models.dart';
import '../../../../core/data/models.dart';
import '../../domain/chat_message.dart';
import '../../domain/job_posting_chat_repository.dart';

// ---------------- Events ----------------

sealed class JobPostingChatEvent extends Equatable {
  const JobPostingChatEvent();

  @override
  List<Object?> get props => <Object?>[];
}

/// Fired once when the screen mounts. [resumeSessionId] is the cross-device
/// pickup: non-null → bind that existing session and hydrate its transcript
/// instead of opening a new one.
class JobPostingChatStarted extends JobPostingChatEvent {
  const JobPostingChatStarted({this.resumeSessionId});

  final String? resumeSessionId;

  @override
  List<Object?> get props => <Object?>[resumeSessionId];
}

/// The payer sent a message.
class JobPostingChatMessageSent extends JobPostingChatEvent {
  const JobPostingChatMessageSent(this.text);

  final String text;

  @override
  List<Object?> get props => <Object?>[text];
}

/// Re-send the failed payer message at [index]. The transcript is append-only,
/// so an index stays stable once emitted.
class JobPostingChatRetryRequested extends JobPostingChatEvent {
  const JobPostingChatRetryRequested(this.index);

  final int index;

  @override
  List<Object?> get props => <Object?>[index];
}

/// Publish the draft through the existing job-posting create path.
class JobPostingChatPublishRequested extends JobPostingChatEvent {
  const JobPostingChatPublishRequested();
}

// ---------------- State ----------------

/// Outcome of the publish action, consumed once by the screen (toast + close).
enum PublishOutcome {
  /// Nothing has been attempted yet.
  none,

  /// The posting was created.
  success,

  /// The server rejected the draft as incomplete (400).
  incomplete,

  /// A 409 — the session is already published, OR the engine has not called the
  /// draft ready. The server does not distinguish the two on the wire, so the
  /// copy must not claim to either.
  conflict,

  /// Transport / server failure — retryable.
  failed,
}

class JobPostingChatState extends Equatable {
  const JobPostingChatState({
    required this.messages,
    this.initializing = true,
    this.sending = false,
    this.followups = const <String>[],
    this.sessionFailed = false,
    this.draft = const JobPostingDraft(),
    this.draftReady = false,
    this.lastReplyBlocked = false,
    this.lastReplyMock = false,
    this.publishing = false,
    this.publishOutcome = PublishOutcome.none,
    this.publishedJobId,
  });

  /// Ordered, append-only transcript.
  final List<ChatMessage> messages;

  /// True while the session is being opened/hydrated.
  final bool initializing;

  /// True while a reply is in flight — drives the typing indicator so a real
  /// (1–3s) engine turn does not look frozen.
  final bool sending;

  /// Tap-to-answer chips for the LATEST reply. Cleared the moment the payer
  /// sends again (they belong to a question already answered).
  final List<String> followups;

  /// True when opening the session failed and no send has healed it yet —
  /// drives a banner, so the payer is TOLD rather than typing into a session
  /// that was never opened.
  final bool sessionFailed;

  /// The draft as the SERVER last reported it. Never assembled client-side.
  final JobPostingDraft draft;

  /// The engine's own readiness decision (`draft_ready`).
  ///
  /// STICKY by design — it latches on the first `true` and never falls back.
  /// The engine's signal is monotonic in practice, and a transient false (a
  /// degraded reply, a field lost in a partial parse) must never yank the
  /// Publish action away from a payer who was already told they could finish.
  final bool draftReady;

  /// True when the MOST RECENT reply was blocked (pseudonymization failed
  /// closed, invariant #3): the payer's last answer was NOT processed, so the
  /// screen cues them to say it again. Turn-scoped — the next good turn clears
  /// it.
  final bool lastReplyBlocked;

  /// True when the most recent reply came from the mock/AI-down fallback.
  final bool lastReplyMock;

  final bool publishing;

  /// One-shot publish result the screen consumes (toast + close).
  final PublishOutcome publishOutcome;

  /// Id of the posting created by a successful publish.
  final String? publishedJobId;

  JobPostingChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
    bool? sessionFailed,
    JobPostingDraft? draft,
    bool? draftReady,
    bool? lastReplyBlocked,
    bool? lastReplyMock,
    bool? publishing,
    PublishOutcome? publishOutcome,
    String? publishedJobId,
  }) {
    return JobPostingChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
      sessionFailed: sessionFailed ?? this.sessionFailed,
      draft: draft ?? this.draft,
      // Latch: once ready, always ready (see the field doc).
      draftReady: this.draftReady || (draftReady ?? false),
      lastReplyBlocked: lastReplyBlocked ?? this.lastReplyBlocked,
      lastReplyMock: lastReplyMock ?? this.lastReplyMock,
      publishing: publishing ?? this.publishing,
      publishOutcome: publishOutcome ?? this.publishOutcome,
      publishedJobId: publishedJobId ?? this.publishedJobId,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        messages,
        initializing,
        sending,
        followups,
        sessionFailed,
        draft,
        draftReady,
        lastReplyBlocked,
        lastReplyMock,
        publishing,
        publishOutcome,
        publishedJobId,
      ];
}

// ---------------- Bloc ----------------

/// The CLIENT-side opening line, shown before the engine's first turn exists.
///
/// FALLBACK, NOT THE ONLY PATH: `POST /payer/job-posting-chat/session` may serve
/// the engine's own opener (`opening_text`), and the bloc swaps it into bubble 0
/// when it arrives. This constant is what the payer sees when it does not — AI
/// service unreachable, mock client, or an API build that predates the field.
/// The chat must never open on a blank bubble.
///
/// THE COPY deliberately does NOT greet the payer by company name and does NOT
/// ask for one: the org name is auto-filled server-side from `payers.orgNameEnc`
/// at publish time and never enters the conversation or the LLM (ADR-0035
/// §Decision 3). It asks the engine's actual first topic — the role — so turn 1
/// advances instead of repeating itself.
const String kJobPostingChatOpeningText =
    'Namaste! Main aapki job posting banane mein madad karunga. '
    'Shuru karte hain — aapko kis kaam ke liye log chahiye?';

const ChatMessage kJobPostingChatOpeningMessage = ChatMessage(
  text: kJobPostingChatOpeningText,
  fromPayer: false,
);

class JobPostingChatBloc
    extends Bloc<JobPostingChatEvent, JobPostingChatState> {
  JobPostingChatBloc(this._repo)
      : super(
          const JobPostingChatState(
            messages: <ChatMessage>[kJobPostingChatOpeningMessage],
          ),
        ) {
    on<JobPostingChatStarted>(_onStarted);
    on<JobPostingChatMessageSent>(_onMessageSent);
    on<JobPostingChatRetryRequested>(_onRetryRequested);
    on<JobPostingChatPublishRequested>(_onPublishRequested);
  }

  final JobPostingChatRepository _repo;

  /// How many sends are awaiting a reply right now.
  ///
  /// bloc 8.x processes events CONCURRENTLY (no transformer is registered), so
  /// two quick sends overlap. The counter keeps [JobPostingChatState.sending]
  /// honest: the typing indicator stays up until the LAST in-flight reply lands,
  /// not the first.
  int _inFlightSends = 0;

  Future<void> _onStarted(
    JobPostingChatStarted event,
    Emitter<JobPostingChatState> emit,
  ) async {
    bool failed = false;
    JobPostingChatTurn? opening;

    final String? resumeId = event.resumeSessionId;
    final bool resuming = resumeId != null && resumeId.isNotEmpty;
    if (resuming) {
      // CROSS-DEVICE PICKUP: bind the existing session. No opener — the payer is
      // mid-conversation and re-greeting them would read as not having listened.
      _repo.resumeSession(resumeId);
    } else {
      try {
        opening = await _repo.openSession();
      } catch (_) {
        // Do NOT swallow. The spinner still drops so the payer can type, but the
        // failure is SURFACED: the repository re-opens lazily on the next send,
        // and until that succeeds the banner says the connection is not up.
        failed = true;
      }
    }

    // Drop the spinner + apply the served opener NOW, before any hydration
    // await — a concurrent first send (the fast-typist race) must not be
    // reordered behind a slow transcript read.
    emit(state.copyWith(
      initializing: false,
      sessionFailed: failed,
      messages: _withOpener(opening?.reply),
      followups: opening?.suggestedReplies,
      draft: opening?.draft,
      draftReady: opening?.draftReady,
    ));

    if (failed) return;

    // Hydration as a FOLLOW-UP emit — this is what makes a session started on
    // another device readable here. It carries the DRAFT and the engine's
    // readiness decision too, so a resumed chat shows what was already built
    // without the payer having to send another message.
    //
    // BEST-EFFORT: a hiccup degrades to "no history" and never blocks the
    // already-open chat.
    JobPostingChatTranscript? transcript;
    try {
      transcript = await _repo.loadTranscript();
    } catch (_) {
      transcript = null;
    }
    if (transcript == null) return;

    final List<ChatMessage> history = <ChatMessage>[
      for (final JobPostingChatMessageRow row in transcript.messages)
        if ((row.bodyText ?? '').trim().isNotEmpty)
          ChatMessage(text: row.bodyText!, fromPayer: row.fromPayer),
    ];
    final List<ChatMessage>? redrawn = _historyRedraw(history);
    // Only adopt the hydrated draft/chips on the RESUME path. On a fresh session
    // the opening turn above is newer than anything this read can return, and a
    // late hydration must not overwrite a turn the payer has already had.
    emit(state.copyWith(
      messages: redrawn,
      draft: resuming ? transcript.draft : null,
      draftReady: resuming ? transcript.draftReady : null,
      followups: resuming && redrawn != null ? transcript.suggestedReplies : null,
    ));
  }

  /// The transcript with bubble 0 swapped for the server-served [opener], or
  /// null = "leave messages alone" (the [JobPostingChatState.copyWith]
  /// contract).
  ///
  /// REPLACES rather than APPENDS: appending would greet the payer twice with
  /// two different openers, and the canned one already asks the role question —
  /// they would answer it, then be asked again.
  ///
  /// Rebuilt from `state.messages` AT EMIT TIME, never from a list captured
  /// before the await: bloc 8.x runs events concurrently, so a fast payer can
  /// have typed before the session call returned and a captured list would
  /// silently drop their message.
  List<ChatMessage>? _withOpener(String? opener) {
    if (opener == null || opener.trim().isEmpty) return null;
    final List<ChatMessage> messages = state.messages;
    if (messages.isEmpty || messages.first.fromPayer) return null;
    if (messages.first.text == opener) return null; // already applied
    return <ChatMessage>[
      ChatMessage(text: opener, fromPayer: false),
      ...messages.skip(1),
    ];
  }

  /// The greeting bubble followed by the server-side transcript, or null when
  /// there is nothing to redraw.
  ///
  /// REDRAWS ONLY WHEN THE PAYER HAS NOT TYPED YET. A payer who has already sent
  /// a message (the live path, or a fast-typist race during the hydration await)
  /// must never have their bubbles replaced.
  List<ChatMessage>? _historyRedraw(List<ChatMessage> history) {
    if (history.isEmpty) return null;
    final List<ChatMessage> base = state.messages;
    if (base.any((ChatMessage m) => m.fromPayer)) return null;
    final List<ChatMessage> opening = base.isNotEmpty && !base.first.fromPayer
        ? <ChatMessage>[base.first]
        : const <ChatMessage>[];
    // Hydrating a resumed session: the stored transcript already contains its
    // own opener row, so drop the client's canned bubble to avoid two greetings.
    final bool historyStartsWithAssistant = !history.first.fromPayer;
    return <ChatMessage>[
      if (!historyStartsWithAssistant) ...opening,
      ...history,
    ];
  }

  Future<void> _onMessageSent(
    JobPostingChatMessageSent event,
    Emitter<JobPostingChatState> emit,
  ) async {
    final String text = event.text.trim();
    if (text.isEmpty) return;

    final int index = state.messages.length;
    emit(state.copyWith(
      messages: <ChatMessage>[
        ...state.messages,
        ChatMessage(text: text, fromPayer: true),
      ],
      sending: true,
      followups: const <String>[],
    ));

    await _deliver(text, index, emit);
  }

  /// Sends [text] (already appended at [index]) and records the outcome. Shared
  /// by a first send and a retry so both surface failure identically.
  Future<void> _deliver(
    String text,
    int index,
    Emitter<JobPostingChatState> emit,
  ) async {
    _inFlightSends++;
    try {
      final JobPostingChatTurn turn = await _repo.sendMessage(text);
      _inFlightSends--;
      emit(state.copyWith(
        // Append to CURRENT state, never to a list captured before the await:
        // while this reply was in flight another send may have appended bubbles,
        // and re-emitting a pre-await snapshot would ERASE them.
        messages: <ChatMessage>[
          ..._withStatus(state.messages, index, ChatSendStatus.sent),
          ChatMessage(text: turn.reply, fromPayer: false),
        ],
        sending: _inFlightSends > 0,
        followups: turn.suggestedReplies,
        // A delivered message proves the session is open again.
        sessionFailed: false,
        // TRUST THE SERVER'S DRAFT ONLY. A blocked turn carries no state change,
        // so keep the draft we already had rather than letting a fallback reply
        // blank out fields the payer already gave.
        draft: turn.blocked ? state.draft : (turn.draft ?? state.draft),
        draftReady: turn.draftReady,
        lastReplyBlocked: turn.blocked,
        lastReplyMock: turn.isMock,
      ));
    } catch (_) {
      _inFlightSends--;
      // Do NOT keep the bubble looking delivered. Mark it FAILED so it reads as
      // undelivered and offers tap-to-retry.
      emit(state.copyWith(
        messages: _withStatus(state.messages, index, ChatSendStatus.failed),
        sending: _inFlightSends > 0,
      ));
    }
  }

  /// Returns [messages] with the entry at [index] set to [status]. Out-of-range
  /// indices are returned unchanged (defensive — the list is append-only).
  List<ChatMessage> _withStatus(
    List<ChatMessage> messages,
    int index,
    ChatSendStatus status,
  ) {
    if (index < 0 || index >= messages.length) return messages;
    if (messages[index].status == status) return messages;
    final List<ChatMessage> next = List<ChatMessage>.of(messages);
    next[index] = next[index].copyWith(status: status);
    return next;
  }

  Future<void> _onRetryRequested(
    JobPostingChatRetryRequested event,
    Emitter<JobPostingChatState> emit,
  ) async {
    final int index = event.index;
    if (index < 0 || index >= state.messages.length) return;
    final ChatMessage message = state.messages[index];
    if (!message.fromPayer || message.status != ChatSendStatus.failed) return;

    emit(state.copyWith(
      messages: _withStatus(state.messages, index, ChatSendStatus.sent),
      sending: true,
      followups: const <String>[],
    ));

    await _deliver(message.text, index, emit);
  }

  /// Publishes the draft. The SERVER is the authority: it re-validates against
  /// `PayerCreateJobPostingSchema` and calls the same `createForPayer` the
  /// manual form uses (which already emits `job_posting.created`). This bloc
  /// only reports the outcome honestly.
  Future<void> _onPublishRequested(
    JobPostingChatPublishRequested event,
    Emitter<JobPostingChatState> emit,
  ) async {
    if (state.publishing) return; // one in-flight publish per session
    emit(state.copyWith(
      publishing: true,
      publishOutcome: PublishOutcome.none,
    ));
    try {
      final String jobPostingId = await _repo.publish();
      emit(state.copyWith(
        publishing: false,
        publishOutcome: PublishOutcome.success,
        publishedJobId: jobPostingId,
      ));
    } on PayerApiException catch (e) {
      emit(state.copyWith(
        publishing: false,
        publishOutcome: switch (e.statusCode) {
          400 => PublishOutcome.incomplete,
          409 => PublishOutcome.conflict,
          _ => PublishOutcome.failed,
        },
      ));
    } catch (_) {
      emit(state.copyWith(
        publishing: false,
        publishOutcome: PublishOutcome.failed,
      ));
    }
  }
}
