import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_client.dart' show WorkPrefOptionsDto;
import '../../../core/di/locator.dart';
import '../../../core/session/known_worker_facts_store.dart' show WorkerFact;
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/tap_guard.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/onboarding/form_flow_parts.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/option_icons.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/questionnaire_bottom_bar.dart';
import '../../../core/widgets/onboarding/selection_cards.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../../voice/domain/speech_reader.dart';
import '../domain/finishing_models.dart';
import 'cubit/finishing_cubit.dart';
import 'widgets/employer_card.dart';
import 'widgets/finishing_controls.dart';
import 'widgets/finishing_option_icons.dart';

// ---- Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart. ----

const String _kRewardLine =
    'Bas kuch aakhri baatein — phir aapka resume taiyaar ho jayega.';

const String _kLangTitle = 'Aap kaun si bhasha bolte hain?';
const String _kLangSubtitle = 'Jitni bhasha aati hain, sab chunein.';

const String _kDocTitle = 'Kaun se document taiyaar hain?';
const String _kDocSubtitle = 'Jo aapke paas hain, unhe chunein.';

const String _kShiftTitle = 'Kaam ka time aur type';
const String _kShiftSubtitle = 'Jo aapko theek lage, chunein.';
const String _kShiftLabel = 'Shift';
const String _kJobTypeLabel = 'Naukri ka type';

const String _kCitiesTitle = 'Kahan kaam karna chahte hain?';
const String _kCitiesSubtitle = 'Sheher daalein — ek se zyada bhi chalega.';
const String _kCityHint = 'Sheher ka naam likhein';
// Screen-reader name for the icon-only add-city button (it used to read "+").
const String _kAddCity = 'Sheher jodein';
const String _kRelocateLabel = 'Doosre sheher ja sakte hain?';
const String _kAccommodationLabel = 'Rehne ki jagah chahiye?';

// #1471 — one "Salary aur padhai" page carried FIVE questions and had to be
// scrolled. Three pages now, one idea each; every one stays optional.
const String _kSalaryTitle = 'Mahine ki salary';
const String _kSalarySubtitle = 'Jitni chahte hain, wahi chunein — optional hai.';

const String _kEduTitle = 'ITI ya Diploma';
const String _kEduSubtitle = 'Agar kiya hai to chunein — optional hai.';

const String _kEduDetailTitle = 'Padhai ki detail';
const String _kEduDetailSubtitle = 'Saal aur institute — optional hai.';
const String _kCredentialLabel = 'Agar ITI ya Diploma hai to kaun sa?';
const String _kCouncilLabel = 'Council / board';
const String _kEduYearLabel = 'Kis saal poora hua';
const String _kEduYearHint = 'Jaise: 2018';
const String _kInstituteLabel = 'Institute ka naam';
const String _kInstituteHint = 'Jaise: Govt. ITI, Faridabad';

// #1298 — the education vocabularies are NOT served by the options endpoint, so
// they are pinned here from the authoritative source
// (apps/api/src/profiles/worker-preferences.vocabulary.ts). A slug outside these
// dictionaries is rejected by the API, so keep them in lockstep with that file.
const Map<String, String> _kCredentials = <String, String>{
  'iti': 'ITI',
  'diploma': 'Diploma',
};
const Map<String, String> _kCouncils = <String, String>{
  'ncvt': 'NCVT',
  'scvt': 'SCVT',
  'nsqf': 'NSQF',
  'aicte': 'AICTE',
  'state_board': 'State board',
  'cbse': 'CBSE',
  'icse': 'ICSE',
  'open_school': 'NIOS / Open school',
};

// #1312 — expected salary is a BAND, never a point figure (§4.4). Each entry
// maps a band's UPPER bound (what the wire sends as `salary_expected_max`) to a
// persona-neutral Hinglish label. The chosen band's upper bound is the value
// sent, so the server contract is unchanged; the open-ended top band pins a
// sensible max (100000, ≤ the server's 500000 ceiling). Ordered low→high; a
// Map literal keeps that insertion order, which is the display order. Skipping
// the page leaves `salaryExpectedMax` null, so the key stays ABSENT on the wire.
const Map<int, String> _kSalaryBands = <int, String>{
  15000: '₹10–15 hazaar',
  20000: '₹15–20 hazaar',
  25000: '₹20–25 hazaar',
  35000: '₹25–35 hazaar',
  50000: '₹35–50 hazaar',
  100000: '₹50 hazaar se upar',
};

// Server bound (worker-preferences.dto.ts) — guard the year at the input edge so
// an out-of-range value is simply not sent, never a doomed 400.
const int _kYearMin = 1950;
const int _kYearMax = 2100;

const String _kHistoryTitle = 'Aapne pehle kahan kaam kiya?';
const String _kHistorySubtitle = 'Zyada se zyada 4 jagah likh sakte hain.';
const String _kAddEmployer = 'Aur ek jagah jodein';

const String _kNext = 'Aage badhein';
const String _kFinish = 'Ho gaya';
const String _kLoading = 'Taiyaari ho rahi hai…';
const String _kRetry = 'Dobara koshish karein';

/// The pill under a multi-select page's heading (the mockups' "ⓘ" hint).
const String _kMultiHint = 'Multiple options select kar sakte hain';

/// (category, topic) per page — the category follows the step in the header
/// ("STEP 3 OF 8 • AVAILABILITY & TERMS"), the topic heads the progress strip.
(String, String) _topicFor(FinishingPage page) => switch (page) {
      FinishingPage.languages => ('Languages', 'Languages spoken'),
      FinishingPage.documents => ('Documents', 'Documents ready'),
      FinishingPage.shiftAndType => ('Availability & terms', 'Shift & job type'),
      FinishingPage.cities => ('Location', 'Preferred cities'),
      FinishingPage.salary => ('Availability & terms', 'Salary expectation'),
      FinishingPage.education => ('Qualifications', 'Education'),
      FinishingPage.educationDetail => ('Qualifications', 'Education details'),
      FinishingPage.history => ('Work history', 'Past jobs'),
    };

/// Whether the keyboard has left too little room for this screen's full
/// chrome — the navy header, the STEP line AND the progress strip — above the
/// docked bar.
///
/// MEASURED, not guessed: on a 320x568 handset at a 200% system font with the
/// keyboard up, the form-flow header, the progress strip and the docked bar
/// come to ~370dp of chrome in the 308dp the keyboard leaves, so the
/// scrollable page gets 0dp and the docked bar overflows the column — a red
/// error band under the worker's thumb on the one page that types (work
/// history). While the keyboard crowds the screen the chrome therefore sheds
/// the STEP line and the strip, and the header falls back to the kit's
/// collapsed drawing; all three come straight back when the keyboard closes.
///
/// CALL THIS ABOVE THE SCAFFOLD — from the widget that BUILDS it, as both
/// callers do. A [Scaffold] with the default `resizeToAvoidBottomInset`
/// consumes `viewInsets.bottom` and hands its body a shorter box with the
/// inset zeroed, so the same question asked inside the body always answers 0.
///
/// [MediaQuery] rather than `View.of`, deliberately: reading the window gives
/// the right number but subscribes to nothing, so the build that read it never
/// re-runs when the keyboard opens. `viewInsetsOf`/`sizeOf` register the two
/// dependencies, so the keyboard appearing IS the rebuild.
///
/// Duplicated verbatim in
/// `features/trade_form/presentation/trade_form_screen.dart`, whose wizard has
/// the identical header + strip + docked-bar column; keep both in sync if this
/// ever changes.
bool _keyboardCrowdsChrome(BuildContext context) {
  final double keyboard = MediaQuery.viewInsetsOf(context).bottom;
  if (keyboard <= 0) return false;
  return MediaQuery.sizeOf(context).height - keyboard < 480;
}

/// Whether the HEADER should fall back to the kit's collapsed drawing — the
/// keyboard, OR a short screen at a large system font. See the identical
/// helper in `trade_form_screen.dart` for the measurement and why R14 is
/// untouched by it (the strip, glyphs, hint chip and decline link all stay).
bool _chromeCrowdsChrome(BuildContext context) =>
    _keyboardCrowdsChrome(context) || chromeCrowdsViewport(context);

/// Pages whose closed set allows several answers.
bool _isMultiSelect(FinishingPage page) =>
    page == FinishingPage.languages || page == FinishingPage.documents;

/// The header's STEP line — the true position in the pages this worker is
/// shown (a page the chat already asked is left out), then the page's category.
String _stepBadge(FinishingState state) =>
    'Step ${state.pageIndex + 1} of ${state.pages.length} • '
    '${_topicFor(state.page).$1}';

/// What the listen button reads: the page's own title and subtitle (fixed
/// copy — never anything the worker typed). A title without end punctuation
/// gets a full stop so the voice pauses before the subtitle.
String _spokenPage(String title, String subtitle) {
  final String t = title.trim();
  final bool ended = t.endsWith('?') || t.endsWith('.') || t.endsWith('।');
  return ended ? '$t $subtitle' : '$t. $subtitle';
}

/// Body gutter — the form flow's 20dp sides and top; 16dp at the bottom
/// (#1471 pages must still fit a handset).
const EdgeInsets _kBodyPadding = EdgeInsets.fromLTRB(
  FormFlowLayout.gutter,
  FormFlowLayout.bodyPaddingTop,
  FormFlowLayout.gutter,
  16,
);

/// Vertical gap between two questions on one page.
const double _kQuestionGap = 14;

/// The post-interview finishing form (#1296) — five closed-set pages that fill
/// the résumé rows the interview's ask-budget cannot afford. Reached straight
/// after the interview confirms, before the first résumé generate; on completion
/// it routes to [Routes.building].
///
/// Form-flow chrome (the Workholding / Measuring / Operations mockups): Shift
/// Blue header (yellow title, subtitle, "Step n of 8 • category" line, back =
/// previous page), the white progress strip (topic + true percent), a
/// scrolling width-capped body whose option cards all carry an icon tile, and
/// the docked [QuestionnaireBottomBar]. Its listen button reads the page's
/// title and subtitle on the device's TTS, and appears only when a
/// [SpeechReader] is registered — no dead button otherwise.
class FinishingScreen extends StatelessWidget {
  const FinishingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<FinishingCubit>(
      create: (_) => locator<FinishingCubit>()..load(),
      child: const _FinishingView(),
    );
  }
}

class _FinishingView extends StatefulWidget {
  const _FinishingView();

  @override
  State<_FinishingView> createState() => _FinishingViewState();
}

class _FinishingViewState extends State<_FinishingView> {
  /// The device TTS seam, or null when none is registered (widget tests) — in
  /// which case the bar gets no listen button at all.
  final SpeechReader? _reader =
      locator.isRegistered<SpeechReader>() ? locator<SpeechReader>() : null;

  /// Reads [text] aloud, cutting off anything already playing.
  void _speak(String text) {
    final SpeechReader? reader = _reader;
    if (reader == null) return;
    unawaited(() async {
      await reader.stop();
      await reader.speak(text);
    }());
  }

  /// Never leave the voice reading a page the worker has moved on from.
  void _stopSpeech() {
    final SpeechReader? reader = _reader;
    if (reader != null) unawaited(reader.stop());
  }

  @override
  void dispose() {
    _stopSpeech();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return BlocListener<FinishingCubit, FinishingState>(
      // Next, back, or any other page change silences the previous page.
      listenWhen: (FinishingState p, FinishingState c) =>
          p.pageIndex != c.pageIndex,
      listener: (BuildContext context, FinishingState state) => _stopSpeech(),
      child: BlocConsumer<FinishingCubit, FinishingState>(
        listenWhen: (FinishingState p, FinishingState c) =>
            p.status != c.status,
        listener: (BuildContext context, FinishingState state) {
          if (state.status == FinishingStatus.done) {
            // The two writes have landed — generate the résumé they just filled.
            context.go(Routes.building);
          }
        },
        builder: (BuildContext context, FinishingState state) {
          switch (state.status) {
            case FinishingStatus.loadingOptions:
              return const _StatusScaffold(child: _LoadingBody());
            case FinishingStatus.loadError:
              return _StatusScaffold(
                child: _ErrorBody(
                  message: state.error ?? _kRetry,
                  onRetry: () => context.read<FinishingCubit>().load(),
                ),
              );
            case FinishingStatus.ready:
            case FinishingStatus.submitting:
            case FinishingStatus.done:
              return _WizardScaffold(
                state: state,
                onListen: _reader == null ? null : _speak,
                onAdvance: _stopSpeech,
              );
          }
        },
      ),
    );
  }
}

/// A bare blue-header scaffold for the pre-form loading / error states.
class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final bool crowded = _keyboardCrowdsChrome(context);
    return Scaffold(
      backgroundColor: FormFlowColors.canvas,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: _kHistoryTitle,
            subtitle: _kRewardLine,
            titleColor: OnboardingColors.safetyYellow,
            // The approved form-flow drawing, except on a keyboard-crowded
            // short screen: this header carries a title AND a subtitle, which
            // at a 2.0 system font on a 320dp phone is taller than what the
            // keyboard leaves of the viewport — see [_keyboardCrowdsChrome].
            variant: crowded
                ? OnboardingVariant.standard
                : OnboardingVariant.formFlow,
            compact: crowded,
          ),
          Expanded(child: SafeArea(top: false, child: child)),
        ],
      ),
    );
  }
}

/// The kit's captioned loader ([BbStatusView.loading]) — the app's one loading
/// drawing (decision D12), not a local spinner of its own.
class _LoadingBody extends StatelessWidget {
  const _LoadingBody();
  @override
  Widget build(BuildContext context) =>
      const BbStatusView.loading(caption: _kLoading);
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    // The kit's status view (decision D12): the 54dp error disc, the reason as
    // the title, the retry as the kit's hero CTA. Centred while there is room
    // and SCROLLED when there is not.
    //
    // It replaces a local `OnboardingBody(fillViewport: true)` column, which
    // sized itself through `IntrinsicHeight`: a Text reports its intrinsic
    // height for ONE unwrapped line, so on a landscape phone at a 2.0 system
    // font the box came out shorter than the wrapped copy and the state
    // overflowed instead of scrolling.
    //
    // [message] is the real reason from the cubit — never a generic "check
    // internet".
    return BbStatusView(
      icon: Icons.error_outline_rounded,
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

/// The eight-page wizard chrome: header (per-page yellow title + STEP line +
/// back-to-previous-page), the progress strip, the swapped page body, and the
/// docked advance bar.
class _WizardScaffold extends StatelessWidget {
  const _WizardScaffold({
    required this.state,
    required this.onListen,
    required this.onAdvance,
  });
  final FinishingState state;

  /// Speaks the given text; null hides the listen button.
  final ValueChanged<String>? onListen;

  /// Runs just before next / submit (silences the voice).
  final VoidCallback onAdvance;

  static const List<String> _titles = <String>[
    _kLangTitle,
    _kDocTitle,
    _kShiftTitle,
    _kCitiesTitle,
    _kSalaryTitle,
    _kEduTitle,
    _kEduDetailTitle,
    _kHistoryTitle,
  ];
  static const List<String> _subtitles = <String>[
    _kLangSubtitle,
    _kDocSubtitle,
    _kShiftSubtitle,
    _kCitiesSubtitle,
    _kSalarySubtitle,
    _kEduSubtitle,
    _kEduDetailSubtitle,
    _kHistorySubtitle,
  ];

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    // Copy is indexed by the PAGE, not the position: a page the chat already
    // asked is skipped, so the two can differ.
    final int i = state.page.index;
    final ValueChanged<String>? listen = onListen;
    // The keyboard is up on a short screen (the work-history page): the chrome
    // sheds its context-only parts so the card being filled and the docked
    // action still fit. See [_keyboardCrowdsChrome] for the measurement.
    final bool crowded = _keyboardCrowdsChrome(context);
    // The header collapses on a short screen too, not only under a keyboard.
    final bool headerCrowded = _chromeCrowdsChrome(context);
    return Scaffold(
      backgroundColor: FormFlowColors.canvas,
      body: Column(
        children: <Widget>[
          // Mockup: the header carries the section; the question itself is the
          // body's headline.
          ShiftBlueHeader(
            title: _topicFor(state.page).$1,
            stepBadge: crowded ? null : _stepBadge(state),
            titleColor: OnboardingColors.safetyYellow,
            onBack: state.isFirstPage ? null : cubit.previousPage,
            // The approved form-flow drawing everywhere except a crowded short
            // screen, where it does not fit at all and the kit's collapsed
            // drawing takes over.
            variant: headerCrowded
                ? OnboardingVariant.standard
                : OnboardingVariant.formFlow,
            compact: headerCrowded,
          ),
          // Hidden only while the keyboard crowds the screen: it states the
          // same progress as the STEP line, and a worker mid-typing is reading
          // their own words.
          if (!crowded)
            FormProgressStrip(
              topic: _topicFor(state.page).$2,
              position: state.pageIndex + 1,
              total: state.pages.length,
            ),
          Expanded(
            // Bottom inset is the docked bar's job; keep only the side insets.
            child: SafeArea(
              top: false,
              bottom: false,
              child: OnboardingBody(
                padding: _kBodyPadding,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Text(_titles[i],
                        style: OnboardingTypography.formQuestionHeadline()),
                    const SizedBox(height: FormFlowLayout.headlineToWhyGap),
                    Text(_subtitles[i],
                        style: OnboardingTypography.formWhyText()),
                    // #1575 — why THIS question is being asked again: the chat
                    // served-and-skipped it (`unanswered`), or an answer exists
                    // the profile could not carry (`dropped_by_projector`).
                    // Null for never-asked facts (the question is the ask) and
                    // for settled ones (their pages are hidden, not annotated).
                    if (gapNoteForPage(state.page, state.fillEntries)
                        case final String note) ...<Widget>[
                      const SizedBox(height: 6),
                      Text(note,
                          style: OnboardingTypography.formWhyText()),
                    ],
                    // The finishing form IS the reward — say so once, on page
                    // one.
                    if (state.isFirstPage)
                      Text(_kRewardLine,
                          style: OnboardingTypography.formWhyText()),
                    if (_isMultiSelect(state.page)) ...<Widget>[
                      const SizedBox(height: FormFlowLayout.whyToHintGap),
                      const FormHintChip(text: _kMultiHint),
                      const SizedBox(height: FormFlowLayout.hintToOptionsGap),
                    ] else
                      const SizedBox(height: FormFlowLayout.introToOptionsGap),
                    _PageBody(state: state),
                  ],
                ),
              ),
            ),
          ),
          _BottomBar(
            state: state,
            onListen: listen == null
                ? null
                : () => listen(_spokenPage(_titles[i], _subtitles[i])),
            onAdvance: onAdvance,
          ),
        ],
      ),
    );
  }
}

class _PageBody extends StatelessWidget {
  const _PageBody({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    final WorkPrefOptionsDto options = state.options!;
    final FinishingCubit cubit = context.read<FinishingCubit>();
    switch (state.page) {
      case FinishingPage.languages:
        return _MultiCards(
          labels: options.languages,
          selected: state.prefs.languages,
          onTap: cubit.toggleLanguage,
          iconFor: (_, __) => kFinishingLanguageIcon,
        );
      case FinishingPage.documents:
        return _MultiCards(
          labels: options.documentsReady,
          selected: state.prefs.documentsReady,
          onTap: cubit.toggleDocument,
          iconFor: documentOptionIcon,
        );
      case FinishingPage.shiftAndType:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // The chat already asked "din ki shift ya raat ki" — not again.
            if (!state.knownFacts.contains(WorkerFact.shift)) ...<Widget>[
              _SectionLabel(_kShiftLabel),
              _SingleCards(
                labels: options.shift,
                selected: state.prefs.shift,
                onTap: cubit.selectShift,
                iconFor: shiftOptionIcon,
              ),
              const SizedBox(height: _kQuestionGap),
            ],
            _SectionLabel(_kJobTypeLabel),
            _SingleCards(
              labels: options.jobType,
              selected: state.prefs.jobType,
              onTap: cubit.selectJobType,
              iconFor: jobTypeOptionIcon,
            ),
          ],
        );
      case FinishingPage.cities:
        return _CitiesPage(state: state);
      case FinishingPage.salary:
        return _SalaryPage(state: state);
      case FinishingPage.education:
        return _EducationPage(state: state);
      case FinishingPage.educationDetail:
        return _EducationDetailPage(state: state);
      case FinishingPage.history:
        return _HistoryPage(state: state);
    }
  }
}

/// A question heading inside a page body — the mockups' Anek bold question
/// headline, one step smaller than the kit's 20dp because two questions share
/// the page beneath the header's own title (#1471 fit).
class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(
          text,
          style: OnboardingTypography.anek(
            size: 17,
            weight: FontWeight.w700,
            height: 1.25,
            // Navy, like the form-flow question headline it sits under.
            color: OnboardingColors.shiftBlue,
          ),
        ),
      );
}

/// The leading icon for one option card, from its slug and label.
typedef _OptionIcon = IconData Function(String slug, String label);

/// A form-field label on the education-detail page (kit field label, Inter).
class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: finishingFieldLabelStyle()),
      );
}

/// Multi-select closed set — one kit checkbox card per server-supplied option.
class _MultiCards extends StatelessWidget {
  const _MultiCards({
    required this.labels,
    required this.selected,
    required this.onTap,
    required this.iconFor,
  });
  final Map<String, String> labels;
  final Set<String> selected;
  final void Function(String slug) onTap;
  final _OptionIcon iconFor;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          MultiSelectQuestionCard(
            title: e.value,
            leadingIcon: iconFor(e.key, e.value),
            isSelected: selected.contains(e.key),
            onTap: () => onTap(e.key),
            variant: OnboardingVariant.formFlow,
          ),
      ],
    );
  }
}

/// Single-select closed set — one kit radio card per option. Re-tapping the
/// chosen card clears it (the cubit's toggle-to-clear rule).
class _SingleCards extends StatelessWidget {
  const _SingleCards({
    required this.labels,
    required this.selected,
    required this.onTap,
    required this.iconFor,
    this.twoUp = false,
  });
  final Map<String, String> labels;
  final String? selected;
  final void Function(String slug) onTap;
  final _OptionIcon iconFor;

  /// Two per row where it fits (see [_CardGrid]). Only for the short,
  /// client-pinned education vocabularies (#1298) — server-supplied lists,
  /// whose label length is unknown, stay one per row.
  final bool twoUp;

  @override
  Widget build(BuildContext context) {
    return _CardGrid(
      twoUp: twoUp,
      cards: <_CardSpec>[
        for (final MapEntry<String, String> e in labels.entries)
          _CardSpec(
            title: e.value,
            icon: iconFor(e.key, e.value),
            isSelected: selected == e.key,
            onTap: () => onTap(e.key),
          ),
      ],
    );
  }
}

/// One single-select option card's content, independent of its layout.
class _CardSpec {
  const _CardSpec({
    required this.title,
    required this.icon,
    required this.isSelected,
    required this.onTap,
  });
  final String title;
  final IconData icon;
  final bool isSelected;
  final VoidCallback onTap;
}

/// Lays single-select option cards one per row — the kit card, as in the
/// mockups — or, with [twoUp] and only while each cell still gets
/// [_minTwoUpCardWidth] (scaled with the worker's font size), two per row as
/// [FinishingGridOptionCard]s, which give the title the full cell width.
///
/// Two-up exists for the short client-pinned lists whose pages must fit a
/// handset (#1471): with an icon tile on every card, one column of the
/// education vocabularies (#1298) or the salary bands (#1312) no longer does.
class _CardGrid extends StatelessWidget {
  const _CardGrid({required this.cards, this.twoUp = false});
  final List<_CardSpec> cards;
  final bool twoUp;

  static const double _minTwoUpCardWidth = 150;
  static const double _twoUpGap = 10;

  @override
  Widget build(BuildContext context) {
    Widget oneUp() => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (final _CardSpec c in cards)
              SingleSelectQuestionCard(
                title: c.title,
                leadingIcon: c.icon,
                isSelected: c.isSelected,
                onTap: c.onTap,
                variant: OnboardingVariant.formFlow,
              ),
          ],
        );
    if (!twoUp) return oneUp();
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double cardWidth = (constraints.maxWidth - _twoUpGap) / 2;
        final bool fits = cardWidth >=
            MediaQuery.textScalerOf(context).scale(_minTwoUpCardWidth);
        if (!fits) return oneUp();
        final List<Widget> cells = <Widget>[
          for (final _CardSpec c in cards)
            FinishingGridOptionCard(
              title: c.title,
              icon: c.icon,
              isSelected: c.isSelected,
              onTap: c.onTap,
            ),
        ];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (int i = 0; i < cells.length; i += 2)
              // Equal heights across the row when one label wraps.
              IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Expanded(child: cells[i]),
                    const SizedBox(width: _twoUpGap),
                    Expanded(
                      child: i + 1 < cells.length
                          ? cells[i + 1]
                          : const SizedBox.shrink(),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

/// Single-select salary BAND cards (#1312). Mirrors [_SingleCards] but is keyed
/// on each band's UPPER bound (an int), which is exactly what the wire sends as
/// `salary_expected_max`. Re-tapping the chosen band clears it (a real "skip"),
/// so no salary key is sent — the same toggle-to-clear rule as shift / job type.
class _SalaryBandCards extends StatelessWidget {
  const _SalaryBandCards({required this.selected, required this.onTap});

  /// The currently chosen band's upper bound, or null when none is chosen.
  final int? selected;

  /// Receives the chosen band's upper bound, or null to clear.
  final void Function(int? upperBound) onTap;

  @override
  Widget build(BuildContext context) {
    // Two per row where it fits: six one-per-row cards with icon tiles pushed
    // the salary page past a 360x800 handset (#1471). Read row-wise, the
    // bands still run low to high.
    return _CardGrid(
      twoUp: true,
      cards: <_CardSpec>[
        for (final MapEntry<int, String> e in _kSalaryBands.entries)
          _CardSpec(
            title: e.value,
            icon: kFinishingSalaryIcon,
            isSelected: selected == e.key,
            onTap: () => onTap(selected == e.key ? null : e.key),
          ),
      ],
    );
  }
}

class _CitiesPage extends StatefulWidget {
  const _CitiesPage({required this.state});
  final FinishingState state;
  @override
  State<_CitiesPage> createState() => _CitiesPageState();
}

class _CitiesPageState extends State<_CitiesPage> {
  final TextEditingController _city = TextEditingController();

  /// #1474 — a double-tap used to add the same city twice.
  final TapGuard _addGuard = TapGuard();

  @override
  void dispose() {
    _city.dispose();
    super.dispose();
  }

  void _add() {
    final String value = _city.text.trim();
    if (value.isEmpty) return;
    context.read<FinishingCubit>().addCity(value);
    _city.clear();
  }

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    final FinishingState state = widget.state;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: FinishingTextField(
                controller: _city,
                hint: _kCityHint,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _add(),
              ),
            ),
            const SizedBox(width: 10),
            _AddCityButton(onPressed: _addGuard.wrap(_add)),
          ],
        ),
        if (state.prefs.preferredCities.isNotEmpty) ...<Widget>[
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final String c in state.prefs.preferredCities)
                FinishingChip(
                  label: c,
                  selected: true,
                  trailingIcon: Icons.close_rounded,
                  onTap: () => cubit.removeCity(c),
                ),
            ],
          ),
        ],
        const SizedBox(height: 20),
        FinishingToggleRow(
          label: _kRelocateLabel,
          value: state.prefs.willingToRelocate,
          onChanged: cubit.setRelocate,
        ),
        const SizedBox(height: 10),
        FinishingToggleRow(
          label: _kAccommodationLabel,
          value: state.prefs.accommodationNeeded,
          onChanged: cubit.setAccommodation,
        ),
      ],
    );
  }
}

/// The 48px square "add this city" button beside the city field.
class _AddCityButton extends StatelessWidget {
  const _AddCityButton({required this.onPressed});
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius =
        BorderRadius.circular(OnboardingRadii.nameField);
    return Semantics(
      button: true,
      label: _kAddCity,
      excludeSemantics: true,
      onTap: onPressed,
      child: Material(
        color: OnboardingColors.shiftBlue,
        borderRadius: radius,
        child: InkWell(
          onTap: onPressed,
          borderRadius: radius,
          child: const SizedBox(
            width: OnboardingLayout.tapTarget,
            height: OnboardingLayout.tapTarget,
            child: Icon(Icons.add_rounded,
                size: 24, color: OnboardingColors.textOnBlue),
          ),
        ),
      ),
    );
  }
}

/// #1471 — the money question, alone. The band picker is the only thing on
/// screen, so a worker who cannot read the labels still sees six options and a
/// button without scrolling. Optional: skipping keeps whatever the interview
/// captured; the chosen band's upper bound is sent as `salary_expected_max`
/// (#1312).
class _SalaryPage extends StatelessWidget {
  const _SalaryPage({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    return _SalaryBandCards(
      selected: state.prefs.salaryExpectedMax,
      onTap: context.read<FinishingCubit>().setSalaryMax,
    );
  }
}

/// The two education CARD questions — what was studied, and under whom.
/// Closed sets (#1298), so they answer in a tap each and fit together.
class _EducationPage extends StatelessWidget {
  const _EducationPage({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    final WorkPreferences prefs = state.prefs;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _SectionLabel(_kCredentialLabel),
        _SingleCards(
          labels: _kCredentials,
          selected: prefs.educationCredential,
          onTap: cubit.selectCredential,
          iconFor: (_, __) => kFinishingEducationIcon,
          twoUp: true,
        ),
        const SizedBox(height: _kQuestionGap),
        _SectionLabel(_kCouncilLabel),
        _SingleCards(
          labels: _kCouncils,
          selected: prefs.educationCouncil,
          onTap: cubit.selectCouncil,
          iconFor: (_, __) => kFinishingEducationIcon,
          twoUp: true,
        ),
      ],
    );
  }
}

/// The two education TEXT fields — year and institute. Kept together and kept
/// LAST: they are the only ones that open a keyboard, which is what made the
/// combined page unusable (the keyboard covered the questions above it). The
/// year is range-guarded at the edge, so an out-of-range entry simply produces
/// no year.
class _EducationDetailPage extends StatefulWidget {
  const _EducationDetailPage({required this.state});
  final FinishingState state;
  @override
  State<_EducationDetailPage> createState() => _EducationDetailPageState();
}

class _EducationDetailPageState extends State<_EducationDetailPage> {
  late final TextEditingController _year = TextEditingController(
      text: widget.state.prefs.educationYear?.toString() ?? '');
  late final TextEditingController _institute = TextEditingController(
      text: widget.state.prefs.educationInstitute ?? '');

  @override
  void dispose() {
    _year.dispose();
    _institute.dispose();
    super.dispose();
  }

  int? _inRange(String s, int lo, int hi) {
    final int? v = int.tryParse(s.trim());
    if (v == null || v < lo || v > hi) return null;
    return v;
  }

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _FieldLabel(_kEduYearLabel),
        FinishingTextField(
          controller: _year,
          hint: _kEduYearHint,
          label: _kEduYearLabel,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.next,
          onChanged: (String v) =>
              cubit.setEducationYear(_inRange(v, _kYearMin, _kYearMax)),
        ),
        const SizedBox(height: 18),
        _FieldLabel(_kInstituteLabel),
        FinishingTextField(
          controller: _institute,
          hint: _kInstituteHint,
          label: _kInstituteLabel,
          maxLength: 120,
          textInputAction: TextInputAction.done,
          onChanged: cubit.setInstitute,
        ),
      ],
    );
  }
}

class _HistoryPage extends StatelessWidget {
  const _HistoryPage({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int i = 0; i < state.employments.length; i++) ...<Widget>[
          EmployerCard(
            key: ValueKey<int>(i),
            entry: state.employments[i],
            onChanged: (entry) => cubit.updateEmployer(i, entry),
            onRemove: () => cubit.removeEmployer(i),
          ),
          const SizedBox(height: 12),
        ],
        if (state.employments.length < kMaxEmployers)
          _AddEmployerButton(onPressed: cubit.addEmployer),
      ],
    );
  }
}

/// The kit's secondary (outline) action — 48px, white, hairline, navy label.
class _AddEmployerButton extends StatelessWidget {
  const _AddEmployerButton({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onPressed,
      icon: const Icon(Icons.add_rounded, size: 20),
      label: Text(
        _kAddEmployer,
        style: OnboardingTypography.buttonLabel(),
      ),
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(OnboardingLayout.tapTarget),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        backgroundColor: OnboardingColors.paperWhite,
        foregroundColor: OnboardingColors.shiftBlue,
        side: const BorderSide(color: OnboardingColors.borderDefault, width: 1.2),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
        ),
      ),
    );
  }
}

/// The docked advance/finish bar (+ any inline submit error pinned above it, so
/// a failed save's reason is never scrolled out of view).
class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.state,
    required this.onListen,
    required this.onAdvance,
  });
  final FinishingState state;

  /// Reads the page aloud; null renders no listen button.
  final VoidCallback? onListen;

  /// Runs just before next / submit.
  final VoidCallback onAdvance;

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    final VoidCallback advance = state.isLastPage ? cubit.submit : cubit.nextPage;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (state.submitError != null) _SubmitError(message: state.submitError!),
        QuestionnaireBottomBar(
          nextLabel: state.isLastPage ? _kFinish : _kNext,
          showArrow: !state.isLastPage,
          isLoading: state.isSubmitting,
          onListen: onListen,
          variant: OnboardingVariant.formFlow,
          onNext: state.isSubmitting
              ? null
              : () {
                  onAdvance();
                  advance();
                },
        ),
      ],
    );
  }
}

class _SubmitError extends StatelessWidget {
  const _SubmitError({required this.message});
  final String message;

  /// The strip is pinned chrome beside the CTA, so — like the bar — it caps its
  /// share of the screen: a long server reason at a large font scrolls inside
  /// the strip instead of squeezing the form body off a small handset.
  static const double _maxScreenFraction = 0.25;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        width: double.infinity,
        color: OnboardingColors.errorBg,
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * _maxScreenFraction,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: _content(),
        ),
      ),
    );
  }

  Widget _content() {
    return Center(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints:
            const BoxConstraints(maxWidth: OnboardingLayout.maxContentWidth),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Padding(
              padding: EdgeInsets.only(top: 1),
              child: Icon(Icons.error_outline_rounded,
                  size: 18, color: OnboardingColors.errorRed),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message,
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
}
