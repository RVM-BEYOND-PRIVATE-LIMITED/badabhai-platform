import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MaxLengthEnforcement;
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../../voice/presentation/dictation_controller.dart';
import '../../voice/presentation/widgets/dictation_bar.dart';
import '../domain/feedback_category.dart';
import '../domain/feedback_limits.dart';
import '../domain/feedback_repository.dart';

/// The app-wide feedback page (opened by the floating "Feedback" button on every
/// non-auth screen).
///
/// DELIBERATELY LIGHT — the worker is never boxed in: an optional one-tap
/// category, then a big free-text box they can type OR SPEAK into. There is no
/// blocking full-screen spinner; only the Send button shows a brief busy state
/// while the post is in flight, and the text stays put so a failed send can be
/// retried without re-typing.
///
/// ── VOICE ──────────────────────────────────────────────────────────────────
/// This is the ONE surface whose entire job is "tell us what is wrong", and it
/// used to demand a paragraph of TYPING from workers who are not habituated to
/// apps. The mic runs the SAME [DictationController] the profiling chat uses —
/// tap to start, tap Stop to end — so a worker who has been through the
/// interview already knows the gesture. There is no second gesture vocabulary
/// here on purpose.
///
/// The recognised words land in the SAME text box, where the worker can fix them
/// before sending. No audio is uploaded, no `/voice/*` endpoint is called, no AI
/// spend is incurred, and no new permission or dependency is added — the mic
/// permission and the RecognitionService `<queries>` entry are already declared
/// for chat.
///
/// PRIVACY — WHERE THE AUDIO GOES, HONESTLY. [SpeechDictation] asks the platform
/// for `onDevice: true`, so where a local model exists the audio is transcribed
/// on the device and leaves nowhere. Where NO local model exists the plugin falls
/// back to the platform recogniser, which on most Android devices routes the
/// audio to GOOGLE's cloud speech service — i.e. voice CAN be shared with a third
/// party. `speech_dictation_impl.dart` documents this for chat; this is a SECOND
/// surface where a worker speaks, so it must stay disclosed to the worker and
/// declared on the Play Data Safety form. It is not "no network involved".
class FeedbackScreen extends StatefulWidget {
  const FeedbackScreen({super.key, this.fromRoute});

  /// The RAW route the worker was on when they tapped the floating Feedback
  /// button, handed over as go_router `extra`. Optional telemetry: it is
  /// normalized into a route PATTERN at the wire boundary (see
  /// [normalizeScreenContext]) and simply omitted when it cannot be.
  final String? fromRoute;

  @override
  State<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends State<FeedbackScreen> {
  final TextEditingController _controller = TextEditingController();

  /// Tap-to-talk, shared with the profiling chat. See the class doc.
  late final DictationController _dictation;

  /// Optional coarse tag — null until the worker taps one (and tapping the same
  /// chip again clears it). Never required.
  FeedbackCategory? _category;

  /// True only while a submit is in flight — drives the Send button's busy
  /// state, NOT a modal that blocks the field.
  bool _sending = false;

  bool _hasText = false;

  /// The last NON-TRANSIENT refusal, held on screen instead of thrown into a
  /// snackbar. Null when there is nothing the worker has to act on.
  ///
  /// A snackbar is the right shape for "that didn't work, try again" — it goes
  /// away because the next tap may well succeed. It is the WRONG shape for a
  /// refusal that will repeat identically until the worker changes something:
  /// they read it, it disappears, and the screen looks exactly as it did before.
  /// Those two (403 consent, 400 invalid) get a panel that stays put, and the
  /// consent one gets a button that resolves it.
  Failure? _blocked;

  FeedbackRepository get _repo => locator<FeedbackRepository>();

  @override
  void initState() {
    super.initState();
    _dictation = DictationController(onNotice: _showTransientNotice)
      ..addListener(_onDictationChanged);
    _controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    _dictation
      ..removeListener(_onDictationChanged)
      ..dispose();
    _controller
      ..removeListener(_onTextChanged)
      ..dispose();
    super.dispose();
  }

  /// The counter has to move on EVERY keystroke near the cap, so this rebuilds
  /// whenever the length changes — not only when the field crosses empty.
  void _onTextChanged() =>
      setState(() => _hasText = _controller.text.trim().isNotEmpty);

  /// The dictation controller flipped the waveform on/off — repaint the field row.
  void _onDictationChanged() {
    if (mounted) setState(() {});
  }

  /// Tap the MIC: start voice-to-text. Anything already typed is PRESERVED —
  /// recognised words append onto it — so the mic never eats a half-typed report.
  Future<void> _startDictation() =>
      _dictation.start(initialText: _controller.text);

  /// Tap Stop: end listening and drop the recognised words into the SAME box, so
  /// the worker reads them and can fix them before sending. Nothing is sent here.
  void _stopDictation() => _landDictation(_dictation.stop());

  /// Send from the listening row: end listening, land the words, and submit in
  /// one tap — the chat composer's second control, behaving the same way.
  void _sendFromDictation() {
    _landDictation(_dictation.stopForSend());
    unawaited(_submit());
  }

  /// Put recognised [text] in the field with the caret at the end, so the next
  /// thing the worker types continues their sentence.
  void _landDictation(String text) {
    if (text.isEmpty) return;
    // The client bound applies to spoken words exactly as it does to typed ones;
    // the field's own formatter never sees this assignment.
    final String bounded = text.length > kWorkerFeedbackMessageMax
        ? text.substring(0, kWorkerFeedbackMessageMax)
        : text;
    setState(() {
      _controller.value = TextEditingValue(
        text: bounded,
        selection: TextSelection.collapsed(offset: bounded.length),
      );
    });
  }

  Future<void> _submit() async {
    if (_sending) return;
    // A worker who SPOKE and then reached for the big Bhejein button must not
    // lose the words still sitting in the recogniser.
    if (_dictation.dictating) _landDictation(_dictation.stopForSend());
    final String text = _controller.text.trim();
    if (text.isEmpty) return;
    setState(() {
      _sending = true;
      _blocked = null; // a fresh attempt clears the last refusal
    });
    try {
      await _repo.submit(
        message: text,
        category: _category,
        screen: widget.fromRoute,
      );
      if (!mounted) return;
      _dictation.discard();
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(const SnackBar(
          content: Text('Shukriya, aapka feedback mil gaya.'),
        ));
      context.pop();
    } catch (error) {
      if (!mounted) return;
      final Failure failure = mapError(error);
      // A refusal the worker must ACT on stays on screen; a blip that may pass on
      // its own stays a snackbar. See [_blocked].
      final bool actionable =
          failure is ConsentRequiredFailure || failure is InvalidRequestFailure;
      setState(() {
        _sending = false;
        _blocked = actionable ? failure : null;
      });
      if (!actionable) {
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(
              SnackBar(content: Text(failureReason(failure).reason)));
      }
    }
  }

  /// A transient, honest snackbar for the dictation failure paths (mic denied, no
  /// recogniser). Typing is never blocked by one.
  void _showTransientNotice(String message) {
    if (!mounted || message.trim().isEmpty) return;
    // Plain Text on purpose: an AppTypography style defaults to a DARK colour,
    // invisible on the SnackBar's dark surface (the "blank toast").
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
      );
  }

  /// Characters still available before the server's bound.
  int get _remaining => kWorkerFeedbackMessageMax - _controller.text.length;

  @override
  Widget build(BuildContext context) {
    // While the mic is live the bottom CTA stays enabled even with an empty box:
    // the words are in the recogniser, not the field yet, and [_submit] lands
    // them first. A disabled button there would be the same dead control this
    // change exists to remove.
    final bool canSend = (_hasText || _dictation.dictating) && !_sending;
    return BbScaffold(
      appBar: const BbAppBar(title: 'Feedback'),
      bottomBar: BbButton(
        label: _sending ? 'Bhej rahe hain…' : 'Bhejein',
        block: true,
        loading: _sending,
        iconRight: Icons.send_rounded,
        onPressed: canSend ? _submit : null,
      ),
      body: ListView(
        children: <Widget>[
          const SizedBox(height: AppSpacing.s2),
          Text(
            'Aapko kya accha laga, ya kya theek karna chahiye? Khul kar likhein.',
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            'Likhna mushkil ho to mic dabakar boliye — aapki baat yahin likhi jayegi.',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          Text('KIS BAARE MEIN? (OPTIONAL)',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final FeedbackCategory c in FeedbackCategory.values)
                BbChip(
                  label: c.label,
                  selected: _category == c,
                  // Optional + toggleable: tapping the selected chip clears it,
                  // so the worker is never forced into a bucket.
                  onTap: () => setState(
                      () => _category = _category == c ? null : c),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.s5),
          Text('AAPKI BAAT',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          TextField(
            controller: _controller,
            // Free-form: multi-line and it grows as they type. The ONLY rule is
            // the server's own ceiling (#1013) — enforced here so a worker
            // physically cannot type their way into a 400 they can never clear.
            minLines: 5,
            maxLines: null,
            maxLength: kWorkerFeedbackMessageMax,
            maxLengthEnforcement: MaxLengthEnforcement.enforced,
            // Suppress Material's own "123/4000" counter: it would sit under an
            // EMPTY box announcing a quota. Ours appears only near the ceiling.
            buildCounter: (BuildContext context,
                    {required int currentLength,
                    required bool isFocused,
                    required int? maxLength}) =>
                null,
            keyboardType: TextInputType.multiline,
            textCapitalization: TextCapitalization.sentences,
            autofocus: true,
            style: AppTypography.body(size: AppTypography.sizeMd),
            decoration: InputDecoration(
              hintText: 'Yahan likhein…',
              filled: true,
              fillColor: AppColors.paper,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.s3,
                vertical: AppSpacing.s3,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadii.sm),
                borderSide: const BorderSide(color: AppColors.borderSubtle),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadii.sm),
                borderSide: const BorderSide(color: AppColors.blue, width: 1.5),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          _voiceRow(),
          if (_blocked != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            _blockedPanel(_blocked!),
          ],
          const SizedBox(height: AppSpacing.s4),
        ],
      ),
    );
  }

  /// The row under the box: the mic (idle) or the full-width listening bar, plus
  /// the character counter once the ceiling is close.
  Widget _voiceRow() {
    if (_dictation.listening) {
      return DictationBar(
        level: _dictation.level,
        waveKey: const ValueKey<String>('feedbackVoiceWave'),
        onStop: _stopDictation,
        onSend: _sendFromDictation,
      );
    }
    return Row(
      children: <Widget>[
        TextButton.icon(
          onPressed: _startDictation,
          icon: const Icon(Icons.mic, size: 20, color: AppColors.blue),
          label: Text(
            // The SAME words the chat composer's mic uses, so the two surfaces
            // read as one feature.
            'Bolkar likhein',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.blue,
            ),
          ),
        ),
        const Spacer(),
        if (_remaining <= kFeedbackCounterShowsWithin) _counter(),
      ],
    );
  }

  /// Characters left, shown ONLY near the ceiling — a warning, not a target.
  Widget _counter() {
    final bool full = _remaining <= 0;
    return Text(
      full
          ? 'Itna hi likh sakte hain ($kWorkerFeedbackMessageMax akshar).'
          : '$_remaining akshar bache',
      style: AppTypography.body(
        size: AppTypography.sizeSm,
        color: full ? AppColors.danger : AppColors.textMuted,
      ),
    );
  }

  /// The persistent panel for a refusal the worker has to act on.
  ///
  /// Consent (403) is the one that had NOTHING on the screen to act on: the
  /// worker typed a paragraph, tapped Bhejein, read "consent dena hoga" in a
  /// snackbar, and was left on a screen with no consent anywhere on it. It now
  /// carries the way out.
  Widget _blockedPanel(Failure failure) {
    final bool consent = failure is ConsentRequiredFailure;
    final ({IconData icon, String reason}) shown = failureReason(failure);
    return Container(
      decoration: BoxDecoration(
        color: consent ? AppColors.infoTint : AppColors.dangerTint,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      padding: const EdgeInsets.all(AppSpacing.s3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(shown.icon,
                  size: 20,
                  color: consent ? AppColors.blue : AppColors.danger),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  shown.reason,
                  style: AppTypography.body(size: AppTypography.sizeSm),
                ),
              ),
            ],
          ),
          if (consent) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Text(
              // Honest about the cost: consent replaces this screen, so the text
              // in the box does NOT survive it. Nothing they typed is stored
              // anywhere before they have consented, and it must not be.
              'Aapki baat abhi nahi bheji gayi. Consent ke baad Feedback dobara '
              'kholkar bhejein.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            BbButton(
              label: 'Consent dein',
              size: BbButtonSize.md,
              variant: BbButtonVariant.navy,
              iconRight: Icons.arrow_forward_rounded,
              onPressed: () => context.go(Routes.consent),
            ),
          ],
        ],
      ),
    );
  }
}
