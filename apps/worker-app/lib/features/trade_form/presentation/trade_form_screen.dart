import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../router.dart';
import '../domain/trade_form_models.dart';
import 'cubit/trade_form_cubit.dart';
import 'widgets/trade_form_employment_page.dart';
import 'widgets/trade_form_preferences_page.dart';
import 'widgets/trade_form_progress_bar.dart';
import 'widgets/trade_form_qualifications_page.dart';
import 'widgets/trade_form_question_body.dart';

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

/// The trade form (#1341) — sectioned, resumable, driven entirely by
/// `GET /profiling/form`. Reached via `context.push(Routes.tradeForm)`; no
/// navigation is wired INTO this screen yet (that is #1340's handover card).
class TradeFormScreen extends StatelessWidget {
  const TradeFormScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<TradeFormCubit>(
      create: (_) => locator<TradeFormCubit>()..load(),
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
          context.go(Routes.building);
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

/// A bare blue-header scaffold for the pre-form loading / error / empty
/// states — [onBack] pops the whole screen since there is nothing to walk yet.
class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.canvas,
      body: Column(
        children: <Widget>[
          BbBlueHeader(title: title, onBack: () => context.pop()),
          Expanded(child: SafeArea(top: false, child: child)),
        ],
      ),
    );
  }
}

class _LoadingBody extends StatelessWidget {
  const _LoadingBody();
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const CircularProgressIndicator(color: AppColors.blue),
          const SizedBox(height: AppSpacing.s4),
          Text(_kLoading,
              style: AppTypography.body(
                  size: AppTypography.sizeBase, color: AppColors.textMuted)),
        ],
      ),
    );
  }
}

/// The honest "nothing to fill here" state for a 404 — DISTINCT from a blank
/// form (#1341). No retry: this is a real, stable answer for this worker
/// right now, not a transient failure.
class _NoFormBody extends StatelessWidget {
  const _NoFormBody();
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(_kNoFormTitle,
                textAlign: TextAlign.center,
                style: AppTypography.display(size: AppTypography.sizeLg)),
            const SizedBox(height: AppSpacing.s2),
            Text(_kNoFormBody,
                textAlign: TextAlign.center,
                style: AppTypography.body(
                    size: AppTypography.sizeBase, color: AppColors.textMuted)),
          ],
        ),
      ),
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(message,
                textAlign: TextAlign.center,
                style: AppTypography.body(size: AppTypography.sizeMd)),
            const SizedBox(height: AppSpacing.s4),
            BbButton(
              label: _kRetry,
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              onPressed: onRetry,
            ),
          ],
        ),
      ),
    );
  }
}

/// The main walk chrome: a per-step header (section title, back-to-previous),
/// a progress bar, and the swapped step body. A marker screen's sticky
/// save/advance button ([_MarkerBottomBar]) lives HERE, a sibling of the
/// scrollable body; a question screen's own pinned submit button lives
/// INSIDE [TradeFormQuestionBody] instead (it needs the live draft text/
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
  // shows the true-final (green/"Ho gaya") treatment prematurely; the worse
  // case is a harmless one-frame "Aage badhein" on a marker that turns out
  // to be single-page (`TradeFormEmploymentPageState.pageCount` with no
  // entries yet), self-corrected the instant the post-frame callback fires.
  int _markerPage = 0;
  int _markerPageCount = 2;

  @override
  void didUpdateWidget(covariant _WizardScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state.currentIndex != widget.state.currentIndex) {
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
        backgroundColor: AppColors.danger,
        content: Text(message,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: Colors.white)),
        actions: <Widget>[
          TextButton(
            onPressed: messenger.hideCurrentMaterialBanner,
            child: const Text('Theek hai',
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
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

    return Scaffold(
      backgroundColor: AppColors.canvas,
      body: Column(
        children: <Widget>[
          BbBlueHeader(
            title: state.currentSectionTitle ?? '',
            // #1384 item 2 — a marker mid-way through its own internal pages
            // walks BACKWARD through those first; only once it is back on
            // its own first internal page does the SAME back arrow fall
            // through to the outer-step behaviour every other step already
            // has.
            onBack: (isMarkerStep && _markerPage > 0)
                ? () => _goToPreviousMarkerPage(step)
                : (state.isFirstStep ? () => context.pop() : cubit.goBack),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: Column(
                children: <Widget>[
                  const SizedBox(height: AppSpacing.s4),
                  Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
                    // #1384 — deliberately NOT `state.answered`/`state.total`
                    // (those are QUESTION-only counters, server-authoritative
                    // per #1375, and stay untouched here). The bar instead
                    // renders progress through the WHOLE walk — questions AND
                    // marker screens — using the worker's own position
                    // (`currentIndex`) against the true step count
                    // (`flatSteps.length`), so it also moves while filling a
                    // preferences/employment marker screen instead of sitting
                    // frozen. `+ 1` so the very first step still shows a
                    // sliver rather than reading empty, and the LAST step
                    // reads fully complete rather than stuck one short;
                    // clamped and `flatSteps`-empty-guarded defensively even
                    // though neither should happen per this state's own
                    // invariants.
                    child: TradeFormProgressBar(
                      answered: state.flatSteps.isEmpty
                          ? 0
                          : (state.currentIndex + 1)
                              .clamp(0, state.flatSteps.length)
                              .toInt(),
                      total: state.flatSteps.length,
                    ),
                  ),
                  if (state.submitError != null) ...<Widget>[
                    const SizedBox(height: AppSpacing.s3),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.gutter),
                      child: Text(
                        state.submitError!,
                        style: AppTypography.body(
                            size: AppTypography.sizeSm, color: AppColors.danger),
                      ),
                    ),
                  ],
                  Expanded(
                    // A question step (`TradeFormQuestionBody`) manages its
                    // OWN internal scroll region + pinned submit footer (the
                    // "Aage badhein"/"Submit karein" button must stay fixed
                    // at the bottom, not scroll away on a long question) — so
                    // it is handed the raw space directly, unwrapped. Every
                    // other step keeps the plain scroll-the-whole-body
                    // treatment.
                    child: step is TradeFormQuestionStep
                        ? _stepBody(step, cubit, enabled, state)
                        : SingleChildScrollView(
                            padding: const EdgeInsets.fromLTRB(
                                AppSpacing.gutter,
                                AppSpacing.s4,
                                AppSpacing.gutter,
                                AppSpacing.s4),
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
                      // ACTUALLY calls `.save()` gets the last-step styling.
                      isLast: state.isLastStep && markerOnLastInternalPage,
                      isSubmitting: state.isSubmitting,
                      onPressed: () {
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
        onPageChanged: _onMarkerPageChanged,
      );
    }
    if (step is TradeFormEmploymentStep) {
      return TradeFormEmploymentPage(
        key: _empKey,
        enabled: enabled,
        onSave: cubit.saveEmploymentAndAdvance,
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

class _MarkerBottomBar extends StatelessWidget {
  const _MarkerBottomBar({
    required this.isLast,
    required this.isSubmitting,
    required this.onPressed,
  });

  final bool isLast;
  final bool isSubmitting;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s3, AppSpacing.gutter, AppSpacing.s4),
      decoration: const BoxDecoration(
        color: AppColors.canvas,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      child: BbButton(
        label: isLast ? _kFinish : _kNext,
        // #1384 item 3 — [isLast] here already means "the true final save"
        // (see the `_MarkerBottomBar(...)` call site's own comment) —
        // green, reserved for exactly this ("Money / WhatsApp / done ONLY",
        // `bb_button.dart`'s own doc on `BbButtonVariant.success`).
        // navy (not primary/haldi) — haldi is IDENTICAL to a selected
        // BbChip's fill, so this nav button read as just another option.
        variant: isLast ? BbButtonVariant.success : BbButtonVariant.navy,
        block: true,
        loading: isSubmitting,
        onPressed: isSubmitting ? null : onPressed,
      ),
    );
  }
}
