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
    show ChatInputMode, ChatOption, ChatQuestionKind, FormOffer;
import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/util/devanagari_guard.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
// Only for [kChatSendFailedLabel]: the bubble itself is drawn locally in the
// Master UI Kit style (see [_ChatBubble]), the copy stays the shared constant.
import '../../../core/widgets/bb_chat_bubble.dart' show kChatSendFailedLabel;
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/selection_cards.dart';
import '../../../core/widgets/bottom_bar_inset.dart';
import '../../../router.dart';
import '../../trade_form/domain/trade_form_args.dart';
import '../../trade_form/presentation/open_trade_form.dart';
import '../../voice/domain/speech_reader.dart';
import '../../voice/domain/voice_models.dart';
import '../../voice/presentation/dictation_controller.dart';
import '../../voice/presentation/widgets/dictation_bar.dart';
import '../domain/chat_message.dart';
import '../domain/chat_companion_keys.dart';
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

/// The server's "none of these" escape `option_key` (mirrors
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
    // Read ONCE, at mount: the lever decides which chat this tab opens, and a
    // Remote Config fetch landing later must not swap it under the worker.
    final bool companion =
        assistantTab && BbRemoteConfig.instance.chatCompanionEnabled;
    return BlocProvider<ChatBloc>(
      create: (_) => locator<ChatBloc>()
        ..add(companion ? const ChatCompanionStarted() : const ChatStarted()),
      child: companion
          ? _CompanionRefocus(child: _ChatView(fromResumeImport: fromResumeImport))
          : _ChatView(fromResumeImport: fromResumeImport),
    );
  }
}

/// ADR-0044 — re-reads the companion recap each time the Bada Bhai tab comes
/// back into focus (the shell keeps the tab mounted, so nothing else would).
/// The bloc throttles it and appends a bubble only when the facts changed.
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
      onFocused: () =>
          context.read<ChatBloc>().add(const ChatCompanionRefreshRequested()),
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

class _ChatViewState extends State<_ChatView> {
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

  /// The composer hint while [_customAnswerMode] is on: the profile hint for a
  /// disambiguation list, the question-neutral one for a chip row.
  String _customAnswerHint = kChatCustomAnswerHint;

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
  }

  @override
  void dispose() {
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
        // Feedback lives HERE instead of the app-wide floating button on this
        // screen (both the onboarding chat and the Bada Bhai tab reuse it) —
        // see the exclusion in feedback_fab.dart. Same action, same icon,
        // only the position differs.
        actions: <Widget>[
          Padding(
            padding: EdgeInsets.only(right: headerActionGutter),
            child: MediaQuery.withClampedTextScaling(
              maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
              child: TextButton(
                style: TextButton.styleFrom(
                  foregroundColor: OnboardingColors.textOnBlue,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(
                      OnboardingRadii.feedbackButton,
                    ),
                    side: BorderSide(
                      color: Colors.white.withValues(alpha: 0.25),
                    ),
                  ),
                ),
                onPressed: () => context.pushOnce(
                  Routes.feedback,
                  extra: GoRouterState.of(context).uri.path,
                ),
                child: Text(
                  'Feedback',
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                    color: OnboardingColors.textOnBlue,
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
            curr.resumeUpdateQueued != prev.resumeUpdateQueued,
        listener: (BuildContext context, ChatState state) {
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
                                  text: m.text,
                                  fromWorker: m.fromWorker,
                                  maxWidth: bubbleMaxWidth,
                                  failed: failed,
                                  onRetry: failed ? () => _retry(i) : null,
                                  // Read-aloud speaker on bada bhai's questions
                                  // only (never the worker's own messages). #896 —
                                  // pass the Devanagari script so read-aloud speaks
                                  // it (falls back to the romanized text when null).
                                  trailing: (!m.fromWorker && !failed)
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
        else if (state.formOffer != null)
          _formOfferLockedHint()
        else
          _inputBar(showVoice),
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
          _doneCta(state),
      ],
      ),
      ),
    );
  }

  /// Kit 03 composer. IDLE: a rounded pill input + a trailing MIC / SEND button.
  /// While the worker dictates, the input area IS the recorder — a FULL-WIDTH
  /// static waveform ([_listeningBar]) fills the field slot with Stop + Send, and
  /// NOTHING is typed until Stop lands the recognised text in the field.
  Widget _inputBar(bool showVoice) {
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
            : _idleBar(showVoice),
      ),
    );
  }

  /// The normal composer row: (hidden) voice-note mic + text field + the trailing
  /// mic/send action.
  Widget _idleBar(bool showVoice) {
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
        return IconButton(
          tooltip: 'Bolkar likhein',
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
  /// Haan / Nahi question keeps the composer.
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
    // #761 — when the turn serves `suggested_options` (the LLM chat), render
    // chips from IT so each carries its stable option_key: the tapped label is
    // submitted byte-identically while the bloc indexes `lookahead` by the key,
    // and the optimistic prediction finally fires. Served ALONGSIDE
    // `suggested_followups`, so a deterministic/older turn with no options falls
    // through to the label-keyed path below, unchanged (label == key there).
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
                : _followupOptions(state.suggestedOptions),
      );
    }
    if (state.followups.isNotEmpty) {
      // A disambiguation turn is mutually-exclusive occupations where the tapped
      // label BECOMES the answer of record and selects the pack — a vertical
      // single-select, not the horizontal scroller a worker can skim past (#649).
      return KeyedSubtree(
        key: const ValueKey<String>('chips'),
        child: state.questionKind == ChatQuestionKind.disambiguate
            ? _disambiguate(state.followups)
            : _followups(state.followups),
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
  Widget _companionActionChips(List<ChatOption> options) {
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
            Padding(
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
        ],
      ),
    );
  }

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
class _AnswerChip extends StatelessWidget {
  const _AnswerChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  static const BorderRadius _radius = BorderRadius.all(Radius.circular(12));

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: Ink(
        decoration: BoxDecoration(
          color: OnboardingColors.chipBg,
          borderRadius: _radius,
          border: Border.all(color: OnboardingColors.borderDefault, width: 1.2),
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
            child: Text(
              label,
              style: OnboardingTypography.inter(size: 14),
            ),
          ),
        ),
      ),
    );
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
