import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart' show Ticker;
import 'package:flutter/services.dart'
    show HapticFeedback, SystemUiOverlayStyle;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart'
    show ChatInputMode, ChatOption, ChatProgress, ChatQuestionKind;
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
import '../../voice/domain/speech_reader.dart';
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

  /// Mic units above the ambient [_floor] that still count as quiet — the
  /// squelch that keeps a fan/room tone off the bars. (Android RMS scale.)
  static const double _kWaveSquelch = 1.5;

  /// Mic units above (floor + squelch) that fill the bars — speech headroom.
  static const double _kWaveSpan = 6.0;

  /// Mic is held and the recorder is live.
  bool _holdRecording = false;

  /// A hold-to-talk leg (start OR transcribe) is in flight — reentrancy guard.
  bool _holdBusy = false;

  /// Release arrived before [_startHoldToTalk] finished starting the mic — ask
  /// that in-flight start to cancel rather than leave a mic with no owner.
  bool _holdStopRequested = false;

  /// The live-waveform cue is showing — for the WHOLE hold (shown on press,
  /// hidden on release).
  bool _listening = false;

  /// The live, normalized (0..1) mic amplitude the waveform reads. A
  /// ValueNotifier so only the waveform repaints, never the whole screen.
  final ValueNotifier<double> _micLevel = ValueNotifier<double>(0);

  /// Adaptive NOISE FLOOR — the ambient level (a fan, room tone) the mic
  /// amplitude is measured against. It seeds to the first sample, then drops
  /// fast to a quieter floor and rises slowly, so a steady fan settles onto the
  /// baseline and only SPEECH (louder than room noise) clears it. This is what
  /// keeps the wave flat on ambient noise while staying REAL-TIME on the voice —
  /// no recognition gate, no lag.
  double _floor = 0;
  bool _floorSeeded = false;

  /// Whatever was already typed when a hold began — recognised words append onto
  /// it so live dictation never clobbers text the worker started by hand. Each
  /// finished utterance is committed back into this so a later utterance appends
  /// onto it instead of overwriting the sentence just spoken.
  String _dictationBase = '';

  /// The latest partial reading of the CURRENT utterance. The recogniser only
  /// ever GROWS a partial (each reading extends the last), so a reading that does
  /// NOT extend this one means it started a NEW utterance after a pause — at which
  /// point the previous utterance is folded into [_dictationBase] before the new
  /// words append. This is what keeps a phrase spoken before a mid-hold pause
  /// (e.g. "hello" before a 5s think) when the next phrase ("I am a CNC
  /// developer") follows — WITHOUT depending on the recogniser emitting a final
  /// or restarting the session, which some devices skip.
  String _lastHeard = '';

  /// True only while a hold is live and the composer should accept recognised
  /// words. Goes false the instant the hold tears down ([_hideWave]) so a
  /// trailing final result the recogniser delivers AFTER release — the
  /// continuous-listen session flushing — can never re-fill the composer once
  /// the worker has cleared or sent it. Without this the composer would
  /// intermittently refill after Send.
  bool _acceptingDictation = false;

  /// Index of the bot bubble currently being read aloud (its speaker icon shows
  /// the stop glyph); null when nothing is speaking.
  int? _speakingIndex;

  @override
  void initState() {
    super.initState();
    // Manual scroll back near the bottom dismisses the pill.
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    if (locator.isRegistered<SpeechReader>()) {
      unawaited(locator<SpeechReader>().stop()); // never leave TTS reading
    }
    _micLevel.dispose();
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final String text = _controller.text;
    if (text.trim().isEmpty) return;
    _sendText(text);
    // Clear the composer AND drop the dictation carry-over so a late recogniser
    // final (or the next hold) can never re-fill it with the sentence just sent.
    _acceptingDictation = false;
    _dictationBase = '';
    _lastHeard = '';
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
    _floor = 0;
    _floorSeeded = false;
    _micLevel.value = 0;
    setState(() => _listening = true);
    try {
      final bool ready = await speech.initialize();
      if (!mounted) return;
      if (!ready) {
        // No recogniser on the device, or the worker denied the mic.
        _hideWave();
        _showComposerNotice(const MicPermissionFailure().message);
        return;
      }
      if (_holdStopRequested) {
        // Released before listening began — nothing to start.
        _hideWave();
        return;
      }
      // Preserve anything already typed; recognised words append onto it.
      _dictationBase = _controller.text.trimRight();
      _lastHeard = '';
      _acceptingDictation = true;
      await speech.listen(
        onResult: _onDictationResult,
        onSoundLevel: _onSoundLevel, // live amplitude → the waveform
      );
      if (!mounted) return;
      setState(() => _holdRecording = true);
    } catch (_) {
      if (mounted) {
        _hideWave();
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
    _hideWave();
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
  /// Each finished utterance is committed into [_dictationBase] so the next one
  /// appends onto it. A new utterance is detected by [_lastHeard] no longer being
  /// extended — see that field — so a phrase said before a mid-hold pause is kept
  /// even when the device never emits a final for it.
  void _onDictationResult(DictationResult result) {
    if (!mounted || !_acceptingDictation) return;
    final String heard = result.text.trim();
    if (heard.isEmpty) return;

    // The recogniser has started a NEW utterance when this reading no longer
    // extends the last — commit the finished one into the base BEFORE appending
    // the new words, or the new phrase would REPLACE the old one.
    if (_lastHeard.isNotEmpty && !_extendsUtterance(heard, _lastHeard)) {
      _dictationBase = _appendToBase(_dictationBase, _lastHeard);
      _lastHeard = '';
    }

    final String merged = _appendToBase(_dictationBase, heard);
    _controller.value = TextEditingValue(
      text: merged,
      selection: TextSelection.collapsed(offset: merged.length),
    );
    _lastHeard = heard;

    if (result.isFinal) {
      // Settled — commit it and start the next utterance clean.
      _dictationBase = _appendToBase(_dictationBase, heard);
      _lastHeard = '';
    }
  }

  /// True when [next] continues the same utterance as [prev] — the recogniser
  /// only extends a partial, so a growing reading starts with the prior one.
  bool _extendsUtterance(String next, String prev) =>
      next.toLowerCase().startsWith(prev.toLowerCase());

  /// Joins a committed [base] with freshly [heard] words, single-spaced.
  String _appendToBase(String base, String heard) =>
      base.isEmpty ? heard : '$base $heard';

  /// The mic's live amplitude → the waveform, in REAL TIME (no wait for
  /// recognition). Measured against the adaptive [_floor] with a small squelch,
  /// so a steady fan/room tone stays at the baseline (flat bars) while speech —
  /// which is louder than ambient — drives the bars, and the moment the worker
  /// stops the level drops and the bars settle. Tuned for the plugin's Android
  /// RMS scale (~ -2..12); other platforms may want [_kWaveSquelch]/[_kWaveSpan]
  /// adjusted.
  void _onSoundLevel(double raw) {
    if (!_floorSeeded) {
      // Seed ABOVE the first sample so the floor can only settle DOWNWARD onto
      // ambient — which it does fast (the 0.5 drop below). Seeding AT the first
      // (cold-mic, often low) sample and letting the floor climb UP to the real
      // ambient was the bug: the climb took 2–3s, and until it caught up every
      // sample read as signal and slammed the bars full at the start of a hold.
      _floor = raw + _kWaveSpan;
      _floorSeeded = true;
    } else if (raw < _floor) {
      _floor = raw * 0.5 + _floor * 0.5; // drop fast toward a quieter ambient
    } else {
      _floor = _floor * 0.9 + raw * 0.1; // rise toward a louder ambient (a fan)
    }
    final double signal = raw - _floor - _kWaveSquelch;
    _micLevel.value = signal <= 0 ? 0.0 : (signal / _kWaveSpan).clamp(0.0, 1.0);
  }

  /// Hides the waveform cue and parks the level at rest (a failed start, or the
  /// worker released the button).
  void _hideWave() {
    // Stop accepting recognised words the moment the hold ends — a trailing
    // final the recogniser flushes after release must not re-fill the composer.
    _acceptingDictation = false;
    _micLevel.value = 0;
    if (mounted && _listening) setState(() => _listening = false);
  }

  /// The read-aloud speaker on a bot bubble. Tap → speak that question; tap the
  /// same one again (or it finishes) → stop. Shows a stop glyph while reading.
  Widget _speakerButton(int index, String text) {
    final bool active = _speakingIndex == index;
    return IconButton(
      onPressed: () => _toggleSpeak(index, text),
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
  Future<void> _toggleSpeak(int index, String text) async {
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
    await reader.speak(text); // resolves when playback finishes
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
                                  // Read-aloud speaker on bada bhai's questions
                                  // only (never the worker's own messages).
                                  trailing: (!m.fromWorker && !failed)
                                      ? _speakerButton(i, m.text)
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
                _waveOverlay(),
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
  /// The live-waveform cue (Gemini-style): a centred dark pill whose bars track
  /// the mic amplitude in REAL TIME while the worker holds to talk — no wait for
  /// recognition. Non-interactive (never eats a tap); fades in/out.
  Widget _waveOverlay() {
    return Positioned.fill(
      child: IgnorePointer(
        child: Center(
          child: AnimatedOpacity(
            key: const ValueKey<String>('voiceWaveCue'),
            opacity: _listening ? 1 : 0,
            duration: AppMotion.fast,
            curve: Curves.easeOut,
            child: Container(
              width: 300,
              height: 72,
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.s5,
                vertical: AppSpacing.s4,
              ),
              decoration: BoxDecoration(
                color: AppColors.surfaceInk.withValues(alpha: 0.94),
                borderRadius: BorderRadius.circular(AppRadii.pill),
                // A soft blue glow — the "smoke" behind the wave.
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: AppColors.blue.withValues(alpha: 0.35),
                    blurRadius: 44,
                    spreadRadius: 4,
                  ),
                ],
              ),
              child: _VoiceWaveform(level: _micLevel, active: _listening),
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

/// A live, scrolling audio waveform (Gemini-style) driven by the mic's amplitude.
///
/// [level] is the current normalized (0..1) amplitude, updated in near real time
/// from the recogniser's sound-level callback.
///
/// A STABLE equaliser, not a scrolling waveform (Gemini/ChatGPT style): a small
/// fixed cluster of centred bars that SIT STILL at a resting height when it is
/// quiet, and rise with the voice when the worker speaks — each bar in place, no
/// left-to-right "running train". A [Ticker] eases the drawn level toward the
/// live one every frame (smooth 60fps, not stepped to the sparse callbacks) and
/// advances a gentle shimmer phase so the speaking cluster looks alive without
/// travelling. The ticker only runs while [active] — a held mic.
class _VoiceWaveform extends StatefulWidget {
  const _VoiceWaveform({required this.level, required this.active});

  final ValueListenable<double> level;
  final bool active;

  @override
  State<_VoiceWaveform> createState() => _VoiceWaveformState();
}

class _VoiceWaveformState extends State<_VoiceWaveform> {
  /// A compact Gemini-like cluster, not a full strip.
  static const int _barCount = 7;

  /// Smoothed, drawn level (eased toward the live [widget.level]).
  double _cur = 0;

  /// Gentle shimmer phase so a SPEAKING cluster shimmers in place — it scales
  /// with the level, so at rest (level ~0) it has no visible effect and the bars
  /// stay perfectly still.
  double _phase = 0;
  Ticker? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Ticker(_onTick);
    if (widget.active) _ticker!.start();
  }

  @override
  void didUpdateWidget(_VoiceWaveform old) {
    super.didUpdateWidget(old);
    if (widget.active && !_ticker!.isActive) {
      _cur = 0; // fresh, resting start each hold
      _phase = 0;
      _ticker!.start();
    } else if (!widget.active && _ticker!.isActive) {
      _ticker!.stop();
    }
  }

  void _onTick(Duration _) {
    // Ease the drawn level toward the live target for a smooth, instant-feeling
    // response, and advance the shimmer. Bars stay in place — only their heights
    // change, so there is no travelling motion.
    final double target = widget.level.value.clamp(0.0, 1.0);
    _cur += (target - _cur) * 0.28;
    _phase += 0.18;
    setState(() {}); // repaint the bars
  }

  @override
  void dispose() {
    _ticker?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: const Size(double.infinity, double.infinity),
      painter: _WavePainter(level: _cur, phase: _phase, barCount: _barCount),
    );
  }
}

/// Draws a STABLE centred cluster of [barCount] rounded vertical bars, mirrored
/// around the horizontal mid-line. Each bar's height is a fixed centre-weighted
/// envelope scaled by [level], with a per-bar shimmer (also scaled by [level]),
/// so at rest the cluster is a still row of short equal bars and on speech it
/// swells in place — never scrolling.
class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.level,
    required this.phase,
    required this.barCount,
  });

  final double level;
  final double phase;
  final int barCount;

  /// Resting half-height as a fraction of the max — a short, calm baseline.
  static const double _idle = 0.14;

  @override
  void paint(Canvas canvas, Size size) {
    final int n = barCount;
    if (n == 0) return;
    const double barW = 6;
    const double gap = 9;
    final double stripW = n * barW + (n - 1) * gap;
    double x = (size.width - stripW) / 2 + barW / 2;
    final double midY = size.height / 2;
    final double maxHalf = size.height / 2;
    final double lvl = level.clamp(0.0, 1.0);
    final double centre = (n - 1) / 2;
    final Paint paint = Paint()
      ..color = AppColors.onBlue
      ..strokeCap = StrokeCap.round
      ..strokeWidth = barW;
    for (int i = 0; i < n; i++) {
      // Centre bar tallest, tapering to the edges.
      final double dist = centre == 0 ? 0 : (i - centre).abs() / centre;
      final double envelope = 1 - 0.5 * dist;
      // A gentle per-bar shimmer, but ONLY when there is a level to shimmer — at
      // rest this term is ~0 so the cluster is dead still.
      final double shimmer = 0.6 + 0.4 * math.sin(phase + i * 0.9);
      final double h = _idle + lvl * envelope * (0.55 + 0.45 * shimmer);
      final double half = (h * maxHalf).clamp(2.0, maxHalf);
      canvas.drawLine(Offset(x, midY - half), Offset(x, midY + half), paint);
      x += barW + gap;
    }
  }

  @override
  bool shouldRepaint(_WavePainter oldDelegate) =>
      oldDelegate.level != level || oldDelegate.phase != phase;
}
