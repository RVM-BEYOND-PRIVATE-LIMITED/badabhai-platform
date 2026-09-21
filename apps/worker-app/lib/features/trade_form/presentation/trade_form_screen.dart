import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/onboarding/form_flow_parts.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/questionnaire_bottom_bar.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../../voice/domain/speech_reader.dart';
import '../domain/trade_form_models.dart';
import 'cubit/trade_form_cubit.dart';
import 'widgets/trade_form_employment_page.dart';
import 'widgets/trade_form_preferences_page.dart';
import 'widgets/trade_form_qualifications_page.dart';
import 'widgets/trade_form_question_body.dart';
import 'widgets/trade_form_topics.dart';

// ---- Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart. ----
const String _kLoading = 'Taiyaari ho rahi hai…';
const String _kRetry = 'Dobara koshish karein';
const String _kNext = 'Aage badhein';
const String _kFinish = 'Ho gaya';
const String _kNoFormTitle = 'Yahan abhi bharne ke liye kuch nahi hai';
const String _kNoFormBody =
    'Aapke liye koi form taiyaar nahi kiya gaya hai. Baad mein dobara dekhein.';
const String _kNoFormHeader = 'Form';

/// The header's STEP line — the worker's position in the WHOLE walk, built
/// from exactly the numbers the progress strip already renders (see the
/// `FormProgressStrip` call site's #1384 doc), then the step's category
/// ("Step 5 of 6 • Tooling & fixtures"). Not a new counter.
String _stepBadge(int position, int total, String category) =>
    category.isEmpty
        ? 'Step $position of $total'
        : 'Step $position of $total • $category';

/// Whether the keyboard has left too little room for this screen's full
/// chrome — the navy header, the STEP line AND the progress strip — above the
/// docked bar.
///
/// MEASURED, not guessed: on a 320x568 handset at a 200% system font with the
/// keyboard up, the form-flow header (223dp), the progress strip (67dp) and
/// the docked bar (81dp) come to 371dp of chrome in the 308dp the keyboard
/// leaves. The scrollable question then gets 0dp and the docked bar overflows
/// the column — a red error band under the worker's thumb. So while the
/// keyboard crowds the screen the chrome sheds the two parts that are pure
/// context (the STEP line and the strip, which say the same thing twice) and
/// keeps the parts the worker is using: the question, the field and the
/// action. Both come straight back when the keyboard closes.
///
/// CALL THIS ABOVE THE SCAFFOLD — from the widget that BUILDS it, as both
/// callers do. A [Scaffold] with the default `resizeToAvoidBottomInset`
/// consumes `viewInsets.bottom` and hands its body a shorter box with the
/// inset zeroed, so the same question asked inside the body always answers 0.
///
/// [MediaQuery] rather than `View.of`, deliberately: reading the window gives
/// the right number but subscribes to nothing, so the build that read it never
/// re-runs when the keyboard opens — the chrome would only collapse if some
/// other rebuild happened to follow. `viewInsetsOf`/`sizeOf` register the two
/// dependencies, so the keyboard appearing IS the rebuild.
///
/// Duplicated verbatim in `features/finishing/presentation/finishing_screen.dart`,
/// whose wizard has the identical header + strip + docked-bar column; keep
/// both in sync if this ever changes.
bool _keyboardCrowdsChrome(BuildContext context) {
  final double keyboard = MediaQuery.viewInsetsOf(context).bottom;
  if (keyboard <= 0) return false;
  return MediaQuery.sizeOf(context).height - keyboard < 480;
}

/// Whether the HEADER should fall back to the kit's collapsed drawing.
///
/// A superset of [_keyboardCrowdsChrome]: the keyboard is one way to run out of
/// vertical space, a 320x568 handset at a 2.0 system font is another. There the
/// approved form-flow header measured 266dp and the strip another 65 — 58% of
/// the screen — so the page opened with NO answer control on it and the worker
/// had to scroll blind past a question to find the options.
///
/// R14 keeps the DRAWING, not the height: the progress strip, the traced option
/// glyphs, the hint chip and the decline link all stay (they are gated on
/// [_keyboardCrowdsChrome], not on this), and on any screen with room the
/// approved header is what ships.
bool _chromeCrowdsChrome(BuildContext context) =>
    _keyboardCrowdsChrome(context) || chromeCrowdsViewport(context);

/// (category, topic) for the header's step line and the progress strip —
/// from the question's own key, or the marker page's fixed pair. Labels only:
/// nothing here changes which step is shown or what is saved.
(String, String) _topicFor(TradeFormStep? step) => switch (step) {
      final TradeFormQuestionStep s => formTopicFor(s.question.id),
      TradeFormPreferencesStep() => kPreferencesTopic,
      TradeFormEmploymentStep() => kEmploymentTopic,
      TradeFormQualificationsStep() => kQualificationsTopic,
      _ => ('', ''),
    };

/// The trade form (#1341) — sectioned, resumable, driven entirely by
/// `GET /profiling/form`. Reached via `context.pushOnce(Routes.tradeForm)`; no
/// navigation is wired INTO this screen yet (that is #1340's handover card).
///
/// Painted with the Master Flutter UI Kit and the form-flow mockups
/// (Workholding / Measuring / Operations): the Shift Blue header on every
/// state (on a walk step: a yellow section title under the step + category
/// line), the white [FormProgressStrip] directly under it, and every step's
/// action docked in [QuestionnaireBottomBar] with a listen button when the
/// device read-aloud is wired.
class TradeFormScreen extends StatelessWidget {
  /// Opens the whole form (null) or one résumé-section walk — currently the
  /// Technical Skills pilot (`trade_form_section_walk.dart`). The router feeds
  /// this from the Bada Bhai menu's `option_key` (`state.extra`); every other
  /// pusher passes nothing and gets exactly today's full walk.
  const TradeFormScreen({super.key, this.sectionKey});

  /// The served menu's section key, or null for the full walk.
  final String? sectionKey;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<TradeFormCubit>(
      create: (_) => locator<TradeFormCubit>()..load(sectionKey: sectionKey),
      child: const _TradeFormView(),
    );
  }
}

class _TradeFormView extends StatelessWidget {
  const _TradeFormView();

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<TradeFormCubit, TradeFormState>(
      listenWhen: (TradeFormState p, TradeFormState c) => p.status != c.status,
      listener: (BuildContext context, TradeFormState state) {
        if (state.status == TradeFormStatus.done) {
          // #1367: the last marker save landed — there is no further step in
          // this walk. Leave via the SAME terminal pipeline every other
          // profiling path already uses (see profile_preview_screen.dart).
          // force: true so the server overlay runs against the fresh pack
          // answers the worker just saved (resume-draft-overlay.ts).
          context.go(Routes.building, extra: true);
        }
      },
      builder: (BuildContext context, TradeFormState state) {
        switch (state.status) {
          case TradeFormStatus.loading:
            return const _StatusScaffold(
              title: _kNoFormHeader,
              child: _LoadingBody(),
            );
          case TradeFormStatus.noForm:
            return const _StatusScaffold(
              title: _kNoFormHeader,
              child: _NoFormBody(),
            );
          case TradeFormStatus.loadError:
            return _StatusScaffold(
              title: _kNoFormHeader,
              child: _ErrorBody(
                message: state.loadError ?? _kRetry,
                onRetry: () => context.read<TradeFormCubit>().load(),
              ),
            );
          case TradeFormStatus.ready:
          case TradeFormStatus.submitting:
            return _WizardScaffold(state: state);
          case TradeFormStatus.done:
            // Mid-navigation-away (the listener above fires `go` for this
            // same state) — one transitional frame, not a stuck screen.
            return const _StatusScaffold(
              title: _kNoFormHeader,
              child: _LoadingBody(),
            );
        }
      },
    );
  }
}

/// A bare Shift Blue header scaffold for the pre-form loading / error / empty
/// states — [onBack] pops the whole screen since there is nothing to walk yet.
class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final bool crowded = _keyboardCrowdsChrome(context);
    return Scaffold(
      backgroundColor: FormFlowColors.canvas,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: title,
            onBack: () => context.pop(),
            // The approved form-flow drawing, except on a keyboard-crowded
            // short screen where it alone is taller than the viewport — see
            // [_keyboardCrowdsChrome].
            variant: crowded
                ? OnboardingVariant.standard
                : OnboardingVariant.formFlow,
            compact: crowded,
            autoCompact: false,
          ),
          Expanded(child: SafeArea(top: false, child: child)),
        ],
      ),
    );
  }
}

/// The kit's captioned loader ([BbStatusView.loading]) — the app's one loading
/// drawing (decision D12), not a fourth local spinner.
class _LoadingBody extends StatelessWidget {
  const _LoadingBody();
  @override
  Widget build(BuildContext context) =>
      const BbStatusView.loading(caption: _kLoading);
}

/// The honest "nothing to fill here" state for a 404 — DISTINCT from a blank
/// form (#1341). No retry: this is a real, stable answer for this worker
/// right now, not a transient failure.
class _NoFormBody extends StatelessWidget {
  const _NoFormBody();
  @override
  Widget build(BuildContext context) {
    // The kit's status view (decision D12): the 54dp informational disc, the
    // Anek title and the muted line, centred while there is room and SCROLLED
    // when there is not. The copy is unchanged.
    //
    // It replaces a local `OnboardingBody(fillViewport: true)` column, which
    // sized itself through `IntrinsicHeight`: a Text reports its intrinsic
    // height for ONE unwrapped line, so on a landscape phone at a 2.0 system
    // font the box came out 36dp shorter than the wrapped copy and the state
    // overflowed instead of scrolling.
    return const BbStatusView(
      icon: Icons.inbox_outlined,
      title: _kNoFormTitle,
      subtitle: _kNoFormBody,
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    // The kit's status view (decision D12), scroll-safe at every text scale.
    // The TITLE is the server's real reason — never a generic "kuch galat ho
    // gaya" over the top of it — and the retry stays the kit's hero CTA.
    return BbStatusView(
      icon: Icons.cloud_off_rounded,
      iconColor: OnboardingColors.errorRed,
      title: message,
      action: PrimaryActionButton(
        label: _kRetry,
        showArrow: false,
        onPressed: onRetry,
      ),
    );
  }
}

/// The main walk chrome: a per-step Shift Blue header (section title, STEP
/// badge, back-to-previous), a progress bar, and the swapped step body. A
/// marker screen's docked save/advance bar ([_MarkerBottomBar]) lives HERE, a
/// sibling of the scrollable body; a question screen's own docked submit bar
/// lives INSIDE [TradeFormQuestionBody] instead (it needs the live draft text/
/// selection, which only that widget holds) — either way every "Aage
/// badhein" on this walk is fixed at the bottom, never scrolls away. Each
/// question answer is still its own `POST /profiling/form/answer` rather
/// than a batched page write.
class _WizardScaffold extends StatefulWidget {
  const _WizardScaffold({required this.state});
  final TradeFormState state;

  @override
  State<_WizardScaffold> createState() => _WizardScaffoldState();
}

class _WizardScaffoldState extends State<_WizardScaffold> {
  // Reused across every occurrence of that marker type — only one is ever
  // mounted at a time (the walk shows one step on screen), so a single
  // GlobalKey per marker kind is safe even though a marker can appear more
  // than once in the walk (e.g. the shipped CNC-turner pack's two
  // "preferences" screens).
  final GlobalKey<TradeFormPreferencesPageState> _prefsKey =
      GlobalKey<TradeFormPreferencesPageState>();
  final GlobalKey<TradeFormEmploymentPageState> _empKey =
      GlobalKey<TradeFormEmploymentPageState>();
  final GlobalKey<TradeFormQualificationsPageState> _qualsKey =
      GlobalKey<TradeFormQualificationsPageState>();

  // #1384 item 2 — the currently-mounted marker's own INTERNAL page state,
  // mirrored up here so the ONE shared sticky bottom bar / header back arrow
  // can act on the right target: an internal "Aage badhein" that only moves
  // within this marker, vs the true save that reaches `widget.onSave(...)`
  // and advances the OUTER walk (`TradeFormCubit.flatSteps`/`currentIndex`,
  // which this pagination never touches — see the marker widgets' own class
  // docs). A marker widget cannot call `setState` on this DIFFERENT State
  // object from inside its own build phase, so it reports through
  // `onPageChanged` instead (see `TradeFormPreferencesPage.onPageChanged`'s
  // doc) — deferred via `addPostFrameCallback` for the very first report,
  // called directly on every later page change (a normal button tap, never
  // mid-build).
  //
  // Defaults deliberately assume "more than one page, not yet on the last
  // one" — `_markerPage(0) < _markerPageCount(2) - 1` — so the ONE transient
  // frame before a freshly-mounted marker's real page count arrives never
  // shows the true-final ("Ho gaya") treatment prematurely; the worse
  // case is a harmless one-frame "Aage badhein" on a marker that turns out
  // to be single-page (`TradeFormEmploymentPageState.pageCount` with no
  // entries yet), self-corrected the instant the post-frame callback fires.
  int _markerPage = 0;
  int _markerPageCount = 2;

  /// The device read-aloud behind the docked bars' listen button. Null when
  /// the voice graph is not registered (most widget tests) — then NO listen
  /// button renders, never a dead one.
  SpeechReader? _speech;

  @override
  void initState() {
    super.initState();
    _speech =
        locator.isRegistered<SpeechReader>() ? locator<SpeechReader>() : null;
  }

  @override
  void dispose() {
    _stopSpeech(); // never leave TTS reading a screen that is gone
    super.dispose();
  }

  void _stopSpeech() {
    final SpeechReader? reader = _speech;
    if (reader != null) unawaited(reader.stop());
  }

  /// The mounted marker's current internal page heading(s), read at TAP time
  /// so it always matches the page on screen. Server/app copy only — never a
  /// value the worker entered.
  String? _markerSpeech(TradeFormStep? step) {
    if (step is TradeFormPreferencesStep) {
      return _prefsKey.currentState?.currentPageSpeech();
    } else if (step is TradeFormEmploymentStep) {
      return _empKey.currentState?.currentPageSpeech();
    } else if (step is TradeFormQualificationsStep) {
      return _qualsKey.currentState?.currentPageSpeech();
    }
    return null;
  }

  void _listenToMarker(TradeFormStep? step) {
    final SpeechReader? reader = _speech;
    final String? text = _markerSpeech(step);
    if (reader == null || text == null || text.trim().isEmpty) return;
    unawaited(() async {
      await reader.stop(); // a second tap restarts rather than overlaps
      await reader.speak(text);
    }());
  }

  @override
  void didUpdateWidget(covariant _WizardScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state.currentIndex != widget.state.currentIndex) {
      _stopSpeech(); // the step changed — stop reading the previous one
      // A freshly (re)mounted marker widget always starts its own internal
      // `_page` at 0 (a brand-new State object — see `_prefsKey`'s doc on
      // why a GlobalKey cannot survive the unmount) — mirror that here so
      // this frame's bottom-bar label never reads stale from the PREVIOUS
      // step, before the new marker's own post-frame report (if any) lands.
      _markerPage = 0;
      _markerPageCount = 2;
    }
  }

  bool _isMarkerStep(TradeFormStep? step) =>
      step is TradeFormPreferencesStep ||
      step is TradeFormEmploymentStep ||
      step is TradeFormQualificationsStep;

  void _onMarkerPageChanged(int page, int pageCount) {
    if (!mounted) return;
    // An internal page change is a step change for the worker's ears too.
    if (page != _markerPage) _stopSpeech();
    setState(() {
      _markerPage = page;
      _markerPageCount = pageCount;
    });
  }

  /// The current marker page's blocking validation message, or null — e.g.
  /// a "kis saal" field still showing a future/invalid year. A red inline
  /// message with no way to stop "Aage badhein" was a real, reported bug;
  /// this is the actual gate, checked before every advance/save below.
  String? _currentMarkerPageError(TradeFormStep? step) {
    if (step is TradeFormPreferencesStep) {
      return _prefsKey.currentState?.currentPageError();
    } else if (step is TradeFormEmploymentStep) {
      return _empKey.currentState?.currentPageError();
    } else if (step is TradeFormQualificationsStep) {
      return _qualsKey.currentState?.currentPageError();
    }
    return null;
  }

  /// Docks at the TOP of the scaffold body (unlike a `SnackBar`, which
  /// always animates from the bottom) — the owner's explicit ask for a red
  /// banner where the worker's eyes already are, right under the header,
  /// not somewhere they have to look down for.
  void _showBlockedBanner(String message) {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger.clearMaterialBanners();
    messenger.showMaterialBanner(
      MaterialBanner(
        backgroundColor: OnboardingColors.errorRed,
        content: Text(
          message,
          style: OnboardingTypography.inter(
            size: 13,
            weight: FontWeight.w500,
            color: OnboardingColors.textOnBlue,
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: messenger.hideCurrentMaterialBanner,
            child: Text(
              'Theek hai',
              style: OnboardingTypography.inter(
                size: 14,
                weight: FontWeight.w700,
                color: OnboardingColors.textOnBlue,
              ),
            ),
          ),
        ],
      ),
    );
    Future<void>.delayed(const Duration(seconds: 4), () {
      if (mounted) messenger.hideCurrentMaterialBanner();
    });
  }

  void _goToNextMarkerPage(TradeFormStep? step) {
    final String? error = _currentMarkerPageError(step);
    if (error != null) {
      _showBlockedBanner(error);
      return;
    }
    if (step is TradeFormPreferencesStep) {
      _prefsKey.currentState?.goToNextPage();
    } else if (step is TradeFormEmploymentStep) {
      _empKey.currentState?.goToNextPage();
    } else if (step is TradeFormQualificationsStep) {
      _qualsKey.currentState?.goToNextPage();
    }
  }

  void _goToPreviousMarkerPage(TradeFormStep? step) {
    if (step is TradeFormPreferencesStep) {
      _prefsKey.currentState?.goToPreviousPage();
    } else if (step is TradeFormEmploymentStep) {
      _empKey.currentState?.goToPreviousPage();
    } else if (step is TradeFormQualificationsStep) {
      _qualsKey.currentState?.goToPreviousPage();
    }
  }

  @override
  Widget build(BuildContext context) {
    final TradeFormCubit cubit = context.read<TradeFormCubit>();
    final TradeFormState state = widget.state;
    final TradeFormStep? step = state.currentStep;
    final bool enabled = !state.isSubmitting;
    final bool isMarkerStep = _isMarkerStep(step);
    final bool markerOnLastInternalPage = _markerPage >= _markerPageCount - 1;

    // #1384 — deliberately NOT `state.answered`/`state.total` (those are
    // QUESTION-only counters, server-authoritative per #1375, and stay
    // untouched here). The progress strip (and the header's STEP line, which
    // reads the same two numbers) instead renders progress through the WHOLE
    // walk —
    // questions AND marker screens — using the worker's own position against
    // the steps the walk will actually SHOW (a marker page already saved is
    // skipped, so it is not counted — see `TradeFormState.visibleStepCount`),
    // so it also moves while filling a preferences/employment marker screen
    // instead of sitting frozen, and never promises steps that will not come.
    final int total = state.visibleStepCount;
    final int position = state.visiblePosition;

    final (String category, String topic) = _topicFor(step);
    // The keyboard is up on a short screen: the chrome sheds its two
    // context-only parts so the question, the field and the docked action
    // still fit. See [_keyboardCrowdsChrome] for the measurement.
    final bool crowded = _keyboardCrowdsChrome(context);
    // The header collapses on a short screen too, not only under a keyboard.
    final bool headerCrowded = _chromeCrowdsChrome(context);

    return Scaffold(
      backgroundColor: FormFlowColors.canvas,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: state.currentSectionTitle ?? '',
            titleColor: OnboardingColors.safetyYellow,
            // The form-flow drawing is the one the user approved, so it is
            // what ships — EXCEPT while the keyboard crowds a short screen,
            // where it does not fit at all (see [_keyboardCrowdsChrome]).
            // There the header falls back to the kit's collapsed drawing
            // (back arrow + one-line title on a single row), which is the
            // same collapse every other screen in the app already does.
            variant: headerCrowded
                ? OnboardingVariant.standard
                : OnboardingVariant.formFlow,
            compact: headerCrowded,
            stepBadge: (total == 0 || crowded)
                ? null
                : _stepBadge(position, total, category),
            // #1384 item 2 — a marker mid-way through its own internal pages
            // walks BACKWARD through those first; only once it is back on
            // its own first internal page does the SAME back arrow fall
            // through to the outer-step behaviour every other step already
            // has.
            onBack: (isMarkerStep && _markerPage > 0)
                ? () => _goToPreviousMarkerPage(step)
                : (state.isFirstStep ? () => context.pop() : cubit.goBack),
          ),
          // Full width, directly under the header — outside the body padding.
          // Hidden only while the keyboard crowds the screen (see
          // [_keyboardCrowdsChrome]); it is the same progress the STEP line
          // states, and a worker mid-typing is reading their own words.
          if (!crowded)
            FormProgressStrip(topic: topic, position: position, total: total),
          Expanded(
            // Bottom inset is handed to the docked bar itself
            // (`QuestionnaireBottomBar` pads for it), so its white ground
            // runs to the screen edge instead of stopping above the gesture
            // area.
            child: SafeArea(
              top: false,
              bottom: false,
              child: Column(
                children: <Widget>[
                  if (state.submitError != null)
                    _CappedWidth(
                      padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          const Icon(
                            Icons.error_outline_rounded,
                            size: 18,
                            color: OnboardingColors.errorRed,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              state.submitError!,
                              style: OnboardingTypography.inter(
                                size: 13,
                                color: OnboardingColors.errorRed,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  Expanded(
                    // A question step (`TradeFormQuestionBody`) manages its
                    // OWN internal scroll region + docked submit bar (the
                    // "Aage badhein"/"Submit karein" button must stay fixed
                    // at the bottom, not scroll away on a long question) — so
                    // it is handed the raw space directly, unwrapped. Every
                    // other step keeps the plain scroll-the-whole-body
                    // treatment.
                    child: step is TradeFormQuestionStep
                        ? _stepBody(step, cubit, enabled, state)
                        : OnboardingBody(
                            padding: const EdgeInsets.fromLTRB(
                              FormFlowLayout.gutter,
                              FormFlowLayout.bodyPaddingTop,
                              FormFlowLayout.gutter,
                              24,
                            ),
                            child: _stepBody(step, cubit, enabled, state),
                          ),
                  ),
                  if (isMarkerStep)
                    _MarkerBottomBar(
                      // #1384 item 2 — "the true final button for THIS
                      // marker" now requires BOTH: the outer walk has
                      // nothing after it (`state.isLastStep`, unchanged) AND
                      // this marker itself is on its own last internal page.
                      // Every internal-pagination "next" tap — including on
                      // a marker whose outer step happens to be last — stays
                      // the ordinary advance button; only the one tap that
                      // ACTUALLY calls `.save()` gets the last-step treatment.
                      isLast: state.isLastStep && markerOnLastInternalPage,
                      isSubmitting: state.isSubmitting,
                      onListen: _speech == null
                          ? null
                          : () => _listenToMarker(step),
                      onPressed: () {
                        _stopSpeech();
                        if (!markerOnLastInternalPage) {
                          _goToNextMarkerPage(step);
                          return;
                        }
                        final String? error = _currentMarkerPageError(step);
                        if (error != null) {
                          _showBlockedBanner(error);
                          return;
                        }
                        if (step is TradeFormPreferencesStep) {
                          _prefsKey.currentState?.save();
                        } else if (step is TradeFormEmploymentStep) {
                          _empKey.currentState?.save();
                        } else if (step is TradeFormQualificationsStep) {
                          _qualsKey.currentState?.save();
                        }
                      },
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stepBody(
    TradeFormStep? step,
    TradeFormCubit cubit,
    bool enabled,
    TradeFormState state,
  ) {
    if (step is TradeFormQuestionStep) {
      return TradeFormQuestionBody(
        key: ValueKey<String>(step.question.id),
        step: step,
        enabled: enabled,
        onSubmitChips: (List<String> keys) =>
            cubit.answerQuestion(step, TradeFormAnswer.chips(keys)),
        onSubmitBoolean: (bool value) =>
            cubit.answerQuestion(step, TradeFormAnswer.boolean(value)),
        onSubmitText: (String text) =>
            cubit.answerQuestion(step, TradeFormAnswer.text(text)),
        onDecline: () => cubit.declineQuestion(step),
        speechReader: _speech,
        // #1384 item 3 — reliable per #1376's fix to `answerQuestion`: a
        // question on the walk's true last step emits `done` directly on
        // submit rather than silently advancing.
        isLastStep: state.isLastStep,
      );
    }
    if (step is TradeFormPreferencesStep) {
      return TradeFormPreferencesPage(
        key: _prefsKey,
        enabled: enabled,
        loadOptions: cubit.loadPreferenceOptions,
        onSave: cubit.savePreferencesAndAdvance,
        initialPreferences: state.savedPreferences,
        knownFacts: state.knownFacts,
        onPageChanged: _onMarkerPageChanged,
      );
    }
    if (step is TradeFormEmploymentStep) {
      return TradeFormEmploymentPage(
        key: _empKey,
        enabled: enabled,
        // NOTHING VOICE-RELATED IS THREADED IN ANY MORE. The spoken work
        // description is now the DEVICE recogniser, resolved by
        // `DictationController` itself and tolerant of its own absence — so the
        // page needs neither a recorder nor the form's `session_id`. Both were
        // here only for the record-and-upload mic this replaced.
        // #1429 — the SAME options fetch the preferences marker uses; it
        // carries the state catalogue + the state-tagged city gazetteer.
        loadOptions: cubit.loadPreferenceOptions,
        onSave: cubit.saveEmploymentAndAdvance,
        // An untouched page with nothing banked never replaces the stored
        // history with its blank default.
        onSkip: cubit.skipEmploymentAndAdvance,
        initialEntries: state.savedEmployment,
        onPageChanged: _onMarkerPageChanged,
      );
    }
    if (step is TradeFormQualificationsStep) {
      return TradeFormQualificationsPage(
        key: _qualsKey,
        suggestedCertificates: step.suggestedCertificates,
        enabled: enabled,
        loadOptions: cubit.loadQualificationOptions,
        onSave: cubit.saveQualificationsAndAdvance,
        initialQualifications: state.savedQualifications,
        onPageChanged: _onMarkerPageChanged,
      );
    }
    return const SizedBox.shrink();
  }
}

/// Centres [child] and caps it at the kit's content width, so the error line
/// lines up with the body column on a tablet.
class _CappedWidth extends StatelessWidget {
  const _CappedWidth({required this.padding, required this.child});

  final EdgeInsetsGeometry padding;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: padding,
      child: Center(
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            maxWidth: OnboardingLayout.maxContentWidth,
          ),
          child: child,
        ),
      ),
    );
  }
}

class _MarkerBottomBar extends StatelessWidget {
  const _MarkerBottomBar({
    required this.isLast,
    required this.isSubmitting,
    required this.onPressed,
    required this.onListen,
  });

  final bool isLast;
  final bool isSubmitting;
  final VoidCallback onPressed;

  /// Reads the marker's current page heading(s) aloud; null (no device
  /// read-aloud wired) renders no listen button at all.
  final VoidCallback? onListen;

  @override
  Widget build(BuildContext context) {
    // #1384 item 3 — [isLast] here already means "the true final save" (see
    // the `_MarkerBottomBar(...)` call site's own comment). The kit's docked
    // bar has ONE button colour, so the true final save is told apart by its
    // own label ("Ho gaya") and by dropping the forward arrow — a button that
    // finishes the walk does not point onward.
    return QuestionnaireBottomBar(
      nextLabel: isLast ? _kFinish : _kNext,
      showArrow: !isLast,
      isLoading: isSubmitting,
      onNext: isSubmitting ? null : onPressed,
      onListen: onListen,
      variant: OnboardingVariant.formFlow,
    );
  }
}
