import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart'
    show HapticFeedback, SystemUiOverlayStyle;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart'
    show ChatInputMode, ChatProgress, ChatQuestionKind;
import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
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
import '../../voice/domain/speech_dictation.dart';
import '../../voice/domain/voice_models.dart';
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

class _ChatViewState extends State<_ChatView> with TickerProviderStateMixin {
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

  // ---- Hold-to-talk (voice → text into the composer) ----------------------
  //
  // Long-pressing the composer mic runs the DEVICE's own speech recogniser
  // ([SpeechDictation], the `speech_to_text` plugin). Recognised words fill the
  // input field live as the worker speaks; on release the text stays there for
  // them to review and Send — sent as an ORDINARY chat message. NO server, no
  // upload, no `/voice/*` endpoint (so no bucket dependency, no 503). A plain
  // TAP still opens the full server-side voice-note screen (unchanged).

  /// Honest copy when the device recogniser could not be started (no engine, or
  /// an unexpected error). Typing always stays available.
  static const String _kVoiceToTextUnavailable =
      'Awaaz text mein nahi badal payi. Dobara boliye ya type kijiye.';

  /// Mic is held and the recorder is live.
  bool _holdRecording = false;

  /// A hold-to-talk leg (start OR transcribe) is in flight — reentrancy guard.
  bool _holdBusy = false;

  /// Release arrived before [_startHoldToTalk] finished starting the mic — ask
  /// that in-flight start to cancel rather than leave a mic with no owner.
  bool _holdStopRequested = false;

  /// The centre "AB BOLEN" cue is showing — for the WHOLE hold (shown on press,
  /// hidden on release), not a flash.
  bool _showAbBolen = false;

  /// True while the worker is actively speaking (recognised words are arriving).
  /// Drives the cue's shake; goes false after a short idle so the cue stands
  /// still when they pause.
  bool _speaking = false;

  /// Whatever was already typed when a hold began — recognised words append onto
  /// it so live dictation never clobbers text the worker started by hand. Each
  /// FINAL utterance is committed back into this so a continuous-listen restart
  /// (see [SpeechDictation]) never drops an earlier sentence.
  String _dictationBase = '';

  /// Fires after a gap in recognised speech to drop [_speaking] (stop the shake).
  Timer? _speechIdleTimer;

  /// The last recognised text the shake reacted to. The shake ticks only when
  /// the words actually CHANGE — the recogniser re-emits the same partial while
  /// idle, so keying on change (not on every callback) is what lets the shake
  /// stop when the worker goes quiet.
  String _lastHeardForShake = '';

  /// The cue's shake — repeats while [_speaking], parked centred otherwise.
  late final AnimationController _shakeCtrl;

  @override
  void initState() {
    super.initState();
    // Manual scroll back near the bottom dismisses the pill.
    _scroll.addListener(_onScroll);
    // A quick in-place shake while the worker speaks: one smooth sine cycle per
    // ~90ms (~11Hz). Parked at 0 (centred) when not speaking.
    _shakeCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 90),
    );
  }

  @override
  void dispose() {
    _speechIdleTimer?.cancel();
    _shakeCtrl.dispose();
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final String text = _controller.text;
    if (text.trim().isEmpty) return;
    _sendText(text);
    _controller.clear();
  }

  /// Send an answer from a tap-to-answer chip — same path as typing it.
  void _sendText(String text) {
    if (text.trim().isEmpty) return;
    context.read<ChatBloc>().add(ChatMessageSent(text));
  }

  /// Send an answer chosen from an OPTIONS list (chips or the disambiguate
  /// rows). One tap per turn: see [_optionTapPending].
  void _sendOption(String label) {
    if (_optionTapPending) return;
    if (label.trim().isEmpty) return;
    setState(() => _optionTapPending = true);
    _sendText(label);
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

  /// Long-press the composer mic: HOLD TO TALK. Buzzes, flashes the centre "AB
  /// BOLEN" cue, and starts the DEVICE recogniser; recognised words fill the
  /// composer live and the worker still taps Send. No recogniser or a denied mic
  /// surfaces as an honest snackbar and leaves typing untouched — never a crash.
  Future<void> _startHoldToTalk() async {
    if (_holdRecording || _holdBusy) return;
    if (!locator.isRegistered<SpeechDictation>()) return;
    final SpeechDictation speech = locator<SpeechDictation>();
    _holdBusy = true;
    _holdStopRequested = false;
    // Instant, BEFORE any await: a buzz + the "AB BOLEN" cue the moment the hold
    // is recognised, so the worker feels the mic engage and does not wonder
    // whether it is listening.
    HapticFeedback.vibrate();
    setState(() => _showAbBolen = true);
    try {
      final bool ready = await speech.initialize();
      if (!mounted) return;
      if (!ready) {
        // No recogniser on the device, or the worker denied the mic.
        _hideAbBolen();
        _showComposerNotice(const MicPermissionFailure().message);
        return;
      }
      if (_holdStopRequested) {
        // Released before listening began — nothing to start.
        _hideAbBolen();
        return;
      }
      // Preserve anything already typed; recognised words append onto it.
      _dictationBase = _controller.text.trimRight();
      _lastHeardForShake = '';
      await speech.listen(onResult: _onDictationResult);
      if (!mounted) return;
      setState(() => _holdRecording = true);
    } catch (_) {
      if (mounted) {
        _hideAbBolen();
        _showComposerNotice(_kVoiceToTextUnavailable);
      }
    } finally {
      _holdBusy = false;
    }
  }

  /// Release the mic: stop listening. The recognised words are ALREADY in the
  /// composer (filled live by [_onDictationResult]); the worker reviews and taps
  /// Send. NOTHING is sent here — from here it is an ordinary typed message.
  Future<void> _stopHoldToTalk() async {
    _hideAbBolen();
    if (!_holdRecording) {
      // Released mid-init: tell the start leg not to begin listening.
      _holdStopRequested = true;
      return;
    }
    setState(() => _holdRecording = false);
    if (!locator.isRegistered<SpeechDictation>()) return;
    try {
      await locator<SpeechDictation>().stop();
    } catch (_) {
      // Best-effort — stopping a recogniser must never surface an error.
    }
  }

  /// Live dictation callback: drops the recognised words into the composer AS
  /// the worker speaks, appended onto whatever was already typed, cursor parked
  /// at the end so Send is the natural next tap. No server, no upload — this text
  /// is sent exactly like a typed message.
  ///
  /// A FINAL result is committed into [_dictationBase] so the next recognition
  /// session (the continuous-listen restart) appends onto it instead of
  /// overwriting the sentence just spoken.
  void _onDictationResult(DictationResult result) {
    if (!mounted) return;
    final String heard = result.text.trim();
    if (heard.isEmpty) return;
    // Shake ONLY on genuinely new words — the recogniser re-emits the same
    // partial while the worker is quiet, so keying on change is what lets the
    // vibration stop between utterances.
    if (heard != _lastHeardForShake) {
      _lastHeardForShake = heard;
      _onSpeechActivity();
    }
    final String merged = _dictationBase.isEmpty
        ? heard
        : '$_dictationBase $heard';
    _controller.value = TextEditingValue(
      text: merged,
      selection: TextSelection.collapsed(offset: merged.length),
    );
    if (result.isFinal) {
      _dictationBase = merged; // commit — the next utterance appends onto this
    }
  }

  /// A speaking tick (new recognised words): run the vibration and (re)arm the
  /// short idle timer that stops it the moment the words stop coming.
  void _onSpeechActivity() {
    _speechIdleTimer?.cancel();
    if (!_speaking) setState(() => _speaking = true);
    if (!_shakeCtrl.isAnimating) _shakeCtrl.repeat();
    _speechIdleTimer = Timer(const Duration(milliseconds: 500), () {
      if (!mounted) return;
      setState(() => _speaking = false);
      _stopShake();
    });
  }

  /// Parks the shake centred (offset 0) and stops the ticker.
  void _stopShake() {
    _shakeCtrl.stop();
    _shakeCtrl.value = 0;
  }

  /// Hides the "AB BOLEN" cue and stops the shake at once (a failed start, or the
  /// worker released the button).
  void _hideAbBolen() {
    _speechIdleTimer?.cancel();
    _stopShake();
    if (!mounted) return;
    if (_showAbBolen || _speaking) {
      setState(() {
        _showAbBolen = false;
        _speaking = false;
      });
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
        titleSpacing: 0,
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
                      if (state.sending)
                        _typingIndicator()
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
                _abBolenOverlay(),
              ],
            );
          },
        ),
      ),
    );
  }

  /// Kit 03 composer: a haldi circular MIC (voice-note entry, when [showVoice])
  /// + a rounded pill input + a blue send icon — a paper bar hairline-separated
  /// from the transcript. NOT a floating pill bar.
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
      child: Row(
        children: <Widget>[
          if (showVoice) ...<Widget>[
            _composerMic(),
            const SizedBox(width: AppSpacing.s2),
          ],
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
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s3,
                  vertical: 10,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                  borderSide: const BorderSide(color: AppColors.borderSubtle),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                  borderSide: const BorderSide(
                    color: AppColors.blue,
                    width: 1.5,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.s1),
          IconButton(
            tooltip: 'Bhejein',
            onPressed: _send,
            icon: const Icon(
              Icons.send_rounded,
              color: AppColors.blue,
              size: 24,
            ),
          ),
        ],
      ),
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
  /// Blue glyph on haldi (text/icon on haldi is always deep blue).
  Widget _composerMic() {
    return Semantics(
      button: true,
      label: 'Voice note bhejein ya dabaye rakhein',
      child: Tooltip(
        message: 'Tap: voice note · Dabaye rakhein: awaaz se likhein',
        // Tap → the full voice-note screen (unchanged). HOLD → record straight
        // into the composer. The long-press recognizer and the InkWell tap share
        // the pointer: a quick tap wins the gesture arena, a hold wins it — so
        // onTap never fires at the end of a hold, and a hold never opens the
        // voice-note screen.
        child: GestureDetector(
          onLongPressStart: (_) => _startHoldToTalk(),
          onLongPressEnd: (_) => _stopHoldToTalk(),
          child: Material(
            color: AppColors.haldi,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _openVoiceNote,
              child: SizedBox(
                width: AppSpacing.tap,
                height: AppSpacing.tap,
                child: Icon(
                  _holdRecording ? Icons.mic_none : Icons.mic,
                  color: AppColors.onHaldi,
                  size: 22,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// The centre "AB BOLEN" cue — a soft, smoky pill that fades in when a hold
  /// begins and fades out a moment later. Non-interactive (never eats a tap) and
  /// always mounted so BOTH the fade-in and the fade-out animate.
  Widget _abBolenOverlay() {
    return Positioned.fill(
      child: IgnorePointer(
        child: Center(
          child: AnimatedOpacity(
            opacity: _showAbBolen ? 1 : 0,
            duration: AppMotion.base,
            curve: Curves.easeOut,
            child: AnimatedBuilder(
              animation: _shakeCtrl,
              builder: (BuildContext context, Widget? child) =>
                  Transform.translate(
                    // Smooth ±4px sine shake while speaking; 0 at rest.
                    offset: Offset(
                      math.sin(_shakeCtrl.value * 2 * math.pi) * 4,
                      0,
                    ),
                    child: child,
                  ),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s5,
                  vertical: AppSpacing.s4,
                ),
                decoration: BoxDecoration(
                  color: AppColors.surfaceInk.withValues(alpha: 0.86),
                  borderRadius: BorderRadius.circular(AppRadii.lg),
                  // The "smoke": a large, soft haldi glow bleeding outward.
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: AppColors.haldi.withValues(alpha: 0.45),
                      blurRadius: 48,
                      spreadRadius: 8,
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(
                      Icons.graphic_eq,
                      color: AppColors.haldi,
                      size: 40,
                    ),
                    const SizedBox(height: AppSpacing.s2),
                    Text(
                      'AB BOLEN',
                      style: AppTypography.display(
                        size: AppTypography.sizeLg,
                        color: AppColors.onBlue,
                      ),
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
  Widget _followups(List<String> followups) {
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
        child: Row(
          children: <Widget>[
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
          ],
        ),
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

  Widget _disambiguateOption(String label) {
    final bool escape =
        label.trim().toLowerCase() == _kDisambiguateEscape.toLowerCase();
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s2),
      child: Material(
        color: escape ? Colors.transparent : AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.md),
          onTap: () => _sendOption(label),
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
