import 'dart:async';
import 'dart:typed_data';

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
import '../../chat/presentation/widgets/voice_wave_visualizer.dart';
import '../../consent/presentation/consent_screen.dart';
import '../../voice/presentation/dictation_controller.dart';
import '../domain/feedback_attachment_uploader.dart';
import '../domain/feedback_category.dart';
import '../domain/feedback_image_picker.dart';
import '../domain/feedback_limits.dart';
import '../domain/feedback_repository.dart';

/// Visible caption on the IDLE voice control — the mic that lives INSIDE the
/// message box, at its trailing edge.
const String kFeedbackSpeakLabel = 'Bolein';

/// Visible caption on the same control while the recogniser is running.
const String kFeedbackStopLabel = 'Rokein';

/// Accessible name of the idle control. Contains the visible caption (a screen
/// reader and a sighted worker must be told the same thing), then says what it
/// does for someone who cannot read the mic glyph.
const String kFeedbackSpeakSemantics = 'Bolein — bolkar likhein';

/// Accessible name of the control while listening.
const String kFeedbackStopSemantics = 'Rokein — sunna band karein';

/// Visible AND spoken state of the listening strip. It is a live region: the
/// most important state on this screen must reach a screen reader the moment it
/// changes, not only when the worker happens to swipe onto the waveform.
const String kFeedbackListeningLabel = 'Sun rahe hain…';

/// The ONE voice control on the screen: mic when idle, stop while listening.
/// Public so tests can assert it is BUILT AND TAPPABLE on a real budget-phone
/// viewport, which is the whole reason it moved into the field.
const Key kFeedbackVoiceControlKey = ValueKey<String>('feedbackVoiceControl');

/// The waveform slot in the listening strip.
const Key kFeedbackVoiceWaveKey = ValueKey<String>('feedbackVoiceWave');

/// The "attach a photo" control. Public so a test can assert it is present, and
/// GONE once the worker has picked [kFeedbackMaxImages].
const Key kFeedbackAddImageKey = ValueKey<String>('feedbackAddImage');

/// The horizontal strip that holds the picked-image thumbnails.
const Key kFeedbackImageStripKey = ValueKey<String>('feedbackImageStrip');

/// The remove (X) control on the thumbnail at [index].
Key feedbackRemoveImageKey(int index) =>
    ValueKey<String>('feedbackRemoveImage_$index');

/// Visible label on the add-photo control. Points at the ACTION in words a worker
/// who cannot read the glyph still understands.
const String kFeedbackAddImageLabel = 'Photo jodein';

/// Shown after a submit whose text sent but whose image(s) did not — honest, not
/// a silent drop. The feedback DID go; only the photo did not attach.
const String kFeedbackPhotoDroppedNotice =
    'Aapka feedback bhej diya. Photo attach nahi ho payi.';

/// The voice control's WIDTH, and its MINIMUM height — therefore also the column
/// the message box reserves for it. Comfortably past the 48dp worker touch floor
/// ([AppSpacing.tap]) because it holds an icon AND its caption.
///
/// A floor on the height, not a fixed square: the caption is real text and grows
/// with the worker's text-size setting, so a hard box made the control overflow
/// itself at large type. The width stays exactly this, because the field's
/// `contentPadding` reserves it — widen the control and the worker's own text
/// starts running underneath it.
const double _kVoiceControlSide = 60;

/// Width the listening strip RESERVES for the waveform. Fixed, so the strip's
/// text can never squeeze the "the mic is live" cue out of existence — which is
/// what an [Expanded] waveform beside an unflexed label did at large text sizes.
const double _kVoiceWaveWidth = 72;

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
/// WHERE THE MIC IS, AND WHY IT MOVED (owner ruling). It sits INSIDE the message
/// box at the trailing edge — the chat composer's slot — and the SAME control
/// becomes Stop while the recogniser runs. Two reasons, in order:
///
///  1. A worker who finished the profiling interview already knows that control:
///     same place, same gesture, same meaning. Inventing a second interaction
///     vocabulary for the same job is the expensive kind of inconsistency.
///  2. It was MEASURED unreachable where it used to live. Under the box, in a
///     lazy [ListView], on a 360x640dp budget Android viewport with the keyboard
///     up, the mic row was 100dp past the fold and the list never BUILT it — so
///     on the hardware this product targets the mic did not exist. The screen's
///     own test had to ask for a 900x1900 canvas to see it, which is the defect
///     written into the test setup. The control is now anchored to the TOP of the
///     box, so it is on screen whenever the box's first line is.
///
/// The listening state gets its own strip directly ABOVE the box (waveform +
/// "Sun rahe hain…", a semantics live region), because the box itself keeps
/// showing what the worker already wrote.
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

  /// The character counter is currently on screen (within
  /// [kFeedbackCounterShowsWithin] of the cap) — see [_onTextChanged].
  bool _nearCap = false;

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

  /// The images the worker attached, resized to JPEG bytes and held IN MEMORY
  /// only (never written to disk here) until submit uploads them. Capped at
  /// [kFeedbackMaxImages]; the add control disappears at the cap.
  final List<Uint8List> _images = <Uint8List>[];

  FeedbackRepository get _repo => locator<FeedbackRepository>();

  /// Resolved lazily so the plugin-free widget-test graph — which registers only
  /// the repository — is untouched unless the worker actually picks/uploads.
  FeedbackImagePicker get _picker => locator<FeedbackImagePicker>();
  FeedbackAttachmentUploader get _uploader =>
      locator<FeedbackAttachmentUploader>();

  /// Drives the ListView, so a refusal panel appended at the bottom can be
  /// scrolled INTO VIEW instead of being created below the fold.
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _dictation = DictationController(
      onNotice: _showTransientNotice,
      // Backgrounding the app, or another surface taking the shared recogniser,
      // ends dictation with no Stop button left to tap — land the words anyway.
      onInterrupted: _landDictation,
    )..addListener(_onDictationChanged);
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
    _scroll.dispose();
    super.dispose();
  }

  /// Rebuild only when something VISIBLE changes: the send button crossing
  /// empty, or the counter — which is on screen only near the cap.
  ///
  /// An unconditional `setState` here rebuilt the whole ListView (the unbounded
  /// TextField and the chip Wrap included) on every keystroke, to drive a
  /// counter that is invisible for the first 3,700 characters. On the low-end
  /// devices this product targets that is per-keystroke jank on the one screen
  /// whose entire job is accepting a paragraph.
  void _onTextChanged() {
    final bool has = _controller.text.trim().isNotEmpty;
    final bool nearCap = _remaining <= kFeedbackCounterShowsWithin;
    if (has != _hasText || nearCap || _nearCap) {
      setState(() {
        _hasText = has;
        _nearCap = nearCap;
      });
    }
  }

  /// The dictation controller flipped the waveform on/off — repaint the field row.
  void _onDictationChanged() {
    if (mounted) setState(() {});
  }

  /// Tap the MIC: start voice-to-text. Anything already typed is PRESERVED —
  /// recognised words append onto it — so the mic never eats a half-typed report.
  ///
  /// The keyboard is dismissed and the box goes read-only for the duration (see
  /// the field's `readOnly`), because the recognised block REPLACES the field's
  /// contents when it lands: anything typed while the mic ran would be destroyed
  /// by that assignment, silently.
  Future<void> _startDictation() {
    if (_sending) return Future<void>.value();
    FocusScope.of(context).unfocus();
    return _dictation.start(initialText: _controller.text);
  }

  /// Tap Stop: end listening and drop the recognised words into the SAME box, so
  /// the worker reads them and can fix them before sending. Nothing is sent here.
  void _stopDictation() {
    final String heard = _dictation.stop();
    if (heard.isEmpty) {
      // The mic ran and produced NOTHING (too quiet, too loud a workshop, no
      // local model). Saying so is the whole point of this screen: silently
      // dropping the waveform reads as "the app is broken".
      _showTransientNotice(kVoiceToTextUnavailable);
      return;
    }
    _landDictation(heard);
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
    if (text.isEmpty) {
      // Bhejein stays enabled while the mic is live (the words are in the
      // recogniser, not the field), so it is reachable with nothing to send.
      // Say so rather than absorbing the tap.
      _showTransientNotice(kVoiceToTextUnavailable);
      return;
    }
    setState(() {
      _sending = true;
      _blocked = null; // a fresh attempt clears the last refusal
    });
    try {
      // Upload the images FIRST and best-effort: a per-image failure drops that
      // image but never blocks the text (see [_uploadAttachments]). The text is
      // the job; the photos are the "other option that makes it better".
      final List<String> paths = await _uploadAttachments();
      await _sendFeedback(text, paths);
      if (!mounted) return;
      _dictation.discard();
      // Honest when a photo did not make it: the feedback DID send, so this is a
      // partial-success notice, not a failure. Only when the worker actually
      // attached something and NONE of it uploaded.
      final bool photosDropped = _images.isNotEmpty && paths.isEmpty;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(
          content: Text(photosDropped
              ? kFeedbackPhotoDroppedNotice
              : 'Shukriya, aapka feedback mil gaya.'),
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
      // The panel is the LAST child of the list, below a box that has grown to
      // fit the worker's message — for anything past a few lines it is created
      // entirely off screen. Since the snackbar is deliberately suppressed for
      // these two, not scrolling to it means the worker taps Bhejein and NOTHING
      // visibly happens: the exact dead end this screen exists to remove.
      if (actionable) _revealBlockedPanel();
      if (!actionable) {
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(
              SnackBar(content: Text(failureReason(failure).reason)));
      }
    }
  }

  /// Uploads each attached image best-effort, returning the storage_paths that
  /// SUCCEEDED. A per-image failure (mint 404 = endpoint not deployed, 503 =
  /// bucket dormant, or a PUT failure) drops THAT image and is swallowed — the
  /// worker's text must always send, so an image is never allowed to throw out of
  /// here. Sequential on purpose: at most three images, on a metered 2G uplink,
  /// where three parallel PUTs would fight for the same thin pipe.
  Future<List<String>> _uploadAttachments() async {
    if (_images.isEmpty) return const <String>[];
    final List<String> paths = <String>[];
    for (final Uint8List bytes in _images) {
      try {
        paths.add(await _uploader.upload(bytes));
      } catch (_) {
        // Dropped. A failed image never costs the worker their feedback.
      }
    }
    return paths;
  }

  /// Posts the feedback. Passes `attachmentPaths` ONLY when something uploaded, so
  /// a no-image (or all-dropped) submission is byte-identical to a released build
  /// — the repository/API then omit the key entirely.
  Future<void> _sendFeedback(String text, List<String> paths) {
    return paths.isEmpty
        ? _repo.submit(
            message: text, category: _category, screen: widget.fromRoute)
        : _repo.submit(
            message: text,
            category: _category,
            screen: widget.fromRoute,
            attachmentPaths: paths,
          );
  }

  /// Open the Camera/Gallery chooser, pick + resize one image, and append it.
  ///
  /// Guarded against the cap and an in-flight send. A cancelled pick or a picker
  /// failure simply adds nothing (see [FeedbackImagePicker.pick]) — never a scary
  /// error, because it is not the worker's fault.
  Future<void> _addImage() async {
    if (_sending || _images.length >= kFeedbackMaxImages) return;
    final FeedbackImageSource? source = await _chooseImageSource();
    if (source == null || !mounted) return;
    final Uint8List? bytes = await _picker.pick(source);
    if (bytes == null || !mounted) return;
    setState(() {
      // Re-check the cap: an await gap could have let a second pick land.
      if (_images.length < kFeedbackMaxImages) _images.add(bytes);
    });
  }

  /// The Camera / Gallery source chooser — the profile-photo sheet's shape, minus
  /// the "remove" row (there is a per-thumbnail X for that). Returns null when
  /// dismissed.
  Future<FeedbackImageSource?> _chooseImageSource() {
    return showModalBottomSheet<FeedbackImageSource>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Camera'),
              onTap: () => Navigator.of(sheetContext)
                  .pop(FeedbackImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Gallery'),
              onTap: () => Navigator.of(sheetContext)
                  .pop(FeedbackImageSource.gallery),
            ),
          ],
        ),
      ),
    );
  }

  void _removeImage(int index) {
    if (_sending || index < 0 || index >= _images.length) return;
    setState(() => _images.removeAt(index));
  }

  /// Bring the refusal panel on screen after the frame that creates it. It is the
  /// last thing in the list, so the bottom is where it is.
  void _revealBlockedPanel() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      unawaited(_scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      ));
    });
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
      // ORDER IS LOAD-BEARING. The box (and with it the mic anchored to its top
      // corner) comes BEFORE the optional category chips, so that on a 360x640dp
      // budget viewport with the keyboard up — about 284dp of body — the voice
      // control is on screen without scrolling. The chips are optional and the
      // hint is prose; the box is the job, so the box goes first.
      //
      // NOT a ListView. A lazy list only BUILDS what is near the viewport, and
      // the prose above the box grows with the worker's text-size setting: at
      // the accessibility scales this audience actually uses (measured: 2.0 on
      // 360x640 with the keyboard up, and 2.0 on a 320x480 handset) the box fell
      // past the cache extent and the mic was never built at all — not off
      // screen, ABSENT, the exact defect this screen moved the mic to fix. There
      // are eight children here and one of them is the job, so there is nothing
      // to virtualise and everything to lose: this scroller builds them all.
      body: SingleChildScrollView(
        controller: _scroll,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const SizedBox(height: AppSpacing.s2),
            Text(
              'Aapko kya accha laga, ya kya theek karna chahiye? Khul kar '
              'likhein.',
              style: AppTypography.body(
                size: AppTypography.sizeMd,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            Text('AAPKI BAAT',
                style: AppTypography.eyebrow(color: AppColors.textMuted)),
            const SizedBox(height: AppSpacing.s2),
            _messageBox(),
            const SizedBox(height: AppSpacing.s2),
            if (_remaining <= kFeedbackCounterShowsWithin)
              Align(alignment: Alignment.centerRight, child: _counter()),
            Text(
              // Points at the control by the word printed ON it, because "mic"
              // is a glyph a worker may not read and "upar" is where it now is.
              'Likhna mushkil ho to box ke "$kFeedbackSpeakLabel" par tap karke '
              'boliye — aapki baat yahin likhi jayegi.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
            const SizedBox(height: AppSpacing.s5),
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
                    // Optional + toggleable: tapping the selected chip clears
                    // it, so the worker is never forced into a bucket.
                    onTap: () => setState(
                        () => _category = _category == c ? null : c),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.s5),
            _photoSection(),
            if (_blocked != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s3),
              _blockedPanel(_blocked!),
            ],
            const SizedBox(height: AppSpacing.s4),
          ],
        ),
      ),
    );
  }

  /// The message box: the listening strip (only while the recogniser runs) over
  /// the text field, with the ONE voice control pinned inside the field at its
  /// TOP-trailing corner.
  ///
  /// TOP, not centre: the control's reachability then depends only on the box's
  /// FIRST line being on screen. Centring it on a five-line box (the chat
  /// composer's look, on a field four times the height) put it back within a few
  /// dp of the keyboard line on a 360x640 device — the defect this moved to fix.
  Widget _messageBox() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (_dictation.listening) ...<Widget>[
          _listeningStrip(),
          const SizedBox(height: AppSpacing.s2),
        ],
        Stack(
          children: <Widget>[
            _messageField(),
            // Non-positioned child above sizes the Stack, so this rides the
            // field's own top-right corner at any height it grows to.
            Positioned(top: 1, right: 1, child: _voiceControl()),
          ],
        ),
      ],
    );
  }

  Widget _messageField() {
    return TextField(
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
      // While the mic runs the box is READ-ONLY. The recognised block is
      // assigned over the field wholesale when it lands, built on the text
      // snapshotted at the moment the mic started — so anything typed in
      // between would be destroyed without a word. The chat composer never
      // hits this because it SWAPS the field out for the waveform; this
      // screen keeps the field visible (the worker wants to see what they
      // already wrote), so it has to stop accepting edits instead.
      readOnly: _dictation.listening,
      style: AppTypography.body(size: AppTypography.sizeMd),
      decoration: InputDecoration(
        hintText: 'Yahan likhein…',
        filled: true,
        fillColor: AppColors.paper,
        // The trailing inset RESERVES the voice control's column, so no line of
        // the worker's text ever runs underneath it.
        contentPadding: const EdgeInsets.fromLTRB(
          AppSpacing.s3,
          AppSpacing.s3,
          _kVoiceControlSide + AppSpacing.s2,
          AppSpacing.s3,
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
    );
  }

  /// The ONE voice control, inside the box at its trailing edge: MIC when idle,
  /// STOP while listening. Same slot, same tap, both states — the chat
  /// composer's control, so a worker who finished the interview already knows it.
  ///
  /// ACCESSIBILITY: it carries a VISIBLE Hinglish caption and an explicit
  /// accessible name that contains that caption. A tooltip is not a label — it
  /// needs a long-press to appear, which a worker who cannot read a mic glyph has
  /// no reason to try. [Semantics.excludeSemantics] collapses the icon and the
  /// caption into that one node (so it is announced once, not three times) and
  /// [Semantics.onTap] re-publishes the action the excluded [InkWell] would have.
  Widget _voiceControl() {
    final bool live = _dictation.listening;
    final VoidCallback onTap = live ? _stopDictation : _startDictation;
    return Semantics(
      container: true,
      button: true,
      label: live ? kFeedbackStopSemantics : kFeedbackSpeakSemantics,
      excludeSemantics: true,
      onTap: onTap,
      // Its OWN transparent Material: the ripple otherwise renders on the
      // Scaffold's material, underneath the field's own fill, and the control
      // gives no press feedback at all.
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: kFeedbackVoiceControlKey,
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.sm),
          // The side is a FLOOR on the height, not a fixed box. The caption is
          // real text and grows with the worker's text-size setting: at 2.0 the
          // icon + caption measured 62dp inside a hard 60dp square and the
          // control painted an overflow stripe over itself. The WIDTH stays
          // pinned, because it is the column the field's `contentPadding`
          // reserves — grow that and the worker's text runs under the mic.
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minWidth: _kVoiceControlSide,
              maxWidth: _kVoiceControlSide,
              minHeight: _kVoiceControlSide,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(
                  live ? Icons.stop_circle_rounded : Icons.mic,
                  size: 24,
                  // The stop takes the chat composer's stop colour, not crimson:
                  // ending dictation is not a destructive action, and this design
                  // system reserves danger for ones that are.
                  color: live ? AppColors.textSecondary : AppColors.blue,
                ),
                const SizedBox(height: 2),
                Text(
                  live ? kFeedbackStopLabel : kFeedbackSpeakLabel,
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    weight: FontWeight.w700,
                    color: live ? AppColors.textSecondary : AppColors.blue,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The listening cue, directly above the box: the live waveform plus the words
  /// "Sun rahe hain…". It sits ABOVE rather than below because the box grows with
  /// the worker's report — anything under it walks off the bottom of a small
  /// screen, which is exactly how the mic went missing in the first place.
  ///
  /// One semantics node, [Semantics.liveRegion], so a screen reader is TOLD the
  /// mic went live instead of having to find a painted waveform.
  Widget _listeningStrip() {
    return Semantics(
      container: true,
      liveRegion: true,
      label: kFeedbackListeningLabel,
      excludeSemantics: true,
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.infoTint,
          borderRadius: BorderRadius.circular(AppRadii.sm),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.s1,
        ),
        child: Row(
          children: <Widget>[
            // The LABEL flexes and the WAVE's column is reserved, not the other
            // way round. With the label non-flexible it took the whole row as
            // soon as the worker's text-size setting grew it: measured at 1.5x
            // on 360dp the waveform was laid out 0dp wide and the row painted an
            // overflow stripe instead — the one cue that says the mic is live,
            // gone for exactly the workers most likely to have turned text up.
            Expanded(
              child: Text(
                kFeedbackListeningLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: AppColors.blue,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.s3),
            SizedBox(
              key: kFeedbackVoiceWaveKey,
              width: _kVoiceWaveWidth,
              // A SLIM strip on purpose. It is a cue, not a control (the stop
              // is the box's own trailing button), and every dp it takes pushes
              // that stop closer to the fold on a 640dp-tall phone.
              height: 28,
              child: VoiceWaveVisualizer(level: _dictation.level),
            ),
          ],
        ),
      ),
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

  /// The OPTIONAL "attach a photo" block: a one-line prompt, the picked-image
  /// thumbnails, and the add control — which DISAPPEARS at [kFeedbackMaxImages] so
  /// the worker cannot pick a fourth the server would reject.
  Widget _photoSection() {
    final bool canAdd = _images.length < kFeedbackMaxImages;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text('PHOTO (OPTIONAL)',
            style: AppTypography.eyebrow(color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s1),
        Text(
          'Dikkat ki photo laga sakte hain — screenshot, machine, ya parchi. '
          '$kFeedbackMaxImages tak.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
          ),
        ),
        if (_images.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          _thumbnailStrip(),
        ],
        if (canAdd) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          _addPhotoButton(),
        ],
      ],
    );
  }

  /// The add-photo affordance. A bordered, icon-led control at the 48dp worker
  /// touch floor, labelled in words (not just a glyph). Full-width with an
  /// [Expanded] label so it wraps instead of overflowing at the large text sizes
  /// this audience uses. Disabled while a send is in flight so the picked set
  /// cannot change under an upload.
  Widget _addPhotoButton() {
    return Material(
      type: MaterialType.transparency,
      child: InkWell(
        key: kFeedbackAddImageKey,
        onTap: _sending ? null : _addImage,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: Container(
          constraints: const BoxConstraints(minHeight: AppSpacing.tap),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.s3,
            vertical: AppSpacing.s2,
          ),
          decoration: BoxDecoration(
            color: AppColors.paper,
            borderRadius: BorderRadius.circular(AppRadii.sm),
            border: Border.all(color: AppColors.borderSubtle),
          ),
          child: Row(
            children: <Widget>[
              const Icon(Icons.add_a_photo_outlined,
                  size: 20, color: AppColors.blue),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  kFeedbackAddImageLabel,
                  style: AppTypography.body(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                    color: AppColors.blue,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The horizontal thumbnail strip. One [_thumbnail] per picked image; scrolls
  /// when three tiles overrun a narrow screen.
  Widget _thumbnailStrip() {
    const double side = 96;
    return SizedBox(
      key: kFeedbackImageStripKey,
      height: side,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: _images.length,
        separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.s2),
        itemBuilder: (BuildContext c, int i) => _thumbnail(i, side),
      ),
    );
  }

  /// One image tile ([Image.memory] — the bytes never touch disk here) with a
  /// remove (X) whose TAP area clears the 48dp floor even though the glyph is
  /// small, so a wrong pick is one tap to undo.
  Widget _thumbnail(int index, double side) {
    return SizedBox(
      width: side,
      height: side,
      child: Stack(
        children: <Widget>[
          Positioned.fill(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(AppRadii.sm),
              child: Image.memory(
                _images[index],
                fit: BoxFit.cover,
                gaplessPlayback: true,
                // A corrupt/undecodable pick must never paint a red error box on
                // the one screen whose job is reporting problems — neutral tile.
                errorBuilder: (_, __, ___) => Container(
                  color: AppColors.surfaceSunken,
                  child: const Icon(Icons.broken_image_outlined,
                      color: AppColors.textMuted),
                ),
              ),
            ),
          ),
          Positioned(
            top: 0,
            right: 0,
            child: Semantics(
              button: true,
              label: 'Photo hatayein',
              child: InkWell(
                key: feedbackRemoveImageKey(index),
                onTap: _sending ? null : () => _removeImage(index),
                customBorder: const CircleBorder(),
                // A 48dp hit area (the worker touch floor) around a compact glyph;
                // it sits inside the 96dp tile, so it never overlaps a neighbour.
                child: const SizedBox(
                  width: AppSpacing.tap,
                  height: AppSpacing.tap,
                  child: Center(
                    child: _RemoveBadge(),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Open consent as a ROUND TRIP, not a one-way door.
  ///
  /// `context.go(Routes.consent)` REPLACED the stack: the worker landed on
  /// consent with no back button, and accepting carried them on into the name
  /// step and the profiling interview — an onboarding flow an onboarded worker
  /// had already completed — with no way back to the report they were writing.
  /// Two dead ends bolted onto the screen that exists to remove dead ends.
  ///
  /// So it is PUSHED, with [ConsentReturnIntent] as `extra`. That marker is what
  /// tells [ConsentScreen] this is a recovery and not the first onboarding step:
  /// it shows a back arrow (decline and return) and pops on success instead of
  /// walking on to `/name`. Either way the worker comes back HERE, with their
  /// paragraph still in the box.
  ///
  /// Safe against the router: `_authRedirect` only forces `/consent` when consent
  /// is a definitive `false`, and in that state the Feedback button is hidden and
  /// this screen is unreachable — so this push is never swallowed or bounced.
  Future<void> _openConsent() async {
    final bool? accepted = await context.push<bool>(
      Routes.consent,
      extra: const ConsentReturnIntent(),
    );
    if (!mounted) return;
    // Back from consent either way: the refusal panel describes an attempt that
    // is now over, so clear it and let them press Bhejein again. Deliberately NOT
    // an automatic re-send — posting a worker's words the instant they tick a
    // consent box is exactly the tap that should stay theirs.
    setState(() => _blocked = null);
    if (accepted == true) {
      _showTransientNotice('Consent ho gaya. Ab "Bhejein" dabayein.');
    }
  }

  /// The persistent panel for a refusal the worker has to act on.
  ///
  /// Consent (403) is the one that had NOTHING on the screen to act on: the
  /// worker typed a paragraph, tapped Bhejein, read "consent dena hoga" in a
  /// snackbar, and was left on a screen with no consent anywhere on it. It now
  /// carries the way out — see [_openConsent] for why that way out is a push.
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
              // Honest, and now TRUE: consent is PUSHED over this screen, so the
              // box — and the paragraph in it — is still here when they come
              // back. Nothing they typed is stored anywhere before they have
              // consented, and it must not be; it simply stays on the device.
              'Aapki baat abhi nahi bheji gayi. Consent dene ke baad wapas aakar '
              'Bhejein dabayein — aapki baat yahin rahegi.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            BbButton(
              label: 'Consent dein',
              // lg (52dp), NOT md. `BbButtonSize.md` is 44dp, under the 48dp
              // worker touch floor this design system states in its own spacing
              // tokens ("touch targets are sacred"). The TOKEN is deliberately
              // left alone — `controlMd` is mirrored in payer-app and in the
              // design system, so widening it here would fork the DS to fix one
              // button. This call site simply asks for a size that clears the
              // floor.
              size: BbButtonSize.lg,
              variant: BbButtonVariant.navy,
              iconRight: Icons.arrow_forward_rounded,
              onPressed: _openConsent,
            ),
          ],
        ],
      ),
    );
  }
}

/// The small dark circular X painted at the centre of a thumbnail's 48dp remove
/// hit area. Split out as a `const` widget so the [Image.memory] tile above it
/// stays a `const`-friendly, cheap-to-rebuild subtree.
class _RemoveBadge extends StatelessWidget {
  const _RemoveBadge();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 26,
      height: 26,
      decoration: const BoxDecoration(
        color: AppColors.ink900,
        shape: BoxShape.circle,
      ),
      child: const Icon(Icons.close, size: 16, color: AppColors.paper),
    );
  }
}
