import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:uuid/uuid.dart';

import '../../../../core/api/api_models.dart'
    show
        ChatInputMode,
        ChatOption,
        ChatProgress,
        ChatQuestionKind,
        FormOffer,
        PredictedQuestion;
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../../../core/session/known_worker_facts_store.dart';
import '../../domain/chat_answered_facts.dart';
import '../../domain/chat_message.dart';
import '../../domain/chat_repository.dart';
import '../../domain/chat_session_opening.dart';
import '../../domain/chat_turn.dart';

// ---------------- Events ----------------

sealed class ChatEvent extends Equatable {
  const ChatEvent();

  @override
  List<Object?> get props => <Object?>[];
}

/// Fired once when the screen mounts: opens the chat session.
class ChatStarted extends ChatEvent {
  const ChatStarted();
}

/// The worker sent a message.
///
/// [optionKey] is set ONLY when the message came from tapping a suggested-option
/// chip (#761): it is the key to index the previous turn's `lookahead` by — the
/// tapped label on chat, or `'__declined'` for the decline/escape chip. A typed
/// send leaves it null and never renders a prediction. It does NOT change the
/// submit: the wire body stays `{session_id, text}` with `text` = [text].
///
/// [servedOption] says whether [text] is a SERVED option the worker tapped —
/// a none-of-above option included — and is what a closing fact is recorded
/// on, not [optionKey]. shift_preference's 'Koi bhi chalegi' is none-of-above,
/// so it is keyed `'__declined'` for the lookahead, yet the server stores it as
/// shift `any`; judging by the key left the shift unrecorded and the form asked
/// it again. A typed send and the decline/escape chip leave it false.
class ChatMessageSent extends ChatEvent {
  const ChatMessageSent(this.text, {this.optionKey, this.servedOption = false});

  final String text;
  final String? optionKey;
  final bool servedOption;

  @override
  List<Object?> get props => <Object?>[text, optionKey, servedOption];
}

/// Re-send the failed worker message at [index] (#343). The transcript is
/// append-only, so an index stays stable once emitted.
class ChatRetryRequested extends ChatEvent {
  const ChatRetryRequested(this.index);

  final int index;

  @override
  List<Object?> get props => <Object?>[index];
}

/// A voice note completed on the voice screen: its transcript was ALREADY sent
/// server-side (merged like a typed message by the voice pipeline) and [reply]
/// is bada bhai's answer. This appends both bubbles locally — NO network call,
/// or the message would be sent twice.
class ChatVoiceMerged extends ChatEvent {
  const ChatVoiceMerged({
    required this.transcript,
    required this.reply,
    this.extractionReady = false,
  });

  final String transcript;
  final String reply;

  /// The engine's readiness decision for the turn the voice note produced
  /// (#421) — a worker who finishes the interview BY VOICE must unlock the
  /// same CTA as one who typed.
  final bool extractionReady;

  @override
  List<Object?> get props => <Object?>[transcript, reply, extractionReady];
}

/// The worker chose "Chat se resume banayein" on the post-completion résumé
/// menu (#1566): mint a genuinely NEW session and reset the transcript to a
/// fresh opener. The ended session — and its stored transcript — is preserved
/// server-side; only this client's cached id and visible thread are replaced.
class ChatSessionRestarted extends ChatEvent {
  const ChatSessionRestarted();
}

/// ADR-0044 — the Bada Bhai TAB opened: ask the server whether this worker is
/// in the post-completion COMPANION before touching any chat session.
///
/// Dispatched INSTEAD OF [ChatStarted], and only by the tab. When the answer is
/// "not a companion" — or anything fails — the handler runs the exact
/// [ChatStarted] logic, so the tab behaves as it always has. When it is a
/// companion, no session is opened, resumed or minted at all.
class ChatCompanionStarted extends ChatEvent {
  const ChatCompanionStarted();
}

/// ADR-0044 — the Bada Bhai tab came back into focus. In companion mode the
/// recap is re-read, and a NEW bubble is appended only when its facts changed
/// (the server's `digest_key`) — the worker who just applied on the Jobs tab sees
/// the new count; a worker who changed nothing sees nothing new.
class ChatCompanionRefreshRequested extends ChatEvent {
  const ChatCompanionRefreshRequested({this.force = false});

  /// Skip the 60 s throttle (#1747 review).
  ///
  /// The throttle exists for tab refocus, which a worker can trigger as fast as
  /// he can tap. A return from the companion's OWN job detail is not that: it is
  /// one deliberate trip, and the fact it most likely changed — "jobs applied
  /// to" — is the one the recap leads with. Without this the counts a worker
  /// just moved stay stale on screen for a minute, which reads as the tab not
  /// having noticed he applied.
  final bool force;

  @override
  List<Object?> get props => <Object?>[force];
}

// ---------------- State ----------------

class ChatState extends Equatable {
  const ChatState({
    required this.messages,
    this.initializing = true,
    this.sending = false,
    this.followups = const <String>[],
    this.suggestedOptions = const <ChatOption>[],
    this.sessionFailed = false,
    this.extractionReady = false,
    this.unansweredEssentials = const <String>[],
    this.lastReplyBlocked = false,
    this.lastReplyMock = false,
    this.progress,
    this.questionKind = ChatQuestionKind.ask,
    this.inputMode = ChatInputMode.text,
    this.occupationLabel,
    this.lookahead = const <String, PredictedQuestion?>{},
    this.predictedQuestionKey,
    this.formOffer,
    this.resumePending = false,
    this.resumeUpdateQueued = false,
    this.companion = false,
  });

  /// Ordered, append-only transcript.
  final List<ChatMessage> messages;

  /// True while the session is being opened (shows a spinner, as before).
  final bool initializing;

  /// True while a reply is in flight — drives the "Bada Bhai type kar raha
  /// hai…" indicator so a real (1–3s) LLM turn does not look frozen.
  final bool sending;

  /// Tap-to-answer suggestions for the LATEST reply (backend
  /// `suggested_followups`). Cleared the moment the worker sends again.
  final List<String> followups;

  /// The LATEST reply's `suggested_options` (#761), served ALONGSIDE [followups].
  /// When non-empty the screen renders chips from THIS list so each carries its
  /// stable `option_key` (indexed against [lookahead] on tap); empty falls back
  /// to the label-keyed [followups]. Cleared on send exactly like [followups].
  final List<ChatOption> suggestedOptions;

  /// True when opening the chat session failed and no send has healed it yet
  /// (#343) — drives a banner, so the worker is TOLD rather than typing into a
  /// session that was never opened.
  final bool sessionFailed;

  /// True once the interview engine has reported `extraction_ready` on any turn
  /// of this session (#421) — i.e. it has enough answers to build a profile.
  ///
  /// STICKY by design: it latches on the first `true` and never falls back to
  /// false. The engine's own signal is monotonic in practice (past readiness it
  /// wraps up and keeps returning true), and a transient false — a degraded
  /// reply, a field lost in a partial parse — must never yank the CTA out from
  /// under a worker who was already told they could finish.
  final bool extractionReady;

  /// ESSENTIAL topics the worker has not answered yet (`unanswered_essentials`,
  /// #478), from the LATEST non-blocked turn — topic ids only, never PII. Drives
  /// the named "what's still missing" helper. NOT latched: it must reflect the
  /// current gaps, which shrink as the worker answers. A blocked turn leaves it
  /// unchanged (blocked → "unknown", never "complete").
  final List<String> unansweredEssentials;

  /// True when the MOST RECENT reply was blocked (pseudonymize fail-closed): the
  /// worker's last answer was not processed, so the screen cues them to repeat
  /// it. Turn-scoped (not latched) — the next good turn clears it.
  final bool lastReplyBlocked;

  /// True when the most recent reply came from the mock/AI-down fallback
  /// (`is_mock`). Surfaced only as a non-release demo cue (see [ChatTurn.isMock]).
  final bool lastReplyMock;

  /// How far through the pinned pack the worker is (#649). STICKY-FORWARD: once a
  /// pack pins (first non-null), it stays and reflects the latest count; a null
  /// on a later/blocked turn leaves the last known value rather than flickering
  /// the finish line away. Null until the first pack resolves — the bar is hidden.
  final ChatProgress? progress;

  /// The latest turn's kind (#649). TURN-SCOPED — reset to [ChatQuestionKind.ask]
  /// on send, set from the reply; only [ChatQuestionKind.disambiguate] changes
  /// how the followups render.
  final ChatQuestionKind questionKind;

  /// The latest turn's input mode (#770). TURN-SCOPED exactly like [questionKind]
  /// — reset to [ChatInputMode.text] on send, set from the reply. When
  /// [ChatInputMode.optionsOnly] the composer is suppressed and the chips are the
  /// only answer path. Never latched: the composer returns on the next turn
  /// unless the server re-imposes options-only.
  final ChatInputMode inputMode;

  /// The worker's pinned trade in their own vernacular (#649). STICKY: latches on
  /// the first non-null and stays (the trust moment, shown for the rest of the
  /// interview). A fresh chat rebuilds the bloc, so it clears there.
  final String? occupationLabel;

  /// The LATEST turn's advisory next-turn predictions (#761), keyed by the tapped
  /// option (+ `'__declined'`). Consumed by the NEXT [ChatMessageSent] to render
  /// the predicted question optimistically. Empty = no predictions.
  final Map<String, PredictedQuestion?> lookahead;

  /// The `question_key` of the optimistic predicted bubble currently on screen
  /// (#761), or null when there is none — which is EITHER no prediction rendered
  /// OR a `close`-shaped prediction (those carry a null key and so are never
  /// rendered optimistically; the client waits the round trip for the closing
  /// line). Non-null therefore means "an optimistic bubble is awaiting reconcile":
  /// the next real turn replaces it, and its `asked_question_id` is compared
  /// against this to tell whether the prediction was right.
  final String? predictedQuestionKey;

  /// THE INTERVIEW HANDED OVER TO A FORM (`form_offer`, #1339/#1340), from the
  /// LATEST turn — null on every turn except the one that hands over.
  ///
  /// TURN-SCOPED, like [questionKind] and [inputMode], NOT sticky like
  /// [extractionReady]: it is set from a live reply and reset back to null the
  /// moment the worker acts again (a new send, a retry, a voice merge) so a
  /// stale card can never survive past the turn that offered it. In practice a
  /// handover turn also ends the session, so there is no "next turn" to answer
  /// — but the reset keeps the invariant true defensively rather than by luck.
  final FormOffer? formOffer;

  /// #1689 — the server ACCEPTED the worker's "Haan" to "Aapki nayi jaankari se
  /// resume update kar doon?" and is doing the whole update itself: extract,
  /// auto-confirm, generate.
  ///
  /// What it changes: the app must NOT open the profile preview/confirm step
  /// and must NOT call extract / confirm / generate of its own. The worker's
  /// "Haan" WAS the consent, and a client-side call on this path would mint a
  /// duplicate history entry for work the server already has in flight. The
  /// screen sends them to the Resume tab to watch it land (#1688) instead.
  ///
  /// TURN-SCOPED like [formOffer], not sticky: it describes the one terminal
  /// turn that settled the answer. Every turn passes it explicitly, so a later
  /// turn without it clears it without needing a `clear…` flag (a bool has no
  /// null to confuse with false).
  final bool resumeUpdateQueued;

  /// True when THIS session opened on the server's résumé-confirm first turn
  /// (`resume_pending`, ADR-0042 D8, #1523). Set once from [ChatStarted]'s open
  /// result and STICKY for the life of the bloc. It exists so the UI and tests
  /// can assert that a résumé-routed session never fell back to the canned
  /// "aap kaunsa kaam karte hain?" opener.
  final bool resumePending;

  /// ADR-0044 — the tab is in the post-completion COMPANION: sends go to
  /// `/chat/companion/message`, the "build my profile" CTA is hidden (the profile
  /// is done), and a turn is never counted as an answered interview ask.
  ///
  /// TURN-SCOPED like [resumeUpdateQueued], not latched: the companion open sets
  /// it, every companion turn keeps it, and the first INTERVIEW turn (a 409
  /// fallback, "Chat se resume banayein") clears it — so the UI always reflects
  /// what the last reply actually was.
  final bool companion;

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
    List<ChatOption>? suggestedOptions,
    bool? sessionFailed,
    bool? extractionReady,
    List<String>? unansweredEssentials,
    bool? lastReplyBlocked,
    bool? lastReplyMock,
    ChatProgress? progress,
    ChatQuestionKind? questionKind,
    ChatInputMode? inputMode,
    String? occupationLabel,
    Map<String, PredictedQuestion?>? lookahead,
    String? predictedQuestionKey,
    // predictedQuestionKey is nullable AND must be settable back to null on
    // reconcile — which `?? this` cannot express — so clearing it takes an
    // explicit flag (the standard copyWith idiom for a clearable nullable).
    bool clearPredictedQuestionKey = false,
    FormOffer? formOffer,
    // Same idiom as [clearPredictedQuestionKey]: formOffer is TURN-SCOPED
    // (field doc), so a new turn without one must be able to CLEAR the
    // previous turn's card, which `formOffer ?? this.formOffer` cannot express
    // on its own — every non-null-in-the-wire turn passes this explicitly.
    bool clearFormOffer = false,
    bool? resumePending,
    bool? resumeUpdateQueued,
    bool? companion,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
      suggestedOptions: suggestedOptions ?? this.suggestedOptions,
      sessionFailed: sessionFailed ?? this.sessionFailed,
      // Latch: once ready, always ready (see the field doc).
      extractionReady: this.extractionReady || (extractionReady ?? false),
      unansweredEssentials: unansweredEssentials ?? this.unansweredEssentials,
      lastReplyBlocked: lastReplyBlocked ?? this.lastReplyBlocked,
      lastReplyMock: lastReplyMock ?? this.lastReplyMock,
      // Sticky-forward / sticky: a null keeps the last known (see field docs).
      progress: progress ?? this.progress,
      questionKind: questionKind ?? this.questionKind,
      inputMode: inputMode ?? this.inputMode,
      occupationLabel: occupationLabel ?? this.occupationLabel,
      lookahead: lookahead ?? this.lookahead,
      predictedQuestionKey: clearPredictedQuestionKey
          ? null
          : (predictedQuestionKey ?? this.predictedQuestionKey),
      formOffer: clearFormOffer ? null : (formOffer ?? this.formOffer),
      // Sticky: once a résumé-confirm session, always (the opening is applied
      // exactly once and never un-opens).
      resumePending: this.resumePending || (resumePending ?? false),
      // TURN-SCOPED (field doc): the caller always passes this turn's value, so
      // `?? this` only ever holds it across an emit that is not a new turn.
      resumeUpdateQueued: resumeUpdateQueued ?? this.resumeUpdateQueued,
      companion: companion ?? this.companion,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        messages,
        initializing,
        sending,
        followups,
        suggestedOptions,
        sessionFailed,
        extractionReady,
        unansweredEssentials,
        lastReplyBlocked,
        lastReplyMock,
        progress,
        questionKind,
        inputMode,
        occupationLabel,
        lookahead,
        predictedQuestionKey,
        formOffer,
        resumePending,
        resumeUpdateQueued,
        companion,
      ];
}

// ---------------- Bloc ----------------

/// The opening bada-bhai prompt — the CLIENT-side fallback shown when the server
/// serves no opening turn (#422).
///
/// THE FALLBACK, NOT THE ONLY PATH. `POST /chat/session` can serve the opener
/// itself (`opening_text`, behind CHAT_ONE_SHOT_OPENER_ENABLED, or the
/// résumé-confirm first turn, #1523), and [ChatBloc] swaps it into bubble 0 when
/// it arrives. This constant is what the worker sees when it does not: flag off,
/// AI service unreachable, mock client, or an API build that predates the field.
/// Keeping it is the point — the chat must never open on a blank bubble.
///
/// SERVER-OWNED COPY. The server is the source of truth for the opening; this is
/// strictly the offline/no-server-turn fallback. The string is a byte-for-byte
/// twin of `CHAT_OPENING_TEXT` in `apps/api/src/chat/chat-replies.ts`, and
/// `test/features/chat/chat_opening_parity_test.dart` reads that TS file at test
/// time and FAILS if the two drift. If you edit one, edit the other in the same
/// change.
///
/// THE COPY. Warm Hinglish, aap-form, one question per turn (B-5), no worker-name
/// vocative (the persona's `"{{worker_name}} ji, "` slot is filled server-side;
/// the client holds no name and must not render one). No exclamation mark — the
/// persona's Ten Laws forbid it (`test/persona_neutrality_test.dart`).
const String kChatOpeningText =
    'Namaste. Aap kaun sa kaam karte hain, aur kitna tajurba hai?';

/// The DEVANAGARI rendering of [kChatOpeningText] for read-aloud (#896) — the
/// SAME content in the native script so the on-device hi-IN voice pronounces it
/// correctly (romanized Hindi is read as gibberish by every TTS voice). Client
/// constant because the canned opener is: a server-served opening ships its own
/// `opening_tts_text` twin (which then rides bubble 0 instead — see
/// [ChatBloc._withOpener]), and only this fallback has no server twin to carry.
/// It is the twin the API computes for [kChatOpeningText] via
/// `ttsTextFor` (`apps/api/src/profiling/question-tts-text.ts`). Displayed
/// nowhere — spoken only.
const String kChatOpeningTtsText =
    'नमस्ते। आप कौन सा काम करते हैं, और कितना तजुर्बा है?';

/// The opening bada-bhai prompt as a transcript bubble. Carries [kChatOpeningTtsText]
/// so read-aloud speaks Devanagari from the very first question (#896).
const ChatMessage kChatOpeningMessage = ChatMessage(
  text: kChatOpeningText,
  fromWorker: false,
  ttsText: kChatOpeningTtsText,
);

/// Sink for the PII-free funnel milestones the chat emits (#B7, #1316) — the
/// terminal [BbAnalytics.chatWrapUp] and the per-ask
/// [BbAnalytics.profilingAnswerSpoken] index. Injectable ONLY so a test can
/// OBSERVE the events without a live Firebase; production always takes
/// [_defaultChatAnalyticsSink].
typedef ChatAnalyticsSink = void Function(BbAnalyticsEvent event);

/// The production sink: fire-and-forget to [BbAnalytics.instance], which is
/// itself fail-open (a device with no Firebase simply records nothing, and a
/// throw never reaches the interview).
void _defaultChatAnalyticsSink(BbAnalyticsEvent event) =>
    unawaited(BbAnalytics.instance.log(event));

class ChatBloc extends Bloc<ChatEvent, ChatState> {
  ChatBloc(
    this._repo, {
    ChatAnalyticsSink? analyticsSink,
    KnownWorkerFactsStore? knownFacts,
    DateTime Function()? clock,
  })  : _analytics = analyticsSink ?? _defaultChatAnalyticsSink,
        _knownFacts = knownFacts,
        _clock = clock ?? DateTime.now,
        super(const ChatState(messages: <ChatMessage>[kChatOpeningMessage])) {
    on<ChatStarted>(_onStarted);
    on<ChatMessageSent>(_onMessageSent);
    on<ChatRetryRequested>(_onRetryRequested);
    on<ChatVoiceMerged>(_onVoiceMerged);
    on<ChatSessionRestarted>(_onSessionRestarted);
    on<ChatCompanionStarted>(_onCompanionStarted);
    on<ChatCompanionRefreshRequested>(_onCompanionRefreshRequested);
  }

  final ChatRepository _repo;

  /// The time source for the companion refresh throttle. Injectable ONLY so a
  /// test can step it; production is [DateTime.now].
  final DateTime Function() _clock;

  /// ADR-0044 — the `digest_key` of the companion recap last shown, so a tab
  /// refocus that changed nothing adds nothing.
  String? _companionDigestKey;

  /// ADR-0044 — when the companion recap was last read; refocus refreshes at
  /// most once per [_companionRefreshMinGap] so tab-flipping costs no requests.
  DateTime? _companionReadAt;
  static const Duration _companionRefreshMinGap = Duration(seconds: 60);

  /// PII-free funnel-milestone sink (#B7, #1316). Defaults to
  /// [BbAnalytics.instance]; a test injects its own to observe the per-ask
  /// indices (and the wrap-up count) deterministically.
  final ChatAnalyticsSink _analytics;

  /// True once the wrap-up milestone has been logged for this session (#B7).
  /// [ChatState.extractionReady] LATCHES, so without this the milestone would
  /// re-fire on every turn after the interview completes and the funnel would
  /// read as many wrap-ups per worker.
  bool _wrapUpLogged = false;

  /// Log the "interview complete" funnel milestone the first time the engine
  /// says so. PII-free: a turn COUNT, never a message, id, or topic.
  void _logWrapUpOnce({required bool ready}) {
    if (!ready || _wrapUpLogged) return;
    _wrapUpLogged = true;
    _analytics(BbAnalytics.chatWrapUp(
      turnCount:
          state.messages.where((ChatMessage m) => m.fromWorker).length,
    ));
  }

  /// Emit the per-ask funnel index (#1316) for ONE answered ask in the chat
  /// interview — the flow workers actually reach. Until now the chat emitted
  /// only the single terminal [_logWrapUpOnce], so a drop-off-by-ask-index curve
  /// could not be drawn; this is the missing per-ask signal, reusing the event
  /// that already existed for the unreachable voice_form.
  ///
  /// [questionIndex] is the 1-based rank of the ask among answered asks — a
  /// COUNT only, matching the voice_form call site. NEVER the question text, the
  /// answer text, or any id (that is exactly the shape
  /// [BbAnalytics.profilingAnswerSpoken] enforces and `analytics_pii_test` scans).
  ///
  /// Fired only when the answer is actually RECORDED — a delivered send or a
  /// server-merged voice note — so a failed-and-abandoned ask is never counted
  /// and a retry never double-counts (the failed first attempt emitted nothing).
  void _logAnswerSpoken(int questionIndex) =>
      _analytics(BbAnalytics.profilingAnswerSpoken(questionIndex: questionIndex));

  /// How many sends are awaiting a reply right now.
  ///
  /// bloc 8.x processes events CONCURRENTLY by default (no transformer is
  /// registered), so two quick sends — or a send racing a [ChatVoiceMerged] —
  /// overlap. The counter keeps [ChatState.sending] honest: the typing indicator
  /// must stay up until the LAST in-flight reply lands, not the first (#344).
  int _inFlightSends = 0;

  /// Where a closing-question answer is recorded once the server processed it,
  /// so a later form does not ask that fact again (see [chatAnsweredFact]).
  /// Null records nothing.
  final KnownWorkerFactsStore? _knownFacts;

  /// The question the latest processed turn asked (`asked_question_id`), i.e.
  /// what the worker's next message answers. Null before the first reply and
  /// on a resumed transcript, where nothing is recorded.
  String? _askedQuestionId;

  Future<void> _onStarted(ChatStarted event, Emitter<ChatState> emit) async {
    bool failed = false;
    ChatSessionOpening? opening;
    try {
      opening = await _repo.ensureSession();
    } on Failure catch (_) {
      // Do NOT swallow this (#343). The spinner still drops so the worker can
      // type, but the failure is now SURFACED: the repository re-opens the
      // session lazily on the next send, and until that succeeds the banner
      // tells the worker the connection is not established.
      failed = true;
    }

    // The opening's chips, if any (a résumé confirm's Haan/Nahi, #1523). The
    // LABELS are what a chip displays and submits; the objects carry the stable
    // option_key the bloc indexes `lookahead` by — exactly a later turn's
    // suggestedOptions/followups pair. Null (no server opening) leaves whatever
    // the state holds, which is the empty default on a fresh mount.
    final List<String>? openingFollowups = opening == null
        ? null
        : <String>[for (final ChatOption o in opening.options) o.labelText];

    // Drop the spinner + apply the served opening NOW — before any hydration
    // await. A concurrent first send (the fast-typist race, #344) must not be
    // reordered behind a slow transcript read: this emit is what the existing
    // ordering contract depends on, so it stays a single await deep, exactly as
    // before #502.
    emit(state.copyWith(
      initializing: false,
      sessionFailed: failed,
      // #1523 — a server opening REPLACES the canned bubbles; without one the
      // state keeps rendering `kChatOpeningMessage` (canned text + Devanagari
      // twin), byte-for-byte as before.
      messages: _withOpener(opening),
      // A résumé-confirm session is flagged so nothing downstream can mistake it
      // for the generic canned opener — the worker must never have seen "aap
      // kaunsa kaam karte hain?" on a resume-routed session.
      resumePending: opening?.resumePending ?? false,
      suggestedOptions: opening?.options,
      followups: openingFollowups,
    ));

    if (failed) return;

    // #502 transcript hydration, as a FOLLOW-UP emit: redraw a prior session's
    // turns that live only server-side. After a >5min background re-lock the app
    // rebuilds [ChatBloc] with just its opener bubble while `chat_messages` still
    // holds every answer — the worker would otherwise land on a BLANK thread
    // mid-interview. BEST-EFFORT and decorative: a hydration hiccup degrades to
    // "no history" (the repo returns [] on error; the catch guards a
    // mock/regression too) and never blocks the already-open chat.
    List<ChatMessage> history;
    try {
      history = await _repo.loadHistory();
    } catch (_) {
      history = const <ChatMessage>[];
    }
    final List<ChatMessage>? redrawn = _historyRedraw(history);
    if (redrawn != null) emit(state.copyWith(messages: redrawn));
  }

  /// The transcript with bubble 0 swapped for the server-served [opener].
  ///
  /// Returns null (= "leave messages alone", the [ChatState.copyWith] contract)
  /// whenever there is no opener to apply, which is every flag-off, AI-service-
  /// down, mock-client and older-API session. Those keep rendering
  /// [kChatOpeningText], so this is additive in the strict sense.
  ///
  /// REPLACES rather than APPENDS. Appending would greet the worker twice with
  /// two different openers, and the canned one asks the `role` question outright
  /// — the worker would answer it, then be invited to answer everything at once,
  /// which reads as the app not having listened.
  ///
  /// Rebuilt from `state.messages` AT EMIT TIME, not from a list captured before
  /// the await. bloc 8.x runs events CONCURRENTLY (no transformer is registered
  /// here), so a fast worker can have typed before the session call returned; a
  /// captured list would silently drop their message. Index 0 is stable under
  /// that race because the transcript is append-only and the constructor seeds
  /// bubble 0 as the opener — nothing can ever insert ahead of it.
  List<ChatMessage>? _withOpener(ChatSessionOpening? opening) {
    if (opening == null || opening.text.trim().isEmpty) return null;
    final List<ChatMessage> messages = state.messages;
    if (messages.isEmpty || messages.first.fromWorker) return null;
    if (messages.first.text == opening.text) return null; // already applied
    return <ChatMessage>[
      // #1526 — the server opener's Devanagari twin (`opening_tts_text`) rides
      // bubble 0 so turn one reads aloud correctly. Null when the server served
      // no twin (e.g. a résumé confirm): read-aloud then speaks the romanized
      // text, never the Canned twin of a DIFFERENT sentence.
      ChatMessage(
        text: opening.text,
        fromWorker: false,
        ttsText: opening.ttsText,
      ),
      ...messages.skip(1),
    ];
  }

  /// The greeting bubble (0) followed by the server-side transcript (#502), or
  /// null — "leave messages alone", the [ChatState.copyWith] contract — when
  /// there is nothing to redraw. Rebuilt from `state.messages` AT EMIT TIME for
  /// the same bloc-8.x concurrency reason as [_withOpener].
  ///
  /// REDRAWS ONLY WHEN THE WORKER HAS NOT TYPED YET — the transcript is still
  /// just the opener. A worker who has already sent a message (the same-instance
  /// live path, or a fast-typist race during the hydration await) must never
  /// have their bubbles replaced; and on a fresh mount a non-empty [history] is
  /// exactly the re-lock case this fixes.
  ///
  /// A STORED OPENER IS NEVER RE-PREPENDED (#1641). The résumé identity and
  /// batch-confirm openings (#1609/#1523) ARE written to the transcript by
  /// `openTurn` — a re-entry must redraw them — so this redraw would render the
  /// SAME bubble twice: once from `opening_text`, once from the transcript.
  /// When [history] already opens with the bubble at index 0, the served copy
  /// replaces that row instead of preceding it (it may carry the read-aloud
  /// twin). Only the render-only openers — the canned greeting and the
  /// flag-gated one-shot opener, neither of which is ever stored server-side —
  /// are still prepended.
  List<ChatMessage>? _historyRedraw(List<ChatMessage> history) {
    if (history.isEmpty) return null;
    final List<ChatMessage> base = state.messages;
    if (base.any((ChatMessage m) => m.fromWorker)) return null;
    // `base.first` is the opener: the guard above proves no worker message can
    // precede it, and `base.isEmpty` (nothing to redraw ahead of) returns the
    // transcript untouched — today's behavior.
    if (base.isEmpty || base.first.fromWorker) return <ChatMessage>[...history];
    final bool storedOpener =
        !history.first.fromWorker && history.first.text == base.first.text;
    return <ChatMessage>[
      base.first,
      if (storedOpener) ...history.skip(1) else ...history,
    ];
  }

  Future<void> _onMessageSent(
    ChatMessageSent event,
    Emitter<ChatState> emit,
  ) async {
    final String text = event.text.trim();
    if (text.isEmpty) return;

    // #870 — mint the per-submission id ONCE, here, when the worker's action
    // commits. It rides on the worker bubble (below) so [_onRetryRequested] can
    // re-send the SAME id: a retried POST is then distinguishable server-side
    // from a worker genuinely repeating the same words (which is a NEW action and
    // a new id). Minted per physical submission, never per HTTP attempt.
    final String submissionId = const Uuid().v4();

    // The transcript is append-only, so this index stays valid for marking the
    // worker bubble failed later (#343).
    final int index = state.messages.length;
    // #761 — OPTIMISTIC LOOKAHEAD. If the tapped option carries a server
    // prediction WITH a next question (a `close`-shaped prediction has a null
    // key and is skipped — its closing line is not latency-critical), render the
    // predicted next turn NOW so a 2G worker does not wait the round trip.
    // ADVISORY ONLY: nothing here is banked as an answer, the [_deliver] below
    // still submits the byte-identical `text`, and the real reply reconciles.
    final PredictedQuestion? predicted =
        event.optionKey == null ? null : state.lookahead[event.optionKey];

    if (predicted != null && predicted.questionKey != null) {
      emit(state.copyWith(
        messages: <ChatMessage>[
          ...state.messages,
          ChatMessage(text: text, fromWorker: true, submissionId: submissionId),
          // The optimistic bada-bhai bubble — REPLACED by the real reply in
          // [_deliver]. It is never persisted to history: it lives only in this
          // in-memory transcript until reconcile.
          ChatMessage(text: predicted.promptText, fromWorker: false),
        ],
        sending: true,
        followups: predicted.options,
        // The prediction carries LABELS only (no option objects), so clear the
        // option list and let the predicted chips render from [followups] — the
        // label-keyed path, which is correct until the real turn brings its own
        // `suggested_options`.
        suggestedOptions: const <ChatOption>[],
        // Sticky-forward: a null predicted progress keeps the last known bar.
        progress: predicted.progress,
        questionKind: predicted.questionKind,
        // #770 — the composer returns the moment the worker answers, on the
        // optimistic path too: an options-only turn must never outlive the
        // question that imposed it, and the predicted turn brings its own mode.
        inputMode: ChatInputMode.text,
        predictedQuestionKey: predicted.questionKey,
        // The previous turn's card, if any, belongs to a question already
        // answered — clear it alongside the other turn-scoped fields (#1340). A
        // `close`-shaped prediction (the only kind a handover could produce) is
        // filtered out above by the `predicted.questionKey != null` guard, so
        // this branch can never itself be predicting a handover card back in.
        clearFormOffer: true,
      ));
    } else {
      // No usable prediction → EXACTLY today's behaviour: show the typing
      // indicator and drop the previous turn's chips (they belong to a question
      // already answered).
      emit(state.copyWith(
        messages: <ChatMessage>[
          ...state.messages,
          ChatMessage(text: text, fromWorker: true, submissionId: submissionId),
        ],
        sending: true,
        followups: const <String>[],
        // The previous turn's options belong to a question already answered —
        // drop them alongside the followups (#761).
        suggestedOptions: const <ChatOption>[],
        // The previous turn's kind belongs to a question already answered — reset
        // so a stale disambiguate layout can't outlive its chips (#649).
        questionKind: ChatQuestionKind.ask,
        // Same reason (#770): bring the composer back the moment the worker answers.
        inputMode: ChatInputMode.text,
        // The previous turn's handover card, if any, belongs to a question
        // already answered — clear it alongside the chips (#1340). In practice a
        // handover turn also ends the session, so this send is rare, but a stale
        // card must never survive it.
        clearFormOffer: true,
      ));
    }

    // #1316 — the 1-based rank of the ask this send answers, captured NOW (both
    // branches above have appended the worker bubble) so it is stable under the
    // bloc-8.x concurrency: a second send appends its own bubble and reads its
    // own higher index. Emitted on delivery, not here — see [_deliver].
    final int askIndex =
        state.messages.where((ChatMessage m) => m.fromWorker).length;
    await _deliver(
      text,
      index,
      emit,
      submissionId: submissionId,
      askIndex: askIndex,
      answering: _askedQuestionId,
      tappedOption: event.servedOption,
    );
  }

  /// Sends [text] (already appended at [index]) and records the outcome.
  ///
  /// Shared by a first send and a retry so both surface failure identically.
  /// [submissionId] (#870) is forwarded to the repo unchanged; a retry passes the
  /// ORIGINAL id read off the failed worker bubble, so the re-POST carries the
  /// same id as the send it retries.
  Future<void> _deliver(
    String text,
    int index,
    Emitter<ChatState> emit, {
    required int askIndex,
    String? submissionId,
    String? answering,
    bool tappedOption = false,
  }) async {
    _inFlightSends++;
    try {
      final ChatTurn turn = await _sendByMode(text, submissionId);
      _inFlightSends--;
      // #761 — RECONCILE the optimistic lookahead render. The real reply is
      // ALWAYS authoritative: when an optimistic predicted bubble is on screen
      // (predictedQuestionKey != null) we REPLACE it rather than append a second
      // bot bubble. If the prediction was RIGHT (its question_key matches the real
      // turn's asked_question_id) the rendered bubble is kept and only the
      // metadata refreshes; if WRONG, its text/chips are overwritten with the
      // real turn. Either way the transcript ends with exactly one bot bubble for
      // this turn, and the prediction is cleared.
      //
      // Append to CURRENT state, never to a list captured before the await
      // (#344): while this reply was in flight, a second send or a voice merge
      // may have appended bubbles. Re-emitting a pre-await snapshot ERASED them
      // from the visible transcript — the worker watched their own answers
      // vanish mid-profiling.
      final List<ChatMessage> healed =
          _withStatus(state.messages, index, ChatSendStatus.sent);
      final bool reconciling = state.predictedQuestionKey != null;
      final bool predictionWasRight =
          reconciling && turn.askedQuestionId == state.predictedQuestionKey;
      final List<ChatMessage> nextMessages;
      if (!reconciling) {
        // No optimistic bubble — today's behaviour: append the reply.
        nextMessages = <ChatMessage>[
          ...healed,
          // #896 — the reply bubble carries the Devanagari read-aloud script.
          ChatMessage(
            text: turn.reply,
            fromWorker: false,
            ttsText: turn.ttsText,
          ),
        ];
      } else if (predictionWasRight) {
        // The prediction stood — keep the optimistic bubble as-is (metadata
        // refreshes below), so an agreeing turn causes no visible flicker. Its
        // ttsText stays null: the predicted bubble has no Devanagari, and it
        // shows the romanized predicted prompt (which read-aloud falls back to).
        nextMessages = healed;
      } else {
        // The prediction was wrong — overwrite the optimistic bubble in place
        // with the real reply AND its Devanagari read-aloud script (#896).
        nextMessages = _replaceLastBot(healed, turn.reply, turn.ttsText);
      }
      emit(state.copyWith(
        messages: nextMessages,
        sending: _inFlightSends > 0,
        followups: turn.followups,
        // #761 — the option objects for THIS turn (with their stable keys); the
        // screen renders chips from these when present, else from [followups].
        suggestedOptions: turn.suggestedOptions,
        // A delivered message proves the session is open again.
        sessionFailed: false,
        // The engine's interview-completeness decision for this turn (#421).
        // copyWith LATCHES this, so a later turn cannot un-ready the CTA.
        extractionReady: turn.extractionReady,
        // #478 — the named "what's still missing" gaps. TRUST ONLY a non-blocked
        // turn: a blocked turn degrades `unanswered_essentials` to [] = "unknown"
        // (not "complete"), so keep the previous known gaps rather than wrongly
        // declaring the profile finished.
        unansweredEssentials:
            turn.blocked ? state.unansweredEssentials : turn.unansweredEssentials,
        // Turn-scoped honesty cues (see [ChatTurn]).
        lastReplyBlocked: turn.blocked,
        lastReplyMock: turn.isMock,
        // OIE Phase 8 (#649): progress + occupation are sticky-forward (a null on
        // a blocked turn keeps the last known); questionKind drives the followup
        // layout for THIS turn (disambiguate → vertical single-select).
        progress: turn.progress,
        questionKind: turn.questionKind,
        // #770 — this turn's composer decision; text on a blocked/older turn, so
        // the worker is never left without a way to answer.
        inputMode: turn.inputMode,
        occupationLabel: turn.occupationLabel,
        // #761 — the fresh predictions for the NEXT tap; the current one is done.
        lookahead: turn.lookahead,
        clearPredictedQuestionKey: true,
        // #1339/#1340 — THIS turn's handover card, or null on an ordinary turn.
        // Also carried on a RETRY/REPLAY: a flaky link that lands the retried
        // POST against the server's cached response gets the same offer back
        // here, byte-identical, and redraws the same card.
        formOffer: turn.formOffer,
        clearFormOffer: turn.formOffer == null,
        // #1689 — 'queued' only on the terminal turn that settled a "Haan".
        // Passed on EVERY turn so an ordinary one clears it.
        resumeUpdateQueued: turn.resumeUpdateQueued,
        // ADR-0044 — TURN-SCOPED: a companion answer keeps the tab in companion
        // mode; an interview reply (a 409 fallback) takes it out.
        companion: turn.companion,
      ));
      // ADR-0044 — a companion answer is not an interview ask: it must not feed
      // the per-ask funnel, the wrap-up milestone, the answered-facts store or
      // `asked_question_id`. Everything below is interview bookkeeping.
      if (turn.companion) return;
      // #1316 — the ask is now ANSWERED (the reply landed). Emit its per-ask
      // index for the abandonment curve. On a retry this is the FIRST time this
      // ask records (the failed attempt threw below and emitted nothing), so no
      // double-count. On a failure the answer is not recorded — nothing here.
      _logAnswerSpoken(askIndex);
      _logWrapUpOnce(ready: turn.extractionReady);
      // A blocked turn did not process the answer and carries no interview
      // state: record nothing and keep answering the same question.
      if (!turn.blocked) {
        _recordAnsweredFact(answering, text, tappedOption, turn);
        _askedQuestionId = turn.askedQuestionId;
      }
    } on Failure catch (_) {
      _inFlightSends--;
      // Do NOT silently keep the bubble looking delivered (#343). Mark it FAILED
      // so it reads as undelivered and offers tap-to-retry — a worker whose
      // answers never reached the server must find out here, not when their
      // profile comes out empty.
      //
      // #761 — a failed send retracts any optimistic bubble: the predicted next
      // question never actually happened, so drop it (and its chips) rather than
      // leave a phantom turn above the worker's failed answer.
      final bool reconciling = state.predictedQuestionKey != null;
      final List<ChatMessage> reverted =
          reconciling ? _removeLastBot(state.messages) : state.messages;
      emit(state.copyWith(
        messages: _withStatus(reverted, index, ChatSendStatus.failed),
        sending: _inFlightSends > 0,
        followups: reconciling ? const <String>[] : state.followups,
        // Mirror [followups]: a retracted optimistic turn drops its options too;
        // a plain failure keeps the current turn's options so the chips remain.
        suggestedOptions:
            reconciling ? const <ChatOption>[] : state.suggestedOptions,
        questionKind: reconciling ? ChatQuestionKind.ask : state.questionKind,
        clearPredictedQuestionKey: true,
      ));
    }
  }

  /// ADR-0044 — send [text] down the path the tab is on. In companion mode it
  /// goes to the companion; when the server answers that the worker is no longer
  /// a companion worker (409 → null), the SAME text is sent down today's chat, so
  /// the worker's message is never lost to a mode change they did not see.
  Future<ChatTurn> _sendByMode(String text, String? submissionId) async {
    if (state.companion) {
      final ChatTurn? answer =
          await _repo.sendCompanionMessage(text, submissionId: submissionId);
      if (answer != null) return answer;
    }
    return _repo.sendMessage(text, submissionId: submissionId);
  }

  /// ADR-0044 — see [ChatCompanionStarted].
  Future<void> _onCompanionStarted(
    ChatCompanionStarted event,
    Emitter<ChatState> emit,
  ) async {
    ChatTurn? opening;
    try {
      opening = await _repo.openCompanion();
    } catch (_) {
      // A bare catch, on purpose: the contract is "never throws", and anything
      // that does anyway (an Error, an unstubbed test double) must still fall
      // back to today's chat rather than strand the tab on its spinner.
      opening = null;
    }
    if (opening == null) {
      await _onStarted(const ChatStarted(), emit);
      return;
    }
    _companionDigestKey = opening.digestKey;
    _companionReadAt = _clock();
    // The recap REPLACES the canned interview question in bubble 0: a finished
    // worker is not asked "aap kaun sa kaam karte hain?". Rebuilt from `state`
    // at emit time (#344), though the composer is not shown while initializing.
    emit(state.copyWith(
      initializing: false,
      sessionFailed: false,
      companion: true,
      messages: <ChatMessage>[
        ChatMessage(
          text: opening.reply,
          fromWorker: false,
          ttsText: opening.ttsText,
        ),
        ...state.messages.skip(1),
      ],
      followups: opening.followups,
      suggestedOptions: opening.suggestedOptions,
      questionKind: opening.questionKind,
      inputMode: ChatInputMode.text,
    ));
  }

  /// ADR-0044 — see [ChatCompanionRefreshRequested]. Only ever acts while the
  /// tab is ALREADY in companion mode: it never switches an interview into the
  /// companion, because a worker mid-redo needs that interview's own CTA.
  Future<void> _onCompanionRefreshRequested(
    ChatCompanionRefreshRequested event,
    Emitter<ChatState> emit,
  ) async {
    if (!state.companion || state.initializing || state.sending) return;
    final DateTime now = _clock();
    final DateTime? last = _companionReadAt;
    if (!event.force &&
        last != null &&
        now.difference(last) < _companionRefreshMinGap) {
      return;
    }
    _companionReadAt = now;
    // The transcript as this read began. Handlers run CONCURRENTLY (see
    // [_inFlightSends]), so a send can start AND finish inside the await below;
    // its answer then owns the thread and the chips, and a recap landing after
    // it would bury that answer and swap its chips (a jobs list, the résumé
    // menu) for the recap's.
    final List<ChatMessage> before = state.messages;

    ChatTurn? fresh;
    try {
      fresh = await _repo.openCompanion();
    } catch (_) {
      fresh = null;
    }
    // Still a companion worker, still in companion mode, nothing said since the
    // read began, and something changed. A recap with no key cannot be compared,
    // so it is never re-announced. The key is NOT recorded when the transcript
    // moved, so the next refocus evaluates the change again.
    if (fresh == null || !state.companion || state.sending) return;
    if (!identical(state.messages, before)) return;
    final String? key = fresh.digestKey;
    if (key == null || key == _companionDigestKey) return;
    _companionDigestKey = key;
    emit(state.copyWith(
      messages: <ChatMessage>[
        ...state.messages,
        ChatMessage(text: fresh.reply, fromWorker: false, ttsText: fresh.ttsText),
      ],
      followups: fresh.followups,
      suggestedOptions: fresh.suggestedOptions,
      questionKind: fresh.questionKind,
      inputMode: ChatInputMode.text,
    ));
  }

  /// Returns [messages] with the LAST message replaced by a bot bubble carrying
  /// [reply] and its Devanagari read-aloud script [ttsText] (#761 optimistic-
  /// bubble overwrite; #896 read-aloud). Defensive, mirroring [_withStatus]: an
  /// empty list or a worker-bubble tail is returned unchanged.
  List<ChatMessage> _replaceLastBot(
    List<ChatMessage> messages,
    String reply,
    String? ttsText,
  ) {
    if (messages.isEmpty || messages.last.fromWorker) return messages;
    final List<ChatMessage> next = List<ChatMessage>.of(messages);
    next[next.length - 1] =
        ChatMessage(text: reply, fromWorker: false, ttsText: ttsText);
    return next;
  }

  /// Returns [messages] with a trailing bot bubble removed (the #761 optimistic
  /// bubble, retracted on a failed send). Unchanged when the tail is not a bot
  /// bubble.
  List<ChatMessage> _removeLastBot(List<ChatMessage> messages) {
    if (messages.isEmpty || messages.last.fromWorker) return messages;
    return messages.sublist(0, messages.length - 1);
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

  /// Re-sends a failed bubble in place — no duplicate bubble is appended.
  /// Records the fact [text] settled for [answering], when the server
  /// processed it ([turn] is its reply). Fire-and-forget; the store never
  /// throws. A RETRY passes no [answering] and records nothing: which question
  /// the failed bubble answered is not known for sure by then.
  void _recordAnsweredFact(
    String? answering,
    String text,
    bool tappedOption,
    ChatTurn turn,
  ) {
    final KnownWorkerFactsStore? facts = _knownFacts;
    if (facts == null) return;
    final WorkerFact? fact = chatAnsweredFact(
      askedQuestionId: answering,
      reply: text,
      tappedOption: tappedOption,
      unansweredEssentials: turn.unansweredEssentials,
    );
    if (fact != null) unawaited(facts.record(fact));
  }

  Future<void> _onRetryRequested(
    ChatRetryRequested event,
    Emitter<ChatState> emit,
  ) async {
    final int index = event.index;
    if (index < 0 || index >= state.messages.length) return;
    final ChatMessage message = state.messages[index];
    // Only a worker bubble that actually failed is retryable.
    if (!message.fromWorker || message.status != ChatSendStatus.failed) return;

    // Optimistically un-fail it while the retry is in flight.
    emit(state.copyWith(
      messages: _withStatus(state.messages, index, ChatSendStatus.sent),
      sending: true,
      followups: const <String>[],
      suggestedOptions: const <ChatOption>[], // #761 — drop with the followups
      questionKind: ChatQuestionKind.ask, // #649 — drop a stale disambiguate
      inputMode: ChatInputMode.text, // #770 — bring the composer back on retry
      clearFormOffer: true, // #1340 — drop a stale card while the retry is in flight
    ));

    // #1316 — the ask this bubble answers, by its rank among worker bubbles UP TO
    // AND INCLUDING position [index]. Later worker bubbles do not shift it, so a
    // retry emits the SAME index the original send would have had once it lands.
    final int askIndex = state.messages
        .take(index + 1)
        .where((ChatMessage m) => m.fromWorker)
        .length;

    // #870 — re-send the ORIGINAL id minted for this bubble on the first send, so
    // the server sees a retry (same submission) rather than a fresh answer. The
    // text is already re-sent byte-identically; the id now rides with it.
    await _deliver(
      message.text,
      index,
      emit,
      submissionId: message.submissionId,
      askIndex: askIndex,
    );
  }

  /// True while [ChatSessionRestarted] is minting a new session. Guards against
  /// a double-tap on "Chat se resume banayein" minting TWO sessions: the second
  /// event is ignored until the first open resolves.
  bool _restarting = false;

  /// Mints a NEW session and resets to a clean interview (#1566).
  ///
  /// The reset is a WHOLE new [ChatState], not a `copyWith` — extractionReady,
  /// occupationLabel, progress, formOffer and every turn-scoped chip must clear,
  /// because none of them belongs to the new interview. The bloc's own counters
  /// (`_askedQuestionId`, `_wrapUpLogged`, `_inFlightSends`) are reset too: the
  /// wrap-up milestone must be able to fire again for the new session, and a
  /// value latched from the old one must not suppress it.
  Future<void> _onSessionRestarted(
    ChatSessionRestarted event,
    Emitter<ChatState> emit,
  ) async {
    if (_restarting) return;
    _restarting = true;
    _askedQuestionId = null;
    _wrapUpLogged = false;
    _inFlightSends = 0;
    emit(const ChatState(messages: <ChatMessage>[kChatOpeningMessage]));
    try {
      final ChatSessionOpening? opening = await _repo.startNewSession();
      emit(state.copyWith(
        initializing: false,
        messages: _withOpener(opening),
        resumePending: opening?.resumePending ?? false,
        suggestedOptions: opening?.options,
        followups: opening == null
            ? null
            : <String>[for (final ChatOption o in opening.options) o.labelText],
      ));
    } on Failure {
      // The transcript is already reset; surface the failed open with the same
      // banner an ordinary open failure uses, so the worker can retry by typing.
      emit(state.copyWith(initializing: false, sessionFailed: true));
    } finally {
      _restarting = false;
    }
  }

  /// Appends the already-server-merged voice transcript + reply. Local only —
  /// the voice pipeline sent the transcript through ChatRepository.sendMessage.
  void _onVoiceMerged(ChatVoiceMerged event, Emitter<ChatState> emit) {
    // The voice pipeline returns only the reply text (no followups), so clear
    // any stale chips from the previous typed turn.
    emit(state.copyWith(
      messages: <ChatMessage>[
        ...state.messages,
        ChatMessage(text: event.transcript, fromWorker: true),
        ChatMessage(text: event.reply, fromWorker: false),
      ],
      // A voice merge must not clear a TYPED send's indicator that is still
      // awaiting its reply (#344) — only report idle when nothing is in flight.
      sending: _inFlightSends > 0,
      followups: const <String>[],
      // The voice pipeline returns no options — clear with the followups (#761).
      suggestedOptions: const <ChatOption>[],
      // A voice answer is never a disambiguation turn — reset the layout (#649).
      questionKind: ChatQuestionKind.ask,
      // A voice merge returns no chips, so the worker must be able to type the
      // next turn — never leave them on an options-only lock (#770).
      inputMode: ChatInputMode.text,
      // The voice turn went through the SAME chat endpoint, so it carries the
      // same readiness decision (#421).
      extractionReady: event.extractionReady,
      // #1340 — the voice pipeline's merge event carries no `form_offer` (it
      // predates #1339 and the handover flow is text-only today), so a stale
      // card from a previous typed turn must not survive a voice answer.
      clearFormOffer: true,
    ));
    // #1316 — a voice answer is an answered ask too: the transcript was already
    // sent server-side and is merged (recorded) here, so emit its per-ask index
    // like a delivered typed send. Rank = worker bubbles after the merge above.
    _logAnswerSpoken(
      state.messages.where((ChatMessage m) => m.fromWorker).length,
    );
    _logWrapUpOnce(ready: event.extractionReady);
  }
}
