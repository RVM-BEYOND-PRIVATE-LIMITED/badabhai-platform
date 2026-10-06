import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart'
    show
        HapticFeedback,
        SystemChannels,
        SystemUiOverlayStyle,
        TextInputFormatter;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart'
    show
        ChatAnswerType,
        ChatInputMode,
        ChatOption,
        ChatQuestionKind,
        EditProposal,
        EditProposalRow,
        FormOffer;
import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/util/devanagari_guard.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_button.dart';
// Only for [kChatSendFailedLabel]: the bubble itself is drawn locally in the
// Master UI Kit style (see [_ChatBubble]), the copy stays the shared constant.
import '../../../core/widgets/bb_chat_bubble.dart' show kChatSendFailedLabel;
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/selection_cards.dart';
import '../../../core/widgets/bottom_bar_inset.dart';
import '../../../router.dart';
import '../../resume/domain/resume_edit_repository.dart';
import '../../resume/domain/resume_safe_fields.dart';
import '../../trade_form/domain/trade_form_args.dart';
import '../../trade_form/presentation/open_trade_form.dart';
import '../../voice/domain/speech_reader.dart';
import '../../voice/domain/voice_models.dart';
import '../../voice/presentation/dictation_controller.dart';
import '../../voice/presentation/widgets/dictation_bar.dart';
// #1559 / #1583 — the SAME Haan / Nahi copy and none-of-above tick rule the
// voice form and the trade form already use for these answer types.
import '../../voice_form/domain/voice_form_models.dart' show VoiceChoice;
import '../../voice_form/presentation/widgets/voice_choice_chips.dart'
    show applyNoneOfAboveRule, kVoiceBooleanNo, kVoiceBooleanYes;
import '../domain/chat_message.dart';
import '../domain/chat_multi_select.dart';
import '../domain/chat_companion_keys.dart';
import '../domain/chat_identity_questions.dart';
import 'widgets/chat_location_card.dart';
import 'widgets/flying_name.dart';
import '../domain/companion_edit_value.dart';
import '../domain/chat_resume_menu.dart';
import '../../swipe/domain/job_detail.dart';
import 'bloc/chat_bloc.dart';
import '../../../core/util/push_once.dart';

/// How close to the bottom (px) the worker must be for a freshly-received bot
/// message to auto-scroll. Beyond this, we surface the "new message" pill
/// instead of yanking the transcript down under their thumb.
const double _kNearBottomThreshold = 120;

/// The disambiguation "none of these" escape label (#649). The backend serves it
/// as an ordinary `suggested_followups` entry (`is_none_of_above`, currently
/// 'Kuch aur'); the client recognises it by this label to style it distinctly.
/// If the phrase ever changes server-side it degrades to a normal option, never
/// breaks.
const String _kDisambiguateEscape = 'Kuch aur';

/// The label the escape row (and the trailing chip on an LLM suggestion row)
/// DISPLAYS. The worker's profile may not be among the suggestions, so the
/// escape no longer declines the list — it opens the composer for their own
/// words ("custom answer" mode, see [_ChatViewState._customAnswerMode]).
/// Aap-form, PII-free constant copy.
const String kChatCustomAnswerLabel = 'Kuch aur — khud likhein';

/// The composer hint while "custom answer" mode is on after the escape on a
/// PROFILE list (a disambiguation turn): tells the worker what to type once
/// they have said none of the suggested profiles fit.
const String kChatCustomAnswerHint = 'Apna kaam ya profile khud likhein';

/// Screen-reader label for the profile-list escape row — spells out that
/// tapping it opens typing rather than answering.
const String kChatCustomAnswerSemantics =
    'Kuch aur, apna kaam ya profile khud likhein';

/// The composer hint after the escape chip on an ordinary chip ROW. The
/// model's chips can suggest a profile, a skill or a duration, so the hint
/// asks for "your answer", never for a profile where a skill belongs.
const String kChatCustomAnswerGenericHint = 'Apna jawab khud likhein';

/// Screen-reader label for the chip-row escape (see
/// [kChatCustomAnswerGenericHint]).
const String kChatCustomAnswerGenericSemantics =
    'Kuch aur, apna jawab khud likhein';

/// The composer's everyday hint (unchanged copy, now named so the custom-mode
/// swap reads plainly).
const String _kComposerHint = 'Boliye ya likhiye…';

/// Normalised labels of the ONE legitimate lock-the-keyboard turn: the
/// engine's experience gate ("Aur koi experience jodna hai?" → Haan / Nahi).
/// Any other `options_only` turn keeps the composer (see
/// [_ChatViewState._isYesNoGate]).
const Set<String> _kGateYesLabels = <String>{'haan', 'han', 'ha', 'yes'};
const Set<String> _kGateNoLabels = <String>{'nahi', 'nahin', 'na', 'no'};

/// The experience gate's prompt, byte-identical to the engine's
/// `EXPERIENCE_GATE_PROMPT`. The chips alone do not identify the gate: the
/// model can serve its own Haan / Nahi question as options_only, and that one
/// must keep the composer. If the copy ever drifts the lock simply lifts,
/// which is the safe side — the server accepts typed text on every turn.
const String _kExperienceGatePrompt = 'Aur koi experience jodna hai?';

/// `option_key` prefix of the LLM interview's model-suggested chips
/// (`slugIndexKey("llm", i)` server-side → `llm_a`, `llm_b`, …; the slug schema
/// allows no digits).
const String _kLlmOptionKeyPrefix = 'llm_';

// ADR-0045 — the server's word on whether the skills gate is open this turn.
// `gateKind == "skills"` means the skills gate ("Kya aur koi skill jodni hai?")
// is open and the composer must be locked. The chips above are the only answer path.
/// `DISAMBIGUATION_ESCAPE_KEY` in `packages/config` occupation tuning).
/// Whatever turn it rides on (a disambiguation list today, a model chip row
/// once the backend appends it there) it opens custom-answer mode and is never
/// submitted as the worker's answer.
const String _kServerEscapeOptionKey = 'kuch_aur';

/// Hinglish label on the jump-to-bottom pill.
const String _kNewMessageLabel = 'Naye message';

/// Height of the green pack-progress line on the header's bottom edge (#649).
/// Reserved even before a pack resolves (as an empty navy strip), so the
/// header never changes height mid-conversation.
const double _kHeaderProgressHeight = 4;

/// The most of the chat body the stack UNDER the transcript (answer options,
/// notices, composer, CTA / handover card) may occupy before it scrolls within
/// itself. Only reachable on a short phone with a very large system font; an
/// ordinary layout is far below it.
const double _kBottomStackMaxFraction = 0.6;

/// Banner copy when the chat session could not be opened (#343). Honest about
/// the cause: the connection was not established, and sending retries it.
const String _kSessionFailedLabel =
    'Server se connection nahi bana — message bhejenge to dobara try hoga.';

// ---------------------------------------------------------------------------
// #421 — readiness copy for the "build my profile" CTA.
//
// The engine decides when it has enough to build a profile (`extraction_ready`).
// Before that, the CTA is SOFTENED, never dead: it keeps its ≥48px tap target
// and stays tappable, and tapping it opens a warm sheet that explains what is
// missing and offers BOTH "keep talking" and "build it anyway". A hard-disabled
// button with no explanation would be worse than the bug for a first-time,
// low-literacy worker — and a client-side gate must never be able to trap a
// worker in a chat they cannot leave.
// ---------------------------------------------------------------------------

/// CTA label once the engine says the interview is complete.
const String kChatDoneReadyLabel = 'Ho gaya — meri profile banaiye';

/// CTA label while the interview is still short — an invitation, not a block.
const String kChatDoneNotReadyLabel = 'Thodi aur baat karein';

/// Shown when a turn was blocked (pseudonymize fail-closed): the worker's last
/// answer was NOT processed, so tell them plainly rather than let a canned
/// fallback reply read as "understood". PII-free constant copy.
const String kChatBlockedNotice =
    'Aapki baat theek se nahi pahunch payi — thoda saaf karke dobara likhein.';

/// Shown in place of the composer on an `options_only` turn (#770): the chips
/// above are the only answer path this turn, so tell the worker to pick one
/// rather than leave a dead, greyed-out field with no explanation. Aap-form,
/// PII-free constant copy.
const String kChatOptionsOnlyHint = 'Upar diye gaye vikalp mein se chunein';

/// Shown in place of the composer on a `form_offer` (handover) turn (#1363):
/// the server has CLOSED this session (`kind: "close"`, `form_handoff`), so
/// typing here would go nowhere — tell the worker the button below is the way
/// forward rather than leave a live-looking field on a dead session. Aap-form,
/// PII-free constant copy; distinct from [kChatOptionsOnlyHint] because there
/// are no chips above to point at on this turn.
const String kChatFormOfferLockedHint = 'Neeche diya button dabakar aage badhein';

/// The button under a `multi_select` turn's chips (#1559 / #1583): the chips
/// only TICK there, and this sends every ticked choice as ONE answer. Disabled
/// until at least one chip is ticked. Aap-form-neutral, PII-free constant copy.
const String kChatMultiSelectDoneLabel = 'Ho gaya';

/// Nudge-sheet heading.
///
/// PERSONA: was 'Ek minute, bhai'. `bhai` as a VOCATIVE is banned by the Ten
/// Laws — the persona is NAMED Bada Bhai but never calls the worker one. The
/// client holds no worker name to address them by (see `kChatOpeningText`), so
/// the honorific `ji` carries the warmth on its own.
const String kChatNudgeTitle = 'Ek minute ji';

/// Nudge-sheet body — honest about the cost of stopping now.
const String kChatNudgeBody =
    'Aap abhi profile bana sakte hain, par woh adhoori rahegi. Thodi baat aur '
    'ho jaye to company ko aapki poori baat dikhegi.';

/// Nudge-sheet primary action — back to the chat.
const String kChatNudgeContinueLabel = 'Baat jaari rakhein';

/// Nudge-sheet escape hatch — the worker is never trapped.
const String kChatNudgeProceedLabel = 'Phir bhi profile banaiye';

/// The `extra` the résumé-upload screen hands [Routes.chatProfiling] when the
/// worker arrived from a REAL import that said nothing on the way (#1660).
///
/// It lives HERE, not in `Routes`: it is a navigation ARGUMENT, and the
/// screen-template contract test reads every `static const String` in
/// `router.dart` as a declared route the feedback table must know.
const String kChatFromResumeImport = 'resume_import';

class ChatProfilingScreen extends StatelessWidget {
  const ChatProfilingScreen({
    super.key,
    this.fromResumeImport = false,
    this.assistantTab = false,
  });

  /// ADR-0044 — this screen is the Bada Bhai TAB, not the onboarding chat.
  ///
  /// Only the tab may open the post-completion companion, and only while the
  /// `worker_chat_companion_enabled` Remote Config lever is on (it ships off).
  /// The onboarding `/chat` route never passes it, so the interview a worker is
  /// taken through at signup is byte-for-byte what it was.
  final bool assistantTab;

  /// #1660 — this arrival came from an import that routed to the chat.
  ///
  /// The import read cannot yet say whether anything was EXTRACTED (backend
  /// #1656), but the session open can: a staged identity turn arrives as
  /// `resume_pending`. No pending turn after an import means the document
  /// yielded nothing, and the worker is owed one honest line rather than being
  /// dropped into the ordinary interview as if he had never uploaded anything.
  final bool fromResumeImport;

  @override
  Widget build(BuildContext context) {
    // Read at mount, for the chat this tab OPENS. A Remote Config fetch landing
    // later never swaps the chat on screen; the lever is read again only when
    // the tab comes back into focus (see [_CompanionRefocus]).
    final bool companion =
        assistantTab && BbRemoteConfig.instance.chatCompanionEnabled;
    final Widget view = _ChatView(fromResumeImport: fromResumeImport);
    return BlocProvider<ChatBloc>(
      create: (_) => locator<ChatBloc>()
        ..add(companion ? ChatCompanionStarted() : ChatStarted()),
      // Wrapped whatever the lever said at mount: the tree must not change shape
      // when the lever does, and a tab that opened as the interview needs the
      // refocus as much as one that opened on the recap.
      child: assistantTab ? _CompanionRefocus(child: view) : view,
    );
  }
}

/// ADR-0044 — each time the Bada Bhai tab comes back into focus (the shell keeps
/// the tab mounted, so nothing else would), asks the bloc to re-read the
/// companion, while the Remote Config lever is on:
///
///   - on the recap, the recap is refreshed; the bloc throttles it and appends a
///     bubble only when the facts changed;
///   - on the interview, the tab moves to the recap when the server now says so
///     and the worker has not answered that interview in this tab (the bloc's
///     rule). That is how a worker who confirmed after the tab opened, or whose
///     phone loaded the lever after it opened, reaches the recap without
///     restarting the app.
///
/// The lever is read at FOCUS time, not at mount: a tab that opened before the
/// fetch landed would otherwise never ask.
///
/// No-op when [TabFocus] is not registered (a widget test's bare locator), so a
/// test that does not care about refocus need not wire it.
class _CompanionRefocus extends StatelessWidget {
  const _CompanionRefocus({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!locator.isRegistered<TabFocus>()) return child;
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.chat,
      onFocused: () {
        if (!BbRemoteConfig.instance.chatCompanionEnabled) return;
        context.read<ChatBloc>().add(const ChatCompanionRefreshRequested());
      },
      child: child,
    );
  }
}

class _ChatView extends StatefulWidget {
  const _ChatView({this.fromResumeImport = false});

  final bool fromResumeImport;

  @override
  State<_ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<_ChatView>
    with SingleTickerProviderStateMixin {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scroll = ScrollController();

  /// True when a bot message arrived while the worker had scrolled up — drives
  /// the "Naye message" jump pill rather than yanking the transcript down.
  bool _hasUnreadBelow = false;

  /// True while the profile preview is being opened (#372) — see
  /// [_openProfilePreview] for why a bool and not just the disabled state.
  bool _openingPreview = false;

  /// Sticky once a Devanagari keystroke (typed or dictated) has been
  /// stripped from the composer — see [DevanagariBlockFormatter]. No
  /// resume-rendering step transliterates Hindi script today (#1411), so
  /// this stops it reaching a worker's printed resume at the source instead.
  bool _devanagariBlocked = false;

  /// True while the trade-form handover is being opened (#1340) — same
  /// same-frame double-tap guard as [_openingPreview]; see [_openTradeForm].
  bool _openingTradeForm = false;

  /// #1660 — the "your résumé gave us nothing" line has been said once for this
  /// arrival. One-shot: it explains what just happened, it is not a banner that
  /// follows the worker through the conversation.
  bool _emptyImportSaid = false;

  /// An option/chip tap is dispatched and the reply has not arrived yet.
  ///
  /// SET SYNCHRONOUSLY IN THE HANDLER, because the options row is only removed
  /// on the next rebuild — and `state.sending` is false by construction at
  /// build time, so gating on it in the builder does nothing. Two taps inside
  /// one frame otherwise dispatch two `ChatMessageSent`s, and the server is
  /// not idempotent across DIFFERENT text: Layer A replay only catches a
  /// byte-identical message. The first settles the offer and pins the pack;
  /// the second arrives with the offer already cleared and is captured against
  /// whatever pack question the engine has just served — a bogus answer of
  /// record, on the one control where a mis-tap costs a whole trade-specific
  /// interview. Released when the turn SETTLES (see [_wasSending]).
  bool _optionTapPending = false;

  /// Previous `state.sending`, so the listener can spot the settle EDGE.
  ///
  /// Releasing on "followups changed" does not work: the bloc clears followups
  /// the moment the worker sends ("Cleared the moment the worker sends again"),
  /// so that fires on the way IN and unlatches before the second tap.
  bool _wasSending = false;

  /// "Custom answer" mode: the worker tapped [kChatCustomAnswerLabel] because
  /// their profile is not among the suggestions. The composer is shown (even
  /// on an `options_only` turn), focused, and hinted with
  /// [_customAnswerHint]; whatever they type goes through the ordinary
  /// typed-send path with no `optionKey`. TURN-SCOPED: cleared by the bloc
  /// listener on the next send / reply, never latched across questions.
  bool _customAnswerMode = false;

  /// ADR-0048 — the state the worker chose on the `worker_state` turn, so the
  /// `worker_city` turn can offer that state's cities. Screen-local and
  /// deliberately not persisted: it is only needed for the very next turn.
  String? _identityState;

  /// The composer hint while [_customAnswerMode] is on: the profile hint for a
  /// disambiguation list, the question-neutral one for a chip row.
  String _customAnswerHint = kChatCustomAnswerHint;

  /// #1559 / #1583 — the chips TICKED on a `multi_select` turn, as
  /// [ChatOption.optionKey]s in the order the worker ticked them. Nothing is
  /// sent until [kChatMultiSelectDoneLabel]. TURN-SCOPED like
  /// [_customAnswerMode]: cleared by the bloc listener the moment the turn
  /// moves on (a send, a reply), never carried to the next question.
  List<String> _ticked = const <String>[];

  /// Focus for the composer [TextField], so entering [_customAnswerMode] can
  /// raise the keyboard straight onto the field.
  final FocusNode _composerFocus = FocusNode();

  /// Anchors the bottom composer/CTA segment (the composer-or-hint row plus
  /// the CTA-or-handover-card row) so its rendered height can be measured and
  /// published to [bottomBarInset] (#1364). This screen uses a raw [Scaffold],
  /// not [BbScaffold], so it never otherwise participates in the mechanism
  /// [FeedbackFabOverlay] reads to float clear of a page's bottom content —
  /// without this, the FAB sits at its default float height and the (taller)
  /// #1339/#1340 handover card's headline collides with it. See
  /// [_publishBottomInset] for the measure-and-publish discipline, copied from
  /// `BbScaffold._publishInset` (deliberately NOT refactored onto BbScaffold —
  /// the composer/CTA stack here lives inside a SafeArea > Column inside a
  /// Stack-based body, not a clean `bottomNavigationBar` slot).
  final GlobalKey _bottomSegmentKey = GlobalKey();

  // ---- ADR-0048 — the worker's name flies from the chat to the header ------
  //
  // The name the identity intake captures travels up to the header's action as
  // a moving token ([FlyingName]); the action then reads the name instead of
  // 'Feedback'. These fields only coordinate that one-shot move.

  /// The header action the name lands on — the destination of the flight.
  final GlobalKey _headerNameActionKey = GlobalKey();

  /// The LAST worker bubble — the source of the flight. Reassigned each build to
  /// whichever bubble is last, which at the instant a name is captured is the
  /// bubble the name was just typed into.
  final GlobalKey _lastWorkerBubbleKey = GlobalKey();

  /// The name shown on the header action. Null until a name is captured (the
  /// action reads 'Feedback' then), set when the token lands so the label and
  /// the move agree.
  String? _headerName;

  /// True while a token is in flight, so a second capture cannot start a second
  /// flight over the first.
  bool _flyingName = false;

  /// The action's small settle pop when a name lands. Driven by an explicit
  /// controller (not a keyed [TweenAnimationBuilder]) so the action's subtree —
  /// and the label's cross-fade inside it — is never rebuilt from scratch.
  late final AnimationController _namePop;
  late final Animation<double> _namePopScale;

  /// The live flight overlay, removed on teardown so a mid-flight dispose never
  /// leaves a token painted over another route.
  OverlayEntry? _nameFlightEntry;

  // ---- Tap-to-talk (voice → text into the composer) -----------------------
  //
  // Tapping the MIC in the send slot ([_composerAction]) runs the DEVICE's own
  // speech recogniser and KEEPS listening — no hold. Tapping STOP ends listening
  // and the recognised text lands in the field for review, with the button now
  // showing SEND — sent as an ORDINARY chat message. NO server, no upload, no
  // `/voice/*` endpoint (so no bucket dependency, no 503). The haldi mic on the
  // LEFT is unrelated: a plain TAP there opens the server-side voice-note screen
  // (unchanged).
  //
  // The dictation itself — the utterance-boundary commit, the trailing-final
  // latch, the adaptive noise floor — lives in [DictationController], shared with
  // every other surface that dictates. This screen only decides what happens to
  // the text it hands back.
  late final DictationController _dictation;

  /// Index of the bot bubble currently being read aloud (its speaker icon shows
  /// the stop glyph); null when nothing is speaking.
  int? _speakingIndex;

  @override
  void initState() {
    super.initState();
    _dictation = DictationController(
      onNotice: _showComposerNotice,
      // The app going to the background, or the feedback screen taking the
      // shared recogniser, ends dictation with no Stop left to tap — land the
      // words in the composer instead of dropping the worker's answer.
      onInterrupted: _landDictation,
    )..addListener(_onDictationChanged);
    // Manual scroll back near the bottom dismisses the pill.
    _scroll.addListener(_onScroll);
    // ADR-0048 — a mount that already has the captured name (a rebuild, a
    // returning route) shows it at once; only the null → non-null edge flies.
    _headerName = context.read<ChatBloc>().state.workerName;
    // OWNER REQUEST (2026-10-05): the BadaBhai tab runs no identity intake, so
    // the header would never learn the worker's name. Read the SAME
    // `GET /workers/me/resume-fields` the Profile tab reads, so the header shows
    // the worker's own name here too. Fail-silent, and the chat's own capture
    // still wins if it lands first.
    if (_headerName == null) {
      // ignore: discarded_futures — fire-and-forget; state updates on done.
      _loadHeaderName();
    }
    // Starts SETTLED (value 1 = scale 1.0) so the action is not enlarged on
    // mount; a landing rewinds it to 0 and plays the pop.
    _namePop = AnimationController(vsync: this, duration: AppMotion.slower)
      ..value = 1.0;
    _namePopScale = Tween<double>(begin: 1.14, end: 1.0).animate(
      CurvedAnimation(parent: _namePop, curve: AppMotion.stamp),
    );
  }

  @override
  void dispose() {
    // ADR-0048 — drop a mid-flight token before the route goes, so it cannot
    // linger over whatever is behind.
    _nameFlightEntry?.remove();
    _nameFlightEntry = null;
    _namePop.dispose();
    if (locator.isRegistered<SpeechReader>()) {
      unawaited(locator<SpeechReader>().stop()); // never leave TTS reading
    }
    _dictation
      ..removeListener(_onDictationChanged)
      ..dispose();
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    _composerFocus.dispose();
    _controller.dispose();
    // #1364 — this page is leaving; stop claiming the FAB inset it published.
    // DEFERRED to after the frame, same reason as `BbScaffold.dispose`:
    // dispose runs during the build/tree-finalize phase, and writing the
    // (listened) notifier synchronously here would markNeedsBuild the FAB
    // overlay mid-build. An overlay that outlives this screen falls back to
    // its own default float height — never an overlap.
    WidgetsBinding.instance.addPostFrameCallback((_) => bottomBarInset.value = 0);
    super.dispose();
  }

  /// Measures [_bottomSegmentKey]'s rendered height and publishes it to
  /// [bottomBarInset] (#1364) so the app-wide Feedback FAB floats clear of
  /// whichever is on screen today — the short [_doneCta] row or the taller
  /// #1339/#1340 handover card. Same measure-and-publish discipline as
  /// `BbScaffold._publishInset`: deferred to a post-frame callback because the
  /// render box is only sized after layout, keeping the notifier write out of
  /// the build phase. `?? 0` covers both the `initializing` branch (the key's
  /// widget is not in the tree yet) and a frame where layout has not run.
  void _publishBottomInset() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      bottomBarInset.value = _bottomSegmentKey.currentContext?.size?.height ?? 0;
    });
  }

  /// The dictation controller flipped the waveform on/off — repaint the composer.
  void _onDictationChanged() {
    if (mounted) setState(() {});
  }

  void _send() {
    final String text = _controller.text;
    if (text.trim().isEmpty) return;
    _sendText(text);
    // Clear the composer AND drop the dictation carry-over so a late recogniser
    // final (or the next hold) can never re-fill it with the sentence just sent.
    _dictation.discard();
    _controller.clear();
  }

  /// Send an answer from a tap-to-answer chip — same path as typing it.
  void _sendText(String text) {
    if (text.trim().isEmpty) return;
    // The custom answer has been given — back to the everyday composer.
    if (_customAnswerMode) setState(() => _customAnswerMode = false);
    context.read<ChatBloc>().add(ChatMessageSent(text));
  }

  /// The worker's profile is not among the suggestions: enter
  /// [_customAnswerMode] and focus the composer. Sends NOTHING — the typed
  /// answer goes out through [_send] like any other message. One tap per turn,
  /// same as the options it sits beside (see [_optionTapPending]).
  void _enterCustomAnswer({String hint = kChatCustomAnswerHint}) {
    if (_optionTapPending) return;
    setState(() {
      _customAnswerMode = true;
      _customAnswerHint = hint;
    });
    // After the frame: on a locked turn the TextField only mounts on the
    // rebuild this setState schedules.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_customAnswerMode) return;
      if (_composerFocus.hasFocus) {
        // Still focused from an earlier send (the send icon keeps focus) with
        // the keyboard closed by back: requestFocus would change nothing and
        // the keyboard would stay down, so raise it directly.
        unawaited(
            SystemChannels.textInput.invokeMethod<void>('TextInput.show'));
      } else {
        _composerFocus.requestFocus();
      }
    });
  }

  /// Send an answer chosen from an OPTIONS list (the deterministic chips). One
  /// tap per turn: see [_optionTapPending].
  ///
  /// #761 — carries the tapped option as `optionKey` so the bloc can index the
  /// previous turn's `lookahead` and render the predicted next question
  /// optimistically. On chat the LABEL is the answer of record, so it is both the
  /// submit text (byte-identical, unchanged) and the lookahead key; a
  /// deterministic decline chip is keyed `'__declined'` — a real decline of a
  /// closed list. The DISAMBIGUATION escape never reaches here: it opens
  /// [_enterCustomAnswer] instead.
  void _sendOption(String label) {
    if (_optionTapPending) return;
    if (label.trim().isEmpty) return;
    setState(() => _optionTapPending = true);
    final bool escape =
        label.trim().toLowerCase() == _kDisambiguateEscape.toLowerCase();
    context.read<ChatBloc>().add(
          ChatMessageSent(
            label,
            optionKey: escape ? '__declined' : label,
            servedOption: !escape,
          ),
        );
  }

  /// Send an answer chosen from a `suggested_options` chip/row (#761).
  ///
  /// THE FIX. SUBMITS [ChatOption.labelText] as the answer of record — BYTE-
  /// IDENTICAL to typing it, exactly as [_sendOption] does — while passing the
  /// stable [ChatOption.optionKey] (or `'__declined'` for a deterministic
  /// none-of-above chip; the disambiguation escape opens [_enterCustomAnswer]
  /// instead) as the lookahead index. On the LLM chat the display label differs from that
  /// key, so keying the prediction by the label (the [_sendOption] path) missed
  /// and the optimistic render silently never fired; the option_key hits it.
  /// One tap per turn — see [_optionTapPending].
  ///
  /// Every option that reaches here is a served answer, none-of-above included
  /// ('Koi bhi chalegi' is stored as shift `any`), so it is flagged
  /// [ChatMessageSent.servedOption] and its closing fact is recorded. The
  /// server's escape never reaches here.
  ///
  /// #1566 — POST-COMPLETION MENU. On an ended session the served options carry
  /// the résumé menu's stable keys, and [resumeMenuActionFor] decides the route.
  /// The two menu-NAVIGATION keys (`resume_edit`, `resume_redo`) still go to the
  /// server, because the SERVER owns the next menu (six sections, or
  /// upload-vs-chat). `resume_upload`, `resume_chat_create` and every
  /// `section_*` are handled on the client and are NEVER submitted — sending
  /// them would only produce the server's ack. Within `section_*`, the
  /// Technical Skills pilot opens its filtered trade-form walk while the
  /// other sections open the Resume Edit. An ordinary (non-menu) option
  /// falls through to exactly today's submit.
  /// ADR-0044 — a companion job chip, and the recap re-read on the way back.
  ///
  /// #1747 review: this push used to be fire-and-forget, so the `'applied'` the
  /// detail screen pops was dropped on the floor. Nothing else re-read the
  /// recap either — `TabFocus` fires on a shell BRANCH change and both of these
  /// routes are pushed on the ROOT navigator, so popping back is not a refocus.
  /// The worker therefore applied through the companion and came back to the
  /// same "jobs applied to" count, which is exactly the acceptance line the
  /// issue asks for.
  Future<void> _openCompanionJob(
    String jobId,
    ({String title, String? city}) parts,
  ) async {
    // The detail route REQUIRES a JobDetail extra (it redirects to the feed
    // without one); the title and city pre-fill its header until
    // GET /jobs/:id lands.
    final Object? result = await context.pushOnce<Object?>(
      '${Routes.jobDetail}/$jobId',
      extra: JobDetail(jobId: jobId, title: parts.title, city: parts.city),
    );
    if (!mounted || result != 'applied') return;
    // #1752 — the same confirmation the feed gives for the same pop, and the
    // chip goes with it: tapping it again would reopen the detail showing
    // "Apply karein" for a job he has already applied to.
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(const SnackBar(content: Text(kCompanionAppliedToast)));
    context.read<ChatBloc>().add(ChatCompanionJobApplied(jobId));
  }

  /// The applied-list chip, and the recap re-read on the way back. Not forced:
  /// reading the list changes nothing by itself, so the ordinary throttle is
  /// the right gate.
  Future<void> _openCompanionApplied() async {
    await context.pushOnce<Object?>(Routes.appliedJobs);
    if (!mounted) return;
    context.read<ChatBloc>().add(const ChatCompanionRefreshRequested());
  }

  void _sendChoice(ChatOption option) {
    // ADR-0044 — the companion's app-routed chips FIRST. None of them is ever
    // posted; every other key (interview chips, the résumé menu, the companion's
    // server-answered chips) falls through to exactly the routing below.
    final CompanionAction companionAction = companionActionFor(option.optionKey);
    // #1753 — counts only, by key CLASS, and only while the tab is the companion.
    final ChatBloc bloc = context.read<ChatBloc>();
    if (bloc.state.companion) {
      bloc.add(ChatCompanionChipTapped(
        companionChipKeyClass(option.optionKey),
        openedJob: companionAction == CompanionAction.openJob,
      ));
    }
    switch (companionAction) {
      case CompanionAction.openJob:
        final String? jobId = companionJobId(option.optionKey);
        if (jobId == null) return;
        _openCompanionJob(jobId, companionJobLabelParts(option.labelText));
        return;
      case CompanionAction.openJobsTab:
        context.go(Routes.jobs);
        return;
      case CompanionAction.openApplied:
        _openCompanionApplied();
        return;
      case CompanionAction.none:
        break;
    }
    switch (resumeMenuActionFor(option.optionKey)) {
      case ResumeMenuAction.openResumeUpload:
        // NO send, so no `_optionTapPending` latch: `pushOnce` already refuses a
        // duplicate push, and latching here would block the NEXT tap on the menu
        // if the worker comes back without sending anything.
        context.pushOnce(Routes.resumeUpload);
        return;
      case ResumeMenuAction.startFreshChat:
        // The BLOC owns the one-restart-at-a-time guard (a second event during
        // the mint is ignored), so the screen does not latch either.
        context.read<ChatBloc>().add(const ChatSessionRestarted());
        return;
      case ResumeMenuAction.openSection:
        // PILOT: Technical Skills re-asks only its questions on the EXISTING
        // trade-form pages (section-filtered walk, never submitted here).
        // Every other section still opens the Resume tab's Edit surface — the
        // same destination the server's ack copy names — until its own walk
        // lands. The key rides along either way so a test can assert WHICH
        // section was chosen without string-matching the display copy.
        if (option.optionKey == kResumeMenuTechnicalSkillsKey) {
          context.pushOnce(Routes.tradeForm, extra: option.optionKey);
          return;
        }
        context.pushOnce(Routes.resumeEdit, extra: option.optionKey);
        return;
      case ResumeMenuAction.sendToServer:
        break;
    }
    if (_optionTapPending) return;
    if (option.labelText.trim().isEmpty) return;
    setState(() => _optionTapPending = true);
    context.read<ChatBloc>().add(
          ChatMessageSent(
            option.labelText,
            optionKey: option.isNoneOfAbove ? '__declined' : option.optionKey,
            servedOption: true,
          ),
        );
  }

  /// #1559 / #1583 — a chip on a `multi_select` turn TICKS (or unticks)
  /// instead of sending. [options] is the whole row, so the none-of-above rule
  /// the voice and trade forms apply holds here too: ticking "none of these"
  /// clears the rest, ticking anything else clears "none of these".
  ///
  /// Blocked while a send is pending (see [_optionTapPending]): the turn is
  /// about to move on, and the listener would clear the tick anyway.
  void _toggleTick(ChatOption option, List<ChatOption> options) {
    if (_optionTapPending) return;
    setState(() {
      _ticked = applyNoneOfAboveRule(
        current: _ticked,
        key: option.optionKey,
        options: <VoiceChoice>[
          for (final ChatOption o in options)
            VoiceChoice(
              key: o.optionKey,
              label: o.labelText,
              isNoneOfAbove: o.isNoneOfAbove,
            ),
        ],
      );
    });
  }

  /// #1559 / #1583 — "Ho gaya" on a `multi_select` turn: every ticked choice
  /// goes as ONE message, the labels joined ([chatMultiSelectAnswer]) — the
  /// form the server's option matcher reads several choices from. One send
  /// per turn, like any chip (see [_optionTapPending]).
  ///
  /// No `optionKey`: the server serves no lookahead on a multi-select turn,
  /// and a joined answer has no single key to predict from. Flagged
  /// [ChatMessageSent.servedOption] because every part of it is a served label.
  void _sendTicked(List<ChatOption> options) {
    if (_optionTapPending) return;
    final String answer =
        chatMultiSelectAnswer(options: options, tickedKeys: _ticked);
    if (answer.isEmpty) return;
    setState(() {
      _optionTapPending = true;
      _ticked = const <String>[];
    });
    context
        .read<ChatBloc>()
        .add(ChatMessageSent(answer, servedOption: true));
  }

  /// #1583 — a Haan / Nahi quick reply on a `boolean` turn the server served
  /// no chips for. Sent as the plain word, exactly as if typed: the server
  /// reads it with the same yes/no parser it runs on typed text
  /// (`parseAffirmation`). Client-authored, so not a served option; no
  /// lookahead key (the question has no options to key one by). One send per
  /// turn (see [_optionTapPending]).
  void _sendBooleanReply(String word) {
    if (_optionTapPending) return;
    setState(() => _optionTapPending = true);
    context.read<ChatBloc>().add(ChatMessageSent(word));
  }

  /// Re-send the failed bubble at [index] (#343) — in place, no duplicate.
  void _retry(int index) {
    context.read<ChatBloc>().add(ChatRetryRequested(index));
  }

  /// Whether the viewport is within [_kNearBottomThreshold] of the end.
  bool get _isNearBottom {
    if (!_scroll.hasClients) return true;
    final ScrollPosition pos = _scroll.position;
    return pos.pixels >= pos.maxScrollExtent - _kNearBottomThreshold;
  }

  /// How many measure-and-jump passes [_animateToBottom] may take to settle.
  ///
  /// One is not enough once bubble heights VARY. A `ListView.builder` only
  /// ESTIMATES `maxScrollExtent` from the items it has currently laid out, so
  /// when the worker is scrolled UP — the multi-line opener on screen, the
  /// one-line answers below it unbuilt — the estimate is inflated. The
  /// animation then targets that inflated figure, overshoots the true end, and
  /// the old single corrective jump measured against a value that was itself
  /// still stale, leaving the transcript parked past its last bubble in blank
  /// space with nothing to scroll it back.
  ///
  /// MEASURED (400x700, `_kChatOpeningText` as the first bubble, one-word
  /// replies, worker scrolled to the top before the reply lands):
  ///
  ///   |  turns |  pixels |     max | overshoot |
  ///   |--------|---------|---------|-----------|
  ///   |      6 |   881.7 |   857.0 |     +24.7 |
  ///   |     12 |  1949.7 |  1589.0 |    +360.7 |
  ///   |     20 |  3373.8 |  2565.0 |    +808.8 |
  ///
  /// It is zero in every one of those fixtures when the worker is already AT
  /// the bottom (the estimate is then formed from the short bubbles), and zero
  /// with a single-line opener — which is why this only became reachable when
  /// the opener grew (#422), and why it is fixed in that same change.
  ///
  /// Each jump forces a layout pass, which sharpens the estimate, so a few
  /// bounded passes converge. Bounded so it can never spin.
  static const int _kBottomSettleSteps = 5;

  /// Smooth-scroll to the newest message after the list has rebuilt.
  ///
  /// A freshly-appended bubble can still be growing the list's
  /// `maxScrollExtent` on the frame we kick the animation off, so the captured
  /// target misses the true bottom in either direction. We animate to the
  /// best-known extent, then converge on the real one (see
  /// [_kBottomSettleSteps]) so the newest message is always fully in view.
  void _animateToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!_scroll.hasClients) return;
      await _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: AppMotion.base,
        curve: AppMotion.easeOut,
      );
      // Re-measure and re-jump until pixels and the reported end agree (or the
      // step budget runs out — never loop on a list that will not settle).
      for (int step = 0; step < _kBottomSettleSteps; step++) {
        if (!mounted || !_scroll.hasClients) return;
        final double end = _scroll.position.maxScrollExtent;
        if ((_scroll.position.pixels - end).abs() < 0.5) return;
        // Also corrects an OVERSHOOT (pixels beyond the true end), which left
        // the transcript parked past its last bubble in empty space.
        _scroll.jumpTo(end);
        await WidgetsBinding.instance.endOfFrame;
      }
    });
  }

  /// Clear the unread pill once the worker has scrolled back near the bottom.
  void _onScroll() {
    if (_hasUnreadBelow && _isNearBottom) {
      setState(() => _hasUnreadBelow = false);
    }
  }

  /// Decide how to react to a freshly-appended message.
  /// #1660 — an import that yielded NOTHING must not be silent.
  ///
  /// The import read cannot say how much was extracted (that field is backend
  /// #1656), but the session open can: a staged identity summary arrives as
  /// `resume_pending` and the chat opens on "Resume se ye mila: … Kya ye aap hi
  /// hain?". If the worker got here straight from an import and NO such turn
  /// was staged, the document gave us nothing — and he is owed one honest line
  /// rather than the ordinary first question as though he had never uploaded.
  ///
  /// Said ONCE, only after the session has actually opened, and never for an
  /// arrival that did not come from an import (the no-résumé door, a tab
  /// return, a deep link). It stays a CONTINUE — the interview carries on
  /// underneath (ruling D9) — and it is a client-side explanation, never a
  /// fabricated assistant turn in the transcript.
  void _maybeSayEmptyImport(ChatState state) {
    if (!widget.fromResumeImport || _emptyImportSaid) return;
    if (state.initializing || state.messages.isEmpty) return;
    _emptyImportSaid = true;
    if (state.resumePending) return; // the identity turn speaks for itself
    // ADR-0048 (#1864) — NOR ON AN IDENTITY-INTAKE OPEN. This line infers a
    // failed import from `resume_pending` being ABSENT, which stopped being a
    // safe inference once the chat could open on "aapka naam?": there the
    // absence means the server is asking for the worker's name, not that their
    // résumé yielded nothing. Telling them their résumé failed while asking
    // their name is two wrong things at once.
    if (state.askedQuestionKey != null &&
        kChatIdentityQuestionKeys.contains(state.askedQuestionKey)) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        const SnackBar(
          content: Text(
            'Resume dekh liya, lekin poori jaankari nahi ban paayi. Hum baat '
            'karke aage badhte hain.',
          ),
          duration: Duration(seconds: 6),
        ),
      );
  }

  void _onMessagesChanged(List<ChatMessage> messages) {
    if (messages.isEmpty) return;
    final bool ownMessage = messages.last.fromWorker;
    if (ownMessage || _isNearBottom) {
      // Own message always follows the worker down; a received one only when
      // they were already reading the bottom.
      if (_hasUnreadBelow) setState(() => _hasUnreadBelow = false);
      _animateToBottom();
    } else {
      // Received while scrolled up — surface the pill instead of jumping.
      setState(() => _hasUnreadBelow = true);
    }
  }

  void _jumpToBottom() {
    _animateToBottom();
    setState(() => _hasUnreadBelow = false);
  }

  /// Opens the voice-note screen and, when it pops with a completed
  /// [VoiceNoteOutcome], appends the transcript + reply bubbles. The pipeline
  /// already sent the transcript server-side, so this is a LOCAL append only
  /// (see [ChatVoiceMerged]).
  Future<void> _openVoiceNote() async {
    final ChatBloc bloc = context.read<ChatBloc>();
    final VoiceNoteOutcome? outcome = await context.push<VoiceNoteOutcome>(
      Routes.voiceNote,
    );
    if (outcome == null) return;
    bloc.add(
      ChatVoiceMerged(
        transcript: outcome.transcript,
        reply: outcome.reply,
        // A voice answer is a normal chat turn server-side, so it carries the
        // engine's readiness decision too (#421).
        extractionReady: outcome.extractionReady,
      ),
    );
  }

  /// Tap the MIC: START voice-to-text. The controller requests the mic
  /// permission, starts the DEVICE recogniser and raises the FULL-WIDTH waveform
  /// in place of the field. NOTHING is typed while listening — the recognised
  /// text lands in the field only on Stop. Anything already typed is preserved:
  /// recognised words append onto it. A denied mic / no recogniser surfaces an
  /// honest notice and leaves typing untouched — never a crash.
  Future<void> _startDictation() =>
      _dictation.start(initialText: _controller.text);

  /// Tap Stop: end listening and DROP the recognised text into the field — the
  /// waveform hides and all the spoken text lands at once. NOTHING is sent here;
  /// the trailing button becomes Send.
  void _stopDictation() {
    final String text = _dictation.stop();
    if (text.isEmpty) {
      // The mic ran and heard nothing — say so. Dropping the waveform in silence
      // reads as a broken app on the surface where the worker is answering.
      _showComposerNotice(kVoiceToTextUnavailable);
      return;
    }
    _landDictation(text);
  }

  /// Put recognised [text] in the composer with the caret at the end.
  ///
  /// A programmatic write like this NEVER goes through the field's
  /// [DevanagariBlockFormatter] (formatters only intercept interactive
  /// keyboard input) — dictation is a separate route into the same box, so
  /// it needs its own strip here rather than relying on the formatter.
  void _landDictation(String text) {
    if (text.isEmpty || !mounted) return;
    final String romanized = stripDevanagari(text);
    setState(() {
      if (romanized != text) _devanagariBlocked = true;
      _controller.value = TextEditingValue(
        text: romanized,
        selection: TextSelection.collapsed(offset: romanized.length),
      );
    });
  }

  /// SEND while listening (the send arrow on the recorder row): end listening and
  /// send the recognised text in ONE tap. A stop with no speech just returns to
  /// the idle composer.
  void _sendFromDictation() {
    final String text = _dictation.stopForSend();
    if (text.isEmpty) {
      _showComposerNotice(kVoiceToTextUnavailable);
      return;
    }
    _sendText(text);
    _controller.clear();
  }

  /// The read-aloud speaker on a bot bubble. Tap → speak that question; tap the
  /// same one again (or it finishes) → stop. Shows a stop glyph while reading.
  ///
  /// [ttsText] is the Devanagari rendering of [text] (#896): when present it is
  /// what gets SPOKEN (romanized Hindi is unpronounceable by TTS), while [text]
  /// stays what the bubble shows. Null (older API / worker bubble) → speak [text].
  Widget _speakerButton(int index, String text, String? ttsText) {
    final bool active = _speakingIndex == index;
    return IconButton(
      onPressed: () => _toggleSpeak(index, text, ttsText),
      tooltip: 'Sunein',
      // No visualDensity.compact — it shrinks the constraints below and netted a
      // ~44px target; the read-aloud button must honour the full 48px tap floor.
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(
        minWidth: AppSpacing.tap,
        minHeight: AppSpacing.tap,
      ),
      icon: Icon(
        active ? Icons.stop_circle_outlined : Icons.volume_up_rounded,
        size: 20,
        color: OnboardingColors.shiftBlue,
      ),
    );
  }

  /// Reads bot bubble [index] aloud, or stops it if it is already the one
  /// speaking. Best-effort: no recogniser/voice just does nothing (the text is
  /// on screen). The speaker icon clears when playback finishes.
  ///
  /// #896 — SPEAKS the Devanagari [ttsText] when present (so the hi-IN voice
  /// pronounces the Hindi), falling back to the on-screen romanized [text] when
  /// absent. The bubble display is unaffected either way.
  Future<void> _toggleSpeak(int index, String text, String? ttsText) async {
    if (!locator.isRegistered<SpeechReader>()) return;
    final SpeechReader reader = locator<SpeechReader>();
    if (_speakingIndex == index) {
      await reader.stop();
      if (mounted) setState(() => _speakingIndex = null);
      return;
    }
    await reader.stop();
    if (!mounted) return;
    setState(() => _speakingIndex = index);
    await reader.speak(ttsText ?? text); // resolves when playback finishes
    if (mounted && _speakingIndex == index) {
      setState(() => _speakingIndex = null);
    }
  }

  /// A transient, honest snackbar for the hold-to-talk failure paths (mic
  /// denied, nothing heard, transcription unavailable). Typing itself is
  /// never blocked, except character-by-character for Devanagari script
  /// (see [_devanagariBlocked] / [DevanagariBlockFormatter]), which uses the
  /// persistent [_replyNotice] instead of this transient one.
  void _showComposerNotice(String message) {
    if (!mounted || message.trim().isEmpty) return;
    // Plain Text on purpose: a custom AppTypography style defaults to a DARK
    // color, which is invisible on the SnackBar's dark surface (the "blank
    // toast"). Letting the SnackBar theme the text keeps it readable.
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
      );
  }

  /// A thin one-line notice above the composer (blocked cue). Additive —
  /// it never replaces a bubble, and reads as calm context, not an error screen.
  Widget _replyNotice({
    required IconData icon,
    required Color color,
    required String text,
  }) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s1,
      ),
      child: _capped(
        Row(
          children: <Widget>[
            Icon(icon, size: 16, color: color),
            const SizedBox(width: AppSpacing.s2),
            Flexible(
              child: Text(
                text,
                style: OnboardingTypography.inter(size: 13, color: color),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Caps a bottom-stack row at [OnboardingLayout.maxContentWidth] and centres
  /// it, so on a tablet or landscape phone the composer, CTA and option cards
  /// keep the kit's proportions instead of stretching edge to edge. A no-op on
  /// any phone narrower than the cap.
  Widget _capped(Widget child) {
    return Center(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: OnboardingLayout.maxContentWidth,
        ),
        child: child,
      ),
    );
  }

  /// The "build my profile" CTA (#421).
  ///
  /// Not-ready is a SOFT gate: the button keeps its full-width ≥48px target and
  /// stays tappable — it just changes voice from "done" to "let's talk a bit
  /// more", and routes through [_confirmEarlyFinish] instead of straight to the
  /// preview. Nothing here can leave the worker stuck.
  Widget _doneCta(ChatState state) {
    final bool ready = state.extractionReady;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        0,
        AppSpacing.s4,
        AppSpacing.s3,
      ),
      // Master UI Kit: both labels ride the kit's yellow PrimaryActionButton.
      // The READY "profile banaiye" CTA keeps the forward arrow (it moves the
      // worker on); the not-ready "Thodi aur baat karein" invitation drops it,
      // so the two still read differently at a glance. Both stay tappable —
      // the #421 soft gate is unchanged.
      child: _capped(
        PrimaryActionButton(
          label: ready ? kChatDoneReadyLabel : kChatDoneNotReadyLabel,
          showArrow: ready,
          // #372's visible half: the same-frame half lives in
          // `_openProfilePreview`. Only the READY path can stack previews —
          // the not-ready path opens a sheet, which is its own guard.
          onPressed: ready
              ? (_openingPreview ? null : _openProfilePreview)
              : _confirmEarlyFinish,
        ),
      ),
    );
  }

  /// The handover card (#1339/#1340) — drawn INSTEAD OF [_doneCta] on the one
  /// turn the interview hands the worker to a trade-specific form (see
  /// [ChatState.formOffer] for why the two must never both render).
  ///
  /// [offer].headline and the button label are SERVER-SUPPLIED copy, not
  /// client-authored — `persona_neutrality_test.dart`'s scan does not apply to
  /// them (see [FormOffer]); this widget's own layout contributes no static
  /// copy of its own. Drawn as the Master UI Kit's sticky white action card: a
  /// successGreen check icon before the SERVER headline (an icon, never a
  /// glyph spliced into the server string), then the kit's yellow CTA.
  Widget _formOfferCard(FormOffer offer) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        0,
        AppSpacing.s4,
        AppSpacing.s3,
      ),
      child: _capped(
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: OnboardingColors.paperWhite,
            borderRadius: BorderRadius.circular(OnboardingRadii.card),
            border: Border.all(color: OnboardingColors.borderDefault, width: 1.2),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Padding(
                    padding: EdgeInsets.only(top: 1),
                    child: Icon(
                      Icons.check_circle_rounded,
                      size: 20,
                      color: OnboardingColors.successGreen,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.s2),
                  Expanded(
                    child: Text(
                      offer.headline,
                      style: OnboardingTypography.subheadBold(),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.s3),
              // #1364 — `ctaLabel` is server-supplied copy that can run long
              // ("Form bharkar resume pura karein") and must never be
              // shortened client-side; [_WrappingPrimaryButton] lets it wrap
              // to a second line instead of truncating or shrinking it.
              _WrappingPrimaryButton(
                label: offer.ctaLabel,
                onPressed: _openingTradeForm ? null : _openTradeForm,
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Opens the trade form at most once per round trip — same same-frame
  /// double-tap guard as [_openProfilePreview] (#372): the disabled state on
  /// the CTA button arrives only on the NEXT frame, too late to stop a real
  /// double-tap landing both inside the current one.
  Future<void> _openTradeForm() async {
    if (_openingTradeForm) return;
    setState(() => _openingTradeForm = true);
    try {
      // #1698 — stops at the tier chooser ONLY when the server says this
      // worker still has to choose; every other answer pushes the form exactly
      // as this line always did.
      await openTradeFormWithTier(context, entry: TierEntry.pushed);
    } finally {
      // The worker can back out of the form and return to this (dead) chat
      // session — re-arm so the card stays tappable rather than permanently
      // disabled.
      if (mounted) setState(() => _openingTradeForm = false);
    }
  }

  /// #1689 — the server has ACCEPTED the résumé update and is doing all of it
  /// itself. Take the worker to the Résumé tab, where #1688 shows them it
  /// landing.
  ///
  /// This REPLACES the preview/confirm step for this one path, and nothing
  /// here calls extract / confirm / generate: the worker's "Haan" was the
  /// consent and the server is already acting on it, so a client-side call
  /// would mint a SECOND résumé for the same acceptance.
  ///
  /// `go`, not `push`: the interview is over (`session_ended: true` rides the
  /// same turn), so the chat must not stay on the stack behind the tab. The
  /// latch is synchronous for the same reason `_openingPreview` is — two
  /// emits inside one frame must not both navigate.
  bool _leavingForResumeUpdate = false;

  void _maybeLeaveForResumeUpdate(ChatState state) {
    if (!state.resumeUpdateQueued || _leavingForResumeUpdate) return;
    _leavingForResumeUpdate = true;
    context.go(Routes.resume);
  }

  /// Opens the profile preview at most once per round trip (#372).
  ///
  /// The boolean is checked SYNCHRONOUSLY, before the frame that disables the
  /// button paints: a real double-tap lands both taps inside the same frame, so
  /// the disabled state alone would arrive too late to stop the second push —
  /// which stacked duplicate preview screens AND duplicate extraction jobs.
  Future<void> _openProfilePreview() async {
    if (_openingPreview) return;
    setState(() => _openingPreview = true);
    try {
      await context.pushOnce(Routes.profilePreview);
    } finally {
      // Confirming the profile leaves via `go(/building)` — this screen is gone
      // by then, hence the mounted check before re-arming the button.
      if (mounted) setState(() => _openingPreview = false);
    }
  }

  /// Warm nudge when the engine has not called the interview complete yet.
  ///
  /// Explains WHY in one plain Hinglish line and offers both ways out: keep
  /// talking (the default, primary) or build the profile anyway. The escape
  /// hatch is deliberate — the client must never be the reason a worker cannot
  /// finish (e.g. if `extraction_ready` were missing from a reply, which the
  /// parser reads as "not ready").
  Future<void> _confirmEarlyFinish() async {
    final bool? proceed = await showBbBottomSheet<bool>(
      context: context,
      // The EXPLANATION scrolls; the two ways out are DOCKED below it (the
      // sheet's `footer`). With the actions at the end of the scrolling body, a
      // 320x568 screen at a 2.0 system font showed a half-cut 'Baat jaari
      // rakhein' and pushed the escape hatch off the sheet entirely — exactly
      // what this screen's own rule forbids: a client-side gate must never be
      // able to trap a worker in a chat they cannot leave.
      builder: (BuildContext sheetContext) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              kChatNudgeTitle,
              style: OnboardingTypography.questionHeadline(
                color: OnboardingColors.shiftBlue,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            Text(
              kChatNudgeBody,
              style: OnboardingTypography.body(color: OnboardingColors.ink600),
            ),
          ],
        ),
      ),
      footer: (BuildContext sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const SizedBox(height: AppSpacing.s5),
          PrimaryActionButton(
            label: kChatNudgeContinueLabel,
            showArrow: false,
            onPressed: () => Navigator.of(sheetContext).pop(false),
          ),
          const SizedBox(height: AppSpacing.s2),
          // The escape hatch stays a quiet text action under the yellow CTA —
          // present and thumb-sized, never competing with "keep talking".
          MediaQuery.withClampedTextScaling(
            maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
            child: TextButton(
              style: TextButton.styleFrom(
                foregroundColor: OnboardingColors.shiftBlue,
                minimumSize: const Size(
                  double.infinity,
                  OnboardingLayout.tapTarget,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(OnboardingRadii.button),
                ),
              ),
              onPressed: () => Navigator.of(sheetContext).pop(true),
              child: Text(
                kChatNudgeProceedLabel,
                textAlign: TextAlign.center,
                style: OnboardingTypography.buttonLabel(),
              ),
            ),
          ),
        ],
      ),
    );
    if (proceed != true) return;
    if (!mounted) return;
    _openProfilePreview();
  }

  @override
  Widget build(BuildContext context) {
    // B7 kill switch. Defaults to VISIBLE (today's behaviour); ops can hide the
    // mic without a release if transcription is degraded. Typing is untouched,
    // so this narrows the flow and never blocks it.
    //
    // Read at BUILD time, with no listener on Remote Config: a fetch that lands
    // mid-conversation applies from the next build, not the next frame. That is
    // deliberate — a control must not vanish from under a worker's thumb
    // between the moment they reach for it and the moment they tap.
    final bool showVoice = !BbRemoteConfig.instance.voiceEntryHidden;
    // B7 display lever: a non-empty notice is shown above the composer. Empty by
    // default, so nothing renders unless ops set one.
    final String maintenance = BbRemoteConfig.instance.chatMaintenanceNotice;
    // D3: the header's inner row sits on the SAME grid as the body. The
    // transcript and the composer both stop at
    // [OnboardingLayout.maxContentWidth] and centre, so on a tablet the 'BB /
    // Bada Bhai / online' lockup and the Feedback action sat ~144dp outside the
    // column they belong to.
    //
    // It is the SAME expression the transcript's `listGutter` uses, applied as
    // PADDING with `titleSpacing: 0` rather than as titleSpacing: an AppBar
    // charges `titleSpacing` against BOTH sides of the middle slot, so pushing
    // the gutter through it took the width away twice and overflowed the
    // lockup on a landscape phone.
    final double headerGutter = math.max(
      AppSpacing.s4,
      (MediaQuery.sizeOf(context).width - OnboardingLayout.maxContentWidth) / 2,
    );
    final double headerActionGutter = math.max(
      AppSpacing.s2,
      (MediaQuery.sizeOf(context).width - OnboardingLayout.maxContentWidth) / 2,
    );
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      appBar: AppBar(
        // Master UI Kit chat header: a SHIFT BLUE bar with the brand mark
        // (badabhai_main.png) + 'Bada Bhai / online'. The voice-note entry moved OUT of the
        // app bar and INTO the composer (the haldi mic), per the kit — its kill
        // switch (`showVoice`) still governs it. The back arrow is still the
        // AppBar's own implied one: drawn only when this route can pop (the
        // onboarding chat), absent on the Bada Bhai tab.
        backgroundColor: OnboardingColors.shiftBlue,
        foregroundColor: OnboardingColors.textOnBlue,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        iconTheme: const IconThemeData(color: OnboardingColors.textOnBlue),
        systemOverlayStyle: SystemUiOverlayStyle.light,
        // Kit gutter of left space so the brand mark + title are not flush
        // against the screen edge — aligns the header with the body's margin.
        titleSpacing: 0,
        title: Padding(
          padding: EdgeInsets.only(left: headerGutter),
          child: MediaQuery.withClampedTextScaling(
          maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
          child: Row(
            children: <Widget>[
              Image.asset(
                // The brand mark, same asset as the global BrandBadge lockup.
                'assets/fonts/image/badabhai_main.png',
                width: 36,
                height: 36,
                filterQuality: FilterQuality.high,
                excludeFromSemantics: true,
              ),
              const SizedBox(width: 10),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      'Bada Bhai',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: OnboardingTypography.anek(
                        size: 17,
                        weight: FontWeight.w700,
                        color: OnboardingColors.textOnBlue,
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: OnboardingColors.successGreen,
                            shape: BoxShape.circle,
                            // A light ring so the dark kit green still reads
                            // as a status dot on the navy band.
                            border: Border.all(
                              color: OnboardingColors.successBg,
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            'online',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: OnboardingTypography.inter(
                              size: 12,
                              weight: FontWeight.w500,
                              color: OnboardingColors.textOnBlueMuted,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          ),
        ),
        // OWNER REQUEST (2026-10-05): this slot used to be the Feedback action
        // (the app-wide floating Feedback button is excluded on this screen —
        // see feedback_fab.dart). The click is gone and the 'Feedback' word with
        // it: the slot now shows the worker's OWN NAME, the way the onboarding
        // chat already does once the identity intake captures it (ADR-0048). On
        // the Bada Bhai tab there is no intake, so the name is read from the
        // profile ([_loadHeaderName]).
        actions: <Widget>[
          Padding(
            padding: EdgeInsets.only(right: headerActionGutter),
            child: MediaQuery.withClampedTextScaling(
              maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
              // ADR-0048 — the action gives a small settle pop when a captured
              // name lands. A ScaleTransition (not a keyed builder) keeps the
              // subtree — and the label's cross-fade — alive across the pop.
              child: ScaleTransition(
                scale: _namePopScale,
                // A plain, NON-CLICKABLE label — no Feedback navigation. The key
                // stays so a captured name still flies here (ADR-0048).
                child: Container(
                  key: _headerNameActionKey,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(
                      OnboardingRadii.feedbackButton,
                    ),
                    border: Border.all(
                      color: Colors.white.withValues(alpha: 0.25),
                    ),
                  ),
                  child: BbAnimatedSwitcher(
                    child: ConstrainedBox(
                      // The switcher animates on the DIRECT child's key, so the
                      // key rides the ConstrainedBox (the label rides inside).
                      key: ValueKey<String>(_headerName ?? ''),
                      // A long name must never blow the header's layout: cap it
                      // and ellipsize rather than shove the title off screen.
                      constraints: BoxConstraints(
                        maxWidth: MediaQuery.sizeOf(context).width * 0.34,
                      ),
                      child: Text(
                        // The worker's own name; empty until it is known.
                        _headerName ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: OnboardingTypography.inter(
                          size: 13,
                          weight: FontWeight.w700,
                          color: OnboardingColors.textOnBlue,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
        // OIE Phase 8 (#649): the pack progress line sits on the header's
        // bottom edge. SAME value as before (`ChatState.progress`), and hidden
        // (an empty navy strip) until a pack resolves — no invented progress.
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(_kHeaderProgressHeight),
          child: BlocBuilder<ChatBloc, ChatState>(
            buildWhen: (ChatState prev, ChatState curr) =>
                prev.progress != curr.progress,
            builder: (BuildContext context, ChatState state) =>
                state.progress == null
                    ? const SizedBox(height: _kHeaderProgressHeight)
                    : _HeaderProgressLine(value: state.progress!.fraction),
          ),
        ),
      ),
      body: BlocListener<ChatBloc, ChatState>(
        // Fire when a message is appended (length grows) OR when the in-flight
        // flag moves — NOT on every state change (e.g. the initializing flag
        // flipping). The second condition carries the one-tap-per-turn latch.
        listenWhen: (ChatState prev, ChatState curr) =>
            curr.messages.length > prev.messages.length ||
            curr.sending != prev.sending ||
            curr.initializing != prev.initializing ||
            // #1689 — the terminal turn that settled a "Haan" must be acted on
            // even if nothing else about the state moved.
            curr.resumeUpdateQueued != prev.resumeUpdateQueued ||
            // ADR-0046 §5.2 — the edit card's one-shot notice. On the CHANGE
            // edge only, so it is shown once and never re-shown on a rebuild.
            curr.editNotice != prev.editNotice ||
            // ADR-0048 — the identity turn moved on, so a held city may now be
            // due (see [_maybeAnswerHeldCity]).
            curr.askedQuestionKey != prev.askedQuestionKey ||
            // ADR-0048 — a name was captured: fly it up to the header.
            curr.workerName != prev.workerName,
        listener: (BuildContext context, ChatState state) {
          _maybeFlyName(state);
          _maybeAnswerHeldCity(state);
          _showEditNotice(state);
          _maybeSayEmptyImport(state);
          _maybeLeaveForResumeUpdate(state);
          // Release on the SETTLE EDGE (sending true → false), never on the
          // way in: the bloc clears followups and sets sending as soon as the
          // worker sends, so anything keyed on those unlatches while the turn
          // is still in flight — which is precisely the window the latch is
          // for.
          if (_wasSending && !state.sending && _optionTapPending) {
            setState(() => _optionTapPending = false);
          }
          // Custom-answer mode belongs to the question it was opened on. This
          // listener only fires when a message lands or `sending` flips —
          // i.e. the turn has moved on — so drop it here.
          if (_customAnswerMode) setState(() => _customAnswerMode = false);
          // #1559 / #1583 — ticks belong to the question they were made on,
          // for the same reason.
          if (_ticked.isNotEmpty) setState(() => _ticked = const <String>[]);
          _wasSending = state.sending;
          _onMessagesChanged(state.messages);
        },
        child: BlocBuilder<ChatBloc, ChatState>(
          builder: (BuildContext context, ChatState state) {
            if (state.initializing) {
              // Branded, captioned loader — the design system bans bare Material
              // spinners, and a low-literacy worker gets a "loading…" cue.
              return const BbStatusView.loading(
                  caption: 'Bada Bhai taiyaar ho raha hai…');
            }
            // Master UI Kit width cap: the transcript column stops at
            // [OnboardingLayout.maxContentWidth] and centres on a tablet or
            // landscape phone. On any phone narrower than the cap this is the
            // same 16px gutter and 78%-of-screen bubble as before.
            final double screenWidth = MediaQuery.sizeOf(context).width;
            final double listGutter = math.max(
              AppSpacing.s4,
              (screenWidth - OnboardingLayout.maxContentWidth) / 2,
            );
            final double bubbleMaxWidth =
                math.min(screenWidth, OnboardingLayout.maxContentWidth) * 0.78;
            // ADR-0048 — the index of the LAST worker bubble, so the captured
            // name's flight has a real source to lift off from. At the instant a
            // name is captured this is the bubble the name was typed into.
            int lastWorkerIndex = -1;
            for (int i = state.messages.length - 1; i >= 0; i--) {
              if (state.messages[i].fromWorker) {
                lastWorkerIndex = i;
                break;
              }
            }
            return Stack(
              children: <Widget>[
                // bottom: false — the docked composer panel consumes the
                // system inset ITSELF (see [_bottomComposerSegment]), so its
                // white ground runs to the screen edge instead of stopping
                // above the home-indicator area and showing canvas under it.
                SafeArea(
                  bottom: false,
                  child: LayoutBuilder(
                   builder: (BuildContext context, BoxConstraints body) =>
                    Column(
                    children: <Widget>[
                      if (state.sessionFailed) _sessionBanner(),
                      // OIE Phase 8 (#649): the pinned occupation pill. Hidden
                      // until a trade pins. (The pack progress line moved onto
                      // the header's bottom edge — see the AppBar `bottom`.)
                      if (state.occupationLabel != null)
                        _occupationStrip(state.occupationLabel!),
                      Expanded(
                        child: Stack(
                          children: <Widget>[
                            ListView.builder(
                              controller: _scroll,
                              // Full horizontal gutter, lighter vertical rhythm so
                              // more of the transcript stays visible with the
                              // keyboard up.
                              padding: EdgeInsets.symmetric(
                                horizontal: listGutter,
                                vertical: AppSpacing.s2,
                              ),
                              itemCount: state.messages.length,
                              itemBuilder: (BuildContext context, int i) {
                                final ChatMessage m = state.messages[i];
                                final bool failed =
                                    m.status == ChatSendStatus.failed;
                                return _ChatBubble(
                                  // ADR-0048 — the name's flight lifts off from
                                  // the last worker bubble.
                                  key: i == lastWorkerIndex
                                      ? _lastWorkerBubbleKey
                                      : null,
                                  text: m.text,
                                  fromWorker: m.fromWorker,
                                  maxWidth: bubbleMaxWidth,
                                  failed: failed,
                                  onRetry: failed ? () => _retry(i) : null,
                                  // Read-aloud speaker on bada bhai's questions
                                  // only (never the worker's own messages). #896 —
                                  // pass the Devanagari script so read-aloud speaks
                                  // it (falls back to the romanized text when null).
                                  //
                                  // ADR-0046 O9 — EXCEPT on a model-written turn.
                                  // That fallback is the hazard there: such a turn
                                  // has no reviewed Devanagari twin, so `ttsText ??
                                  // text` would read the model's raw romanized
                                  // Hinglish aloud in a hi-IN voice. A bubble the
                                  // server marked `read_aloud: false` is offered no
                                  // speaker at all.
                                  trailing: (!m.fromWorker && !failed && m.canReadAloud)
                                      ? _speakerButton(i, m.text, m.ttsText)
                                      : null,
                                );
                              },
                            ),
                            if (_hasUnreadBelow)
                              Positioned(
                                left: 0,
                                right: 0,
                                bottom: AppSpacing.s3,
                                child: Center(child: _jumpPill()),
                              ),
                          ],
                        ),
                      ),
                      // #1059 — the answer affordance (typing indicator ↔ chips)
                      // cross-fades instead of snapping. The child is keyed by
                      // KIND ('typing' / 'chips' / 'none') so typing→chips
                      // animates while chip→chip content changes stay instant.
                      // Layout safety (320x568 at a 2.0 system font): the stack
                      // under the transcript — answer options, notices,
                      // composer and CTA / handover card — takes at most
                      // [_kBottomStackMaxFraction] of the body and scrolls
                      // inside that, so the transcript is never squeezed into
                      // an overflow. On an ordinary phone the stack is far
                      // shorter than the cap: nothing scrolls, nothing moves.
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxHeight: body.maxHeight * _kBottomStackMaxFraction,
                        ),
                        child: SingleChildScrollView(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                      // ADR-0046 Phase 1 — the edit card (companion mode only)
                      if (state.companion &&
                          BbRemoteConfig.instance.chatCompanionV2Enabled &&
                          state.editProposal != null)
                        _editProposalCard(state.editProposal!),
                      BbAnimatedSwitcher(child: _answerAffordance(state)),
                      // A blocked turn (pseudonymize fail-closed) never processed the
                      // worker's last answer — say so rather than let the canned
                      // fallback reply read as understood. Shown in every build.
                      if (state.lastReplyBlocked)
                        _replyNotice(
                          icon: Icons.error_outline,
                          color: OnboardingColors.errorRed,
                          text: kChatBlockedNotice,
                        ),
                      // B7 maintenance notice — ops copy, shown only when set.
                      if (maintenance.isNotEmpty)
                        _replyNotice(
                          icon: Icons.info_outline,
                          color: OnboardingColors.ink500,
                          text: maintenance,
                        ),
                      // #1411 — Devanagari never reaches the composer; this
                      // is why, the first time it happens this session.
                      if (_devanagariBlocked)
                        _replyNotice(
                          icon: Icons.error_outline,
                          color: OnboardingColors.errorRed,
                          text: kDevanagariBlockedHint,
                        ),
                      _bottomComposerSegment(state, showVoice),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  /// The composer-or-hint row plus the CTA-or-handover-card row, as ONE
  /// measured segment (#1364): wrapped in [_bottomSegmentKey] so
  /// [_publishBottomInset] can tell the app-wide Feedback FAB how tall
  /// today's bottom content actually is. Scheduled on every call — which
  /// tracks the [BlocBuilder] rebuild cadence — because either row's content
  /// (and so this segment's height) can change from turn to turn.
  Widget _bottomComposerSegment(ChatState state, bool showVoice) {
    _publishBottomInset();
    // One white docked panel (Master UI Kit bottom bar): the composer's top
    // hairline is the panel's edge, and the CTA / handover card sit on the same
    // white below it. The ColoredBox adds no height, so the measured segment
    // is exactly the keyed Column.
    return ColoredBox(
      color: OnboardingColors.paperWhite,
      // The system bottom inset is consumed HERE, inside the white panel and
      // OUTSIDE the measured Column: the panel paints to the screen edge while
      // `bottomBarInset` keeps reporting the height above the inset, which is
      // exactly what the floating Feedback pill adds the inset to.
      child: Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewPaddingOf(context).bottom,
      ),
      child: Column(
      key: _bottomSegmentKey,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        // #770 — the composer (and its mic, since voice resolves to
        // typed text) is suppressed ONLY on the engine's yes/no gate
        // ("Aur koi experience jodna hai?" → Haan / Nahi). Any other
        // options_only turn — a model-chosen one, e.g. role
        // suggestions — keeps it: the server accepts typed text on
        // every turn and the worker's profile may not be a chip.
        // [_isYesNoGate] needs two chips, so a malformed options_only
        // turn with no chips still never traps the worker, and
        // custom-answer mode always brings the composer back.
        //
        // #1363 — a form_offer turn is the server CLOSING the
        // session (`kind: "close"`, `form_handoff`): typing into it
        // would be swallowed, so the composer must never render
        // alongside the handover card. `state.formOffer != null`
        // alone is a safe gate (unlike options_only, [FormOffer]
        // has no "empty list" hazard — its required fields cannot
        // be blank; see `FormOffer.fromJson`), so no separate flag
        // is needed. Shares the [_optionsOnlyHint] locked-look
        // FRAME (via [_lockedComposerBar]) with its own copy,
        // rather than leaving a bare gap.
        if (state.inputMode == ChatInputMode.optionsOnly &&
            !_customAnswerMode &&
            _isYesNoGate(state))
          _optionsOnlyHint()
        // #1821 F1 — THE COOL-DOWN BLOCKS FREE TEXT, AND ONLY FREE TEXT. The
        // server serves `cooldown_until` on a faltu turn; until that instant the
        // composer is replaced by a locked bar counting down. The chips above
        // this segment are untouched on purpose: a cooled-down worker must still
        // reach their résumé and the jobs, which is what the chips are for.
        else if (_cooldownActive(state))
          _cooldownComposerLock(state.cooldownUntil!)
        else if (state.gateKind == 'skills')
          _skillsGateLockedHint()
        else if (state.formOffer != null)
          _formOfferLockedHint()
        else
          _inputBar(
            // ONE MIC PER SCREEN (#1862). In companion mode the v2 voice button
            // sits just below this composer, and BOTH were labelled "Bolkar
            // likhein" — two identical controls, doing different things (this
            // one dictates locally; that one uploads and transcribes). The v2
            // button is the surface ADR-0046 F3 specifies, so the composer's own
            // dictation mic stands down there. The interview keeps it, exactly
            // as before.
            showVoice && !state.companion,
            // #1583 — a `number` question opens the number keypad for this
            // turn only; the turn-scoped answerType reverts it on the next.
            numeric: state.answerType == ChatAnswerType.number,
          ),
        // #1339/#1340 — the handover card REPLACES the "build my
        // profile" CTA on the one turn that hands the worker to a
        // trade form, never alongside it. `extraction_ready` is
        // already false on that turn (see [ChatState.formOffer]),
        // but `_doneCta` renders UNCONDITIONALLY regardless of
        // readiness (it only changes label/style) — so this branch,
        // not that flag, is what actually keeps the two CTAs from
        // both appearing.
        if (state.formOffer != null)
          _formOfferCard(state.formOffer!)
        // ADR-0044 — a companion worker's profile is DONE: "build my profile"
        // would only re-open the preview for a finished interview.
        else if (!state.companion)
          _doneCta(state)
        // ADR-0046 F3 — the companion composer's mic. TWO levers, both of which
        // must be on: the v2 lever (the whole Phase 1 UI ships dark) and the
        // SHIPPED B7 mic kill switch, which exists so ops can pull every mic in
        // the app without a release when transcription is degraded. This is the
        // same `voiceEntryHidden` the interview composer above obeys — a second
        // mic that ignored it would quietly defeat the switch during exactly the
        // incident it was built for.
        // ...AND NOT WHILE COOLING DOWN. The mic resolves to typed text in the
        // very composer the cool-down just removed, so leaving it up let a
        // worker record, transcribe and land a transcript in a box that is not
        // on screen — the wait, defeated by the control beside it.
        else if (state.companion &&
            BbRemoteConfig.instance.chatCompanionV2Enabled &&
            !BbRemoteConfig.instance.voiceEntryHidden &&
            !_cooldownActive(state))
          _companionVoiceButton(),
      ],
      ),
      ),
    );
  }

  /// ADR-0046 F3 — the companion composer's voice button: the EXISTING voice
  /// upload + transcribe flow (consent `voice_processing` as today), but the
  /// transcript lands in the COMPOSER for the worker to review and send rather
  /// than being merged into a chat session the companion does not have.
  ///
  /// Only rendered while the v2 lever is on (the whole Phase 1 UI ships dark).
  Widget _companionVoiceButton() {
    // OWNER REQUEST (2026-10-05): the "Awaaz note record karein" pill is
    // PERMANENTLY hidden for now. Wrapped in [Visibility] (not deleted) so the
    // button can be restored by flipping `visible` back to `true`.
    return Visibility(
      visible: false,
      child: Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s3,
        AppSpacing.s4,
        AppSpacing.s3,
      ),
      // A LABELLED CTA, NOT A SECOND BARE MIC (owner request). This sat directly
      // above the composer's dictation mic wearing the same `Icons.mic` and the
      // same words, so one screen read as two mics for one job. They are two
      // jobs: the composer's mic types what you say into the field as you speak,
      // this one records a note, has it transcribed and drops the text back for
      // review. A distinct glyph AND words on the face carry that difference; a
      // bare second yellow circle cannot.
      //
      // The kit's own CTA rather than a hand-rolled pill: its `FittedBox` scales
      // a long Hinglish label down instead of painting overflow stripes inside
      // the control, which a fixed-width pill does at 320dp and text scale 2.0.
      // `buttonKey` keeps the handle a test needs on THIS voice entry — the
      // screen carries three (this one, the composer's dictation mic and the
      // interview's voice note) and only this one rides the v2 lever.
      child: _capped(
        PrimaryActionButton(
          buttonKey: kCompanionVoiceButtonKey,
          label: kCompanionVoiceLabel,
          leadingIcon: Icons.voice_chat,
          showArrow: false,
          onPressed: _openCompanionVoiceNote,
        ),
      ),
      ),
    );
  }

  /// Opens the voice-note screen in COMPOSE mode: it records, uploads and
  /// transcribes exactly as it always has, then pops the approved transcript
  /// instead of sending it. The text lands in the composer for review — the
  /// worker sends it as an ordinary companion message, so it goes through the
  /// classifier like anything they type.
  Future<void> _openCompanionVoiceNote() async {
    final String? transcript =
        await context.push<String>(Routes.voiceNote, extra: true);
    if (transcript == null || !mounted || transcript.trim().isEmpty) return;
    _landDictation(transcript);
    _composerFocus.requestFocus();
  }

  /// Kit 03 composer. IDLE: a rounded pill input + a trailing MIC / SEND button.
  /// While the worker dictates, the input area IS the recorder — a FULL-WIDTH
  /// static waveform ([_listeningBar]) fills the field slot with Stop + Send, and
  /// NOTHING is typed until Stop lands the recognised text in the field.
  ///
  /// [numeric] (#1583) swaps the field's keyboard to a number keypad; the mic
  /// and dictation are untouched (dictated text lands in the field as before).
  Widget _inputBar(bool showVoice, {bool numeric = false}) {
    return Container(
      decoration: const BoxDecoration(
        color: OnboardingColors.paperWhite,
        border: Border(top: BorderSide(color: OnboardingColors.borderDefault)),
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s3,
        AppSpacing.s2,
        AppSpacing.s3,
        AppSpacing.s2,
      ),
      child: _capped(
        _dictation.listening
            ? DictationBar(
                level: _dictation.level,
                waveKey: const ValueKey<String>('voiceWaveInline'),
                onStop: _stopDictation,
                onSend: _sendFromDictation,
              )
            : _idleBar(showVoice, numeric: numeric),
      ),
    );
  }

  /// The normal composer row: (hidden) voice-note mic + text field + the trailing
  /// mic/send action. [numeric]: see [_inputBar].
  Widget _idleBar(bool showVoice, {bool numeric = false}) {
    return Row(
      children: <Widget>[
        // Owner request: HIDE the bottom-left voice-note mic — hidden with
        // Visibility ONLY (no code removed); flip `visible` true to restore it.
        if (showVoice)
          Visibility(
            visible: false,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                _composerMic(),
                const SizedBox(width: AppSpacing.s2),
              ],
            ),
          ),
        Expanded(
          child: TextField(
            controller: _controller,
            focusNode: _composerFocus,
            minLines: 1,
            maxLines: 4,
            // #1583 — null keeps the field's own default (today's keyboard);
            // a live change re-configures the open keyboard in place.
            keyboardType: numeric ? TextInputType.number : null,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _send(),
            inputFormatters: <TextInputFormatter>[
              DevanagariBlockFormatter(
                onBlocked: () => setState(() => _devanagariBlocked = true),
              ),
            ],
            // Compact composer (owner request): body-size text + dense padding so
            // the field is shorter and leaves more transcript visible with the
            // keyboard open. Matches the chat bubble size (sizeSm).
            style: OnboardingTypography.inter(size: 14),
            decoration: InputDecoration(
              hintText:
                  _customAnswerMode ? _customAnswerHint : _kComposerHint,
              hintStyle: OnboardingTypography.inter(
                size: 14,
                color: OnboardingColors.ink500,
              ),
              isDense: true,
              filled: true,
              fillColor: OnboardingColors.paperWhite,
              // Roomier padding + the design's input radius (md=12, not the pill):
              // a fully-rounded pill made multi-line text hug the curved corners
              // and touch the border. A softer 12-radius box gives the text clear
              // breathing room on every line.
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.s4,
                vertical: AppSpacing.s3,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(OnboardingRadii.card),
                borderSide: const BorderSide(
                  color: OnboardingColors.borderDefault,
                  width: 1.2,
                ),
              ),
              // UI kit v3 (decision D8): FOCUS is navy at 1.8 — the spec's one
              // focus rule (§3.3, the OTP cell). Safety yellow now means
              // SELECTED (a picked card, a ticked checkbox, a chosen chip) and
              // nothing else, so a caret sitting in the composer can no longer
              // read as an answer the worker has already given.
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(OnboardingRadii.card),
                borderSide: const BorderSide(
                  color: OnboardingColors.shiftBlue,
                  width: 1.8,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.s2),
        _composerAction(),
      ],
    );
  }

  /// The trailing button on the IDLE row: SEND when the field has text, otherwise
  /// MIC (tap starts voice-to-text). While listening the whole row is a
  /// [DictationBar] (waveform + Stop + Send), so this slot never shows a Stop.
  Widget _composerAction() {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: _controller,
      builder: (BuildContext context, TextEditingValue value, Widget? _) {
        if (value.text.trim().isNotEmpty) {
          return IconButton(
            tooltip: 'Bhejein',
            onPressed: _send,
            style: _composerActionStyle,
            icon: const Icon(
              Icons.send_rounded,
              color: OnboardingColors.shiftBlue,
              size: 22,
            ),
          );
        }
        // KEEPS THE PLAIN MIC, AND KEEPS ITS OWN WORDS. This is the keyboard
        // slot's dictation affordance — the one glyph every worker already
        // reads as "speak instead of typing" — so it is the companion's voice
        // NOTE entry that was re-dressed, never this. Its wording must stay
        // different from [kCompanionVoiceLabel]: these two sit one above the
        // other and the label is the only thing that says which does which.
        return IconButton(
          tooltip: kComposerDictationLabel,
          onPressed: _startDictation,
          style: _composerActionStyle,
          icon: const Icon(
            Icons.mic,
            color: OnboardingColors.shiftBlue,
            size: 22,
          ),
        );
      },
    );
  }

  /// The labels THIS turn's chips display — from `suggested_options` when the
  /// turn serves them (the same source [_answerAffordance] renders from), else
  /// the label-only `suggested_followups`.
  static List<String> _turnLabels(ChatState state) =>
      state.suggestedOptions.isNotEmpty
          ? <String>[
              for (final ChatOption o in state.suggestedOptions) o.labelText,
            ]
          : state.followups;

  /// Whether [labels] are exactly the engine's yes/no gate pair (normalised:
  /// trimmed, lower-cased, trailing punctuation dropped) — one of
  /// [_kGateYesLabels] and one of [_kGateNoLabels], nothing else.
  static bool _isYesNoPair(List<String> labels) {
    if (labels.length != 2) return false;
    final List<String> norm = <String>[
      for (final String l in labels)
        l.trim().toLowerCase().replaceAll(RegExp(r'[.?]+$'), ''),
    ];
    return (_kGateYesLabels.contains(norm[0]) &&
            _kGateNoLabels.contains(norm[1])) ||
        (_kGateNoLabels.contains(norm[0]) &&
            _kGateYesLabels.contains(norm[1]));
  }

  /// Whether this turn is the one legitimate keyboard lock (#770): the yes/no
  /// gate — its chips ([_isYesNoPair]) AND its prompt, the latest bot bubble
  /// ([_kExperienceGatePrompt], trimmed and case-folded). A model's own
  /// Haan / Nahi question keeps the composer. Additionally, the skills gate
  /// (ADR-0045) locks the keyboard when [gateKind] is `"skills"`.
  static bool _isYesNoGate(ChatState state) {
    if (state.messages.isEmpty) return false;
    final ChatMessage last = state.messages.last;
    return !last.fromWorker &&
        last.text.trim().toLowerCase() ==
            _kExperienceGatePrompt.toLowerCase() &&
        _isYesNoPair(_turnLabels(state));
  }

  /// Whether [option] is the server's own escape ([_kServerEscapeOptionKey]).
  static bool _isServerEscape(ChatOption option) =>
      option.optionKey == _kServerEscapeOptionKey;

  /// Whether every option on the row, the server escape aside, is a model
  /// suggestion (`llm_<letter>` keys) — the only horizontal row that gains a
  /// trailing [kChatCustomAnswerLabel] chip when the server sent none.
  /// Deterministic pack chips (closed lists) never do.
  static bool _isLlmSuggestionRow(List<ChatOption> options) {
    final Iterable<ChatOption> suggestions =
        options.where((ChatOption o) => !_isServerEscape(o));
    return suggestions.isNotEmpty &&
        suggestions.every(
          (ChatOption o) => o.optionKey.startsWith(_kLlmOptionKeyPrefix),
        );
  }

  /// Replaces the composer on an `options_only` turn (#770): a locked-look bar
  /// that keeps the same paper-bar frame as [_inputBar] (no layout jump) and
  /// tells the worker, in aap-form, to answer from the chips above. No text
  /// field, no send, no mic — the chips are the only way to answer this turn.
  Widget _optionsOnlyHint() =>
      _lockedComposerBar(text: kChatOptionsOnlyHint, icon: Icons.touch_app_outlined);

  /// Replaces the composer on a `form_offer` (handover) turn (#1363): the same
  /// locked-look frame as [_optionsOnlyHint], but pointing at the CTA below
  /// rather than chips above — this turn has none, only the handover card's
  /// button.
  Widget _formOfferLockedHint() => _lockedComposerBar(
        text: kChatFormOfferLockedHint,
        icon: Icons.arrow_downward_rounded,
      );

  /// Replaces the composer on a skills gate turn (ADR-0045): the same
  /// locked-look frame as [_optionsOnlyHint], but pointing at the Haan/Nahi
  /// chips above rather than a hint — the skills gate locks the keyboard
  /// and only the two gate chips are the answer path.
  Widget _skillsGateLockedHint() => _lockedComposerBar(
        text: kChatOptionsOnlyHint,
        icon: Icons.touch_app_outlined,
      );

  /// Shared locked-look composer replacement: same paper-bar frame as
  /// [_inputBar] (no layout jump when it swaps in), a muted icon and one line
  /// of muted, aap-form copy. No text field, no send, no mic.
  Widget _lockedComposerBar({required String text, required IconData icon}) {
    return Container(
      decoration: const BoxDecoration(
        color: OnboardingColors.paperWhite,
        border: Border(top: BorderSide(color: OnboardingColors.borderDefault)),
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s3,
        AppSpacing.s3,
        AppSpacing.s3,
        AppSpacing.s3,
      ),
      child: _capped(
        Row(
          children: <Widget>[
            Icon(icon, color: OnboardingColors.ink500, size: 20),
            const SizedBox(width: AppSpacing.s2),
            Expanded(
              child: Text(
                text,
                style: OnboardingTypography.bodyMuted(
                  color: OnboardingColors.ink600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The composer's trailing MIC / SEND slot in the kit style: a 48px yellow
  /// rounded square carrying a shift-blue glyph. Same tap floor as before.
  static final ButtonStyle _composerActionStyle = IconButton.styleFrom(
    backgroundColor: OnboardingColors.safetyYellow,
    foregroundColor: OnboardingColors.shiftBlue,
    fixedSize: const Size(OnboardingLayout.tapTarget, OnboardingLayout.tapTarget),
    minimumSize: const Size(OnboardingLayout.tapTarget, OnboardingLayout.tapTarget),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(OnboardingRadii.card),
    ),
  );

  /// The yellow circular mic in the composer — opens the voice-note flow (kit 03).
  /// Shift-blue glyph on safety yellow (ink on yellow is always navy). TAP-ONLY now:
  /// speech-to-text moved to the tap-to-talk mic in the send slot
  /// ([_composerAction]), so this button no longer records into the composer on a
  /// hold — it only opens the server voice-note screen.
  Widget _composerMic() {
    return Semantics(
      button: true,
      label: 'Voice note bhejein',
      child: Tooltip(
        message: 'Voice note',
        child: Material(
          color: OnboardingColors.safetyYellow,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: _openVoiceNote,
            child: const SizedBox(
              width: AppSpacing.tap,
              height: AppSpacing.tap,
              child: Icon(
                Icons.mic,
                color: OnboardingColors.textOnYellow,
                size: 22,
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Shown when the chat session could not be opened (#343).
  ///
  /// The failure used to be swallowed entirely: the worker typed answer after
  /// answer into a session that was never opened, saw no error, and only found
  /// out when their profile came out empty. The next send re-opens the session
  /// lazily, so this states the real cause and what to do — no false blame on
  /// the worker's internet, and no fake "sent" impression.
  Widget _sessionBanner() {
    return Container(
      width: double.infinity,
      color: OnboardingColors.errorBg,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      child: _capped(
        Row(
          children: <Widget>[
            const Icon(
              Icons.cloud_off,
              size: 18,
              color: OnboardingColors.errorRed,
            ),
            const SizedBox(width: AppSpacing.s2),
            Flexible(
              child: Text(
                _kSessionFailedLabel,
                style: OnboardingTypography.inter(
                  size: 13,
                  weight: FontWeight.w500,
                  color: OnboardingColors.errorRed,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The single "answer affordance" slot that sits above the composer — either
  /// the typing indicator or the tap-to-answer chips — as ONE keyed child so
  /// [BbAnimatedSwitcher] can cross-fade the swap (#1059). Every branch carries a
  /// ValueKey; the two chip paths share `'chips'` so a question→question chip
  /// change stays instant while typing→chips animates.
  /// ADR-0048 — send the city the worker already gave, the moment the server
  /// asks for it.
  ///
  /// The location card collects state AND city, but the server asks them as two
  /// turns. This closes the gap: the state answer goes on "Theek hai", the
  /// server replies with the city question, and this answers it immediately from
  /// what the worker already chose. They are never asked twice for one thing.
  ///
  /// GUARDED ON `sending` so the auto-answer cannot race the turn that is still
  /// in flight, and the held value is cleared BEFORE the send so a rebuild
  /// cannot fire it a second time.
  void _maybeAnswerHeldCity(ChatState state) {
    final String? city = _heldCity;
    if (city == null) return;
    if (state.sending) return;
    if (state.askedQuestionKey != kChatCityQuestionKey) return;
    _heldCity = null;
    _sendText(city);
  }

  /// ADR-0048 — the worker pressed "Theek hai" on the location card.
  ///
  /// ONE PRESS, TWO WIRE ANSWERS, because the server still asks two questions:
  /// it HOLDS the state and writes `current_state`/`current_city` together when
  /// the city lands (`identity-intake.ts`). So the state goes now and the city
  /// is held here until the server asks for it, which it does on the very next
  /// turn. The worker sees one question and answers it once.
  ///
  /// When only the city was asked (the record already had a state) there is
  /// nothing to hold and the city goes straight out.
  void _submitIdentityLocation({String? state, String? city}) {
    final String? chosenState = state?.trim();
    final String? chosenCity = city?.trim();
    if (chosenState != null && chosenState.isNotEmpty) {
      _identityState = chosenState;
      // Held for the city turn that follows this answer.
      _heldCity = (chosenCity != null && chosenCity.isNotEmpty) ? chosenCity : null;
      _sendText(chosenState);
      return;
    }
    if (chosenCity != null && chosenCity.isNotEmpty) {
      _heldCity = null;
      _sendText(chosenCity);
    }
  }

  /// The city the worker chose on the STATE card, waiting for the server to ask
  /// for it. Null whenever there is nothing waiting — which is every turn but
  /// the one immediately after a two-field card.
  String? _heldCity;

  Widget _answerAffordance(ChatState state) {
    // #761 — while an optimistic predicted turn is on screen
    // (predictedQuestionKey != null), show its chips instead of the typing
    // indicator, so the worker can answer the predicted question during the
    // round trip.
    if (state.sending && state.predictedQuestionKey == null) {
      return KeyedSubtree(
        key: const ValueKey<String>('typing'),
        child: _typingIndicator(),
      );
    }
    // ADR-0048 (#1864) — THE TWO LOCATION QUESTIONS GET PICKERS, not a bare
    // text box. `/name` never asked a worker to spell their state, and moving
    // the question into the chat must not cost them that: the lists are closed
    // and long, and typing "Maharashtra" correctly is not a test a worker should
    // have to pass to finish signing up.
    //
    // The composer stays live underneath, exactly as `/name` kept free text —
    // the city lists are suggestions, never a gate, and the server canonicalises
    // whatever is sent.
    if (isChatLocationQuestion(state.askedQuestionKey)) {
      // THE CITY TURN IS ANSWERED BEFORE IT IS DRAWN when the worker already
      // gave the city on the state card — see [_heldCity]. Nothing renders in
      // that gap, so the pair reads as the single question it was.
      if (state.askedQuestionKey == kChatCityQuestionKey && _heldCity != null) {
        return const SizedBox.shrink();
      }
      return KeyedSubtree(
        key: const ValueKey<String>('identity-location'),
        child: ChatLocationCard(
          // On the STATE turn the card collects both, because the server holds
          // the state and writes the pair together — so answering them in one
          // breath lands exactly as `/name`'s single PATCH did.
          askState: state.askedQuestionKey == kChatStateQuestionKey,
          askCity: true,
          knownState: state.askedQuestionKey == kChatCityQuestionKey
              ? _identityState
              : null,
          onSubmit: _submitIdentityLocation,
        ),
      );
    }
    // #761 — when the turn serves `suggested_options` (the LLM chat), render
    // chips from IT so each carries its stable option_key: the tapped label is
    // submitted byte-identically while the bloc indexes `lookahead` by the key,
    // and the optimistic prediction finally fires. Served ALONGSIDE
    // `suggested_followups`, so a deterministic/older turn with no options falls
    // through to the label-keyed path below, unchanged (label == key there).
    //
    // #1559 / #1583 — a `multi_select` pack question: its chips TICK and one
    // "Ho gaya" sends them together. Never in companion mode (those chips
    // navigate) and never on a disambiguation (one trade is the answer).
    final bool multiSelect = !state.companion &&
        state.answerType == ChatAnswerType.multiSelect &&
        state.questionKind != ChatQuestionKind.disambiguate;
    if (state.suggestedOptions.isNotEmpty) {
      return KeyedSubtree(
        key: const ValueKey<String>('chips'),
        // #1754 — IN COMPANION MODE THESE CHIPS NAVIGATE. The server sets
        // `question_kind: disambiguate` on every companion turn that carries
        // chips (it wants the vertical layout), and this client renders that as
        // SingleSelectQuestionCard rows: an empty radio circle, announced
        // `checked: false, inMutuallyExclusiveGroup: true`. TalkBack therefore
        // read "unchecked radio button" for a chip that opens a screen on tap,
        // and a sighted low-literacy worker saw circles that say "pick one, then
        // confirm". ADR-0044 R3 says chips, not cards.
        child: state.companion
            ? _companionActionChips(state.suggestedOptions)
            : state.questionKind == ChatQuestionKind.disambiguate
                ? _disambiguateOptions(state.suggestedOptions)
                : multiSelect
                    ? _multiSelectOptions(state.suggestedOptions)
                    : _followupOptions(state.suggestedOptions),
      );
    }
    if (state.followups.isNotEmpty) {
      // A disambiguation turn is mutually-exclusive occupations where the tapped
      // label BECOMES the answer of record and selects the pack — a vertical
      // single-select, not the horizontal scroller a worker can skim past (#649).
      return KeyedSubtree(
        key: const ValueKey<String>('chips'),
        // COMPANION FIRST, exactly as the `suggested_options` branch above.
        // #1754 fixed companion chips rendering as unchecked radio buttons, but
        // only on the options branch — and ADR-0046's career answer (P3) arrives
        // with `suggested_followups` and NO options, on a turn the server marks
        // `question_kind: disambiguate`. It therefore fell straight back into
        // `_disambiguate`, reinstating the exact bug #1754 closed: TalkBack
        // announcing "unchecked radio button" for a chip that just sends text,
        // and circles that tell a low-literacy worker to "pick one, then
        // confirm". In companion mode these are chips, whichever field carried
        // them.
        child: state.companion
            ? _companionActionChips(<ChatOption>[
                for (final String f in state.followups)
                  ChatOption(optionKey: f, labelText: f),
              ])
            : state.questionKind == ChatQuestionKind.disambiguate
            ? _disambiguate(state.followups)
            : multiSelect
                // Label-only chips (an older build, or the optimistic
                // prediction's labels): the label is the key, as on
                // [_followups].
                ? _multiSelectOptions(<ChatOption>[
                    for (final String f in state.followups)
                      ChatOption(optionKey: f, labelText: f),
                  ])
                : _followups(state.followups),
      );
    }
    // #1583 — a `boolean` pack question arrives with NO chips (every boolean
    // pack item carries zero options), so offer Haan / Nahi. Only when the
    // server served none: served chips above always win.
    if (!state.companion && state.answerType == ChatAnswerType.boolean) {
      return KeyedSubtree(
        key: const ValueKey<String>('chips'),
        child: _booleanReplies(),
      );
    }
    return const SizedBox.shrink(key: ValueKey<String>('none'));
  }

  /// "Bada Bhai type kar raha hai…" — shown while a reply is in flight so a
  /// real (1–3s) LLM turn does not look frozen.
  ///
  /// Deliberately STATIC (a dots glyph, not a spinning `CircularProgressIndicator`):
  /// an indefinite animation never lets `WidgetTester.pumpAndSettle` settle, and
  /// the value here is the honest "still working" cue, not motion.
  Widget _typingIndicator() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.more_horiz,
            size: 20,
            color: OnboardingColors.shiftBlue,
          ),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              'Bada Bhai type kar raha hai…',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 13,
                color: OnboardingColors.ink500,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Tap-to-answer chips from the backend's `suggested_followups`. Tapping one
  /// sends it exactly like a typed answer — so a worker who cannot type quickly
  /// can still answer. Horizontally scrollable so long suggestions never clip.
  ///
  /// THE LABEL BECOMES THE WORKER'S ANSWER OF RECORD, verbatim. That is why the
  /// backend now serves ANSWERS to the question on screen and never questions:
  /// the shipped constant offered 'Controller kaunsa — Fanuc ya Siemens?' on
  /// every turn, and one tap recorded two controllers the worker never named.
  /// Nothing here rewrites or filters a chip — if a question ever appears in this
  /// row again, the fix belongs in `question_bank.py`, not in this widget.
  Widget _followups(List<String> followups) => _chipScroller(<Widget>[
        for (final String f in followups) ...<Widget>[
          // Answer chips read like a chat message: same 14px size and a
          // normal weight (owner request 2026-07-23), on the kit's chip surface.
          _AnswerChip(label: f, onTap: () => _sendOption(f)),
          const SizedBox(width: AppSpacing.s2),
        ],
      ]);

  /// The horizontal chip row rendered from `suggested_options` (#761). Same look
  /// as [_followups] — each chip DISPLAYS [ChatOption.labelText] — but a tap
  /// routes through [_sendChoice], which submits that label byte-identically
  /// while indexing `lookahead` by the stable [ChatOption.optionKey].
  ///
  /// ONE trailing [kChatCustomAnswerLabel] chip opens [_enterCustomAnswer]:
  ///  * when the server sent its own escape ([_kServerEscapeOptionKey]) on the
  ///    row, that option becomes this chip. It is never submitted: sending it
  ///    would record "Kuch aur" as the worker's answer;
  ///  * otherwise on an LLM suggestion row (every key `llm_<letter>`): the
  ///    model offers at most four guesses and the worker's own answer may be
  ///    none of them. Never on the yes/no gate — there the two chips ARE the
  ///    full answer.
  Widget _followupOptions(List<ChatOption> options) {
    final List<ChatOption> answers =
        options.where((ChatOption o) => !_isServerEscape(o)).toList();
    final bool escape = answers.length != options.length ||
        (_isLlmSuggestionRow(options) &&
            !_isYesNoPair(<String>[
              for (final ChatOption o in answers) o.labelText,
            ]));
    return _chipScroller(<Widget>[
      for (final ChatOption o in answers) ...<Widget>[
        _AnswerChip(label: o.labelText, onTap: () => _sendChoice(o)),
        const SizedBox(width: AppSpacing.s2),
      ],
      if (escape) _customAnswerChip(),
    ]);
  }

  /// The chip-row escape: opens [_enterCustomAnswer] with the question-neutral
  /// hint, since a chip row can be about a skill or a duration, not a profile.
  Widget _customAnswerChip() {
    void open() => _enterCustomAnswer(hint: kChatCustomAnswerGenericHint);
    return Semantics(
      container: true,
      button: true,
      label: kChatCustomAnswerGenericSemantics,
      excludeSemantics: true,
      onTap: open,
      child: _AnswerChip(label: kChatCustomAnswerLabel, onTap: open),
    );
  }

  /// #1559 / #1583 — a `multi_select` turn's chips. A tap TICKS (the kit's
  /// selected paint) instead of sending ([_toggleTick]), and
  /// [kChatMultiSelectDoneLabel] — enabled once anything is ticked — sends
  /// every ticked choice as one answer ([_sendTicked]).
  ///
  /// A WRAP, not the horizontal scroller: a worker choosing several has to be
  /// able to see them all (sixteen languages), and the stack under the
  /// transcript already scrolls within its cap on a short phone.
  ///
  /// The server's own escape ([_kServerEscapeOptionKey]) is never a tick: it
  /// opens the composer, exactly as on [_followupOptions].
  Widget _multiSelectOptions(List<ChatOption> options) {
    final List<ChatOption> answers =
        options.where((ChatOption o) => !_isServerEscape(o)).toList();
    final bool escape = answers.length != options.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: _capped(
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final ChatOption o in answers)
                  _AnswerChip(
                    label: o.labelText,
                    selected: _ticked.contains(o.optionKey),
                    onTap: () => _toggleTick(o, answers),
                  ),
                if (escape) _customAnswerChip(),
              ],
            ),
            const SizedBox(height: AppSpacing.s2),
            // Navy, not the yellow primary: yellow is the SELECTED chip paint
            // right above it, and the "build my profile" CTA below is the
            // screen's one primary (the voice form's multi-select submit
            // makes the same call).
            BbButton(
              label: kChatMultiSelectDoneLabel,
              variant: BbButtonVariant.navy,
              size: BbButtonSize.md,
              block: true,
              onPressed: _ticked.isEmpty ? null : () => _sendTicked(answers),
            ),
          ],
        ),
      ),
    );
  }

  /// #1583 — Haan / Nahi for a `boolean` question the server served with no
  /// chips. Same row and look as served chips; the composer stays, since the
  /// server reads a typed "haan ji" the same way.
  Widget _booleanReplies() => _chipScroller(<Widget>[
        _AnswerChip(
          label: kVoiceBooleanYes,
          onTap: () => _sendBooleanReply(kVoiceBooleanYes),
        ),
        const SizedBox(width: AppSpacing.s2),
        _AnswerChip(
          label: kVoiceBooleanNo,
          onTap: () => _sendBooleanReply(kVoiceBooleanNo),
        ),
      ]);

  /// The horizontal, scrollable wrapper shared by the label-keyed fallback
  /// ([_followups]) and the `suggested_options` path ([_followupOptions]) — just
  /// the frame; the caller builds the chips so each carries its own tap handler.
  Widget _chipScroller(List<Widget> chips) {
    return Container(
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: chips),
      ),
    );
  }

  /// OIE Phase 8 (#649): the pinned occupation pill, under the header. The pack
  /// progress bar (the finish line, the single strongest completion lever for
  /// low-literacy users) is drawn on the header's bottom edge instead — see
  /// [_HeaderProgressLine] — from the same `ChatState.progress` value.
  Widget _occupationStrip(String occupation) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s2,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: _capped(
        Align(
          alignment: Alignment.centerLeft,
          child: _occupationPill(occupation),
        ),
      ),
    );
  }

  /// The trust moment: the worker's trade in their OWN vernacular, once pinned.
  /// [label] is worker/engine data (e.g. "darzi"), never a persona string.
  Widget _occupationPill(String label) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s3,
        vertical: AppSpacing.s1,
      ),
      decoration: BoxDecoration(
        color: OnboardingColors.selectedCardBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
        border: Border.all(color: OnboardingColors.safetyYellow, width: 1.2),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Icon(
            Icons.check_circle,
            size: 16,
            color: OnboardingColors.shiftBlue,
          ),
          const SizedBox(width: AppSpacing.s1),
          Flexible(
            child: Text(
              label,
              style: OnboardingTypography.inter(
                size: 14,
                weight: FontWeight.w600,
              ),
              overflow: TextOverflow.ellipsis,
              maxLines: 1,
            ),
          ),
        ],
      ),
    );
  }

  /// A disambiguation turn (#649): mutually-exclusive occupations as a VERTICAL
  /// single-select. Unlike [_followups]' horizontal scroller, nothing can be
  /// skimmed past — the tapped label becomes the answer of record and selects
  /// the pack. The "none of these" escape is rendered visually distinct.
  Widget _disambiguate(List<String> options) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final String o in options) _disambiguateOption(o),
        ],
      ),
    );
  }

  /// A disambiguation turn rendered from `suggested_options` (#761): same vertical
  /// single-select as [_disambiguate], but each row submits [ChatOption.labelText]
  /// while [_sendChoice] indexes `lookahead` by [ChatOption.optionKey] (and the
  /// escape is the option's own `is_none_of_above`, not the hardcoded label).
  ///
  /// The escape does NOT submit: sending it as `'__declined'` made the server
  /// stop identifying the trade with nobody asking the worker to name it. It
  /// opens [_enterCustomAnswer] so they type their own profile.
  /// #1754 — the companion's chips: VERTICAL ROWS THAT ARE BUTTONS.
  ///
  /// The server sets `question_kind: disambiguate` on every companion turn that
  /// carries chips — it wants the vertical layout — and this client rendered that
  /// as `SingleSelectQuestionCard`: an empty radio circle, announced
  /// `checked: false, inMutuallyExclusiveGroup: true`. So TalkBack read "unchecked
  /// radio button" for a chip that opens a screen on one tap, and a sighted
  /// low-literacy worker saw circles that say "pick one, then confirm"
  /// (ADR-0044 R3: chips, not cards).
  ///
  /// Vertical, not the horizontal chip scroller: a recap carries up to three job
  /// chips plus two more, and in the scroller the later ones sit off-screen where
  /// a worker — and a test — cannot reach them. Routing is untouched: the tap
  /// still goes to [_sendChoice], which decides on the KEY.
  /// TEMPORARY (owner request, 2026-10-05): hide the post-completion MENU chips
  /// at the bottom of the BadaBhai chat — "Resume badlo" / "Naya resume" /
  /// "Career ki baat" / "Naye jobs dekhein" — WITHOUT deleting any of them. Each
  /// is wrapped in [Visibility] so the worker can still type a reply; flip
  /// [_kShowCompanionMenuChips] back to `true` to restore the menu.
  ///
  /// Deliberately NOT hidden: the individual job chips (`companion_job:`), the
  /// Jobs-tab chip and the Applied chip — the ask named only the menu.
  static const bool _kShowCompanionMenuChips = false;

  bool _hidesCompanionMenuChip(String optionKey) =>
      !_kShowCompanionMenuChips &&
      (isCompanionV2OnlyKey(optionKey) || optionKey == kCompanionNewJobsKey);

  Widget _companionActionChips(List<ChatOption> options) {
    // THE LEVER GATES THE DOOR TOO (ADR-0046 F4). v2-only chips are dropped on a
    // build whose lever is off — see [isCompanionV2OnlyKey] for why offering one
    // without its destination is worse than not offering it. v1's chips (jobs,
    // applied, a job, the résumé menu) are untouched by this and always render.
    final List<ChatOption> shown = BbRemoteConfig.instance.chatCompanionV2Enabled
        ? options
        : options
            .where((ChatOption o) => !isCompanionV2OnlyKey(o.optionKey))
            .toList(growable: false);
    // Every chip on the turn was v2-only: draw NOTHING rather than an empty
    // padded column, so a lever-off build is byte-identical to v1.
    if (shown.isEmpty) return const SizedBox.shrink();
    // Every remaining chip is a hidden MENU chip (owner request): draw nothing,
    // so hiding the menu leaves no empty padded column behind.
    if (shown.every((ChatOption o) => _hidesCompanionMenuChip(o.optionKey))) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final ChatOption o in shown)
            // TEMPORARY (owner request): the menu chips are hidden via
            // Visibility, not deleted — flip `_kShowCompanionMenuChips` to
            // restore them. Job / Jobs-tab / Applied chips stay visible.
            Visibility(
              visible: !_hidesCompanionMenuChip(o.optionKey),
              child: Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.s2),
              child: Semantics(
                container: true,
                button: true,
                label: o.labelText,
                child: Material(
                  color: OnboardingColors.paperWhite,
                  borderRadius: BorderRadius.circular(OnboardingRadii.card),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(OnboardingRadii.card),
                    onTap: () => _sendChoice(o),
                    child: Container(
                      // The 48dp tap floor every other row on this screen keeps.
                      constraints: const BoxConstraints(minHeight: 48),
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.s3,
                        vertical: AppSpacing.s2,
                      ),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(OnboardingRadii.card),
                        border: Border.all(color: OnboardingColors.borderCard),
                      ),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: ExcludeSemantics(
                              child: Text(
                                o.labelText,
                                style: OnboardingTypography.inter(
                                  size: 14,
                                  weight: FontWeight.w600,
                                  height: 1.35,
                                  color: OnboardingColors.ink900,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            ),
        ],
      ),
    );
  }

  /// ADR-0046 §5.2 — say why the edit card could not be applied.
  ///
  /// The bloc sets [ChatState.editNotice] on exactly three paths: a dead card
  /// (404 expired or already applied), a failed Haan and a failed Nahi. All
  /// three used to be SILENT — the card either vanished or the button did
  /// nothing — which on a worker's own profile is the most alarming thing this
  /// screen can do.
  ///
  /// A STALE card (409 `{reason:"stale"}`) is deliberately NOT one of them: the
  /// server carries the reviewed `V2_EDIT_STALE` line on that answer, so the
  /// bloc renders it as an ordinary Bada Bhai bubble instead of a snackbar.
  ///
  /// A snackbar, the same surface the companion already uses for "Applied", and
  /// fired from the listener's change edge so it shows once per notice.
  void _showEditNotice(ChatState state) {
    final String? notice = state.editNotice;
    if (notice == null || notice.isEmpty) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(notice)));
  }

  // ---- ADR-0048 — fly the captured name up to the header -------------------

  /// Fly the name captured on this turn from its bubble to the header action.
  ///
  /// THE COMPLETE NAME MOVES. A worker who gives a first name and then a surname
  /// sees the WHOLE name ("Rishi Ojha") lift off on the surname turn, not just
  /// the freshly-typed word — the token is always [ChatState.workerName] in
  /// full, so what flies is exactly what the action will read.
  ///
  /// Fired on the `workerName` change edge. The rects are read AFTER the frame,
  /// because the bubble carrying the name is appended in the same emit and is
  /// not laid out yet when the listener runs. Reduced motion, or a bubble the
  /// ListView has not built, degrades to setting the name with no flight — the
  /// header is always correct, the motion is the flourish.
  void _maybeFlyName(ChatState state) {
    final String? name = state.workerName;
    if (name == null || name == _headerName || _flyingName) return;
    final bool reduceMotion =
        MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _flyingName || name == _headerName) return;
      final Rect? from =
          _globalRectOf(_lastWorkerBubbleKey) ?? _fallbackNameSource();
      final Rect? to = _globalRectOf(_headerNameActionKey);
      if (reduceMotion || from == null || to == null) {
        setState(() => _headerName = name);
        return;
      }
      _startNameFlight(name, from, to);
    });
  }

  void _startNameFlight(String name, Rect from, Rect to) {
    _flyingName = true;
    _nameFlightEntry = showFlyingName(
      overlay: Overlay.of(context, rootOverlay: true),
      text: name,
      from: from,
      to: to,
      onLanded: () {
        if (!mounted) return;
        setState(() {
          _flyingName = false;
          _nameFlightEntry = null;
          _headerName = name;
        });
        // Punctuate the landing with the action's settle pop.
        _namePop.forward(from: 0);
      },
    );
  }

  /// The SCREEN rect of [key]'s render box, or null when it is not laid out.
  Rect? _globalRectOf(GlobalKey key) {
    final BuildContext? ctx = key.currentContext;
    if (ctx == null) return null;
    final RenderObject? object = ctx.findRenderObject();
    if (object is! RenderBox || !object.hasSize) return null;
    return object.localToGlobal(Offset.zero) & object.size;
  }

  /// Where the name lifts off from when its bubble is not on screen (a fast
  /// reply pushed it out of view): just above the composer, where it was typed.
  Rect? _fallbackNameSource() {
    final Rect? segment = _globalRectOf(_bottomSegmentKey);
    if (segment == null) return null;
    return Rect.fromCenter(
      center: Offset(segment.center.dx, segment.top + 12),
      width: 140,
      height: 40,
    );
  }

  /// Read the worker's own name for the header (owner request, 2026-10-05) —
  /// the same `GET /workers/me/resume-fields` the Profile tab reads. Fail-silent:
  /// a missing name or a read error just leaves the header without a label, and
  /// a name the chat itself captured meanwhile is never overwritten.
  Future<void> _loadHeaderName() async {
    if (!locator.isRegistered<ResumeEditRepository>()) return;
    try {
      final ResumeSafeFields fields =
          await locator<ResumeEditRepository>().load();
      if (!mounted || _headerName != null) return;
      final String name = fields.displayName.trim();
      if (name.isEmpty) return;
      setState(() => _headerName = name);
    } catch (_) {
      // Enhancement only — never the screen.
    }
  }

  /// ADR-0046 §5.1 — the edit card: one row per proposed change, all ticked,
  /// with Haan / Nahi under them. Haan sends the TICKED rows' server-minted
  /// `row_id`s to the confirm route; Nahi cancels. The card disables itself
  /// once `expires_at` passes (the server would refuse it anyway).
  Widget _editProposalCard(EditProposal proposal) {
    return _EditProposalCard(
      // Keyed on the proposal: a replaced card starts with every row ticked
      // again and a fresh expiry clock.
      key: ValueKey<String>(proposal.proposalId),
      proposal: proposal,
      onConfirm: (List<String> rowIds) =>
          context.read<ChatBloc>().add(ChatEditProposalConfirmed(rowIds)),
      onCancel: () =>
          context.read<ChatBloc>().add(const ChatEditProposalCancelled()),
    );
  }

  /// #1821 F1 — is the companion still cooling down, right now?
  ///
  /// Gated by the v2 lever like every other v2 surface, so a lever-off build
  /// never locks its composer on a field it would not otherwise render.
  bool _cooldownActive(ChatState state) =>
      state.companion &&
      BbRemoteConfig.instance.chatCompanionV2Enabled &&
      state.cooldownUntil != null &&
      state.cooldownUntil!.isAfter(DateTime.now());

  /// #1821 F1 — the composer, replaced by a live countdown until [until].
  ///
  /// It REPLACES the composer rather than sitting above it, using the same
  /// locked-bar frame as the skills gate and the form handover, because a
  /// visible-but-ignored text box is the thing that makes a worker type into
  /// nothing. [_CooldownComposerLock] owns the clock and tells this screen when
  /// the wait is over, so the composer comes back on its own.
  Widget _cooldownComposerLock(DateTime until) => _CooldownComposerLock(
        until: until,
        onExpired: () {
          if (mounted) setState(() {});
        },
        builder: (String text) => _lockedComposerBar(
          text: text,
          icon: Icons.hourglass_empty,
        ),
      );

  Widget _disambiguateOptions(List<ChatOption> options) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final ChatOption o in options)
            _disambiguateRow(
              label: o.labelText,
              escape: o.isNoneOfAbove || _isServerEscape(o),
              onTap: o.isNoneOfAbove || _isServerEscape(o)
                  ? _enterCustomAnswer
                  : () => _sendChoice(o),
            ),
        ],
      ),
    );
  }

  /// Fallback label path: the escape is recognised by the hardcoded
  /// [_kDisambiguateEscape] phrase and the tapped label is both submit and key.
  /// The escape opens [_enterCustomAnswer], exactly as on the options path.
  Widget _disambiguateOption(String label) {
    final bool escape =
        label.trim().toLowerCase() == _kDisambiguateEscape.toLowerCase();
    return _disambiguateRow(
      label: label,
      escape: escape,
      onTap: escape ? _enterCustomAnswer : () => _sendOption(label),
    );
  }

  /// One vertical single-select row, shared by the fallback ([_disambiguateOption])
  /// and the `suggested_options` path ([_disambiguateOptions]). [escape] renders
  /// the "none of these" style (borderless, muted) with the
  /// [kChatCustomAnswerLabel] copy in place of the server's bare label; [onTap]
  /// submits a real row or opens custom-answer mode for the escape.
  Widget _disambiguateRow({
    required String label,
    required bool escape,
    required VoidCallback onTap,
  }) {
    // Master UI Kit: a single-select option is a SingleSelectQuestionCard. It
    // is never pre-selected — the tap IS the answer and the row leaves on the
    // next rebuild (the one-tap latch lives in [_sendOption]/[_sendChoice]).
    if (!escape) {
      return _capped(
        SingleSelectQuestionCard(
          title: label,
          isSelected: false,
          onTap: onTap,
        ),
      );
    }
    // The "none of these" escape stays visibly quieter than a real option
    // (#649): a hairline, muted text, no radio. It reads "Kuch aur — khud
    // likhein" whatever the server labelled it, because tapping it now opens
    // typing rather than declining the list.
    const BorderRadius radius = BorderRadius.all(Radius.circular(14));
    return _capped(
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Semantics(
          container: true,
          button: true,
          label: kChatCustomAnswerSemantics,
          excludeSemantics: true,
          onTap: onTap,
          child: Material(
            color: Colors.transparent,
            borderRadius: radius,
            child: InkWell(
              borderRadius: radius,
              onTap: onTap,
              child: Container(
                constraints: const BoxConstraints(
                  minHeight: OnboardingLayout.tapTarget,
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s4,
                  vertical: AppSpacing.s3,
                ),
                decoration: BoxDecoration(
                  borderRadius: radius,
                  border: Border.all(
                    color: OnboardingColors.borderSubtle,
                    width: 1.2,
                  ),
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        kChatCustomAnswerLabel,
                        style: OnboardingTypography.inter(
                          size: 14,
                          color: OnboardingColors.ink500,
                        ),
                      ),
                    ),
                    const Icon(
                      Icons.edit_outlined,
                      color: OnboardingColors.ink500,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// "Naye message" jump pill — shown bottom-centre above the composer when a
  /// bot reply lands while the worker has scrolled up. Tapping rides them down.
  Widget _jumpPill() {
    // Chrome, so its text scale is clamped like the kit's other chrome; the
    // label may still ellipsize rather than overflow on a very narrow phone.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: _jumpPillBody(),
    );
  }

  Widget _jumpPillBody() {
    return Material(
      color: OnboardingColors.paperWhite,
      elevation: 0,
      // Flat pill (kit): a hairline border, not a shadow, lifts it off the chat.
      shape: const StadiumBorder(
        side: BorderSide(color: OnboardingColors.borderDefault),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadii.pill),
        onTap: _jumpToBottom,
        child: Container(
          constraints: const BoxConstraints(minHeight: AppSpacing.tap),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.s4,
            vertical: AppSpacing.s2,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Flexible(
                child: Text(
                  _kNewMessageLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                    color: OnboardingColors.shiftBlue,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.s1),
              const Icon(
                Icons.keyboard_arrow_down_rounded,
                color: OnboardingColors.shiftBlue,
                size: 20,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One transcript bubble in the Master UI Kit chat style: bada bhai on white
/// with a `borderDefault` hairline, the worker on Shift Blue with white text.
///
/// A LOCAL restyle of [BbChatBubble] (shared chrome other surfaces still use),
/// keeping every behaviour it carries: the ~78% width cap, one squared "tail"
/// corner toward the speaker, the #343 failed-send tint + footer, the whole
/// failed bubble as the retry control with its combined semantics label, and
/// the optional [trailing] control (the read-aloud speaker).
class _ChatBubble extends StatelessWidget {
  const _ChatBubble({
    super.key,
    required this.text,
    required this.fromWorker,
    required this.maxWidth,
    this.failed = false,
    this.onRetry,
    this.trailing,
  });

  final String text;
  final bool fromWorker;

  /// The bubble never spans the full column, so the speaker side stays legible.
  final double maxWidth;

  /// The message did not reach the server (#343).
  final bool failed;

  /// Tapped on a [failed] bubble to re-send it.
  final VoidCallback? onRetry;

  /// Rendered just to the RIGHT of the bubble (the read-aloud speaker).
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    const Radius soft = Radius.circular(AppRadii.md);
    const Radius tail = Radius.circular(AppRadii.bubbleTail);

    final bool workerFilled = fromWorker && !failed;
    final Color background = failed
        ? OnboardingColors.errorBg
        : (fromWorker
            ? OnboardingColors.shiftBlue
            : OnboardingColors.paperWhite);
    final Color borderColor = failed
        ? OnboardingColors.errorRed
        : (fromWorker
            ? OnboardingColors.shiftBlue
            : OnboardingColors.borderDefault);
    // White on the filled navy bubble; dark ink everywhere else (a failed
    // worker bubble sits on the light error tint, so it keeps dark text).
    final Color textColor =
        workerFilled ? OnboardingColors.textOnBlue : OnboardingColors.ink900;

    final Widget bubble = Container(
      constraints: BoxConstraints(maxWidth: maxWidth),
      margin: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s3,
        vertical: AppSpacing.s2,
      ),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.only(
          topLeft: soft,
          topRight: soft,
          bottomLeft: fromWorker ? soft : tail,
          bottomRight: fromWorker ? tail : soft,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(text, style: OnboardingTypography.body(color: textColor)),
          if (failed) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(
                  Icons.error_outline,
                  size: 16,
                  color: OnboardingColors.errorRed,
                ),
                const SizedBox(width: AppSpacing.s1),
                Flexible(
                  child: Text(
                    kChatSendFailedLabel,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 13,
                      weight: FontWeight.w700,
                      color: OnboardingColors.errorRed,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );

    // A failed bubble is the retry control itself — the whole bubble is the
    // tap target, so it comfortably clears the 48px minimum.
    final Widget content = failed && onRetry != null
        ? Semantics(
            button: true,
            label: '$text — $kChatSendFailedLabel',
            child: InkWell(
              onTap: onRetry,
              borderRadius: BorderRadius.circular(AppRadii.lg),
              child: bubble,
            ),
          )
        : bubble;

    return Align(
      alignment: fromWorker ? Alignment.centerRight : Alignment.centerLeft,
      child: trailing == null
          ? content
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Flexible(child: content),
                trailing!,
              ],
            ),
    );
  }
}

/// A tap-to-answer chip in the Master UI Kit style: `chipBg` fill with a
/// `borderDefault` hairline; the press state washes it safety yellow. There is
/// no persistent "selected" state — the tap sends the answer and the row is
/// replaced on the next turn. Keeps `BbChip`'s 48px tap floor and its
/// single-line label inside the horizontally-scrolling row.
///
/// The one exception is a `multi_select` turn (#1559 / #1583), where the chip
/// is a TOGGLE — see [selected].
class _AnswerChip extends StatelessWidget {
  const _AnswerChip({required this.label, required this.onTap, this.selected});

  final String label;
  final VoidCallback onTap;

  /// Null on every chip but a multi-select's: today's chip, unchanged.
  /// Non-null makes the chip a toggle announced as selected / not selected;
  /// `true` wears the kit's SELECTED paint (the [OnboardingColors.selectedCardBg]
  /// wash behind a 1.8 safety-yellow border, navy label) plus a check, so the
  /// tick never rests on colour alone.
  final bool? selected;

  static const BorderRadius _radius = BorderRadius.all(Radius.circular(12));

  @override
  Widget build(BuildContext context) {
    final bool ticked = selected ?? false;
    final Widget chip = Material(
      color: Colors.transparent,
      child: Ink(
        decoration: BoxDecoration(
          color: ticked ? OnboardingColors.selectedCardBg : OnboardingColors.chipBg,
          borderRadius: _radius,
          border: ticked
              ? Border.all(color: OnboardingColors.safetyYellow, width: 1.8)
              : Border.all(color: OnboardingColors.borderDefault, width: 1.2),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: _radius,
          splashColor: OnboardingColors.safetyYellow.withValues(alpha: 0.30),
          highlightColor: OnboardingColors.safetyYellow.withValues(alpha: 0.18),
          child: Container(
            alignment: Alignment.center,
            constraints: const BoxConstraints(
              minHeight: OnboardingLayout.tapTarget,
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: 14,
              vertical: AppSpacing.s2,
            ),
            child: ticked
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const Icon(
                        Icons.check_rounded,
                        size: 16,
                        color: OnboardingColors.shiftBlue,
                      ),
                      const SizedBox(width: AppSpacing.s1),
                      Text(
                        label,
                        style: OnboardingTypography.inter(
                          size: 14,
                          color: OnboardingColors.shiftBlue,
                        ),
                      ),
                    ],
                  )
                : Text(
                    label,
                    style: OnboardingTypography.inter(size: 14),
                  ),
          ),
        ),
      ),
    );
    if (selected == null) return chip;
    return Semantics(button: true, selected: ticked, child: chip);
  }
}

/// The pack progress line on the Shift Blue header's bottom edge (#649): a
/// successGreen fill over a faint white track, animating to [value] the way
/// `BbProgressBar` did. Finite animation, so `pumpAndSettle` still settles.
class _HeaderProgressLine extends StatelessWidget {
  const _HeaderProgressLine({required this.value});

  /// Completion fraction, `0..1` (`ChatProgress.fraction`). Clamped.
  final double value;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: _kHeaderProgressHeight,
      width: double.infinity,
      child: ColoredBox(
        color: Colors.white.withValues(alpha: 0.12),
        child: TweenAnimationBuilder<double>(
          tween: Tween<double>(begin: 0, end: value.clamp(0, 1).toDouble()),
          duration: AppMotion.slow,
          curve: AppMotion.easeOut,
          builder: (BuildContext context, double t, _) {
            return FractionallySizedBox(
              widthFactor: t,
              alignment: Alignment.centerLeft,
              child: const ColoredBox(color: OnboardingColors.successGreen),
            );
          },
        ),
      ),
    );
  }
}

/// The kit's yellow primary CTA for a SERVER-SUPPLIED label that may need two
/// lines (#1364): same fill, 52px minimum height, 14 radius, shift-blue Anek
/// label, trailing arrow and light haptic as [PrimaryActionButton] — but the
/// label WRAPS instead of being scaled down, so long copy is never shrunk or
/// truncated client-side.
class _WrappingPrimaryButton extends StatelessWidget {
  const _WrappingPrimaryButton({required this.label, required this.onPressed});

  final String label;

  /// Null renders the kit's disabled state.
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onPressed != null;
    final Color ink =
        enabled ? OnboardingColors.shiftBlue : OnboardingColors.disabledText;
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: ElevatedButton(
        style: ButtonStyle(
          elevation: const WidgetStatePropertyAll<double>(0),
          minimumSize: const WidgetStatePropertyAll<Size>(
            Size(double.infinity, OnboardingLayout.buttonHeight),
          ),
          padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
            EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          ),
          shape: const WidgetStatePropertyAll<OutlinedBorder>(
            RoundedRectangleBorder(
              borderRadius:
                  BorderRadius.all(Radius.circular(OnboardingRadii.button)),
            ),
          ),
          backgroundColor:
              WidgetStateProperty.resolveWith((Set<WidgetState> s) {
            if (s.contains(WidgetState.disabled)) {
              return OnboardingColors.disabledBg;
            }
            if (s.contains(WidgetState.pressed)) {
              return OnboardingColors.safetyYellowDark;
            }
            return OnboardingColors.safetyYellow;
          }),
          foregroundColor: WidgetStatePropertyAll<Color>(ink),
          overlayColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
        ),
        onPressed: enabled
            ? () {
                HapticFeedback.lightImpact();
                onPressed!();
              }
            : null,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Flexible(
              child: Text(
                label,
                textAlign: TextAlign.center,
                softWrap: true,
                style: OnboardingTypography.buttonLabel(color: ink),
              ),
            ),
            const SizedBox(width: 8),
            Icon(Icons.arrow_forward_rounded, size: 20, color: ink),
          ],
        ),
      ),
    );
  }
}

/// ADR-0046 §5.1 — the pending edit card.
///
/// STATEFUL so the tick set and the expiry clock belong to ONE proposal: the
/// parent keys it on `proposal_id`, so a replaced card starts fresh (every row
/// ticked, the clock re-armed).
///
/// THE VALUES NEVER LEAVE. The card shows `before` / `after`; the confirm call
/// carries only the ticked `row_id`s — the server re-reads its own stored
/// proposal and re-checks everything on confirm (contracts §5.2).
/// The most row ids `POST /chat/companion/edits/:id/confirm` accepts
/// (`ConfirmEditSchema.row_ids` is `.min(1).max(3)`, ADR-0046 §5.2).
///
/// Mirrored here because the app must not build a body the route will reject.
/// Note the asymmetry it guards: `EditProposalSchema.rows` is `.min(1)` with NO
/// maximum, so a proposal MAY legitimately arrive with more rows than a single
/// confirm can carry — and since every row starts ticked, that card would open
/// with an un-confirmable Haan unless the worker is told to narrow it.
/// #1821 F1 — the cool-down countdown that replaces the composer.
///
/// ITS OWN TICKER, for the same reason the edit card has one: nothing else on a
/// waiting chat screen rebuilds, so a countdown computed once at build time
/// would freeze at whatever it first read and the composer would never return.
/// This rebuilds every second and calls [onExpired] on the tick that crosses
/// [until], which is what lets the SCREEN re-evaluate and give the composer back.
///
/// The text counts minutes while there are minutes left and seconds below that —
/// "2 minute baad" is useful, "0 minute baad" is not.
class _CooldownComposerLock extends StatefulWidget {
  const _CooldownComposerLock({
    required this.until,
    required this.onExpired,
    required this.builder,
  });

  final DateTime until;
  final VoidCallback onExpired;

  /// Draws the bar. Passed in so this widget owns the CLOCK and the screen keeps
  /// ownership of the locked-bar frame it shares with the skills gate.
  final Widget Function(String text) builder;

  @override
  State<_CooldownComposerLock> createState() => _CooldownComposerLockState();
}

class _CooldownComposerLockState extends State<_CooldownComposerLock> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (!widget.until.isAfter(DateTime.now())) {
        _ticker?.cancel();
        widget.onExpired();
        return;
      }
      setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      widget.builder(kCooldownComposerText(widget.until));
}

/// What the locked composer says while the companion is cooling down.
///
/// Hinglish, aap-form. Names the real reason — Bada Bhai is busy — and the wait,
/// because "try again later" with no number is what makes a worker tap a dead
/// box repeatedly.
String kCooldownComposerText(DateTime until) {
  final Duration left = until.difference(DateTime.now());
  // #1862 — DO NOT BLAME BADA BHAI'S BUSYNESS. The wait is the faltu
  // cool-down, not the assistant being occupied; saying "vyast hain" invents a
  // cause and tells the worker nothing they can act on. Say what they can do
  // and when.
  if (left.inSeconds <= 0) return 'Ab aap likh sakte hain.';
  if (left.inMinutes >= 1) {
    return '${left.inMinutes} minute baad aap dobara likh sakte hain.';
  }
  return '${left.inSeconds} second baad aap dobara likh sakte hain.';
}

/// The companion composer's mic (ADR-0046 F3) — keyed because this screen draws
/// three mics and only this one is gated by the v2 lever.
const Key kCompanionVoiceButtonKey = ValueKey<String>('companion-voice-button');

/// What the two VISIBLE voice controls say, and why they must never say the
/// same thing.
///
/// The companion draws both at once, one above the other, and until #1884 both
/// wore `Icons.mic` and the words "Bolkar likhein" — so the screen offered a
/// worker two identical mics and no way to tell them apart. They do different
/// work:
///
///  * [kComposerDictationLabel] — the composer's trailing mic. On-device
///    dictation: speak and the words appear in the field as you go.
///  * [kCompanionVoiceLabel] — the pill above it. Records a note, uploads it to
///    be transcribed, and lands the text back in the composer to check.
///
/// "record karein" and not "bhejein" on the pill: it does NOT send. The worker
/// still reads the transcript and presses send, and a label that promised
/// otherwise would be a lie about where their words went.
const String kComposerDictationLabel = 'Bolkar likhein';
const String kCompanionVoiceLabel = 'Awaaz note record karein';

/// What an edit row's operation DOES, in the worker's words. `section_label`
/// names the section only, so without these a row is ambiguous between adding
/// and removing the very same value.
const String kEditOpAdd = 'Jodenge:';
const String kEditOpDelete = 'Hatayenge:';

/// Shown on the edit card once its proposal has expired (#1862 — plain words,
/// not "samay-seema").
const String kEditCardExpired = 'Is card ka time khatam ho gaya.';

const int kEditProposalMaxRows = 3;

/// Shown when more rows are ticked than one confirm can carry.
const String kEditProposalTooManyTicked =
    'Ek baar mein teen badlav tak. Kuch ka tick hata dein.';

class _EditProposalCard extends StatefulWidget {
  const _EditProposalCard({
    super.key,
    required this.proposal,
    required this.onConfirm,
    required this.onCancel,
  });

  final EditProposal proposal;

  /// Called with the TICKED rows' server-minted ids (never the values).
  final void Function(List<String> rowIds) onConfirm;

  /// Nahi.
  final VoidCallback onCancel;

  @override
  State<_EditProposalCard> createState() => _EditProposalCardState();
}

class _EditProposalCardState extends State<_EditProposalCard> {
  /// The rows the worker UNTICKED. Non-destructive rows (`add` / `edit`) start
  /// TICKED (phase-1 F1), so only the destructive ones are seeded here.
  final Set<String> _unticked = <String>{};

  /// Rebuilds once a second so Haan / Nahi disable the moment `expires_at`
  /// passes, with no other rebuild arriving.
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // TD151(2) — a DESTRUCTIVE row (`op: "delete"`) starts UNTICKED: removing a
    // skill / language / trade / saved place must take a DELIBERATE tick, never
    // a Haan tapped without reading. Non-destructive rows (`add` / `edit`) keep
    // the all-ticked default. `op` is the authoritative signal (§5.1); the
    // confirm route still receives only the ticked rows' ids.
    for (final EditProposalRow row in widget.proposal.rows) {
      if (row.op == 'delete') _unticked.add(row.rowId);
    }
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  /// True once the proposal's TTL has passed: the server would refuse the
  /// confirm, so the card must not offer one.
  bool get _expired => !DateTime.now().isBefore(widget.proposal.expiresAt);

  List<String> get _tickedRowIds => <String>[
        for (final EditProposalRow row in widget.proposal.rows)
          if (!_unticked.contains(row.rowId)) row.rowId,
      ];

  void _toggle(EditProposalRow row) {
    if (_expired) return;
    setState(() {
      if (!_unticked.remove(row.rowId)) _unticked.add(row.rowId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final bool expired = _expired;
    final List<String> ticked = _tickedRowIds;
    // The confirm route takes at most [kEditProposalMaxRows] row ids, but the
    // proposal schema puts NO ceiling on rows — so a longer card arrives with
    // every row ticked and a Haan that the server would 400. Say so, in the
    // worker's terms, instead of letting them tap into a rejection.
    final bool overTicked = ticked.length > kEditProposalMaxRows;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s2,
        AppSpacing.s4,
        AppSpacing.s3,
      ),
      child: Center(
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            maxWidth: OnboardingLayout.maxContentWidth,
          ),
          child: Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: OnboardingColors.paperWhite,
              borderRadius: BorderRadius.circular(OnboardingRadii.card),
              border: Border.all(
                color: OnboardingColors.borderDefault,
                width: 1.2,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                for (final EditProposalRow row in widget.proposal.rows)
                  _row(row, expired: expired),
                const SizedBox(height: AppSpacing.s2),
                Text(
                  expired
                      // #1862 — everyday Hinglish. "samay-seema" and "maany"
                      // are bookish Hindi a low-literacy worker does not use.
                      ? kEditCardExpired
                      : '${_formatExpiry(widget.proposal.expiresAt)} tak Haan daba sakte hain.',
                  style: OnboardingTypography.bodyMuted(
                    color: OnboardingColors.ink600,
                  ),
                ),
                // Why Haan is off, when it is off for THIS reason. Without the
                // line a worker sees a dead button and no way to work out what
                // the card wants from them.
                if (overTicked) ...<Widget>[
                  const SizedBox(height: AppSpacing.s2),
                  Text(
                    kEditProposalTooManyTicked,
                    style: OnboardingTypography.inter(
                      size: 12,
                      height: 1.35,
                      color: OnboardingColors.errorRed,
                    ),
                  ),
                ],
                const SizedBox(height: AppSpacing.s3),
                Row(
                  children: <Widget>[
                    Expanded(
                      // NEUTRAL, NOT DESTRUCTIVE (#1862). Nahi only declines the
                      // proposal — nothing of the worker's is lost by tapping
                      // it, and red is this app's colour for removal (it is what
                      // marks the card's own delete rows). Every other Haan/Nahi
                      // pair in the app is neutral; this was the odd one out,
                      // and it made the safe answer look like the dangerous one.
                      child: OutlinedButton(
                        onPressed: expired ? null : widget.onCancel,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: OnboardingColors.ink900,
                          side: const BorderSide(
                            color: OnboardingColors.borderCard,
                          ),
                          minimumSize: const Size(double.infinity, 48),
                          shape: RoundedRectangleBorder(
                            borderRadius:
                                BorderRadius.circular(OnboardingRadii.button),
                          ),
                        ),
                        child: Text(
                          kVoiceBooleanNo,
                          style: OnboardingTypography.buttonLabel(
                            color: OnboardingColors.ink900,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.s3),
                    Expanded(
                      child: PrimaryActionButton(
                        label: kVoiceBooleanYes,
                        showArrow: false,
                        // Nothing ticked is nothing to apply; expired is nothing
                        // the server would accept; and more than
                        // [kEditProposalMaxRows] is a body the confirm route
                        // rejects outright (see the getter).
                        onPressed: (expired ||
                                ticked.isEmpty ||
                                ticked.length > kEditProposalMaxRows)
                            ? null
                            : () => widget.onConfirm(ticked),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// One row: a tick (everything starts ticked), the section's server-supplied
  /// label, and what changes.
  Widget _row(EditProposalRow row, {required bool expired}) {
    final bool ticked = !_unticked.contains(row.rowId);
    return InkWell(
      onTap: expired ? null : () => _toggle(row),
      borderRadius: BorderRadius.circular(OnboardingRadii.card),
      child: Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.s2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // The tick is the row's only control; the whole row is its target.
            Checkbox(
              value: ticked,
              onChanged: expired ? null : (_) => _toggle(row),
              activeColor: OnboardingColors.shiftBlue,
              checkColor: OnboardingColors.textOnBlue,
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            const SizedBox(width: AppSpacing.s2),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    // `section_label · field_label` (§5.1). The section alone
                    // cannot tell two rows of one section apart, so the field's
                    // own name rides beside it. An older server sends no
                    // `field_label` and the header stays exactly the section.
                    row.fieldLabel == null
                        ? row.sectionLabel
                        : '${row.sectionLabel} · ${row.fieldLabel}',
                    style: OnboardingTypography.inter(
                      size: 13,
                      weight: FontWeight.w700,
                      color: OnboardingColors.ink900,
                    ),
                  ),
                  const SizedBox(height: 2),
                  _rowChange(row),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// What one row's change reads as. `add` shows the new value, `delete` the
  /// removed one (struck through), `edit` both; an unknown future op falls back
  /// to the same before→after line rather than hiding the row.
  ///
  /// The server now labels a CLOSED-SET value itself ([EditProposalRow
  /// .beforeDisplay] / [.afterDisplay]) from the same dictionaries the form
  /// chips and the résumé print, and the app PREFERS that label when it is
  /// present. The server owns the wording; the client carries no label map of
  /// its own. An older server sends null and every value falls back through
  /// [companionEditValue], which is why that humaniser stays.
  ///
  /// The row_ids sent back on Haan are untouched by this; only the pixels are
  /// humanised.
  Widget _rowChange(EditProposalRow row) {
    final String? before = row.before == null
        ? null
        : (row.beforeDisplay ?? companionEditValue(row.before!));
    final String? after = row.after == null
        ? null
        : (row.afterDisplay ?? companionEditValue(row.after!));
    switch (row.op) {
      case 'add':
        // Say it is being ADDED. A bare value under a section label reads as a
        // statement of fact, not as a change the worker is about to authorise.
        return _opLine(kEditOpAdd, after ?? '');
      case 'delete':
        // THE ONE ROW THAT DESTROYS SOMETHING. A strikethrough alone carries
        // that meaning only to a reader who already knows the convention, so the
        // row now starts UNTICKED (TD151(2)) AND the word says so, in the same
        // red the app uses for removal — a worker can never lose a skill, a
        // language or a qualification by tapping Haan without reading.
        return _opLine(
          kEditOpDelete,
          before ?? '',
          struckThrough: true,
          tone: OnboardingColors.errorRed,
        );
      default:
        if ((before ?? '').isEmpty) return _valueText(after ?? '');
        if ((after ?? '').isEmpty) return _valueText(before!);
        return Text(
          '$before  →  $after',
          style: OnboardingTypography.inter(
            size: 13,
            color: OnboardingColors.ink600,
          ),
        );
    }
  }

  /// One row's change, prefixed by what the change DOES.
  ///
  /// The prefix is the fix for the card's worst ambiguity: `section_label` names
  /// the SECTION ("Skills"), never the operation, so "Welding" under "Skills"
  /// could equally mean adding it or removing it. Screen readers get the same
  /// sentence, which a strikethrough cannot give them at all.
  Widget _opLine(
    String op,
    String value, {
    bool struckThrough = false,
    Color? tone,
  }) =>
      Text.rich(
        TextSpan(children: <InlineSpan>[
          TextSpan(
            text: '$op ',
            style: OnboardingTypography.inter(
              size: 13,
              weight: FontWeight.w700,
              color: tone ?? OnboardingColors.ink600,
            ),
          ),
          TextSpan(
            text: value,
            style: OnboardingTypography.inter(
              size: 13,
              color: OnboardingColors.ink600,
              decoration:
                  struckThrough ? TextDecoration.lineThrough : null,
            ),
          ),
        ]),
      );

  Widget _valueText(String value, {bool struckThrough = false}) => Text(
        value,
        style: OnboardingTypography.inter(
          size: 13,
          color: OnboardingColors.ink600,
          decoration: struckThrough ? TextDecoration.lineThrough : null,
        ),
      );
}

/// The card's remaining lifetime, e.g. "8 minute". A relative figure is all the
/// worker needs; the exact instant is not actionable.
String _formatExpiry(DateTime expiresAt) {
  final Duration remaining = expiresAt.difference(DateTime.now());
  if (remaining.inMinutes <= 0) return 'kuch second';
  if (remaining.inHours >= 1) return '${remaining.inHours} ghante';
  return '${remaining.inMinutes} minute';
}
