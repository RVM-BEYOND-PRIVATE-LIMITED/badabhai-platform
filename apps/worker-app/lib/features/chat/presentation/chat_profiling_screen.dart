import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show SystemUiOverlayStyle;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart'
    show ChatInputMode, ChatOption, ChatProgress, ChatQuestionKind;
import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chat_bubble.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_progress_bar.dart';
import '../../../router.dart';
import '../../voice/domain/speech_reader.dart';
import '../../voice/domain/voice_models.dart';
import '../../voice/presentation/dictation_controller.dart';
import '../../voice/presentation/widgets/dictation_bar.dart';
import '../domain/chat_message.dart';
import 'bloc/chat_bloc.dart';

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

/// Hinglish label on the jump-to-bottom pill.
const String _kNewMessageLabel = 'Naye message';

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

class ChatProfilingScreen extends StatelessWidget {
  const ChatProfilingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ChatBloc>(
      create: (_) => locator<ChatBloc>()..add(const ChatStarted()),
      child: const _ChatView(),
    );
  }
}

class _ChatView extends StatefulWidget {
  const _ChatView();

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
    _controller.dispose();
    super.dispose();
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
    context.read<ChatBloc>().add(ChatMessageSent(text));
  }

  /// Send an answer chosen from an OPTIONS list (chips or the disambiguate
  /// rows). One tap per turn: see [_optionTapPending].
  ///
  /// #761 — carries the tapped option as `optionKey` so the bloc can index the
  /// previous turn's `lookahead` and render the predicted next question
  /// optimistically. On chat the LABEL is the answer of record, so it is both the
  /// submit text (byte-identical, unchanged) and the lookahead key; the
  /// decline/escape chip is keyed `'__declined'`.
  void _sendOption(String label) {
    if (_optionTapPending) return;
    if (label.trim().isEmpty) return;
    setState(() => _optionTapPending = true);
    final bool escape =
        label.trim().toLowerCase() == _kDisambiguateEscape.toLowerCase();
    context.read<ChatBloc>().add(
          ChatMessageSent(label, optionKey: escape ? '__declined' : label),
        );
  }

  /// Send an answer chosen from a `suggested_options` chip/row (#761).
  ///
  /// THE FIX. SUBMITS [ChatOption.labelText] as the answer of record — BYTE-
  /// IDENTICAL to typing it, exactly as [_sendOption] does — while passing the
  /// stable [ChatOption.optionKey] (or `'__declined'` for the none-of-above chip)
  /// as the lookahead index. On the LLM chat the display label differs from that
  /// key, so keying the prediction by the label (the [_sendOption] path) missed
  /// and the optimistic render silently never fired; the option_key hits it.
  /// One tap per turn — see [_optionTapPending].
  void _sendChoice(ChatOption option) {
    if (_optionTapPending) return;
    if (option.labelText.trim().isEmpty) return;
    setState(() => _optionTapPending = true);
    context.read<ChatBloc>().add(
          ChatMessageSent(
            option.labelText,
            optionKey: option.isNoneOfAbove ? '__declined' : option.optionKey,
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
  void _landDictation(String text) {
    if (text.isEmpty || !mounted) return;
    setState(() {
      _controller.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
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
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(
        minWidth: AppSpacing.tap,
        minHeight: AppSpacing.tap,
      ),
      icon: Icon(
        active ? Icons.stop_circle_outlined : Icons.volume_up_rounded,
        size: 20,
        color: AppColors.blue,
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
  /// denied, nothing heard, transcription unavailable). Typing is never blocked.
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
      child: Row(
        children: <Widget>[
          Icon(icon, size: 16, color: color),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              text,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: color,
              ),
            ),
          ),
        ],
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
      child: BbButton(
        label: ready ? kChatDoneReadyLabel : kChatDoneNotReadyLabel,
        block: true,
        // Compact "Thodi aur baat karein" (owner request 2026-07-23): the not-ready
        // CTA is a small, low-emphasis nudge — smaller text + shorter height — so it
        // frees vertical space with the keyboard open. The READY "profile banaiye"
        // CTA stays full-size (lg): it is the primary action.
        size: ready ? BbButtonSize.lg : BbButtonSize.sm,
        variant: ready ? BbButtonVariant.primary : BbButtonVariant.secondary,
        iconLeft: ready ? Icons.check_circle_outline : Icons.forum_outlined,
        // #372's visible half: the same-frame half lives in
        // `_openProfilePreview`. Only the READY path can stack previews —
        // the not-ready path opens a sheet, which is its own guard.
        onPressed: ready
            ? (_openingPreview ? null : _openProfilePreview)
            : _confirmEarlyFinish,
      ),
    );
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
      await context.push(Routes.profilePreview);
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
      builder: (BuildContext sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            kChatNudgeTitle,
            style: AppTypography.display(size: AppTypography.sizeLg),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            kChatNudgeBody,
            style: AppTypography.body(
              size: AppTypography.sizeBase,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: kChatNudgeContinueLabel,
            block: true,
            onPressed: () => Navigator.of(sheetContext).pop(false),
          ),
          const SizedBox(height: AppSpacing.s2),
          BbButton(
            label: kChatNudgeProceedLabel,
            block: true,
            variant: BbButtonVariant.ghost,
            onPressed: () => Navigator.of(sheetContext).pop(true),
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
    return Scaffold(
      appBar: AppBar(
        // Kit 03 chat header: a DEEP-BLUE bar with a haldi 'BB' avatar + 'Bada
        // Bhai / online'. The voice-note entry moved OUT of the app bar and INTO
        // the composer (the haldi mic), per the kit — its kill switch
        // (`showVoice`) still governs it.
        backgroundColor: AppColors.surfaceInk,
        foregroundColor: AppColors.onBlue,
        iconTheme: const IconThemeData(color: AppColors.onBlue),
        systemOverlayStyle: SystemUiOverlayStyle.light,
        // Gutter of left space so the BB avatar + title are not flush against
        // the screen edge — aligns the header with the body's left margin.
        titleSpacing: AppSpacing.gutter,
        title: Row(
          children: <Widget>[
            Container(
              width: 32,
              height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.haldi,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Text(
                'BB',
                style: AppTypography.display(
                  size: AppTypography.sizeSm,
                  color: AppColors.onHaldi,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.s2),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text(
                  'Bada Bhai',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w700,
                    color: AppColors.onBlue,
                  ),
                ),
                Text(
                  'online',
                  style: AppTypography.body(
                    size: AppTypography.size2xs,
                    color: AppColors.green300,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      body: BlocListener<ChatBloc, ChatState>(
        // Fire when a message is appended (length grows) OR when the in-flight
        // flag moves — NOT on every state change (e.g. the initializing flag
        // flipping). The second condition carries the one-tap-per-turn latch.
        listenWhen: (ChatState prev, ChatState curr) =>
            curr.messages.length > prev.messages.length ||
            curr.sending != prev.sending,
        listener: (BuildContext context, ChatState state) {
          // Release on the SETTLE EDGE (sending true → false), never on the
          // way in: the bloc clears followups and sets sending as soon as the
          // worker sends, so anything keyed on those unlatches while the turn
          // is still in flight — which is precisely the window the latch is
          // for.
          if (_wasSending && !state.sending && _optionTapPending) {
            setState(() => _optionTapPending = false);
          }
          _wasSending = state.sending;
          _onMessagesChanged(state.messages);
        },
        child: BlocBuilder<ChatBloc, ChatState>(
          builder: (BuildContext context, ChatState state) {
            if (state.initializing) {
              return const Center(child: CircularProgressIndicator());
            }
            return Stack(
              children: <Widget>[
                SafeArea(
                  child: Column(
                    children: <Widget>[
                      if (state.sessionFailed) _sessionBanner(),
                      // OIE Phase 8 (#649): the pack progress bar + the pinned
                      // occupation pill. Hidden until a pack resolves / a trade pins.
                      if (state.progress != null ||
                          state.occupationLabel != null)
                        _oieHeader(state.progress, state.occupationLabel),
                      Expanded(
                        child: Stack(
                          children: <Widget>[
                            ListView.builder(
                              controller: _scroll,
                              // Full horizontal gutter, lighter vertical rhythm so
                              // more of the transcript stays visible with the
                              // keyboard up.
                              padding: const EdgeInsets.symmetric(
                                horizontal: AppSpacing.s4,
                                vertical: AppSpacing.s2,
                              ),
                              itemCount: state.messages.length,
                              itemBuilder: (BuildContext context, int i) {
                                final ChatMessage m = state.messages[i];
                                final bool failed =
                                    m.status == ChatSendStatus.failed;
                                return BbChatBubble(
                                  text: m.text,
                                  fromWorker: m.fromWorker,
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
                      // #761 — while an optimistic predicted turn is on screen
                      // (predictedQuestionKey != null), show its chips instead of
                      // the typing indicator, so the worker can answer the
                      // predicted question during the round trip.
                      if (state.sending && state.predictedQuestionKey == null)
                        _typingIndicator()
                      // #761 — when the turn serves `suggested_options` (the LLM
                      // chat), render chips from IT so each carries its stable
                      // option_key: the tapped label is submitted byte-identically
                      // while the bloc indexes `lookahead` by the key, and the
                      // optimistic prediction finally fires. Served ALONGSIDE
                      // `suggested_followups`, so a deterministic/older turn with
                      // no options falls through to the label-keyed path below,
                      // unchanged (label == key there).
                      else if (state.suggestedOptions.isNotEmpty)
                        state.questionKind == ChatQuestionKind.disambiguate
                            ? _disambiguateOptions(state.suggestedOptions)
                            : _followupOptions(state.suggestedOptions)
                      else if (state.followups.isNotEmpty)
                        // A disambiguation turn is mutually-exclusive occupations
                        // where the tapped label BECOMES the answer of record and
                        // selects the pack — a vertical single-select, not the
                        // horizontal scroller a worker can skim past (#649).
                        state.questionKind == ChatQuestionKind.disambiguate
                            ? _disambiguate(state.followups)
                            : _followups(state.followups),
                      // A blocked turn (pseudonymize fail-closed) never processed the
                      // worker's last answer — say so rather than let the canned
                      // fallback reply read as understood. Shown in every build.
                      if (state.lastReplyBlocked)
                        _replyNotice(
                          icon: Icons.error_outline,
                          color: AppColors.red600,
                          text: kChatBlockedNotice,
                        ),
                      // B7 maintenance notice — ops copy, shown only when set.
                      if (maintenance.isNotEmpty)
                        _replyNotice(
                          icon: Icons.info_outline,
                          color: AppColors.textMuted,
                          text: maintenance,
                        ),
                      // #770 — on an options_only turn the chips above are the
                      // ONLY answer path, so suppress the composer (and its mic,
                      // since voice resolves to typed text). GUARDED on non-empty
                      // followups: a malformed options_only turn with no chips
                      // must never trap the worker with no way to answer, so the
                      // composer stays in that case.
                      if (state.inputMode == ChatInputMode.optionsOnly &&
                          state.followups.isNotEmpty)
                        _optionsOnlyHint()
                      else
                        _inputBar(showVoice),
                      _doneCta(state),
                    ],
                  ),
                ),
              ],
            );
          },
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
        color: AppColors.surfaceCard,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s3,
        AppSpacing.s2,
        AppSpacing.s3,
        AppSpacing.s2,
      ),
      child: _dictation.listening
          ? DictationBar(
              level: _dictation.level,
              waveKey: const ValueKey<String>('voiceWaveInline'),
              onStop: _stopDictation,
              onSend: _sendFromDictation,
            )
          : _idleBar(showVoice),
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
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _send(),
            // Compact composer (owner request): body-size text + dense padding so
            // the field is shorter and leaves more transcript visible with the
            // keyboard open. Matches the chat bubble size (sizeSm).
            style: AppTypography.body(size: AppTypography.sizeSm),
            decoration: InputDecoration(
              hintText: 'Boliye ya likhiye…',
              isDense: true,
              filled: true,
              fillColor: AppColors.canvas,
              // Roomier padding + the design's input radius (md=12, not the pill):
              // a fully-rounded pill made multi-line text hug the curved corners
              // and touch the border. A softer 12-radius box gives the text clear
              // breathing room on every line.
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.s4,
                vertical: AppSpacing.s3,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadii.md),
                borderSide: const BorderSide(color: AppColors.borderSubtle),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadii.md),
                borderSide: const BorderSide(
                  color: AppColors.blue,
                  width: 1.5,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.s1),
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
            icon: const Icon(
              Icons.send_rounded,
              color: AppColors.blue,
              size: 24,
            ),
          );
        }
        return IconButton(
          tooltip: 'Bolkar likhein',
          onPressed: _startDictation,
          icon: const Icon(
            Icons.mic,
            color: AppColors.blue,
            size: 24,
          ),
        );
      },
    );
  }

  /// Replaces the composer on an `options_only` turn (#770): a locked-look bar
  /// that keeps the same paper-bar frame as [_inputBar] (no layout jump) and
  /// tells the worker, in aap-form, to answer from the chips above. No text
  /// field, no send, no mic — the chips are the only way to answer this turn.
  Widget _optionsOnlyHint() {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surfaceCard,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s3,
        AppSpacing.s3,
        AppSpacing.s3,
        AppSpacing.s3,
      ),
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.touch_app_outlined,
            color: AppColors.textMuted,
            size: 20,
          ),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              kChatOptionsOnlyHint,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
              ).copyWith(color: AppColors.textMuted),
            ),
          ),
        ],
      ),
    );
  }

  /// The haldi circular mic in the composer — opens the voice-note flow (kit 03).
  /// Blue glyph on haldi (text/icon on haldi is always deep blue). TAP-ONLY now:
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
          color: AppColors.haldi,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: _openVoiceNote,
            child: const SizedBox(
              width: AppSpacing.tap,
              height: AppSpacing.tap,
              child: Icon(
                Icons.mic,
                color: AppColors.onHaldi,
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
      color: AppColors.red50,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.cloud_off, size: 18, color: AppColors.red600),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              _kSessionFailedLabel,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.red600,
              ),
            ),
          ),
        ],
      ),
    );
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
          const Icon(Icons.more_horiz, size: 20, color: AppColors.brand),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              'Bada Bhai type kar raha hai…',
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
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
          // Answer chips read like a chat message: same size (sizeSm) and a
          // normal weight (owner request 2026-07-23).
          BbChip(
            label: f,
            labelWeight: FontWeight.w400,
            onTap: () => _sendOption(f),
          ),
          const SizedBox(width: AppSpacing.s2),
        ],
      ]);

  /// The horizontal chip row rendered from `suggested_options` (#761). Same look
  /// as [_followups] — each chip DISPLAYS [ChatOption.labelText] — but a tap
  /// routes through [_sendChoice], which submits that label byte-identically
  /// while indexing `lookahead` by the stable [ChatOption.optionKey].
  Widget _followupOptions(List<ChatOption> options) => _chipScroller(<Widget>[
        for (final ChatOption o in options) ...<Widget>[
          BbChip(
            label: o.labelText,
            labelWeight: FontWeight.w400,
            onTap: () => _sendChoice(o),
          ),
          const SizedBox(width: AppSpacing.s2),
        ],
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

  /// OIE Phase 8 header (#649): the pack progress bar (the finish line, the
  /// single strongest completion lever for low-literacy users) and the pinned
  /// occupation pill.
  Widget _oieHeader(ChatProgress? progress, String? occupation) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s2,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (progress != null) BbProgressBar(value: progress.fraction),
          if (progress != null && occupation != null)
            const SizedBox(height: AppSpacing.s2),
          if (occupation != null)
            Align(
              alignment: Alignment.centerLeft,
              child: _occupationPill(occupation),
            ),
        ],
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
        color: AppColors.haldiTint,
        borderRadius: BorderRadius.circular(AppRadii.pill),
        border: Border.all(color: AppColors.haldi),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Icon(Icons.check_circle, size: 16, color: AppColors.blue),
          const SizedBox(width: AppSpacing.s1),
          Flexible(
            child: Text(
              label,
              style: AppTypography.body(size: 14, weight: FontWeight.w600),
              overflow: TextOverflow.ellipsis,
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
  /// escape uses the option's own `is_none_of_above`, not the hardcoded label).
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
              escape: o.isNoneOfAbove,
              onTap: () => _sendChoice(o),
            ),
        ],
      ),
    );
  }

  /// Fallback label path: the escape is recognised by the hardcoded
  /// [_kDisambiguateEscape] phrase and the tapped label is both submit and key.
  Widget _disambiguateOption(String label) => _disambiguateRow(
        label: label,
        escape: label.trim().toLowerCase() == _kDisambiguateEscape.toLowerCase(),
        onTap: () => _sendOption(label),
      );

  /// One vertical single-select row, shared by the fallback ([_disambiguateOption])
  /// and the `suggested_options` path ([_disambiguateOptions]). [escape] renders
  /// the "none of these" style (borderless, muted); [onTap] submits.
  Widget _disambiguateRow({
    required String label,
    required bool escape,
    required VoidCallback onTap,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s2),
      child: Material(
        color: escape ? Colors.transparent : AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.md),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: AppSpacing.tap),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s4,
              vertical: AppSpacing.s3,
            ),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadii.md),
              border: Border.all(
                color: escape ? AppColors.borderSubtle : AppColors.blue,
              ),
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    label,
                    style: AppTypography.body(
                      size: 15,
                      weight: escape ? FontWeight.w400 : FontWeight.w600,
                      color: escape
                          ? AppColors.textMuted
                          : AppColors.textPrimary,
                    ),
                  ),
                ),
                Icon(
                  escape ? Icons.more_horiz : Icons.chevron_right,
                  color: escape ? AppColors.textMuted : AppColors.blue,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// "Naye message" jump pill — shown bottom-centre above the composer when a
  /// bot reply lands while the worker has scrolled up. Tapping rides them down.
  Widget _jumpPill() {
    return Material(
      color: AppColors.surfaceCard,
      elevation: 0,
      // Flat pill (JUL31 system): a hairline border, not a shadow, lifts it off
      // the chat.
      shape: const StadiumBorder(
        side: BorderSide(color: AppColors.borderSubtle),
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
              Text(
                _kNewMessageLabel,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: AppColors.brand,
                ),
              ),
              const SizedBox(width: AppSpacing.s1),
              const Icon(
                Icons.keyboard_arrow_down_rounded,
                color: AppColors.brand,
                size: 20,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
